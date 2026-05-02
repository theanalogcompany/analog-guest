import { randomUUID } from 'node:crypto'
import {
  AGENT_LATENCY_HIGH_THRESHOLD_MS,
  captureAgentLatencyHigh,
} from '@/lib/analytics/posthog'
import { startAgentTrace } from '@/lib/observability'
import { capturePostHogEvent, fireRedAlert } from './alerts'
import { buildRuntimeContext } from './build-runtime-context'
import { scheduleAndSend } from './schedule-and-send'
import { generateStage, retrieveCorpusStage } from './stages'
import {
  buildCorpusContent,
  buildGenerateAttemptContent,
  buildGenerateContent,
  buildRecognitionContent,
} from './trace-content'
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
 *
 * THE-200: instrumented identically to handleInbound (root trace 'agent.followup'
 * with child spans for each stage) minus the classify span. flushAsync runs
 * in finally; followup callers must invoke this inside a `waitUntil` window
 * so the flush completes.
 */
export async function handleFollowup(input: {
  venueId: string
  guestId: string
  trigger: FollowupTrigger
  /**
   * When true, scheduleAndSend skips all human-feel sleeps + the typing
   * indicator. Used by the Command Center Follow Up button — operator
   * clicked "send" expecting fast response, and a manual outbound isn't
   * the kind of "natural" reply where typing theatre belongs. Defaults
   * to false (cron-triggered followups keep the existing cadence).
   */
  skipHumanFeelDelay?: boolean
}): Promise<AgentResult> {
  const agentRunId = randomUUID()
  const start = Date.now()
  const trace = startAgentTrace({
    name: 'agent.followup',
    agentRunId,
    metadata: {
      venueId: input.venueId,
      guestId: input.guestId,
      triggerReason: input.trigger.reason,
    },
  })
  let ctx: RuntimeContext | null = null
  // Threaded into the latency event payload. inboundBody stays null for
  // followups (no inbound). generatedBody stays null on failure paths that
  // didn't reach a successful generation.
  let generatedBody: string | null = null

  try {
    console.log('[agent] followup start', {
      agentRunId,
      venueId: input.venueId,
      guestId: input.guestId,
      triggerReason: input.trigger.reason,
      traceId: trace.id,
    })

    // Build context
    const contextSpan = trace.span('context_build', {
      venueId: input.venueId,
      guestId: input.guestId,
    })
    try {
      ctx = await buildRuntimeContext({
        agentRunId,
        guestId: input.guestId,
        venueId: input.venueId,
        followupTrigger: input.trigger,
        trace,
      })
      contextSpan.end({
        output: {
          recognitionState: ctx.recognition.state,
          recognitionScore: ctx.recognition.score,
          mechanicCount: ctx.mechanics.length,
          recentMessageCount: ctx.recentMessages.length,
        },
        content: trace.captureContent
          ? buildRecognitionContent(ctx.recognition)
          : undefined,
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
      contextSpan.end({ level: 'ERROR', statusMessage: errMsg })
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
    const retrieveSpan = trace.span('retrieve', { triggerReason: input.trigger.reason })
    try {
      ctx.corpus = await retrieveCorpusStage(ctx)
      retrieveSpan.end({
        output: {
          matchCount: ctx.corpus.length,
          topSimilarity: ctx.corpus.length > 0 ? Math.max(...ctx.corpus.map((c) => c.similarity)) : 0,
        },
        content: trace.captureContent ? buildCorpusContent(ctx.corpus) : undefined,
      })
      console.log('[agent] followup corpus retrieved', {
        agentRunId,
        matchCount: ctx.corpus.length,
      })
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : String(e)
      retrieveSpan.end({ level: 'ERROR', statusMessage: errMsg })
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
    const generateSpan = trace.span('generate', { category })
    const gen = await generateStage(ctx, category)
    if (gen.status === 'failed') {
      generateSpan.end({ level: 'ERROR', statusMessage: gen.error })
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
      gen.attemptScores.forEach((score, i) => {
        const attemptSpan = generateSpan.span(`generate.attempt_${i + 1}`, { attempt: i + 1 })
        attemptSpan.end({ output: { voiceFidelity: score } })
      })
      generateSpan.end({
        level: 'WARNING',
        statusMessage: 'fidelity_loop_exhausted',
        output: { attemptScores: gen.attemptScores, finalScore: gen.finalScore },
      })
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
    gen.result.attemptScores.forEach((score, i) => {
      const attemptSpan = generateSpan.span(`generate.attempt_${i + 1}`, { attempt: i + 1 })
      const attempt = gen.result.attemptHistory[i]
      attemptSpan.end({
        output: { voiceFidelity: score },
        content: attempt ? buildGenerateAttemptContent(attempt) : undefined,
      })
    })
    generateSpan.end({
      output: {
        voiceFidelity: gen.result.voiceFidelity,
        attempts: gen.result.attempts,
        attemptScores: gen.result.attemptScores,
        promptVersion: gen.result.promptVersion,
        bodyLength: gen.result.body.length,
      },
      content: trace.captureContent ? buildGenerateContent(gen.result) : undefined,
    })
    generatedBody = gen.result.body
    console.log('[agent] followup generated', {
      agentRunId,
      voiceFidelity: gen.result.voiceFidelity,
      attempts: gen.result.attempts,
    })

    // Send + persist
    const sendSpan = trace.span('send', { bodyLength: gen.result.body.length })
    try {
      const { outboundMessageId, providerMessageId } = await scheduleAndSend(
        ctx,
        gen.result,
        { skipHumanFeelDelay: input.skipHumanFeelDelay === true },
      )
      sendSpan.end({
        output: { outboundMessageId, providerMessageId, bodyLength: gen.result.body.length },
        content: { body: gen.result.body },
      })
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
      trace.update({
        output: {
          status: 'sent',
          outboundMessageId,
          voiceFidelity: gen.result.voiceFidelity,
        },
        content: { outboundDraft: gen.result.body },
      })
      return { status: 'sent', outboundMessageId }
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : String(e)
      const stage: 'send' | 'persist' = errMsg.includes('persist failed') ? 'persist' : 'send'
      sendSpan.end({ level: 'ERROR', statusMessage: errMsg, output: { stage } })
      return { status: 'failed', stage, error: errMsg }
    }
  } catch (unexpected) {
    const errMsg = unexpected instanceof Error ? unexpected.message : String(unexpected)
    const errStack = unexpected instanceof Error ? unexpected.stack : undefined
    trace.update({ output: { status: 'failed', error: errMsg } })
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
        inboundBody: null,
        generatedBody,
      })
    }
    await trace.flushAsync()
  }
}
