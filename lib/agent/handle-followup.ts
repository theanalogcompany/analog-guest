import { randomUUID } from 'node:crypto'
import {
  AGENT_LATENCY_HIGH_THRESHOLD_MS,
  captureAgentLatencyHigh,
} from '@/lib/analytics/posthog'
import { capturePostHogEvent, fireRedAlert } from './alerts'
import { buildRuntimeContext } from './build-runtime-context'
import { scheduleAndSend } from './schedule-and-send'
import { generateStage, retrieveCorpusStage } from './stages'
import type {
  AgentResult,
  Classification,
  FollowupTrigger,
  RuntimeContext,
} from './types'

function triggerToCategory(reason: FollowupTrigger['reason']): Classification['category'] {
  switch (reason) {
    case 'day_1':
    case 'day_3':
    case 'day_7':
    case 'day_14':
      return 'follow_up'
    case 'event':
      return 'event_invite'
    case 'manual':
      return 'manual'
  }
}

/**
 * Top-level orchestrator for outbound followup messages.
 *
 * Server-only. Triggered by a cron / scheduler with a {venueId, guestId,
 * trigger} payload — there is no followups table in v1; the trigger is
 * passed live, not persisted. Generates an agentRunId then runs the pipeline:
 *   buildRuntimeContext → (synthesize Classification from trigger) →
 *   retrieveCorpusStage → generateStage → scheduleAndSend.
 *
 * Skips classification — there's no inbound to classify. The Classification
 * is derived from the trigger reason (day_* → follow_up; event → event_invite;
 * manual → manual) and persisted on the outbound row by scheduleAndSend.
 *
 * Same fail-closed behaviour as handleInbound, with kind='followup' on every
 * alert and followup_message_handled / followup_message_failed PostHog events.
 */
export async function handleFollowup(input: {
  venueId: string
  guestId: string
  trigger: FollowupTrigger
}): Promise<AgentResult> {
  const agentRunId = randomUUID()
  const start = Date.now()
  let ctx: RuntimeContext | null = null

  try {
    console.log('[agent] followup start', {
      agentRunId,
      venueId: input.venueId,
      guestId: input.guestId,
      triggerReason: input.trigger.reason,
    })

    // Build context
    try {
      ctx = await buildRuntimeContext({
        agentRunId,
        guestId: input.guestId,
        venueId: input.venueId,
        followupTrigger: input.trigger,
      })
      console.log('[agent] followup context built', {
        agentRunId,
        venueId: ctx.venue.id,
        guestId: ctx.guest.id,
        recognitionState: ctx.recognition.state,
      })
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : String(e)
      const errStack = e instanceof Error ? e.stack : undefined
      await fireRedAlert({
        agentRunId,
        venueId: input.venueId,
        guestId: input.guestId,
        kind: 'followup',
        stage: 'context_build',
        errorMessage: errMsg,
        errorStack: errStack,
      })
      return { status: 'failed', stage: 'context_build', error: errMsg }
    }

    // Synthesize a Classification from the trigger reason — used for prompt
    // category and for the outbound row's category column persisted by
    // scheduleAndSend. classifierConfidence=1.0 since the trigger is
    // operator-decided, not model-inferred.
    const category = triggerToCategory(input.trigger.reason)
    ctx.classification = {
      category,
      classifierConfidence: 1.0,
      reasoning: `Followup trigger: ${input.trigger.reason}`,
    }

    // Retrieve corpus
    try {
      ctx.corpus = await retrieveCorpusStage(ctx)
      console.log('[agent] followup corpus retrieved', {
        agentRunId,
        matchCount: ctx.corpus.length,
      })
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : String(e)
      await fireRedAlert({
        agentRunId,
        venueId: ctx.venue.id,
        guestId: ctx.guest.id,
        kind: 'followup',
        stage: 'corpus',
        errorMessage: errMsg,
        extra: { matchCount: ctx.corpus?.length ?? 0 },
      })
      return { status: 'failed', stage: 'corpus', error: errMsg }
    }

    // Generate
    const gen = await generateStage(ctx, category)
    if (gen.status === 'failed') {
      await fireRedAlert({
        agentRunId,
        venueId: ctx.venue.id,
        guestId: ctx.guest.id,
        kind: 'followup',
        stage: 'generation',
        errorMessage: gen.error,
      })
      return { status: 'failed', stage: 'generation', error: gen.error }
    }
    if (gen.status === 'refused') {
      await fireRedAlert({
        agentRunId,
        venueId: ctx.venue.id,
        guestId: ctx.guest.id,
        kind: 'followup',
        stage: 'generation',
        errorMessage: 'fidelity_loop_exhausted',
        extra: { attemptScores: gen.attemptScores, finalScore: gen.finalScore },
      })
      return { status: 'refused', reason: 'low_fidelity', attemptScores: gen.attemptScores }
    }
    console.log('[agent] followup generated', {
      agentRunId,
      voiceFidelity: gen.result.voiceFidelity,
      attempts: gen.result.attempts,
    })

    // Send + persist
    try {
      const { outboundMessageId, providerMessageId } = await scheduleAndSend(ctx, gen.result)
      console.log('[agent] followup sent + persisted', {
        agentRunId,
        outboundMessageId,
        providerMessageId,
      })
      await capturePostHogEvent('followup_message_handled', ctx.guest.id, {
        agentRunId,
        venueId: ctx.venue.id,
        guestId: ctx.guest.id,
        triggerReason: input.trigger.reason,
        recognitionState: ctx.recognition.state,
        recognitionScore: ctx.recognition.score,
        category,
        voiceFidelity: gen.result.voiceFidelity,
        attempts: gen.result.attempts,
        attemptScores: gen.result.attemptScores,
        matchCount: ctx.corpus.length,
      })
      return { status: 'sent', outboundMessageId }
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : String(e)
      const stage: 'send' | 'persist' = errMsg.includes('persist failed') ? 'persist' : 'send'
      return { status: 'failed', stage, error: errMsg }
    }
  } catch (unexpected) {
    const errMsg = unexpected instanceof Error ? unexpected.message : String(unexpected)
    const errStack = unexpected instanceof Error ? unexpected.stack : undefined
    await fireRedAlert({
      agentRunId,
      venueId: ctx?.venue.id ?? input.venueId,
      guestId: ctx?.guest.id ?? input.guestId,
      kind: 'followup',
      stage: 'context_build',
      errorMessage: errMsg,
      errorStack: errStack,
    })
    return { status: 'failed', stage: 'context_build', error: errMsg }
  } finally {
    const totalElapsedMs = Date.now() - start
    if (totalElapsedMs > AGENT_LATENCY_HIGH_THRESHOLD_MS) {
      await captureAgentLatencyHigh({
        agentRunId,
        venueId: ctx?.venue.id ?? input.venueId,
        guestId: ctx?.guest.id ?? input.guestId,
        totalElapsedMs,
        kind: 'followup',
      })
    }
  }
}