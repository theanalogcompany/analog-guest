import { randomUUID } from 'node:crypto'
import { waitUntil } from '@vercel/functions'
import {
  AGENT_LATENCY_HIGH_THRESHOLD_MS,
  captureAgentLatencyHigh,
  captureCrisisSafetyReplySent,
  captureDraftDropped,
  captureDraftQueued,
  captureDraftRegenerated,
  captureIntentionPromptRaised,
  captureIntentionPromptRecordingFailed,
} from '@/lib/analytics/posthog'
import { createAdminClient } from '@/lib/db/admin'
import {
  isEmptyContextUpdate,
  updateGuestContext,
} from '@/lib/guests/context'
import { sendCommitmentArrivalPush } from '@/lib/notifications/send-commitment-push'
import { sendDraftFlaggedPush, shouldSendDraftFlaggedPush } from '@/lib/notifications/send'
import { startAgentTrace } from '@/lib/observability'
import { parseMessageChannel } from '@/lib/schemas/message-channel'
import { capturePostHogEvent, fireRedAlert } from './alerts'
import { buildRuntimeContext } from './build-runtime-context'
import { buildCrisisSafetyResult, CRISIS_SAFETY_REVIEW_REASON } from './crisis-safety'
import { dispatchArrivalCapture } from './dispatch-arrival-capture'
import {
  anyKnowledgeGapCard,
  decideSlotAction,
  EMPTY_PENDING_ROWS,
  loadPendingRowsBySlot,
} from './pending-slots'
import { extractReportedOrder } from './extract-reported-order'
import { renderableIntentions } from './intentions/derive'
import { recordIntentionEligibility, recordIntentionPrompts } from './intentions/record'
import { persistOrRegenQueuedDraft } from './schedule-and-send'
import { dispatchReply, type DispatchReplyOutcome } from './dispatch-reply'
import { INSTAGRAM_SEND_FAILED_REVIEW_REASON } from './dispatch-instagram-reply'
import {
  applyApprovalPolicyStage,
  APPROVAL_TRIGGERS,
  classifyStage,
  computeFirstTouchAfterQrScan,
  generateStage,
  GENERATION_FAILED_REVIEW_REASON,
  KNOWLEDGE_GAP_WINDOW_MS,
  type GroundingBackstopResult,
  type MechanicOfferBackstopResult,
  retrieveCorpusStage,
  retrieveKnowledgeStage,
  shouldRetrieveKnowledge,
  verifyGroundingStage,
  verifyMechanicOfferStage,
} from './stages'
import {
  buildCorpusContent,
  buildGenerateAttemptContent,
  buildGenerateContent,
  buildKnowledgeCorpusContent,
  buildRecognitionContent,
} from './trace-content'
import { AI_ERROR_TRUNCATED } from '@/lib/ai/generate-message'
import { PROMPT_VERSION } from '@/lib/ai/prompts/system-template'
import type { GenerateMessageResult } from '@/lib/ai'
import type { AgentResult, InboundMessage, RuntimeContext } from './types'

async function loadInbound(messageId: string): Promise<{
  message: InboundMessage
  guestId: string
  venueId: string
}> {
  const supabase = createAdminClient()
  const { data, error } = await supabase
    .from('messages')
    .select('id, body, provider_message_id, created_at, venue_id, guest_id, direction, channel')
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
      // TAC-495: picks the prompt copy, through resolveConversationChannel.
      channel: parseMessageChannel(data.channel),
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
 * TAC-309: turn a hard generation failure into an operator queue card.
 *
 * Called after generation has failed TWICE. The alternative is what shipped
 * before: no outbound row, no card, no retry — the guest sits in silence and
 * nobody at the venue learns they asked anything. That is strictly worse than
 * a bad draft, because a bad draft at least surfaces.
 *
 * Why this can't go through `applyApprovalPolicyStage`: the gate takes a
 * `GenerateMessageResult` as input and a crash didn't produce one. So the card
 * is written directly, with a synthetic result standing in for the generation
 * that never happened — the same shape as `buildFallbackGeneration` in
 * handle-holding-message.ts.
 *
 * Policy, matching the gate's behavior rather than reinventing it:
 *   - `opted_out_at` → NO card. Nobody is going to reply to someone who left.
 *   - `hold_all_outbound` → card ANYWAY. A queue card IS the hold outcome;
 *     suppressing it would restore the exact silence this fixes, and would do
 *     it specifically at the venues that asked for more oversight. That flag
 *     gates sends, which it already does elsewhere.
 *   - The clock is armed only when the guest doesn't already have a
 *     knowledge-gap card, so a crash can't reset a deadline that's already
 *     running.
 *
 * Never throws — a failure to record a failure must not deepen it.
 */
async function persistGenerationFailureCard(
  ctx: RuntimeContext,
  agentRunId: string,
): Promise<{ kind: 'carded'; outboundMessageId: string } | { kind: 'skipped' }> {
  try {
    const supabase = createAdminClient()
    const { data: guestRow } = await supabase
      .from('guests')
      .select('opted_out_at')
      .eq('id', ctx.guest.id)
      .maybeSingle()
    if (guestRow?.opted_out_at) {
      console.warn('[agent] generation-failure card skipped — guest opted out', {
        agentRunId,
        guestId: ctx.guest.id,
      })
      return { kind: 'skipped' }
    }

    // TAC-394: the crash card is blank, so it carries no commitment and lands
    // in the CONVERSATION slot; a comp card in the obligation slot is neither in
    // this write's way nor at risk from it. decideSlotAction decides the slot
    // with 'regen_gap_card_only', the same function and policy persist race
    // recovery applies below. A failed read reads as two empty slots, as
    // findPendingDraft's null did; the slot's unique index and that recovery
    // are the backstop.
    //
    // The policy never overwrites a pending draft that ISN'T a gap card.
    // Writing over one would UPDATE it in place with body '', voice_fidelity
    // null, a new review_reason AND a nulled pending_commitment, so an operator
    // holding a draft would lose the text, the label and the commitment carrier
    // because a LATER, unrelated turn happened to crash. The guest already has a
    // card in the queue, so nothing is silent: the operator is on the hook
    // either way, and the red alert above records the crash.
    const pendingRows =
      (await loadPendingRowsBySlot(ctx.venue.id, ctx.guest.id)) ?? EMPTY_PENDING_ROWS
    const slotDecision = decideSlotAction({
      rows: pendingRows,
      draftCommitment: null,
      isGapTurn: true,
      truncatedOnly: false,
      callerPolicy: 'regen_gap_card_only',
    })
    if (slotDecision.action === 'drop') {
      console.warn(
        '[agent] generation-failure card skipped — a non-gap pending draft holds the slot',
        { agentRunId, guestId: ctx.guest.id, protectedDraftId: slotDecision.protectedDraftId },
      )
      return { kind: 'skipped' }
    }
    const existingId = slotDecision.action === 'regen' ? slotDecision.draftId : null

    // Same clock rule the gate applies: arm a new deadline only when no
    // knowledge-gap card sits in EITHER slot, so a crash can't push out a
    // deadline that's already running or start a second holding message.
    const pendingUntil = anyKnowledgeGapCard(pendingRows)
      ? undefined
      : new Date(Date.now() + KNOWLEDGE_GAP_WINDOW_MS)

    const persisted = await persistOrRegenQueuedDraft(
      ctx,
      buildGenerationFailureGeneration(),
      // TAC-364: its OWN review_reason, not KNOWLEDGE_GAP. TAC-309 reused the
      // gap value to inherit the timer, the holding message and the priority
      // wiring for free — all of which still work, because none of them key on
      // review_reason (the timer scans pending_until; isKnowledgeGapCard and
      // findPendingQuestion both gained this value in the same change). What
      // the reuse cost was the operator-facing copy: a crash card read "a
      // guest asked something I don't have an answer for", which is not what
      // happened. `review_triggers` is deliberately NOT passed — this path
      // never ran the gate, so there is no trigger SET to record, only the one
      // reason it stamps itself.
      GENERATION_FAILED_REVIEW_REASON,
      existingId,
      // TAC-394: the same decision as above, applied again if a unique
      // violation reveals a card this read didn't see.
      { pendingUntil, blankBody: true, callerPolicy: 'regen_gap_card_only' },
    )
    if (persisted.action === 'dropped') {
      console.warn(
        '[agent] generation-failure card skipped: a non-gap pending draft took the slot during the write',
        { agentRunId, guestId: ctx.guest.id, protectedDraftId: persisted.protectedDraftId },
      )
      return { kind: 'skipped' }
    }

    console.warn('[agent] generation failed twice — carded for operator', {
      agentRunId,
      outboundMessageId: persisted.outboundMessageId,
      persistAction: persisted.action,
    })
    await captureDraftQueued({
      agentRunId,
      venueId: ctx.venue.id,
      guestId: ctx.guest.id,
      triggers: [GENERATION_FAILED_REVIEW_REASON],
      primaryTrigger: GENERATION_FAILED_REVIEW_REASON,
      voiceFidelity: 0,
      modelRequiresApproval: false,
      modelApprovalReason: '',
      compRegexMatchedPattern: null,
      hasPreviousPending: slotDecision.action === 'regen',
      slot: 'conversation',
      otherSlotOccupied: pendingRows.obligation !== null,
      kind: 'inbound',
      // Classification always succeeded to reach the generate stage; the
      // fallback satisfies the non-null contract without inventing a category.
      category: ctx.classification?.category ?? 'unknown',
      inboundBody: ctx.currentMessage?.body ?? null,
      generatedBody: '',
    })
    // shouldSendDraftFlaggedPush fails OPEN on any value outside PUSH_POLICY's
    // total map, so `generation_failed` pushes — which is what this card wants
    // (nobody is coming to look at it otherwise) and is asserted in
    // push-policy.test.ts rather than left to be inferred from the default.
    if (shouldSendDraftFlaggedPush(GENERATION_FAILED_REVIEW_REASON)) {
      waitUntil(
        sendDraftFlaggedPush({
          agentRunId,
          venueId: ctx.venue.id,
          guestId: ctx.guest.id,
          guestFirstName: ctx.guest.firstName,
          draftId: persisted.outboundMessageId,
          primaryTrigger: GENERATION_FAILED_REVIEW_REASON,
        }).catch(() => {}),
      )
    }
    return { kind: 'carded', outboundMessageId: persisted.outboundMessageId }
  } catch (e) {
    console.error('[agent] generation-failure card could not be written', {
      agentRunId,
      error: e instanceof Error ? e.message : String(e),
    })
    return { kind: 'skipped' }
  }
}

/**
 * Synthetic generation for the failure card. The body is blank and
 * `blankBody: true` is passed alongside, so nothing here reaches the row's
 * body — this exists to satisfy the shape `buildOutboundInsert` reads.
 */
function buildGenerationFailureGeneration(): GenerateMessageResult {
  return {
    body: '(generation failed)',
    voiceFidelity: 0,
    reasoning: 'TAC-309: generation failed twice; carded for operator answer',
    // TAC-509: the card is blank, so there is no body to hold a link. Empty
    // also keeps UNVERIFIED_URL out of the crash card's trigger set, which is
    // right: nothing was checked because nothing was generated.
    unverifiedUrls: [],
    requiresOperatorApproval: false,
    approvalReason: '',
    complaintIntent: 'none',
    knowledgeGap: true,
    contextUpdate: {},
    commitment: {},
    arrivalCapture: {},
    attempts: 2,
    attemptScores: [],
    attemptHistory: [],
    systemPrompt: '',
    userPrompt: '',
    promptVersion: PROMPT_VERSION,
    dashViolationPersisted: false,
    selfTalkViolationPersisted: false,
    emojiDirectiveViolated: false,
  }
}

/**
 * TAC-469: push the operator about a card an Instagram reply became. Fired by
 * the orchestrator, like every other card's push. shouldSendDraftFlaggedPush
 * fails OPEN on a value outside PUSH_POLICY's total map, so this card pushes,
 * as it should: nobody is coming to look at it otherwise.
 */
function pushSendFailureCard(ctx: RuntimeContext, cardId: string): void {
  if (!shouldSendDraftFlaggedPush(INSTAGRAM_SEND_FAILED_REVIEW_REASON)) return
  waitUntil(
    sendDraftFlaggedPush({
      agentRunId: ctx.agentRunId,
      venueId: ctx.venue.id,
      guestId: ctx.guest.id,
      guestFirstName: ctx.guest.firstName,
      draftId: cardId,
      primaryTrigger: INSTAGRAM_SEND_FAILED_REVIEW_REASON,
    }).catch(() => {}),
  )
}

/**
 * TAC-469: what an agent reply that did not simply go out means for the run.
 * Only the Instagram arm produces these; the text arm sends or throws.
 *
 *   carded           the reply became an operator card (rule 4), so the run
 *                    queued, like the crash card
 *   superseded       the message already had a reply, usually from staff in
 *                    the Instagram app (rule 3); nothing was sent, by design
 *   not_sent         nothing went out and no card could be written; the Slack
 *                    event carries the text
 *   sent_unrecorded  it went out, but no row saved; its echo will record it
 */
function undeliveredAgentResult(
  ctx: RuntimeContext,
  outcome: Exclude<DispatchReplyOutcome, { kind: 'sent' }>,
): AgentResult {
  switch (outcome.kind) {
    case 'carded':
      pushSendFailureCard(ctx, outcome.cardId)
      return {
        status: 'queued',
        outboundMessageId: outcome.cardId,
        triggers: [INSTAGRAM_SEND_FAILED_REVIEW_REASON],
        primaryTrigger: INSTAGRAM_SEND_FAILED_REVIEW_REASON,
      }
    case 'superseded':
      return { status: 'superseded', byMessageId: outcome.byMessageId }
    case 'not_sent':
      return { status: 'failed', stage: 'send', error: outcome.reason }
    case 'sent_unrecorded':
      return { status: 'failed', stage: 'persist', error: outcome.reason }
  }
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
      // TAC-244: inbound-XOR-outbound invariant. handleInbound is the inbound
      // entry point; currentMessage MUST be set and followupTrigger MUST be
      // null. A violation here means buildRuntimeContext was called with both
      // fields populated (an upstream bug) — throw loud so the top-level
      // catch fires a red alert with stage='context_build' rather than
      // silently producing a malformed prompt.
      if (ctx.currentMessage === null || ctx.followupTrigger !== null) {
        throw new Error(
          'inbound run invariant violated: ctx.currentMessage must be set and ctx.followupTrigger must be null on the inbound flow',
        )
      }
      // TAC-469: the reply is routed on the conversation's channel, and nothing
      // routes on an unknown one. Stop before classifying or generating: there
      // is nowhere to send the result. buildRuntimeContext has already raised
      // conversation_channel_unresolved with the reason; the catch below adds
      // the red alert for the run. Unreachable for a Sendblue guest, whose
      // text arrives from the phone number the guest row holds.
      if (ctx.conversationChannel === null) {
        throw new Error('conversation channel unresolved: the reply has nowhere to be routed')
      }
      contextSpan.end({
        output: {
          recognitionState: ctx.recognition.state,
          recognitionScore: ctx.recognition.score,
          mechanicCount: ctx.mechanics.length,
          recentMessageCount: ctx.recentMessages.length,
          // TAC-380: pre-classification. What actually renders is narrowed
          // later by renderableIntentions.
          openIntentionKeys: ctx.openIntentions.map((o) => o.key),
          newlyEligibleIntentionKeys: ctx.intentionDerivation.newlyEligible.map((e) => e.key),
          rearmedIntentionKeys: ctx.intentionDerivation.newlyEligible
            .filter((e) => e.rearm)
            .map((e) => e.key),
          intentionBrakeEngaged: ctx.intentionDerivation.brakeEngaged,
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

    // TAC-348: crisis-safety short-circuit. Fires immediately after
    // classification, before retrieval or generation. retrieveCorpusStage
    // fails CLOSED on the inbound path (throws below MIN_STRONG_MATCHES), and
    // a crisis message has no reason to resemble venue voice-corpus
    // exemplars, so this cannot wait until inside generateStage — silence on
    // exactly the turn where silence is worst. Bypasses corpus/knowledge
    // retrieval, generateStage, guest-context capture, arrival-capture
    // dispatch, extractReportedOrder, intention recording, and — the
    // important one — applyApprovalPolicyStage entirely: no operator flag,
    // per the owner decision, because the approval gate never runs at all
    // (not because a trigger was suppressed). As a direct consequence this
    // also bypasses venues.hold_all_outbound and category_requires_approval
    // routing — same category of exception migration 031 already carves out
    // for opt-out confirmations (content-free, deterministic,
    // non-negotiable). The reply is a fixed string, never generated — see
    // lib/agent/crisis-safety.ts for why.
    if (ctx.classification.crisisSafety) {
      const crisisSpan = trace.span('crisis_safety', { category: ctx.classification.category })
      try {
        const result = buildCrisisSafetyResult()
        const dispatched = await dispatchReply(ctx, result, {
          skipHumanFeelDelay: true,
          reviewReason: CRISIS_SAFETY_REVIEW_REASON,
          // TAC-469 (ruled 2026-09-19): the crisis-safety reply is exempt from
          // the Instagram reply check. Silencing it because staff typed
          // something leaves someone in crisis with nothing; a duplicate gives
          // them the resources twice, and a hand-typed reply won't carry them.
          replyCheck: 'exempt',
          onUndelivered: 'card',
        })
        if (dispatched.kind !== 'sent') {
          crisisSpan.end({ level: 'WARNING', output: { outcome: dispatched.kind } })
          return undeliveredAgentResult(ctx, dispatched)
        }
        const { outboundMessageId } = dispatched
        // The fixed crisis body is two sentences, so on Instagram it can
        // dispatch as two messages and the resource line is the second one. If
        // it didn't all go out, the remainder is a card like any other and the
        // operator is pushed: this is the turn where silence is worst.
        if (dispatched.undelivered !== null) {
          console.warn('[agent] crisis-safety reply partly delivered', {
            agentRunId,
            outboundMessageId,
            reason: dispatched.undelivered.reason,
            cardId: dispatched.undelivered.cardId,
          })
          if (dispatched.undelivered.cardId !== null) pushSendFailureCard(ctx, dispatched.undelivered.cardId)
        }
        crisisSpan.end({ output: { outboundMessageId } })
        console.log('[agent] inbound crisis-safety reply sent', {
          agentRunId,
          outboundMessageId,
        })
        await captureCrisisSafetyReplySent({
          agentRunId,
          venueId: ctx.venue.id,
          guestId: ctx.guest.id,
          outboundMessageId,
          category: ctx.classification.category,
        })
        generatedBody = result.body
        trace.update({
          output: { status: 'sent', outboundMessageId, crisisSafety: true },
          content: { outboundDraft: result.body },
        })
        return { status: 'sent', outboundMessageId }
      } catch (e) {
        // scheduleAndSend already fired the appropriate stage-specific alert.
        const errMsg = e instanceof Error ? e.message : String(e)
        const stage: 'send' | 'persist' = errMsg.includes('persist failed') ? 'persist' : 'send'
        crisisSpan.end({ level: 'ERROR', statusMessage: errMsg, output: { stage } })
        return { status: 'failed', stage, error: errMsg }
      }
    }

    // TAC-380: persist intentions seen eligible for the first time this turn,
    // and move re-armed ones to their newer event's anchor.
    // Fire-and-forget like every intentions write; it can't affect the reply. A
    // failed write costs nothing lasting: the next turn derives the same
    // intention as newly eligible and writes it again.
    //
    // Placed AFTER classification and the crisis-safety return, and skipped on
    // opt_out, because an eligibility row starts that intention's expiry window.
    // Opening windows for a guest who just asked to stop being contacted, or on
    // a crisis turn, records intent to pursue them on exactly the turns nothing
    // should be pursued. Skipping loses nothing: eligibility re-derives from
    // live facts on the guest's next inbound. Event-armed intentions keep their
    // event as the anchor; first-contact ones anchor to whichever later turn
    // records them. A skipped re-arm leaves the older prompt standing until the
    // guest's next inbound re-arms it.
    if (
      ctx.intentionDerivation.newlyEligible.length > 0 &&
      ctx.classification.category !== 'opt_out'
    ) {
      waitUntil(
        recordIntentionEligibility({
          venueId: ctx.venue.id,
          guestId: ctx.guest.id,
          entries: ctx.intentionDerivation.newlyEligible,
        })
          .then((outcome) => {
            if (outcome.kind === 'failed') {
              console.warn('[agent] intention eligibility write failed (continuing)', {
                agentRunId,
                error: outcome.error,
              })
            }
          })
          .catch((e) => {
            console.error('[agent] recordIntentionEligibility threw unexpectedly', {
              agentRunId,
              error: e instanceof Error ? e.message : String(e),
            })
          }),
      )
    }

    // TAC-323: fire the self-reported-order extractor. Non-blocking by
    // design (waitUntil) — a slow or failed Haiku call must never delay or
    // block the reply. Consequence, deliberate: the extracted order is NOT
    // available to generateStage below, so the reply can't reference it.
    // Never throws; the module logs its own outcome. Placed post-classify,
    // pre-generate per the ticket's own sequencing.
    waitUntil(
      extractReportedOrder(ctx)
        .then((outcome) => {
          if (outcome.kind === 'recorded') {
            console.log('[agent] inbound self-reported order recorded', {
              agentRunId,
              transactionId: outcome.transactionId,
              amountCents: outcome.amountCents,
              itemCount: outcome.itemCount,
              // TAC-377: 'approximate' means this visit does NOT schedule
              // post_visit_* followups, so it's worth seeing in the log line.
              precision: outcome.precision,
            })
          } else if (outcome.kind === 'failed') {
            console.warn('[agent] inbound self-reported order extraction failed (continuing)', {
              agentRunId,
              error: outcome.error,
            })
          }
        })
        .catch((e) => {
          console.error('[agent] extractReportedOrder threw unexpectedly', {
            agentRunId,
            error: e instanceof Error ? e.message : String(e),
          })
        }),
    )

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

    // Retrieve knowledge (conditional). Inbound always fires per
    // shouldRetrieveKnowledge; degrades gracefully on Voyage / DB error so
    // the run can proceed without grounding.
    if (shouldRetrieveKnowledge(ctx)) {
      const knowledgeSpan = trace.span('retrieve_knowledge', {
        queryLength: ctx.currentMessage?.body.length ?? 0,
      })
      ctx.knowledgeCorpus = await retrieveKnowledgeStage(
        ctx,
        ctx.classification?.category ?? null,
        // TAC-367: the guest's own message. Explicit now — this path always
        // has one (shouldRetrieveKnowledge returns true precisely because
        // currentMessage is non-null), so the `?? ''` never fires here.
        ctx.currentMessage?.body ?? '',
      )
      knowledgeSpan.end({
        output: {
          matchCount: ctx.knowledgeCorpus.length,
          topSimilarity:
            ctx.knowledgeCorpus.length > 0
              ? Math.max(...ctx.knowledgeCorpus.map((c) => c.similarity))
              : 0,
        },
        content: trace.captureContent
          ? buildKnowledgeCorpusContent(ctx.knowledgeCorpus)
          : undefined,
      })
      console.log('[agent] inbound knowledge retrieved', {
        agentRunId,
        matchCount: ctx.knowledgeCorpus.length,
      })
    } else {
      ctx.knowledgeCorpus = []
    }

    // Generate
    const generateSpan = trace.span('generate', { category: ctx.classification.category })
    let gen = await generateStage(ctx, ctx.classification.category)
    if (gen.status === 'failed') {
      // TAC-309: retry once before giving up. generateMessage's internal
      // MAX_ATTEMPTS loop only covers fidelity and dash violations — a parse
      // throw exits it immediately, so this is genuinely a second call.
      //
      // EXCEPT on truncation. If the emission hit MAX_OUTPUT_TOKENS, a second
      // attempt runs into the same ceiling: it just doubles the wait for a
      // guest who is already getting no reply, and posts the truncation alert
      // twice. Go straight to the card.
      const truncated = gen.errorCode === AI_ERROR_TRUNCATED
      if (truncated) {
        console.warn('[agent] inbound generation truncated — skipping retry', {
          agentRunId,
          error: gen.error,
        })
      } else {
        console.warn('[agent] inbound generation failed, retrying once', {
          agentRunId,
          error: gen.error,
        })
        gen = await generateStage(ctx, ctx.classification.category)
      }
    }
    if (gen.status === 'failed') {
      generateSpan.end({ level: 'ERROR', statusMessage: gen.error })
      await fireRedAlert({
        agentRunId,
        venueId: ctx.venue.id,
        guestId: ctx.guest.id,
        kind: 'inbound',
        stage: 'generation',
        errorMessage: gen.error,
        extra: { retried: true },
      })
      // TAC-309: two failures in a row, and the guest is waiting. Route to
      // the operator queue instead of returning silence. A crash is
      // functionally "couldn't produce an answer" — the same condition
      // knowledge_gap already handles, on a surface that already exists, so
      // the card gets that whole mechanism: the timer, the holding message,
      // the eviction protection.
      //
      // TAC-364 splits the LABEL off that mechanism. The card now carries
      // review_reason='generation_failed' so the operator reads "something
      // went wrong writing this one" rather than a claim about what the guest
      // asked. Everything else is unchanged — see persistGenerationFailureCard
      // and isKnowledgeGapCard for why the split needed both predicates
      // widened to keep it.
      const card = await persistGenerationFailureCard(ctx, agentRunId)
      if (card.kind === 'carded') {
        trace.update({
          output: { status: 'queued', outboundMessageId: card.outboundMessageId, generationFailed: true },
        })
        return {
          status: 'queued',
          outboundMessageId: card.outboundMessageId,
          triggers: [GENERATION_FAILED_REVIEW_REASON],
          primaryTrigger: GENERATION_FAILED_REVIEW_REASON,
        }
      }
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

    // TAC-296: capture what the agent UNDERSTOOD from the inbound into
    // guests.context. Fires BEFORE the approval-policy gate so the write
    // happens regardless of whether the draft ships, queues, or refuses —
    // the agent's understanding of "Sarah is vegan" is valid either way.
    // Empty contextUpdate short-circuits with no DB hit, no Langfuse span,
    // no log noise. Failures log + continue; context-write is diagnostic,
    // not load-bearing. Never blocks dispatch.
    if (!isEmptyContextUpdate(gen.result.contextUpdate)) {
      const contextWriteSpan = trace.span('context_write', {
        tool: 'update_guest_context',
        hasStructured: gen.result.contextUpdate.structured !== undefined,
        hasObservation:
          gen.result.contextUpdate.observation !== undefined &&
          gen.result.contextUpdate.observation.trim().length > 0,
      })
      const writeResult = await updateGuestContext({
        guestId: ctx.guest.id,
        update: gen.result.contextUpdate,
        now: ctx.recognition.computedAt,
      })
      if (writeResult.ok) {
        contextWriteSpan.end({ output: writeResult.data })
        console.log('[agent] inbound context written', {
          agentRunId,
          guestId: ctx.guest.id,
          updatedFields: writeResult.data,
        })
      } else {
        contextWriteSpan.end({
          level: 'WARNING',
          statusMessage: writeResult.error,
          output: { errorCode: writeResult.errorCode },
        })
        console.warn('[agent] inbound context write failed (continuing)', {
          agentRunId,
          guestId: ctx.guest.id,
          error: writeResult.error,
          errorCode: writeResult.errorCode,
        })
      }
    }

    // TAC-297: dispatch arrival capture. Fires BEFORE the approval-policy
    // gate (mirrors the TAC-296 contextUpdate dispatch site) so the
    // transition + push happen regardless of whether the draft ships,
    // queues, or refuses. What the agent UNDERSTOOD from the inbound is
    // independent of what we SAID back. Imminent win → push fired
    // fire-and-forget via waitUntil. Imminent loss / scheduled / no-op →
    // logged but no push. Never throws.
    const arrival = await dispatchArrivalCapture({
      arrivalCapture: gen.result.arrivalCapture,
      now: ctx.recognition.computedAt,
    })
    if (arrival.kind === 'imminent_won') {
      const commitmentRow = arrival.commitmentRow
      console.log('[agent] inbound arrival imminent — transitioned to pending_ack', {
        agentRunId,
        commitmentId: commitmentRow.id,
      })
      waitUntil(
        sendCommitmentArrivalPush({
          commitmentId: commitmentRow.id,
          venueId: commitmentRow.venue_id,
          guestId: commitmentRow.guest_id,
          guestFirstName: ctx.guest.firstName,
          type: commitmentRow.type,
          code: commitmentRow.code,
          expectedArrival: commitmentRow.expected_arrival,
          arrivalSignal: 'imminent',
          venueTimezone: ctx.venue.timezone,
          agentRunId,
        }).catch((e) => {
          console.error('apns: sendCommitmentArrivalPush threw unexpectedly', {
            agentRunId,
            commitmentId: commitmentRow.id,
            error: e instanceof Error ? e.message : String(e),
          })
        }),
      )
    } else if (arrival.kind === 'scheduled_recorded') {
      console.log('[agent] inbound arrival scheduled — cron will fire at expected_arrival', {
        agentRunId,
        commitmentId: arrival.commitmentRow.id,
        expectedArrival: arrival.commitmentRow.expected_arrival,
      })
    } else if (arrival.kind === 'imminent_lost' || arrival.kind === 'scheduled_lost') {
      console.log('[agent] inbound arrival CAS lost (commitment already transitioned)', {
        agentRunId,
        kind: arrival.kind,
      })
    } else if (arrival.kind === 'invalid_signal') {
      console.warn('[agent] inbound arrival capture invalid', {
        agentRunId,
        reason: arrival.reason,
      })
    } else if (arrival.kind === 'failed') {
      console.warn('[agent] inbound arrival capture dispatch failed (continuing)', {
        agentRunId,
        error: arrival.error,
        errorCode: arrival.errorCode,
      })
    }

    // TAC-350: independent grounding backstop. Only ever calls the model when
    // the generation itself claimed confidence (knowledgeGap=false) on an
    // inbound, non-demo turn — see verifyGroundingStage for the full skip
    // list. Runs BEFORE the approval gate because its finding feeds directly
    // into the gate's own knowledge-gap-card handling (body blanking, clock
    // arming, protected-card carve-out) via the isGapTurn union of both
    // signals.
    //
    // TAC-355: verifyMechanicOfferStage runs alongside it via Promise.allSettled
    // — both are independent Haiku calls with no dependency on each other, so
    // running them sequentially would only add latency for a guest who's
    // waiting. allSettled, not all: verifyGroundingStage and
    // verifyMechanicOfferStage are both verified to never throw today (every
    // call inside each — the AI-module call and the PostHog/Slack capture —
    // is independently wrapped in its own try/catch and degrades to a safe
    // return value on failure), but that invariant lives in OTHER files. If a
    // future change to either ever violated it, Promise.all would let one
    // stage's rejection silently discard the other stage's finding — on the
    // one gate in this file required to fail closed, that is a fail-open by
    // accident. allSettled means a hypothetical future throw degrades to
    // exactly what that stage's own internal catch already returns for a
    // degraded call, instead of losing the sibling stage's result too.
    const verifySpan = trace.span('verify_grounding', { knowledgeGap: gen.result.knowledgeGap })
    const gatedMechanicCount = ctx.mechanics.filter((m) => m.requiresOperatorApproval).length
    const mechanicSpan = trace.span('verify_mechanic_offer', { gatedMechanicCount })
    const [groundingSettled, mechanicOfferSettled] = await Promise.allSettled([
      verifyGroundingStage(ctx, gen.result),
      verifyMechanicOfferStage(ctx, gen.result),
    ])
    if (groundingSettled.status === 'rejected') {
      console.warn('[agent] verifyGroundingStage threw unexpectedly (degrading to skipped)', {
        agentRunId,
        error:
          groundingSettled.reason instanceof Error
            ? groundingSettled.reason.message
            : String(groundingSettled.reason),
      })
    }
    if (mechanicOfferSettled.status === 'rejected') {
      console.warn(
        '[agent] verifyMechanicOfferStage threw unexpectedly (degrading to check_failed)',
        {
          agentRunId,
          error:
            mechanicOfferSettled.reason instanceof Error
              ? mechanicOfferSettled.reason.message
              : String(mechanicOfferSettled.reason),
        },
      )
    }
    // TAC-367: an unexpected THROW degrades to 'skipped', not 'truncated'.
    // The stage catches its own AI-call failures internally, so reaching here
    // means something structurally unexpected happened in our own code — not
    // evidence about the reply, and not the truncation case fail-closed was
    // narrowed to. Degrading to the fail-closed state on an unknown bug would
    // make any future throw here a silent fleet-wide queue flood.
    const groundingBackstop: GroundingBackstopResult =
      groundingSettled.status === 'fulfilled' ? groundingSettled.value : { status: 'skipped' }
    const mechanicOfferBackstop: MechanicOfferBackstopResult =
      mechanicOfferSettled.status === 'fulfilled'
        ? mechanicOfferSettled.value
        : { status: 'check_failed' }
    const groundingClaims =
      groundingBackstop.status === 'flagged' ? groundingBackstop.claims : []
    verifySpan.end({
      output: {
        ran: gen.result.knowledgeGap === false && ctx.guest.isDemo !== true,
        // TAC-367: `status` is the new load-bearing field — it distinguishes
        // a clean verdict from one that was never readable, which the old
        // boolean pair could not. Both kept so existing trace queries don't
        // break.
        status: groundingBackstop.status,
        hasUngroundedClaim: groundingBackstop.status === 'flagged',
        claimCount: groundingClaims.length,
      },
      content: trace.captureContent ? { ungroundedClaims: groundingClaims } : undefined,
    })
    mechanicSpan.end({ output: { status: mechanicOfferBackstop.status } })
    if (groundingBackstop.status === 'flagged') {
      console.warn('[agent] inbound grounding backstop caught an unverified claim', {
        agentRunId,
        claimCount: groundingBackstop.claims.length,
      })
    }
    if (groundingBackstop.status === 'truncated') {
      console.warn('[agent] inbound grounding backstop truncated — queuing (fail closed)', {
        agentRunId,
      })
    }
    if (mechanicOfferBackstop.status === 'flagged' || mechanicOfferBackstop.status === 'check_failed') {
      console.warn('[agent] inbound mechanic-offer backstop fired', {
        agentRunId,
        status: mechanicOfferBackstop.status,
      })
    }

    // TAC-212: approval-policy gate decides send vs. queue. Composable —
    // 4 triggers (fidelity_below_auto_send_floor, model_flagged,
    // comp_regex_backstop, previous_pending_held); any one queues.
    // TAC-297: 5th trigger commitment_type_gated also lands here.
    // TAC-350: 6th (independent) trigger knowledge_gap_backstop also lands
    // here, fed by groundingBackstop above.
    // TAC-355: 7th and 8th (self_talk_detected, mechanic_offer_backstop) also
    // land here, the latter fed by mechanicOfferBackstop above.
    // TAC-367: 9th (grounding_check_failed) also lands here, fed by the
    // 'truncated' state of the same groundingBackstop result.
    const approval = await applyApprovalPolicyStage(
      ctx,
      gen.result,
      groundingBackstop,
      mechanicOfferBackstop,
    )
    console.log('[agent] inbound approval decision', {
      agentRunId,
      action: approval.action,
      primaryTrigger: approval.action === 'queue' ? approval.primaryTrigger : null,
      triggers: approval.action === 'queue' ? approval.triggers : [],
      voiceFidelity: gen.result.voiceFidelity,
      modelRequiresApproval: gen.result.requiresOperatorApproval,
    })

    // A pending card holds this draft's slot and must not be overwritten
    // (decideSlotAction in ./pending-slots), so the draft is discarded. The
    // guest hears nothing on this turn. Two ways to get here on the inbound path:
    //   knowledge_gap_card_protected (TAC-308): a knowledge-gap card holds the
    //     slot and this turn queues for another reason. Losing the outstanding
    //     question is the worse outcome.
    //   obligation_slot_taken (TAC-394): the obligation slot holds a DIFFERENT
    //     commitment. The existing card wins, and the alert names both offers
    //     and the guest.
    if (approval.action === 'drop') {
      console.warn('[agent] inbound draft dropped: a pending card holds its slot', {
        agentRunId,
        reason: approval.reason,
        protectedDraftId: approval.protectedDraftId,
        triggers: approval.triggers,
      })
      await captureDraftDropped({
        agentRunId,
        venueId: ctx.venue.id,
        guestId: ctx.guest.id,
        guestFirstName: ctx.guest.firstName,
        guestPhone: ctx.guest.phoneNumber,
        reason: approval.reason,
        protectedDraftId: approval.protectedDraftId,
        protectedCommitment: approval.protectedCommitment,
        droppedCommitment: approval.droppedCommitment,
        triggers: approval.triggers,
        kind: 'inbound',
        category: ctx.classification.category,
        droppedBody: gen.result.body,
      })
      trace.update({
        output: {
          status: 'dropped',
          reason: approval.reason,
          protectedDraftId: approval.protectedDraftId,
          triggers: approval.triggers,
        },
        content: { droppedDraft: gen.result.body },
      })
      return {
        status: 'dropped',
        reason: approval.reason,
        protectedDraftId: approval.protectedDraftId,
        triggers: approval.triggers,
      }
    }

    // TAC-380 TRAP 4 / TAC-385 PR 1. ONE call, feeding BOTH branches below.
    //
    // This is the exact set buildAiRuntime rendered — never ctx.openIntentions.
    // When the classifier fails twice, recording closes everything it was
    // handed, so a wider set would close intentions suppressed this turn
    // (opt_out, a pending question) that the guest never saw.
    //
    // Hoisted above the queue/send fork by TAC-385 so that what a QUEUED draft
    // stores on messages.rendered_intentions and what an AUTO-SEND records are
    // the same value by construction rather than by two call sites agreeing.
    //
    // NAMING, because the variable reads as more than it is: this is the
    // RECORDABLE set, which is `renderableIntentions(...)` MINUS the opener
    // turn. buildAiRuntime still RENDERS intentions on an opener turn — only
    // recording is suppressed there. Consequence, unchanged from TAC-332 on the
    // auto-send path and now inherited by dispatch: an opener draft that
    // genuinely raises an intention and is then approved records nothing, and
    // the intention is asked again. That fails in the annoying-not-invisible
    // direction, which is the direction TAC-385 §4 chose.
    //
    // TAC-332: never on the true opener turn either. The opener tells the model
    // to greet and ask what they got (TAC-423) rather than raising a tracked
    // intention line, so the classifier there can only return a correct
    // negative or a destructive false positive. Reuses computeFirstTouchAfterQrScan, the
    // flag that renders the opener, so "is this the opener turn" can't diverge
    // between what renders it and what may record against it — and applying it
    // HERE means a queued opener draft stores nothing, so the dispatch path
    // inherits the guard without re-deriving it.
    const renderedIntentions = computeFirstTouchAfterQrScan(ctx, ctx.recognition.computedAt)
      ? []
      : renderableIntentions(
          ctx.openIntentions,
          ctx.classification.category,
          ctx.pendingQuestion !== null,
        )

    if (approval.action === 'queue') {
      const queueSpan = trace.span('queue', {
        primaryTrigger: approval.primaryTrigger,
        triggerCount: approval.triggers.length,
        // TAC-264: surfaces inserted vs. regenerated on the trace.
        existingPendingDraftId: approval.existingPendingDraftId,
      })
      try {
        const persistResult = await persistOrRegenQueuedDraft(
          ctx,
          gen.result,
          approval.primaryTrigger,
          approval.existingPendingDraftId,
          // TAC-308: set only when this draft is becoming a knowledge-gap
          // card that doesn't already have a clock. Undefined preserves an
          // existing pending_until on regen and leaves the column null
          // otherwise — see applyApprovalPolicyStage for the full table.
          // TAC-309: blankBody discards the model's attempted answer on a
          // knowledge-gap card so the operator types rather than swipes.
          // TAC-364: the full trigger set and the verifier's flagged claims,
          // so a co-firing turn reaches the operator with more than the one
          // priority-selected label.
          // TAC-394: callerPolicy 'regen' is the gate's own policy, stated so
          // a 23505 recovery decides a card the gate never saw the same way.
          {
            pendingUntil: approval.pendingUntil,
            blankBody: approval.blankBody,
            reviewTriggers: approval.triggers,
            ungroundedClaims: approval.ungroundedClaims,
            callerPolicy: 'regen',
            // TAC-385 PR 1: carry the rendered set onto the card so
            // dispatchOperatorOutbound can record the ask if an operator
            // approves or edits it. Nulled by the persist layer under
            // blankBody.
            renderedIntentions,
          },
        )
        if (persistResult.action === 'dropped') {
          // TAC-394: race recovery found a card in this draft's slot that the
          // gate never saw and that must not be overwritten. Reported exactly
          // as a gate-time drop, because to the guest and the operator it is one.
          queueSpan.end({
            output: {
              persistAction: 'dropped',
              reason: persistResult.reason,
              protectedDraftId: persistResult.protectedDraftId,
            },
          })
          console.warn('[agent] inbound draft dropped in race recovery: a pending card took its slot', {
            agentRunId,
            reason: persistResult.reason,
            protectedDraftId: persistResult.protectedDraftId,
          })
          await captureDraftDropped({
            agentRunId,
            venueId: ctx.venue.id,
            guestId: ctx.guest.id,
            guestFirstName: ctx.guest.firstName,
            guestPhone: ctx.guest.phoneNumber,
            reason: persistResult.reason,
            protectedDraftId: persistResult.protectedDraftId,
            protectedCommitment: persistResult.protectedCommitment,
            droppedCommitment: persistResult.droppedCommitment,
            triggers: approval.triggers,
            kind: 'inbound',
            category: ctx.classification.category,
            // TAC-309: never republish a discarded guess.
            droppedBody: approval.blankBody ? '' : gen.result.body,
          })
          trace.update({
            output: {
              status: 'dropped',
              reason: persistResult.reason,
              protectedDraftId: persistResult.protectedDraftId,
              triggers: approval.triggers,
            },
          })
          return {
            status: 'dropped',
            reason: persistResult.reason,
            protectedDraftId: persistResult.protectedDraftId,
            triggers: approval.triggers,
          }
        }
        const { outboundMessageId, action: persistAction, priorReviewReason } = persistResult
        queueSpan.end({
          output: {
            outboundMessageId,
            primaryTrigger: approval.primaryTrigger,
            triggers: approval.triggers,
            persistAction,
            priorReviewReason,
            bodyLength: approval.blankBody ? 0 : gen.result.body.length,
          },
          content: { body: approval.blankBody ? '' : gen.result.body },
        })
        console.log(
          persistAction === 'updated'
            ? '[agent] inbound regenerated existing pending draft'
            : '[agent] inbound queued for review',
          {
            agentRunId,
            outboundMessageId,
            primaryTrigger: approval.primaryTrigger,
            triggers: approval.triggers,
            persistAction,
            priorReviewReason,
          },
        )
        // TAC-264: route to the appropriate analytics event based on whether
        // the persist layer regenerated an existing row (UPDATE) or created
        // a fresh one (INSERT, possibly via 23505 race-recovery from another
        // concurrent inbound).
        if (persistAction === 'updated') {
          await captureDraftRegenerated({
            agentRunId,
            venueId: ctx.venue.id,
            guestId: ctx.guest.id,
            originalDraftId: outboundMessageId,
            triggers: approval.triggers,
            primaryTrigger: approval.primaryTrigger,
            priorReviewReason,
            voiceFidelity: gen.result.voiceFidelity,
            modelRequiresApproval: gen.result.requiresOperatorApproval,
            modelApprovalReason: gen.result.approvalReason,
            compRegexMatchedPattern: approval.compMatchedPattern,
            kind: 'inbound',
            category: ctx.classification.category,
            inboundBody: ctx.currentMessage?.body ?? null,
            // TAC-309: a blanked card has no draft. Publishing the discarded
            // guess here would put the sentence this ticket removed into
            // Slack under a field labelled "draft" — for a row whose body is
            // empty.
            generatedBody: approval.blankBody ? '' : gen.result.body,
          })
        } else {
          await captureDraftQueued({
            agentRunId,
            venueId: ctx.venue.id,
            guestId: ctx.guest.id,
            triggers: approval.triggers,
            primaryTrigger: approval.primaryTrigger,
            voiceFidelity: gen.result.voiceFidelity,
            modelRequiresApproval: gen.result.requiresOperatorApproval,
            modelApprovalReason: gen.result.approvalReason,
            compRegexMatchedPattern: approval.compMatchedPattern,
            hasPreviousPending: approval.triggers.includes(
              APPROVAL_TRIGGERS.PREVIOUS_PENDING_HELD,
            ),
            slot: approval.slot,
            otherSlotOccupied: approval.otherSlotOccupied,
            kind: 'inbound',
            category: ctx.classification.category,
            inboundBody: ctx.currentMessage?.body ?? null,
            // TAC-309: see above — never republish a discarded guess.
            generatedBody: approval.blankBody ? '' : gen.result.body,
          })
        }
        // TAC-207: fire APNs push to every operator whose allowlist covers
        // this venue. waitUntil composes with the webhook's outer keep-alive
        // window — push never blocks the agent's return. Helper filters
        // primaryTrigger internally (model_flagged / comp_regex_backstop /
        // fidelity_below_auto_send_floor fire; previous_pending_held skips)
        // and is `never throws` so the .catch is defensive belt-and-braces.
        if (shouldSendDraftFlaggedPush(approval.primaryTrigger)) {
          waitUntil(
            sendDraftFlaggedPush({
              agentRunId,
              venueId: ctx.venue.id,
              guestId: ctx.guest.id,
              guestFirstName: ctx.guest.firstName,
              draftId: outboundMessageId,
              primaryTrigger: approval.primaryTrigger,
            }).catch((e) => {
              console.error('apns: sendDraftFlaggedPush threw unexpectedly', {
                agentRunId,
                draftId: outboundMessageId,
                error: e instanceof Error ? e.message : String(e),
              })
            }),
          )
        }
        trace.update({
          output: {
            status: 'queued',
            outboundMessageId,
            primaryTrigger: approval.primaryTrigger,
            voiceFidelity: gen.result.voiceFidelity,
            persistAction,
          },
          content: { outboundDraft: gen.result.body },
        })
        return {
          status: 'queued',
          outboundMessageId,
          triggers: approval.triggers,
          primaryTrigger: approval.primaryTrigger,
        }
      } catch (e) {
        // persistOrRegenQueuedDraft already fired a red alert.
        const errMsg = e instanceof Error ? e.message : String(e)
        queueSpan.end({ level: 'ERROR', statusMessage: errMsg, output: { stage: 'persist' } })
        return { status: 'failed', stage: 'persist', error: errMsg }
      }
    }

    // Send + persist. TAC-284: demo guests skip the read receipt and typing
    // indicators (TAC-421 removed the pre-send sleep this also used to skip)
    // and, when applyApprovalPolicyStage short-circuited the gate, the send is
    // stamped review_reason='demo_bypass' (approval.reason is undefined on a
    // normal untriggered send).
    const sendSpan = trace.span('send', { bodyLength: gen.result.body.length })
    try {
      const dispatched = await dispatchReply(ctx, gen.result, {
        skipHumanFeelDelay: ctx.guest.isDemo === true,
        reviewReason: approval.reason,
        // TAC-436 ruling 4: the SAME hoisted value the queue branch stores
        // and this branch records against, so what a card carries and what
        // an auto-send carries cannot drift. Audit only on this path — the
        // recording below is what actually closes the intentions.
        renderedIntentions,
        // TAC-469: the Instagram reply check. If this message already has an
        // answer (usually one staff typed in the Instagram app), send nothing.
        // Ignored on the text arm.
        replyCheck: { inboundMessageId: ctx.currentMessage.id },
        onUndelivered: 'card',
      })
      if (dispatched.kind !== 'sent') {
        sendSpan.end({ level: 'WARNING', output: { outcome: dispatched.kind } })
        trace.update({ output: { status: dispatched.kind } })
        return undeliveredAgentResult(ctx, dispatched)
      }
      const { outboundMessageId, providerMessageId, generationId, bubbleCount } = dispatched
      if (dispatched.undelivered !== null) {
        // Part of a split Instagram reply went out; the rest became a card (or
        // couldn't, and the Slack event says why).
        console.warn('[agent] inbound reply partly delivered', {
          agentRunId,
          outboundMessageId,
          reason: dispatched.undelivered.reason,
          cardId: dispatched.undelivered.cardId,
        })
        if (dispatched.undelivered.cardId !== null) pushSendFailureCard(ctx, dispatched.undelivered.cardId)
      }
      sendSpan.end({
        output: {
          outboundMessageId,
          providerMessageId,
          bodyLength: gen.result.body.length,
          // TAC-313: how many messages this response actually became. 1 is the
          // common case; >1 means the model split.
          generationId,
          bubbleCount,
        },
        content: { body: gen.result.body },
      })
      // TAC-324 / TAC-380: close the intentions this send raised. Fire-and-
      // forget, mirroring extractReportedOrder's waitUntil posture: it never
      // blocks the reply. Uses the SENT body.
      //
      // TAC-385 PR 1: `renderedIntentions` is computed ONCE above the
      // queue/send fork and used by both, so an auto-send records exactly the
      // set a queued draft would have stored. The operator-approved and
      // operator-edited paths record the same way now, from
      // dispatchOperatorOutbound — that was TAC-391's gap, 13 of 34 sent
      // replies at Le Mil's in the 30 days to 2026-09-14.
      //
      // See the hoisted declaration for trap 4 and the TAC-332 opener guard.
      if (renderedIntentions.length > 0) {
        const venueId = ctx.venue.id
        const guestId = ctx.guest.id
        const messageId = outboundMessageId
        waitUntil(
          recordIntentionPrompts({
            venueId,
            guestId,
            messageId,
            // TAC-469: what REACHED the guest, which is the whole reply unless
            // a later Instagram message failed. Recording an ask that sat in an
            // undelivered message would close an intention the guest never saw.
            sentBody: dispatched.deliveredBody,
            openIntentions: renderedIntentions,
            now: new Date(),
          })
            .then(async (outcome) => {
              if (outcome.kind === 'recorded') {
                console.log('[agent] inbound intention prompts recorded', {
                  agentRunId,
                  raisedKeys: outcome.raisedKeys,
                  classifierAttempts: outcome.classifierAttempts,
                })
                // TAC-436 ruling 5: a successful raise was a console.log and
                // nothing else, so "zero intentions have ever been raised" was
                // invisible for the whole life of the feature. `offeredKeys` is
                // the rendered set, not ctx.openIntentions — the same value the
                // classifier was given, so the event cannot claim a door was
                // open that this turn suppressed.
                await captureIntentionPromptRaised({
                  agentRunId,
                  via: 'auto_send',
                  venueId,
                  guestId,
                  messageId,
                  raisedKeys: outcome.raisedKeys,
                  offeredKeys: renderedIntentions.map((o) => o.key),
                  classifierAttempts: outcome.classifierAttempts,
                  sentBody: dispatched.deliveredBody,
                })
              } else if (outcome.kind === 'closed_pessimistically') {
                // Ruling 4: nothing re-asks, but these closed without a
                // verdict. Alerted so a run of them is visible.
                console.warn('[agent] intention classifier failed twice; rendered intentions closed', {
                  agentRunId,
                  closedKeys: outcome.closedKeys,
                  error: outcome.classifierError,
                })
                await captureIntentionPromptRecordingFailed({
                  agentRunId,
                  via: 'auto_send',
                  venueId,
                  guestId,
                  messageId,
                  outcome: 'closed_pessimistically',
                  keys: outcome.closedKeys,
                  error: outcome.classifierError,
                })
              } else if (outcome.kind === 'write_failed') {
                // The one remaining path to a genuine re-ask. Before TAC-380
                // this was a bare console.warn.
                console.warn('[agent] intention prompt write failed', {
                  agentRunId,
                  keys: outcome.keys,
                  source: outcome.source,
                  error: outcome.error,
                })
                await captureIntentionPromptRecordingFailed({
                  agentRunId,
                  via: 'auto_send',
                  venueId,
                  guestId,
                  messageId,
                  outcome: 'write_failed',
                  keys: outcome.keys,
                  source: outcome.source,
                  error: outcome.error,
                })
              }
            })
            .catch((e) => {
              console.error('[agent] recordIntentionPrompts threw unexpectedly', {
                agentRunId,
                error: e instanceof Error ? e.message : String(e),
              })
            }),
        )
      }
      console.log('[agent] inbound sent + persisted', {
        agentRunId,
        outboundMessageId,
        providerMessageId,
        generationId,
        bubbleCount,
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
