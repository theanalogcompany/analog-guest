import { randomUUID } from 'node:crypto'
import {
  AGENT_LATENCY_HIGH_THRESHOLD_MS,
  captureAgentLatencyHigh,
} from '@/lib/analytics/posthog'
import { createAdminClient } from '@/lib/db/admin'
import { capturePostHogEvent, fireRedAlert } from './alerts'
import { buildRuntimeContext } from './build-runtime-context'
import { scheduleAndSend } from './schedule-and-send'
import { classifyStage, generateStage, retrieveCorpusStage } from './stages'
import type { AgentResult, InboundMessage, RuntimeContext } from './types'

async function loadInbound(messageId: string): Promise<{
  message: InboundMessage
  guestId: string
  venueId: string
}> {
  const supabase = createAdminClient()
  const { data, error } = await supabase
    .from('messages')
    .select('id, body, provider_message_id, created_at, venue_id, guest_id, direction')
    .eq('id', messageId)
    .single()
  if (error || !data) {
    throw new Error(
      `loadInbound: message not found (${messageId}): ${error?.message ?? 'no data'}`,
    )
  }
  if (data.direction !== 'inbound') {
    throw new Error(
      `loadInbound: message ${messageId} is not inbound (direction=${data.direction})`,
    )
  }
  if (!data.provider_message_id) {
    throw new Error(`loadInbound: message ${messageId} has no provider_message_id`)
  }
  return {
    message: {
      id: data.id,
      providerMessageId: data.provider_message_id,
      body: data.body,
      receivedAt: new Date(data.created_at),
    },
    guestId: data.guest_id,
    venueId: data.venue_id,
  }
}

async function findExistingReply(inboundMessageId: string): Promise<string | null> {
  const supabase = createAdminClient()
  const { data, error } = await supabase
    .from('messages')
    .select('id')
    .eq('reply_to_message_id', inboundMessageId)
    .eq('direction', 'outbound')
    .limit(1)
    .maybeSingle()
  if (error) {
    throw new Error(`findExistingReply: lookup failed: ${error.message}`)
  }
  return data?.id ?? null
}

/**
 * Top-level orchestrator for inbound messages.
 *
 * Server-only. Generates an agentRunId, idempotency-checks against existing
 * replies (returns 'skipped_duplicate' if found), then runs the pipeline:
 *   loadInbound → buildRuntimeContext → classifyStage → retrieveCorpusStage →
 *   generateStage → scheduleAndSend.
 *
 * Every stage failure fails closed: the guest sees nothing, a PostHog event
 * + Slack alert fire with the agentRunId + stage, and an AgentResult.failed
 * is returned. Soft-refusals from generateStage (final fidelity below the
 * 0.4 send floor) return AgentResult.refused with attemptScores so callers
 * can debug the loop. Successes return AgentResult.sent with the outbound
 * message ID and emit an inbound_message_handled PostHog event.
 *
 * Catastrophic / unhandled throws are caught at the top, alerted under
 * stage='context_build' (most common implicit failure shape), and returned
 * as AgentResult.failed.
 */
export async function handleInbound(inboundMessageId: string): Promise<AgentResult> {
  const agentRunId = randomUUID()
  const start = Date.now()
  let ctx: RuntimeContext | null = null
  let knownVenueId: string | null = null
  let knownGuestId: string | null = null
  // Skipped on the duplicate-skip return path: that path is fast and not
  // interesting for the latency signal. Other early returns (failed builds,
  // refused generations, etc.) DO emit so we can see how long bad runs take.
  let skipLatencyEmit = false

  try {
    console.log('[agent] inbound start', { agentRunId, inboundMessageId })

    // Idempotency
    const existing = await findExistingReply(inboundMessageId)
    if (existing) {
      console.log('[agent] inbound skipped (duplicate)', {
        agentRunId,
        inboundMessageId,
        existingReplyId: existing,
      })
      await capturePostHogEvent('inbound_message_skipped', agentRunId, {
        agentRunId,
        inboundMessageId,
        reason: 'duplicate',
      })
      skipLatencyEmit = true
      return { status: 'skipped_duplicate' }
    }

    // Load inbound row
    const inbound = await loadInbound(inboundMessageId)
    knownVenueId = inbound.venueId
    knownGuestId = inbound.guestId

    // Build context
    try {
      ctx = await buildRuntimeContext({
        agentRunId,
        guestId: inbound.guestId,
        venueId: inbound.venueId,
        currentMessage: inbound.message,
      })
      console.log('[agent] inbound context built', {
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
        venueId: inbound.venueId,
        guestId: inbound.guestId,
        kind: 'inbound',
        stage: 'context_build',
        errorMessage: errMsg,
        errorStack: errStack,
      })
      return { status: 'failed', stage: 'context_build', error: errMsg }
    }

    // Classify
    try {
      ctx.classification = await classifyStage(ctx)
      console.log('[agent] inbound classified', {
        agentRunId,
        category: ctx.classification.category,
        classifierConfidence: ctx.classification.classifierConfidence,
      })
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : String(e)
      await fireRedAlert({
        agentRunId,
        venueId: ctx.venue.id,
        guestId: ctx.guest.id,
        kind: 'inbound',
        stage: 'classification',
        errorMessage: errMsg,
      })
      return { status: 'failed', stage: 'classification', error: errMsg }
    }

    // Retrieve corpus
    try {
      ctx.corpus = await retrieveCorpusStage(ctx)
      console.log('[agent] inbound corpus retrieved', {
        agentRunId,
        matchCount: ctx.corpus.length,
      })
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : String(e)
      await fireRedAlert({
        agentRunId,
        venueId: ctx.venue.id,
        guestId: ctx.guest.id,
        kind: 'inbound',
        stage: 'corpus',
        errorMessage: errMsg,
        extra: { matchCount: ctx.corpus?.length ?? 0 },
      })
      return { status: 'failed', stage: 'corpus', error: errMsg }
    }

    // Generate
    const gen = await generateStage(ctx, ctx.classification.category)
    if (gen.status === 'failed') {
      await fireRedAlert({
        agentRunId,
        venueId: ctx.venue.id,
        guestId: ctx.guest.id,
        kind: 'inbound',
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
        kind: 'inbound',
        stage: 'generation',
        errorMessage: 'fidelity_loop_exhausted',
        extra: { attemptScores: gen.attemptScores, finalScore: gen.finalScore },
      })
      return { status: 'refused', reason: 'low_fidelity', attemptScores: gen.attemptScores }
    }
    console.log('[agent] inbound generated', {
      agentRunId,
      voiceFidelity: gen.result.voiceFidelity,
      attempts: gen.result.attempts,
    })

    // Send + persist
    try {
      const { outboundMessageId, providerMessageId } = await scheduleAndSend(ctx, gen.result)
      console.log('[agent] inbound sent + persisted', {
        agentRunId,
        outboundMessageId,
        providerMessageId,
      })
      await capturePostHogEvent('inbound_message_handled', ctx.guest.id, {
        agentRunId,
        venueId: ctx.venue.id,
        guestId: ctx.guest.id,
        recognitionState: ctx.recognition.state,
        recognitionScore: ctx.recognition.score,
        category: ctx.classification.category,
        voiceFidelity: gen.result.voiceFidelity,
        attempts: gen.result.attempts,
        attemptScores: gen.result.attemptScores,
        matchCount: ctx.corpus.length,
      })
      return { status: 'sent', outboundMessageId }
    } catch (e) {
      // scheduleAndSend already fired the appropriate stage-specific alert.
      const errMsg = e instanceof Error ? e.message : String(e)
      const stage: 'send' | 'persist' = errMsg.includes('persist failed') ? 'persist' : 'send'
      return { status: 'failed', stage, error: errMsg }
    }
  } catch (unexpected) {
    const errMsg = unexpected instanceof Error ? unexpected.message : String(unexpected)
    const errStack = unexpected instanceof Error ? unexpected.stack : undefined
    await fireRedAlert({
      agentRunId,
      venueId: ctx?.venue.id ?? knownVenueId ?? 'unknown',
      guestId: ctx?.guest.id ?? knownGuestId ?? undefined,
      kind: 'inbound',
      stage: 'context_build',
      errorMessage: errMsg,
      errorStack: errStack,
    })
    return { status: 'failed', stage: 'context_build', error: errMsg }
  } finally {
    if (!skipLatencyEmit) {
      const totalElapsedMs = Date.now() - start
      if (totalElapsedMs > AGENT_LATENCY_HIGH_THRESHOLD_MS) {
        await captureAgentLatencyHigh({
          agentRunId,
          venueId: ctx?.venue.id ?? knownVenueId ?? 'unknown',
          guestId: ctx?.guest.id ?? knownGuestId ?? 'unknown',
          totalElapsedMs,
          kind: 'inbound',
        })
      }
    }
  }
}