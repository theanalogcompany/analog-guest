import { randomUUID } from 'node:crypto'
import {
  AGENT_LATENCY_HIGH_THRESHOLD_MS,
  captureAgentLatencyHigh,
} from '@/lib/analytics/posthog'
import { createAdminClient } from '@/lib/db/admin'
import { startAgentTrace } from '@/lib/observability'
import { capturePostHogEvent, fireRedAlert } from './alerts'
import { buildRuntimeContext } from './build-runtime-context'
import { scheduleAndSend } from './schedule-and-send'
import { classifyStage, generateStage, retrieveCorpusStage } from './stages'
import {
  buildCorpusContent,
  buildGenerateAttemptContent,
  buildGenerateContent,
  buildRecognitionContent,
} from './trace-content'
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
 *
 * THE-200: every run opens a Langfuse trace named 'agent.inbound' and
 * tracks each stage as a child span. The trace ID is written to the
 * outbound row's langfuse_trace_id column at insert time. The wrapper is
 * no-op when Langfuse isn't configured, so callers see no behavior change.
 * `flushAsync` runs in the finally block — handleInbound already executes
 * inside the webhook's `waitUntil` keep-alive window, so the flush
 * completes before the function ends.
 */
export async function handleInbound(inboundMessageId: string): Promise<AgentResult> {
  const agentRunId = randomUUID()
  const start = Date.now()
  const trace = startAgentTrace({
    name: 'agent.inbound',
    agentRunId,
    metadata: { inboundMessageId },
  })
  let ctx: RuntimeContext | null = null
  let knownVenueId: string | null = null
  let knownGuestId: string | null = null
  // Skipped on the duplicate-skip return path: that path is fast and not
  // interesting for the latency signal. Other early returns (failed builds,
  // refused generations, etc.) DO emit so we can see how long bad runs take.
  let skipLatencyEmit = false
  // Threaded into the latency event payload. generatedBody stays null on
  // failure paths that didn't reach a successful generation.
  let generatedBody: string | null = null

  try {
    console.log('[agent] inbound start', { agentRunId, inboundMessageId, traceId: trace.id })

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
      trace.update({ output: { status: 'skipped_duplicate', existingReplyId: existing } })
      skipLatencyEmit = true
      return { status: 'skipped_duplicate' }
    }

    // Load inbound row
    const inbound = await loadInbound(inboundMessageId)
    knownVenueId = inbound.venueId
    knownGuestId = inbound.guestId
    trace.update({
      metadata: { venueId: inbound.venueId, guestId: inbound.guestId },
      content: { inboundBody: inbound.message.body },
    })

    // Build context
    const contextSpan = trace.span('context_build', {
      venueId: inbound.venueId,
      guestId: inbound.guestId,
    })
    try {
      ctx = await buildRuntimeContext({
        agentRunId,
        guestId: inbound.guestId,
        venueId: inbound.venueId,
        currentMessage: inbound.message,
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
      console.log('[agent] inbound context built', {
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
    const classifySpan = trace.span(
      'classify',
      { inboundLength: ctx.currentMessage?.body.length ?? 0 },
      { inboundBody: ctx.currentMessage?.body ?? null },
    )
    try {
      ctx.classification = await classifyStage(ctx)
      classifySpan.end({
        output: {
          category: ctx.classification.category,
          classifierConfidence: ctx.classification.classifierConfidence,
        },
        content: { reasoning: ctx.classification.reasoning },
      })
      console.log('[agent] inbound classified', {
        agentRunId,
        category: ctx.classification.category,
        classifierConfidence: ctx.classification.classifierConfidence,
      })
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : String(e)
      classifySpan.end({ level: 'ERROR', statusMessage: errMsg })
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
    const retrieveSpan = trace.span(
      'retrieve',
      { queryLength: ctx.currentMessage?.body.length ?? 0 },
      { query: ctx.currentMessage?.body ?? null },
    )
    try {
      ctx.corpus = await retrieveCorpusStage(ctx)
      retrieveSpan.end({
        output: {
          matchCount: ctx.corpus.length,
          topSimilarity: ctx.corpus.length > 0 ? Math.max(...ctx.corpus.map((c) => c.similarity)) : 0,
        },
        content: trace.captureContent ? buildCorpusContent(ctx.corpus) : undefined,
      })
      console.log('[agent] inbound corpus retrieved', {
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
        kind: 'inbound',
        stage: 'corpus',
        errorMessage: errMsg,
        extra: { matchCount: ctx.corpus?.length ?? 0 },
      })
      return { status: 'failed', stage: 'corpus', error: errMsg }
    }

    // Generate
    const generateSpan = trace.span('generate', { category: ctx.classification.category })
    const gen = await generateStage(ctx, ctx.classification.category)
    if (gen.status === 'failed') {
      generateSpan.end({ level: 'ERROR', statusMessage: gen.error })
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
      // Synthesize per-attempt sub-spans from attemptScores. No real per-attempt
      // timing — see follow-up ticket THE-215. The sub-spans are still useful
      // because they enumerate the regen loop attempts in the trace UI.
      // Refused-path note: lib/ai's generateStage doesn't surface attemptHistory
      // on refusal (the AgentResult shape only carries scores). Per-attempt
      // body content lives only on the success path; THE-215 will fix this
      // when threading the trace into the regen loop directly.
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
        kind: 'inbound',
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
    console.log('[agent] inbound generated', {
      agentRunId,
      voiceFidelity: gen.result.voiceFidelity,
      attempts: gen.result.attempts,
    })

    // Send + persist
    const sendSpan = trace.span('send', { bodyLength: gen.result.body.length })
    try {
      const { outboundMessageId, providerMessageId } = await scheduleAndSend(ctx, gen.result)
      sendSpan.end({
        output: { outboundMessageId, providerMessageId, bodyLength: gen.result.body.length },
        content: { body: gen.result.body },
      })
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
      // scheduleAndSend already fired the appropriate stage-specific alert.
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
          inboundBody: ctx?.currentMessage?.body ?? null,
          generatedBody,
        })
      }
    }
    // Flush trace events. Wrapper swallows errors. Caller (webhook route) is
    // already inside a `waitUntil` keep-alive window so the flush completes.
    await trace.flushAsync()
  }
}
