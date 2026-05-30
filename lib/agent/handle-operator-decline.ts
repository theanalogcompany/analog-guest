// TAC-299. Operator-initiated DECLINE draft generation. Routed from
// POST /api/operator/commitments/:id/draft-decline when an operator swipes
// left on a heads-up card. Generates a brief apology in the venue's voice and
// PERSISTS THE DRAFT AS PENDING — never sends. The operator-facing edit
// screen picks up the resulting messages row and dispatches via the existing
// approve/edit pipeline.
//
// Modelled on handle-followup.ts (canonical operator-initiated generation
// template) with two structural differences:
//
//   1. NEVER calls scheduleAndSend / sendMessage. The "persist-pending, not
//      auto-send" invariant is structurally enforced by NOT importing those
//      modules — a regression would have to add the import to silently text
//      a guest. The colocated test asserts no send-side mock invocation.
//   2. SKIPS applyApprovalPolicyStage entirely. The operator's swipe-left IS
//      the approval signal; running the policy gate would either rubber-stamp
//      or queue redundantly. We pass our own primaryTrigger
//      'operator_decline_initiated' straight into persistOrRegenQueuedDraft so
//      it lands on messages.review_reason for the queue UI label.
//
// Trigger & operator instruction: synthesized internally via the existing
// FollowupTrigger.metadata.hint plumbing (THE-232 → buildAiRuntime in
// lib/agent/stages.ts → operatorInstruction in lib/ai/types.ts). Category is
// 'manual' so it flows through the existing runtime-to-prose branch that
// knows how to render operator instructions.
//
// The COMMITMENT-side effect (markCancelled to status='cancelled') lives in
// the ROUTE handler, not here. This orchestrator's responsibility ends at the
// pending draft. The route owns the cancellation timing decision and its
// race-safety posture (CAS-lost → log + accept, draft still persisted).

import { randomUUID } from 'node:crypto'

import {
  AGENT_LATENCY_HIGH_THRESHOLD_MS,
  captureAgentLatencyHigh,
  captureDraftQueued,
  captureDraftRegenerated,
} from '@/lib/analytics/posthog'
import {
  isEmptyContextUpdate,
  updateGuestContext,
} from '@/lib/guests/context'
import { startAgentTrace } from '@/lib/observability'
import { fireRedAlert } from './alerts'
import { buildRuntimeContext } from './build-runtime-context'
import { dispatchArrivalCapture } from './dispatch-arrival-capture'
import { persistOrRegenQueuedDraft } from './schedule-and-send'
import {
  findPendingDraft,
  generateStage,
  retrieveCorpusStage,
} from './stages'
import {
  buildCorpusContent,
  buildGenerateAttemptContent,
  buildGenerateContent,
  buildRecognitionContent,
} from './trace-content'
import type { AgentResult, Classification, RuntimeContext } from './types'

// Operator-decline primary trigger. Distinct from the auto-policy
// APPROVAL_TRIGGERS in lib/agent/stages.ts because the policy gate doesn't
// fire it — the route does. Lands on messages.review_reason; the operator
// queue UI renders it via lib/operator/queue.ts REVIEW_REASON_LABELS.
export const OPERATOR_DECLINE_PRIMARY_TRIGGER = 'operator_decline_initiated'

/**
 * Build the synthetic operator instruction injected into the agent via
 * FollowupTrigger.metadata.hint. Surfaces the commitment description but
 * keeps the framing tight — Sonnet doesn't need to apologize at length,
 * just acknowledge cleanly. R3 (no em dashes), no alternatives, in the
 * venue's voice via the rest of the prompt stack.
 *
 * Pure (no `description` validation here — the route guards the empty case
 * before invoking). Exported for testability.
 */
export function buildDeclineHint(commitmentDescription: string): string {
  // R3 + THE-225: the agent's OUTPUT can't contain em dashes (post-hoc
  // hard-block + rewrite costs a regen). The hint feeds straight into the
  // prompt; Sonnet sometimes echoes the punctuation it saw, so keep the
  // hint em-dash free to avoid wasting attempts.
  return `Operator decision: the venue can't fulfill a commitment we previously made to this guest: "${commitmentDescription}". Draft a brief, warm apology explaining we can't honor it. No alternatives, no upsell. Keep it short, direct, and in the venue's voice.`
}

/**
 * Top-level orchestrator for operator-initiated decline draft generation.
 *
 * Server-only. Triggered by POST /api/operator/commitments/:id/draft-decline.
 * Generates an agentRunId then runs the pipeline:
 *   buildRuntimeContext → (synthesize Classification) → retrieveCorpusStage →
 *   generateStage → findPendingDraft → persistOrRegenQueuedDraft.
 *
 * Skips:
 *   - classification (no inbound to classify; category synthesized to 'manual')
 *   - retrieveKnowledgeStage (declines don't cite venue facts; ctx.knowledgeCorpus
 *     stays [])
 *   - applyApprovalPolicyStage (operator's swipe-left IS the approval)
 *   - scheduleAndSend (NEVER called — persist-pending only)
 *
 * Returns AgentResult.queued on success, .refused on fidelity floor, .failed
 * on any pipeline failure. The route handler maps these to HTTP status codes
 * (200 / 422 / 502 respectively).
 *
 * Observability: root trace 'agent.operator_decline' so Langfuse can
 * distinguish this surface from inbound + followup. flushAsync runs in
 * finally; callers must invoke this inside a `waitUntil` window so the
 * flush completes before the function returns to the network.
 */
export async function handleOperatorDecline(input: {
  venueId: string
  guestId: string
  commitmentId: string
  commitmentDescription: string
}): Promise<AgentResult> {
  const agentRunId = randomUUID()
  const start = Date.now()
  const trace = startAgentTrace({
    name: 'agent.operator_decline',
    agentRunId,
    metadata: {
      venueId: input.venueId,
      guestId: input.guestId,
      commitmentId: input.commitmentId,
    },
  })
  let ctx: RuntimeContext | null = null
  let generatedBody: string | null = null

  try {
    console.log('[agent] operator decline start', {
      agentRunId,
      venueId: input.venueId,
      guestId: input.guestId,
      commitmentId: input.commitmentId,
      traceId: trace.id,
    })

    const hint = buildDeclineHint(input.commitmentDescription)

    // Build context — FollowupTrigger metadata.hint carries the synthesized
    // decline instruction through to buildAiRuntime → operatorInstruction.
    // reason='manual' so the existing 'manual' branch in runtimeToProse +
    // shouldRetrieveKnowledge (event/manual = true) applies. But we don't
    // call retrieveKnowledgeStage anyway — see ctx.knowledgeCorpus=[] below.
    const contextSpan = trace.span('context_build', {
      venueId: input.venueId,
      guestId: input.guestId,
      commitmentId: input.commitmentId,
    })
    try {
      ctx = await buildRuntimeContext({
        agentRunId,
        guestId: input.guestId,
        venueId: input.venueId,
        followupTrigger: {
          reason: 'manual',
          triggeredAt: new Date(),
          metadata: { hint },
        },
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

    // Synthesize Classification. classifierConfidence=1.0 (no inference,
    // operator-decided). category='manual' so the existing user-prompt
    // branch handles the operator instruction.
    const category: Classification['category'] = 'manual'
    ctx.classification = {
      category,
      classifierConfidence: 1.0,
      reasoning: `Operator-initiated decline of commitment ${input.commitmentId}`,
    }

    // Voice corpus — fail-CLOSED. A decline still needs to be in the venue's
    // voice; an unrooted apology is exactly the kind of generic-sounding
    // message we're trying to avoid shipping.
    const retrieveSpan = trace.span('retrieve', { surface: 'operator_decline' })
    try {
      ctx.corpus = await retrieveCorpusStage(ctx)
      retrieveSpan.end({
        output: {
          matchCount: ctx.corpus.length,
          topSimilarity:
            ctx.corpus.length > 0
              ? Math.max(...ctx.corpus.map((c) => c.similarity))
              : 0,
        },
        content: trace.captureContent ? buildCorpusContent(ctx.corpus) : undefined,
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

    // Knowledge corpus: SKIPPED. Declines don't cite venue facts (sourcing
    // stories, staff names, mechanic explanations) — we're saying "we
    // can't do this thing." Setting [] matches the day_* followup posture
    // (block omitted from prompt).
    ctx.knowledgeCorpus = []

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

    // Optional emission side effects, mirroring handle-followup's posture.
    // Both are expected to be empty on the decline path (no inbound to react
    // to, no commitment to capture — we're CANCELLING one). Empty short-
    // circuits with no DB hit. Non-empty logs + continues (don't crash the
    // orchestrator over an unexpected emission).
    if (!isEmptyContextUpdate(gen.result.contextUpdate)) {
      const writeResult = await updateGuestContext({
        guestId: ctx.guest.id,
        update: gen.result.contextUpdate,
        now: ctx.recognition.computedAt,
      })
      if (!writeResult.ok) {
        console.warn('[agent] operator decline context write failed (continuing)', {
          agentRunId,
          guestId: ctx.guest.id,
          error: writeResult.error,
        })
      }
    }
    const arrival = await dispatchArrivalCapture({
      arrivalCapture: gen.result.arrivalCapture,
      now: ctx.recognition.computedAt,
    })
    if (arrival.kind !== 'noop') {
      console.warn(
        '[agent] operator decline arrival capture fired unexpectedly (no push on decline path)',
        { agentRunId, kind: arrival.kind },
      )
    }

    // Persist as pending. NO approval gate (operator's swipe-left IS the
    // approval). NO scheduleAndSend — persist-only.
    //
    // findPendingDraft fails OPEN (returns null on error) — that's the
    // documented posture for that helper. A null return means we route
    // through persistOrRegenQueuedDraft's INSERT path; if there's actually
    // a pending row the migration 020 unique violation will catch us and
    // race-recovery will route to UPDATE. Same belt-and-suspenders chain
    // the inbound path uses.
    const queueSpan = trace.span('queue', {
      primaryTrigger: OPERATOR_DECLINE_PRIMARY_TRIGGER,
      surface: 'operator_decline',
    })
    try {
      const existingPending = await findPendingDraft(ctx.venue.id, ctx.guest.id)
      const persistResult = await persistOrRegenQueuedDraft(
        ctx,
        gen.result,
        OPERATOR_DECLINE_PRIMARY_TRIGGER,
        existingPending?.id ?? null,
      )
      const { outboundMessageId, action: persistAction, priorReviewReason } = persistResult
      queueSpan.end({
        output: {
          outboundMessageId,
          primaryTrigger: OPERATOR_DECLINE_PRIMARY_TRIGGER,
          persistAction,
          priorReviewReason,
          bodyLength: gen.result.body.length,
        },
        content: { body: gen.result.body },
      })
      console.log(
        persistAction === 'updated'
          ? '[agent] operator decline regenerated existing pending draft'
          : '[agent] operator decline queued for review',
        {
          agentRunId,
          outboundMessageId,
          persistAction,
          priorReviewReason,
        },
      )
      if (persistAction === 'updated') {
        await captureDraftRegenerated({
          agentRunId,
          venueId: ctx.venue.id,
          guestId: ctx.guest.id,
          originalDraftId: outboundMessageId,
          triggers: [OPERATOR_DECLINE_PRIMARY_TRIGGER],
          primaryTrigger: OPERATOR_DECLINE_PRIMARY_TRIGGER,
          priorReviewReason,
          voiceFidelity: gen.result.voiceFidelity,
          modelRequiresApproval: gen.result.requiresOperatorApproval,
          modelApprovalReason: gen.result.approvalReason,
          compRegexMatchedPattern: null,
          kind: 'followup',
          category,
          inboundBody: null,
          generatedBody: gen.result.body,
        })
      } else {
        await captureDraftQueued({
          agentRunId,
          venueId: ctx.venue.id,
          guestId: ctx.guest.id,
          triggers: [OPERATOR_DECLINE_PRIMARY_TRIGGER],
          primaryTrigger: OPERATOR_DECLINE_PRIMARY_TRIGGER,
          voiceFidelity: gen.result.voiceFidelity,
          modelRequiresApproval: gen.result.requiresOperatorApproval,
          modelApprovalReason: gen.result.approvalReason,
          compRegexMatchedPattern: null,
          hasPreviousPending: existingPending !== null,
          kind: 'followup',
          category,
          inboundBody: null,
          generatedBody: gen.result.body,
        })
      }
      trace.update({
        output: {
          status: 'queued',
          outboundMessageId,
          primaryTrigger: OPERATOR_DECLINE_PRIMARY_TRIGGER,
          voiceFidelity: gen.result.voiceFidelity,
          persistAction,
        },
        content: { outboundDraft: gen.result.body },
      })
      return {
        status: 'queued',
        outboundMessageId,
        triggers: [OPERATOR_DECLINE_PRIMARY_TRIGGER],
        primaryTrigger: OPERATOR_DECLINE_PRIMARY_TRIGGER,
      }
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : String(e)
      queueSpan.end({ level: 'ERROR', statusMessage: errMsg, output: { stage: 'persist' } })
      return { status: 'failed', stage: 'persist', error: errMsg }
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
