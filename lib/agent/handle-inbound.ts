import { randomUUID } from 'node:crypto'
import { waitUntil } from '@vercel/functions'
import {
  isAgentLatencyHigh,
  captureAgentLatencyHigh,
  captureCrisisSafetyReplySent,
  captureDraftDropped,
  captureDraftQueued,
  captureDraftRegenerated,
  captureIntentionPromptRaised,
  captureIntentionPromptRecordingFailed,
  captureReviewAskRaised,
  captureReviewAskSent,
  captureWarmCloseSent,
} from '@/lib/analytics/posthog'
import { createAdminClient } from '@/lib/db/admin'
import { isEmptyContextUpdate, updateGuestContext } from '@/lib/guests/context'
import {
  clearOptOut,
  decideOptOutTurn,
  readOptedOut,
  recordOptOut,
} from '@/lib/guests/opt-out'
import { sendCommitmentArrivalPush } from '@/lib/notifications/send-commitment-push'
import {
  sendDraftFlaggedPush,
  shouldSendDraftFlaggedPush,
} from '@/lib/notifications/send'
import { startAgentTrace, toAgentUsage } from '@/lib/observability'
import { resolveCancellation } from '@/lib/schemas/guest-commitment'
import { parseMessageChannel } from '@/lib/schemas/message-channel'
import { capturePostHogEvent, fireRedAlert } from './alerts'
import { buildRuntimeContext } from './build-runtime-context'
import {
  INBOUND_COALESCING_ENABLED,
  defaultCoalesceDeps,
  findUncoveredInbound,
  mayExtend,
  newInboundTurnState,
  shouldRetryTurn,
  openCoalescedTurn,
  releaseInboundTurn,
  type CoalesceDeps,
  type InboundTurnState,
} from './coalesce-turn'
import {
  buildCrisisSafetyResult,
  CRISIS_SAFETY_REVIEW_REASON,
} from './crisis-safety'
import { dispatchArrivalCapture } from './dispatch-arrival-capture'
import {
  anyKnowledgeGapCard,
  decideSlotAction,
  EMPTY_PENDING_ROWS,
  loadPendingRowsBySlot,
} from './pending-slots'
import { extractReportedOrder } from './extract-reported-order'
import { retractReportedVisits } from './retract-reported-visit'
import {
  MEDIA_ONLY_SETTLE_MS,
  MEDIA_ONLY_SETTLE_POLL_MS,
  isMediaOnly,
  loadTurnMediaRows,
  mediaAlongsideText,
  resolveMediaOnlyTurn,
} from './inbound-media'
import {
  bodyContainsReviewLink,
  deriveReviewAsk,
  markReviewAsked,
} from './review-ask'
import { scheduleInquiryFollowup } from './schedule-inquiry-followup'
import { renderableIntentions } from './intentions/derive'
import {
  recordIntentionEligibility,
  recordIntentionPrompts,
} from './intentions/record'
import {
  loadWarmCloseBlocker,
  markWarmCloseSent,
  releaseWarmCloseClaim,
} from './warm-close-store'
import {
  classifyCheckinAnswer,
  isAwaitingCheckinAnswer,
  isCheckbackTooLate,
  nextCheckinAnswer,
  orderTurnVerdict,
  owesCheckback,
} from './visit-checkin'
import {
  claimVisitCheckback,
  recordVisitCheckinAnswer,
  recordVisitCheckinAsked,
} from './visit-checkin-store'
import { closesFirstConversation, SIGN_OFF_CATEGORY } from './warm-close'
import { recordInboundTurnOutcome } from './record-inbound-turn-outcome'
import { isVenueProcessingHalted } from '@/lib/venues/status'
import { persistOrRegenQueuedDraft } from './schedule-and-send'
import { dispatchReply, type DispatchReplyOutcome } from './dispatch-reply'
import { signalTyping } from './typing-indicator'
import { INSTAGRAM_SEND_FAILED_REVIEW_REASON } from './dispatch-instagram-reply'
import {
  applyApprovalPolicyStage,
  APPROVAL_TRIGGERS,
  classifyStage,
  generateStage,
  GENERATION_FAILED_REVIEW_REASON,
  MEDIA_ONLY_REVIEW_REASON,
  KNOWLEDGE_GAP_WINDOW_MS,
  mayAutoSendAfterClassification,
  retrieveCorpusStage,
  retrieveKnowledgeWithContextStage,
  shouldRetrieveKnowledge,
} from './stages'
import { runPostSendChecks } from './post-send-checks'
import { buildContextQuery } from './retrieval-context'
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

/**
 * TAC-529: the venue's own `venues.status`, for the halt gate below.
 *
 * A read of its own rather than a field on RuntimeContext, because the gate
 * has to run BEFORE buildRuntimeContext. That is not a preference: context
 * build calls `computeGuestState`, which writes `guest_states` and an audit
 * row on a band change. A venue that has been switched off should not still
 * be accumulating recognition state, so the cheapest correct place is here,
 * one indexed lookup by primary key, before any of the expensive steps.
 *
 * FAILS OPEN, ON BOTH FAILURE SHAPES. A read that did not complete has
 * established nothing, and going silent on a live venue because of a database
 * blip is the worse of the two failures — the same direction
 * `isVenueProcessingHalted` takes for a value it cannot read.
 *
 * THE TRY/CATCH IS THE HALF THAT WAS MISSING, and the docstring claimed it
 * before the code did. supabase-js returns most failures as `{ error }`, but a
 * socket reset, an aborted fetch or `createAdminClient()` throwing on a
 * missing env var THROWS — and an unguarded throw here propagates to
 * `runInboundTurn`'s catch, which red-alerts and returns `failed`, leaving the
 * guest with nothing. Measured, not reasoned about: a rejecting read produced
 * `{status:'failed', stage:'context_build'}` before this was added. Same shape
 * and same fix as `loadInboundIdentity` in `record-inbound-turn-outcome.ts`.
 */
async function loadVenueStatus(venueId: string): Promise<string | null> {
  try {
    const supabase = createAdminClient()
    const { data, error } = await supabase
      .from('venues')
      .select('status')
      .eq('id', venueId)
      .maybeSingle()
    if (error) {
      console.warn('[agent] venue status read failed, proceeding', {
        venueId,
        error: error.message,
      })
      return null
    }
    return data?.status ?? null
  } catch (e) {
    console.warn('[agent] venue status read threw, proceeding', {
      venueId,
      error: e instanceof Error ? e.message : String(e),
    })
    return null
  }
}

async function loadInbound(messageId: string): Promise<{
  message: InboundMessage
  // TAC-574: beside the message rather than on InboundMessage, because only
  // this file reads it (lib/agent/inbound-media.ts decides what it means) and
  // InboundMessage is constructed at thirty sites that have no media.
  mediaUrls: string[]
  guestId: string
  venueId: string
}> {
  const supabase = createAdminClient()
  const { data, error } = await supabase
    .from('messages')
    .select(
      'id, body, media_urls, provider_message_id, created_at, venue_id, guest_id, direction, channel, referral_source',
    )
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
    throw new Error(
      `loadInbound: message ${messageId} has no provider_message_id`,
    )
  }
  return {
    message: {
      id: data.id,
      providerMessageId: data.provider_message_id,
      body: data.body,
      receivedAt: new Date(data.created_at),
      // TAC-495: picks the prompt copy, through resolveConversationChannel.
      channel: parseMessageChannel(data.channel),
      // TAC-518: this turn's scan signal, read by buildRuntimeContext. Raw, so
      // isScanReferral stays the single place that decides what counts.
      referralSource: data.referral_source,
    },
    mediaUrls: data.media_urls ?? [],
    guestId: data.guest_id,
    venueId: data.venue_id,
  }
}

async function findExistingReply(
  inboundMessageId: string,
): Promise<string | null> {
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
 *     Except on the opt_out turn itself (TAC-572): its confirmation is owed.
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
): Promise<
  { kind: 'carded'; outboundMessageId: string } | { kind: 'skipped' }
> {
  try {
    const supabase = createAdminClient()
    const { data: guestRow } = await supabase
      .from('guests')
      .select('opted_out_at')
      .eq('id', ctx.guest.id)
      .maybeSingle()
    // TAC-572: an opt_out turn records the opt-out BEFORE it generates, so
    // this read is true on the very turn whose confirmation just failed. That
    // guest is still owed the confirmation, and the card is the only way an
    // operator learns it did not go; dispatchOperatorOutbound lets an
    // opt_out-category card through for the same reason.
    if (guestRow?.opted_out_at && ctx.classification?.category !== 'opt_out') {
      console.warn(
        '[agent] generation-failure card skipped — guest opted out',
        {
          agentRunId,
          guestId: ctx.guest.id,
        },
      )
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
      (await loadPendingRowsBySlot(ctx.venue.id, ctx.guest.id)) ??
      EMPTY_PENDING_ROWS
    const slotDecision = decideSlotAction({
      rows: pendingRows,
      draftCommitment: null,
      isGapTurn: true,
      checkDidNotComplete: false,
      callerPolicy: 'regen_gap_card_only',
      // TAC-397: no guest inbound on this path, so nothing can be correcting
      // a pending reply. The `regen` policy is the only one that reads this.
      conversationDisposition: null,
    })
    if (slotDecision.action === 'drop') {
      console.warn(
        '[agent] generation-failure card skipped — a non-gap pending draft holds the slot',
        {
          agentRunId,
          guestId: ctx.guest.id,
          protectedDraftId: slotDecision.protectedDraftId,
        },
      )
      return { kind: 'skipped' }
    }
    const existingId =
      slotDecision.action === 'regen' ? slotDecision.draftId : null

    // Arm a new deadline only when no knowledge-gap card sits in EITHER slot,
    // so a crash can't push out a deadline that's already running or start a
    // second holding message.
    //
    // TAC-484: this is NO LONGER the same rule the gate applies. The gate is
    // now strictly narrower (knowledgeGapFired AND the inbound reads as a
    // question AND no gap card in either slot); this site applies only the
    // last of those three, so a crash on a STATEMENT inbound still arms a
    // clock where the gate would not. Left alone deliberately rather than
    // silently: the ruling is about the holding message, that mechanism is
    // disabled, and if it is ever re-enabled loadInboundQuestion is a second
    // gate that returns null for a statement, so the card counts `invalid`
    // and the clock is cleared without a message going out. Narrowing this
    // site to match belongs with whichever ticket re-enables the holding
    // message, where the behaviour can actually be observed.
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
        {
          agentRunId,
          guestId: ctx.guest.id,
          protectedDraftId: persisted.protectedDraftId,
        },
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
    if (
      persisted.action === 'silenced' ||
      persisted.outboundMessageId === null
    ) {
      // TAC-397: unreachable — a crash card uses regen_gap_card_only, which
      // never silences. Handled because that guarantee lives in
      // pending-slots.ts and a null id typed `string` is the bug nobody finds
      // until a card has no id.
      console.warn('[agent] generation-failure card came back with no id', {
        agentRunId,
        guestId: ctx.guest.id,
      })
      return { kind: 'skipped' }
    }
    // shouldSendDraftFlaggedPush fails OPEN on any value outside PUSH_POLICY's
    // total map, so `generation_failed` pushes — which is what this card wants
    // (nobody is coming to look at it otherwise).
    if (shouldSendDraftFlaggedPush(GENERATION_FAILED_REVIEW_REASON)) {
      waitUntil(
        sendDraftFlaggedPush({
          agentRunId,
          venueId: ctx.venue.id,
          guestId: ctx.guest.id,
          guestFirstName: ctx.guest.firstName,
          draftId: persisted.outboundMessageId,
          primaryTrigger: GENERATION_FAILED_REVIEW_REASON,
          // TAC-532. Classification is non-null on this path in practice:
          // persistGenerationFailureCard has one call site, after generateStage,
          // which classification has already succeeded to reach (see the note
          // above). The `?? null` is defensive only, and null suppresses the
          // quote, which is the safe direction. An earlier version of this
          // comment claimed classify itself could have failed here; that is
          // false for this call site and contradicted the note 30 lines up.
          guestQuestion: ctx.currentMessage?.body ?? null,
          guestCategory: ctx.classification?.category ?? null,
          guestIsCrisis: ctx.classification?.crisisSafety ?? false,
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
 * TAC-574: a turn with media and no text at all becomes a blank card the owner
 * answers by hand (ruled 2026-10-06, both channels). Nothing was classified or
 * generated, so there is no draft and no category: the card is written
 * directly, the way the crash card is, with the same synthetic generation
 * standing in for one that never happened.
 *
 * ITS OWN CARD, always: `own_card`, keyed to the inbound message by migration
 * 054's index. It never regenerates or overwrites a card already waiting,
 * because a photo is not a correction to anything. A duplicate delivery of
 * the same message collides on that index and is reported as the card that
 * already exists (persistOrRegenQueuedDraft's own-draft recovery).
 *
 * OPT-OUT (ruled 2026-10-06, revising the same day's earlier ruling): a
 * message with media and no text NEVER opts an opted-out guest back in, on
 * either channel. Only a typed message does, through TAC-572's path
 * (lib/guests/opt-out.ts), which reads a category this turn does not have.
 *   - text: an opted-out guest gets no card and hears nothing. runInboundTurn
 *     decides that before it calls this, so this function never sees one.
 *   - Instagram: the card is still written, and `opted_out_at` is left set.
 *     That covers a thumbs-up GIF after the confirmation and a story tag, which
 *     arrive here looking exactly like a photo and are not the guest writing.
 *
 * CONSEQUENCE, stated because nothing else says it: the operator's send on
 * that Instagram card is refused (`opted_out` in dispatchOperatorOutbound)
 * until the guest types something. The card tells the owner the guest sent
 * something; it cannot be answered from the app while the opt-out stands.
 *
 * Never throws. A card that cannot be written is a `failed` turn, which the
 * turn retries once.
 */
async function persistMediaOnlyCard(
  ctx: RuntimeContext,
  agentRunId: string,
): Promise<AgentResult> {
  try {
    const persisted = await persistOrRegenQueuedDraft(
      ctx,
      buildGenerationFailureGeneration(),
      MEDIA_ONLY_REVIEW_REASON,
      null,
      { blankBody: true, conversationDisposition: 'own_card' },
    )
    if (persisted.outboundMessageId === null) {
      // Unreachable: `own_card` never silences. Handled for the reason the
      // crash card gives, a null id typed `string` is found too late.
      return {
        status: 'failed',
        stage: 'persist',
        error: 'media-only card came back with no id',
      }
    }
    console.log('[agent] media-only inbound carded for the operator', {
      agentRunId,
      outboundMessageId: persisted.outboundMessageId,
    })
    await captureDraftQueued({
      agentRunId,
      venueId: ctx.venue.id,
      guestId: ctx.guest.id,
      triggers: [MEDIA_ONLY_REVIEW_REASON],
      primaryTrigger: MEDIA_ONLY_REVIEW_REASON,
      modelRequiresApproval: false,
      modelApprovalReason: '',
      compRegexMatchedPattern: null,
      hasPreviousPending: false,
      slot: 'conversation',
      otherSlotOccupied: false,
      kind: 'inbound',
      // Nothing was classified. 'unknown' satisfies the non-null contract
      // without inventing a category, as on the crash card.
      category: 'unknown',
      inboundBody: null,
      generatedBody: '',
    })
    pushOperatorCard(ctx, persisted.outboundMessageId, MEDIA_ONLY_REVIEW_REASON)
    return {
      status: 'queued',
      outboundMessageId: persisted.outboundMessageId,
      triggers: [MEDIA_ONLY_REVIEW_REASON],
      primaryTrigger: MEDIA_ONLY_REVIEW_REASON,
    }
  } catch (e) {
    // persistOrRegenQueuedDraft already fired a red alert.
    return {
      status: 'failed',
      stage: 'persist',
      error: e instanceof Error ? e.message : String(e),
    }
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
    cancelsCommitmentId: '',
    // TAC-554: the crash card. Generation failed, so there is no
    // getting-to-know-you question, and the card is blank anyway.
    intentionQuestion: '',
    // Generation failed, so no review ask either; stated rather than omitted.
    reviewAsk: '',
    // TAC-560: the crash card is a blank draft for an operator, not a close.
    closedTheConversation: false,
    // TAC-573: no generation behind this, so nothing is being corrected.
    reportedVisitCorrection: 'none',
    intentionQuestionDuplicateStripped: false,
    // TAC-567: this path composes no question, so the gate never fired.
    intentionQuestionDroppedForBodyQuestion: false,
    askDroppedForVisitCorrection: false,
    // This path composes no review ask, so that gate never fired either.
    reviewAskDroppedForBodyQuestion: false,
    attempts: 2,
    attemptHistory: [],
    systemPrompt: '',
    userPrompt: '',
    conversation: '',
    promptVersion: PROMPT_VERSION,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
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
/**
 * TAC-568: a warm close this turn owns, and the text it will send.
 *
 * `null` everywhere else, which is the ordinary case: the guest is not closing a
 * first conversation, or another path already closed them.
 */
interface ClaimedWarmClose {
  /** The venue's fixed text, byte for byte as the setting holds it. */
  text: string
  /** The guest whose one close this is. */
  guestId: string
  /** The timestamp written into the marker, so a release can scope to it. */
  claimedAt: Date
}

/**
 * Take this guest's one warm close, or find it already taken.
 *
 * markWarmCloseSent is a CAS (`... where warm_close_sent_at is null`), so
 * `already_marked` is the answer for a guest the pause timer closed ten minutes
 * ago, or one this venue closed on an earlier turn. Either way no second close
 * goes out, and that is the acceptance criterion: delete the `already_marked`
 * branch and a guest can be closed twice.
 *
 * FAILS CLOSED. A marker write that errors returns null, so the bubble is NOT
 * appended. The alternative — sending on an unknown marker state — is the one
 * outcome this mechanism is built to avoid. For an Instagram guest the pause
 * timer will try again inside its own window; for an SMS guest there is no
 * second attempt, and failing closed is still right, because
 * a duplicated close is worse than a missing one (TAC-569).
 */
async function claimWarmCloseForTurn(
  ctx: RuntimeContext,
  agentRunId: string,
): Promise<ClaimedWarmClose | null> {
  // TAC-575: the check-back comes before the close. A guest who says "thanks!"
  // while their visit is still owed one is not closed on this turn; the timer
  // checks back if they stay quiet, and the pause timer closes after that. The
  // pause timer applies the same order (`checkback_pending`).
  if (
    ctx.visitCheckin !== null &&
    ctx.visitCheckinHold &&
    owesCheckback(ctx.visitCheckin) &&
    !isCheckbackTooLate(ctx.visitCheckin.orderedAt, new Date())
  ) {
    console.log('[agent] warm close not sent on this turn', {
      agentRunId,
      guestId: ctx.guest.id,
      reason: 'checkback_pending',
    })
    return null
  }

  // TAC-575 (ruled 2026-10-06): no automated close where staff answered by hand
  // or the conversation contains a complaint. The pause timer runs the same
  // check through the same function. BEFORE the marker write, because the
  // marker is what spends the guest's one close. An unreadable thread fails
  // closed, like everything else here.
  const supabase = createAdminClient()
  const blocker = await loadWarmCloseBlocker(
    supabase,
    ctx.venue.id,
    ctx.guest.id,
    ctx.guest.firstContactedAt ?? ctx.guest.createdAt,
  ).catch((e: unknown) => ({
    ok: false as const,
    error: e instanceof Error ? e.message : String(e),
  }))
  if (!blocker.ok || blocker.data !== null) {
    console.log('[agent] warm close not sent on this turn', {
      agentRunId,
      guestId: ctx.guest.id,
      reason: blocker.ok ? blocker.data : 'thread_unreadable',
      ...(blocker.ok ? {} : { error: blocker.error }),
    })
    return null
  }

  const claimedAt = new Date()
  const marked = await markWarmCloseSent(
    supabase,
    ctx.guest.id,
    claimedAt,
  ).catch((e: unknown) => ({
    ok: false as const,
    error: e instanceof Error ? e.message : String(e),
  }))

  if (!marked.ok) {
    console.warn('[agent] warm close marker write failed; not closing', {
      agentRunId,
      guestId: ctx.guest.id,
      error: marked.error,
    })
    return null
  }
  if (marked.data === 'already_marked') {
    console.log(
      '[agent] warm close already sent to this guest; not repeating',
      {
        agentRunId,
        guestId: ctx.guest.id,
      },
    )
    return null
  }
  return { text: ctx.venue.warmCloseText, guestId: ctx.guest.id, claimedAt }
}

/**
 * Give back a claim whose close never reached the guest.
 *
 * Scoped to the exact timestamp this turn wrote (releaseWarmCloseClaim's own
 * guard), so it can never clear a marker the timer set in between. A no-op when
 * nothing was claimed.
 */
async function releaseClaimedWarmClose(
  claimed: ClaimedWarmClose | null,
  agentRunId: string,
): Promise<void> {
  if (claimed === null) return
  console.warn('[agent] warm close did not reach the guest; claim released', {
    agentRunId,
    guestId: claimed.guestId,
  })
  await releaseWarmCloseClaim(
    createAdminClient(),
    claimed.guestId,
    claimed.claimedAt,
  )
}

function pushSendFailureCard(ctx: RuntimeContext, cardId: string): void {
  pushOperatorCard(ctx, cardId, INSTAGRAM_SEND_FAILED_REVIEW_REASON)
}

/** The push for a card a path wrote itself, outside the approval gate. */
function pushOperatorCard(
  ctx: RuntimeContext,
  cardId: string,
  reviewReason: string,
): void {
  if (!shouldSendDraftFlaggedPush(reviewReason)) return
  waitUntil(
    sendDraftFlaggedPush({
      agentRunId: ctx.agentRunId,
      venueId: ctx.venue.id,
      guestId: ctx.guest.id,
      guestFirstName: ctx.guest.firstName,
      draftId: cardId,
      primaryTrigger: reviewReason,
      guestQuestion: ctx.currentMessage?.body ?? null,
      guestCategory: ctx.classification?.category ?? null,
      // TAC-532 code review: THIS is the path that made the crisis leak real.
      // handle-inbound routes a crisis turn whose reply did not fully send into
      // this function, and a crisis message is not a comp_complaint, so the
      // category gate alone would have quoted it onto every operator's lock
      // screen.
      guestIsCrisis: ctx.classification?.crisisSafety ?? false,
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
// Exported for handle-followup.ts, which since TAC-536 reaches the same
// Instagram transport for one trigger reason and must map its outcomes the
// same way. Shared rather than mirrored: four outcomes each needing a
// deliberate AgentResult is exactly the shape two copies drift on.
export function undeliveredAgentResult(
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
 * TAC-540: after a turn ends this way, does the guest still need the dots
 * turned off?
 *
 * A TOTAL MAP, not a `!== 'sent'` check, and the totality is the guard: an
 * eleventh `AgentResult` status fails `tsc` here rather than silently
 * inheriting "leave the dots on", which is the one failure mode this table
 * exists to make impossible. Same discipline `PUSH_POLICY` and
 * `VENUE_PROCESSING` carry.
 *
 * `sent` is the only false. Meta's own documentation says the indicator turns
 * off "after 20 seconds or after a response is sent"
 * (developers.facebook.com/docs/graph-api/reference/page/messages/), so a
 * reply that reached the guest has already cleared it and a `typing_off`
 * behind it would be a second call fighting Meta's own clear. That covers the
 * partly-delivered Instagram case too: something reached the guest.
 *
 * Three of the trues are unreachable with the dots on, because they return
 * before classification ever runs — `skipped_duplicate`, `venue_halted`, and
 * `coalesced`. They are stated rather than omitted so the map stays total and
 * nobody has to re-derive which exits can carry dots.
 */
const TYPING_OFF_AFTER = {
  sent: false,
  queued: true,
  refused: true,
  skipped_duplicate: true,
  dropped: true,
  silenced: true,
  superseded: true,
  coalesced: true,
  venue_halted: true,
  guest_opted_out: true,
  failed: true,
} as const satisfies Record<AgentResult['status'], boolean>

/**
 * Turn the dots off unless a reply went out.
 *
 * Never throws: it runs after the turn's outcome is already decided, and a
 * cosmetic call must not be able to turn a delivered reply into a failed
 * request.
 *
 * AWAITED, unlike `typing_on`, and the asymmetry is the design. `typing_on`
 * sits on the critical path with a guest waiting, so it is fire-and-forget.
 * By the time this runs the reply has either gone or not, so the await costs
 * the guest nothing and buys a deterministic order — which matters, because
 * of the in-flight wait directly below.
 */
async function stopTypingUnlessSent(
  turn: InboundTurnState,
  result: AgentResult | null,
): Promise<void> {
  const shown = turn.typingShownFor
  if (shown === null) return
  // `null` means the run threw past its own catch: the guest certainly got
  // nothing, so the dots certainly have to go.
  if (result !== null && !TYPING_OFF_AFTER[result.status]) return
  try {
    // THE ORDERING GUARD. `typing_on` is fire-and-forget, so a fast failure
    // can reach this exit while that POST is still open. Sent in that order,
    // Meta applies the `off` first and the `on` second and the guest watches
    // dots for the full 20-second timeout — on a turn we already know is not
    // replying. `allSettled` because a rejected `typing_on` is not a reason to
    // skip the `off`.
    if (turn.typingInFlight !== null)
      await Promise.allSettled([turn.typingInFlight])
    await signalTyping({ ...shown, channel: 'instagram' }, 'off')
  } catch (e) {
    console.error('[agent] typing_off failed (cosmetic)', {
      venueId: shown.venueId,
      guestId: shown.guestId,
      error: e instanceof Error ? e.message : String(e),
    })
  } finally {
    turn.typingShownFor = null
    turn.typingInFlight = null
  }
}

/**
 * Show the dots, and remember we did.
 *
 * FIRE-AND-FORGET, deliberately. Both call sites sit directly on the critical
 * path — one right after classification, one right after generation — and the
 * whole point of TAC-540 is to take latency out of that path, not move it
 * around. The promise is kept on the turn so the exit can wait for it before
 * sending `typing_off`; nothing else reads it.
 *
 * Marks `typingShownFor` SYNCHRONOUSLY, before the request resolves. If the
 * POST is still open when the turn ends, the exit must still know to turn the
 * dots off — deferring the mark until success would lose exactly the race the
 * in-flight wait exists to handle.
 */
function startTyping(turn: InboundTurnState, ctx: RuntimeContext): void {
  if (ctx.conversationChannel !== 'instagram') return
  const target = { venueId: ctx.venue.id, guestId: ctx.guest.id }
  turn.typingShownFor = target
  const sending = signalTyping({ ...target, channel: 'instagram' }, 'on').catch(
    (e: unknown) => {
      console.error('[agent] typing_on threw unexpectedly', {
        agentRunId: ctx.agentRunId,
        error: e instanceof Error ? e.message : String(e),
      })
    },
  )
  turn.typingInFlight = sending
  waitUntil(sending)
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
 * is returned. Successes return AgentResult.sent with the outbound
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
export async function handleInbound(
  inboundMessageId: string,
  options: {
    coalescing?: boolean
    coalesceDeps?: CoalesceDeps
    /**
     * How many times this message has already been re-attempted. Set only by
     * the retry in `closeCoalescedTurn`; a webhook always starts at 0.
     */
    retryDepth?: number
  } = {},
): Promise<AgentResult> {
  const agentRunId = randomUUID()
  const enabled = options.coalescing ?? INBOUND_COALESCING_ENABLED
  const coalesceDeps = options.coalesceDeps ?? defaultCoalesceDeps()
  const turn = newInboundTurnState(enabled, options.retryDepth ?? 0)
  let result: AgentResult
  try {
    result = await runInboundTurn(
      inboundMessageId,
      agentRunId,
      turn,
      coalesceDeps,
    )
  } catch (unexpected) {
    // Not redundant with runInboundTurn's own top-level catch: its `finally`
    // block awaits captureAgentLatencyHigh, which is guarded today but by a
    // guarantee living in another module. The ledger should not depend on it.
    await recordSafely({
      inboundMessageId,
      agentRunId,
      result: null,
      unexpected,
    })
    // TAC-540: started before the handoff, never awaited. See the happy path.
    waitUntil(stopTypingUnlessSent(turn, null))
    // `null` is the strongest case for a retry: the turn produced no result
    // at all, so the guest certainly got nothing.
    await closeCoalescedTurn(turn, agentRunId, coalesceDeps, null)
    throw unexpected
  }
  await recordSafely({ inboundMessageId, agentRunId, result })
  // TAC-540: ONE exit for the typing indicator, covering all of
  // runInboundTurn's ~23 return sites plus a throw that escaped its own
  // catch. TAC-523's shape, and the same argument: the orchestrator's
  // `finally` cannot see a throw past itself, and twenty-odd return sites is
  // exactly the shape two copies of a rule drift on.
  //
  // STARTED HERE AND NEVER AWAITED, and the not-awaiting is the load-bearing
  // half. It is started before `closeCoalescedTurn` so the `off` is issued as
  // early as possible; it is handed to `waitUntil` because that function
  // RELEASES THE CLAIM and then fires the retry or the handoff, which is what
  // actually produces the guest's reply on a failed turn.
  //
  // Awaiting it put up to two Graph round-trips and a send-target lookup — a
  // 5s Graph timeout and three supabase reads with no client-side bound —
  // directly in front of that retry. Roughly 0.5-1s typically, ~10s in the
  // tail, on the one ticket whose whole subject is Instagram latency. Found
  // in code review; the first version awaited it.
  //
  // What the await bought and what replaces it: the ordering guard against
  // the retry's OWN typing_on. That guard is weaker now and deliberately so.
  // A retried run is at least loadInbound + classify away from showing dots
  // (the settle no longer adds margin at COALESCE_SETTLE_MS = 0), where this
  // is a call already in flight, so the race is still overwhelmingly won —
  // and losing it costs a retry's dots, not a reply. The ordering that still
  // holds unconditionally is the one inside `stopTypingUnlessSent`: `off`
  // never overtakes this turn's own `on`.
  waitUntil(stopTypingUnlessSent(turn, result))
  await closeCoalescedTurn(turn, agentRunId, coalesceDeps, result)
  return result
}

/**
 * Release the claim, then re-invoke for anything this turn did not cover.
 *
 * THE SECOND HALF IS NOT AN OPTIMISATION, and this comment is here because a
 * future reader will otherwise delete it as dead code — it IS dead on the
 * happy path, which is exactly the problem. Without the post-turn handoff,
 * the claim turns a dead run into a dropped guest.
 *
 * Today two runs is the bug and also the redundancy: if run A dies, run B
 * still replies. Add a claim and remove this handoff and run B has already
 * exited as a loser, so the guest gets silence. It is reachable on every path
 * where the winner did not cover the newest message — a throw, an exhausted
 * extension budget, a refusal, a drop, a queue.
 *
 * Runs on EVERY terminal path including the top-level catch, which is why it
 * sits in `handleInbound` rather than inside the orchestrator: the
 * orchestrator's own `finally` cannot see a throw that escaped it.
 *
 * Fire-and-forget through `waitUntil`, and guarded whole: a handoff that threw
 * would turn a reply that reached the guest into a failed request, which is
 * strictly worse than the silence it exists to prevent.
 */
async function closeCoalescedTurn(
  turn: InboundTurnState,
  agentRunId: string,
  deps: CoalesceDeps,
  /** `null` when the run threw past its own catch. */
  result: AgentResult | null,
): Promise<void> {
  const claim = turn.claim
  if (claim === null) return
  try {
    const released = await releaseInboundTurn({ ...claim, agentRunId }, deps)
    if (!released.ok) {
      // The lease is the backstop. Log rather than alert: the turn already
      // finished, and the next run takes over when the lease expires.
      console.warn(
        '[agent] inbound turn claim not released; leaving it to the lease',
        {
          agentRunId,
          error: released.error,
        },
      )
    }
    turn.claim = null

    const uncovered = await findUncoveredInbound(claim, turn, deps)
    // UNREADABLE IS NOT "NOTHING". A failed read here means we do not know
    // whether a message is uncovered, and the run that would have covered it
    // has already stood down — so treating it as "nothing to do" is a silent,
    // permanent silence for that guest. It cannot be recovered from here (a
    // retry needs the id the read failed to produce), so the obligation is to
    // make it VISIBLE rather than to guess.
    if (uncovered.status === 'unreadable') {
      console.error(
        '[agent] inbound turn could not check for an uncovered message',
        {
          agentRunId,
          answeredMessageId: turn.answered?.id ?? null,
          error: uncovered.error,
        },
      )
      await capturePostHogEvent(
        'inbound_turn_handoff_check_failed',
        agentRunId,
        {
          agentRunId,
          venueId: claim.venueId,
          guestId: claim.guestId,
          answeredMessageId: turn.answered?.id ?? null,
          error: uncovered.error,
        },
      )
      return
    }
    if (uncovered.status === 'none') {
      // NOTHING NEWER, so the handoff has nothing to carry — and that is
      // exactly the case the retry exists for. The winner adopted the newest
      // message and then failed, so there is no later message to hand off and
      // the loser has already stood down: without this the guest gets
      // nothing, where before the claim the loser would have replied about
      // seven seconds later. Restoring that second attempt, and only that
      // one, is what keeps the claim from being a robustness regression.
      //
      // Bounded by DEPTH, threaded into the re-invocation: this is a fresh
      // handleInbound, so a local counter could not bound it, and a turn that
      // fails deterministically would otherwise re-invoke itself forever.
      if (shouldRetryTurn(result, turn) && turn.answered !== null) {
        const retryMessageId = turn.answered.id
        console.warn(
          '[agent] inbound turn failed with nothing newer; retrying once',
          {
            agentRunId,
            retryMessageId,
            outcome: result === null ? 'threw' : result.status,
            retryDepth: turn.retryDepth + 1,
          },
        )
        await capturePostHogEvent('inbound_turn_retried', agentRunId, {
          agentRunId,
          venueId: claim.venueId,
          guestId: claim.guestId,
          retryMessageId,
          outcome: result === null ? 'threw' : result.status,
          retryDepth: turn.retryDepth + 1,
        })
        waitUntil(
          handleInbound(retryMessageId, {
            coalescing: turn.enabled,
            coalesceDeps: deps,
            // The bound. The retried run cannot retry again.
            retryDepth: turn.retryDepth + 1,
          }).catch((e) => {
            console.error('[agent] inbound turn retry failed', {
              agentRunId,
              retryMessageId,
              error: e instanceof Error ? e.message : String(e),
            })
          }),
        )
      }
      return
    }
    console.log('[agent] inbound turn handing off an uncovered message', {
      agentRunId,
      answeredMessageId: turn.answered?.id ?? null,
      handingOffMessageId: uncovered.message.id,
    })
    // Released BEFORE this, deliberately, and the ordering is the guarantee:
    // the handoff re-invokes handleInbound, and that run has to be able to
    // take the claim we were holding. Held, it would stand down immediately
    // and the message would go unanswered — the handoff defeating itself.
    waitUntil(
      handleInbound(uncovered.message.id, {
        coalescing: turn.enabled,
        coalesceDeps: deps,
      }).catch((e) => {
        console.error('[agent] inbound turn handoff failed', {
          agentRunId,
          handingOffMessageId: uncovered.message.id,
          error: e instanceof Error ? e.message : String(e),
        })
      }),
    )
  } catch (e) {
    console.error('[agent] inbound turn close failed', {
      agentRunId,
      error: e instanceof Error ? e.message : String(e),
    })
  }
}

/**
 * The record call is guarded SEPARATELY from the orchestrator's, and the
 * structure is the point: recording sits outside the try that wraps the run.
 *
 * Inside it, a throwing recorder would be caught by the same catch, recorded a
 * second time, and rethrown — converting a reply that reached the guest into a
 * failed request. `recordInboundTurnOutcome` never throws by construction, but
 * "change no decision" cannot rest on a guarantee that lives in another file;
 * that is the same reason the catch above exists at all.
 */
async function recordSafely(input: {
  inboundMessageId: string
  agentRunId: string
  result: AgentResult | null
  unexpected?: unknown
}): Promise<void> {
  try {
    await recordInboundTurnOutcome(input)
  } catch (e) {
    console.error(
      '[agent] inbound turn outcome recorder threw; outcome not recorded',
      {
        agentRunId: input.agentRunId,
        inboundMessageId: input.inboundMessageId,
        error: e instanceof Error ? e.message : String(e),
      },
    )
  }
}

/**
 * The orchestrator itself. Unchanged by TAC-523 apart from its name and
 * taking `agentRunId` as a parameter — every one of its ~20 return sites is
 * untouched, which is what makes "no path's decision changed" a property of
 * the diff rather than a claim in a review.
 */
async function runInboundTurn(
  inboundMessageId: string,
  agentRunId: string,
  turn: InboundTurnState,
  coalesceDeps: CoalesceDeps,
): Promise<AgentResult> {
  const start = Date.now()
  // Captured at ENTRY, because an extension increments the counter before it
  // recurses. Only the outermost call emits latency, so one turn produces one
  // measurement covering the settle and every extension — the honest
  // end-to-end number rather than one per attempt.
  const entryExtensionDepth = turn.extensionsUsed
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
    console.log('[agent] inbound start', {
      agentRunId,
      inboundMessageId,
      traceId: trace.id,
    })

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
      trace.update({
        output: { status: 'skipped_duplicate', existingReplyId: existing },
      })
      skipLatencyEmit = true
      return { status: 'skipped_duplicate' }
    }

    // Load inbound row
    const invoked = await loadInbound(inboundMessageId)
    knownVenueId = invoked.venueId
    knownGuestId = invoked.guestId

    // TAC-529: the venue is paused or archived, so we do not reply.
    //
    // Ruled 2026-09-23 (question 1: A). A venue is paused because something
    // is wrong, and the reply path is where the damage would happen; a switch
    // that stops the crons and leaves the agent talking to guests is a
    // partial stop that reads as a complete one.
    //
    // HERE, and the placement is the decision. Before buildRuntimeContext,
    // which writes `guest_states` and an audit row through computeGuestState
    // on a band change — a switched-off venue should not still be
    // accumulating recognition state. Before openCoalescedTurn too, so a
    // halted venue never takes a conversation claim it would only release.
    //
    // The inbound row is already SAVED by the webhook and stays saved: the
    // history is what you want when the venue is unpaused. Only the reply is
    // withheld, and the ledger row is what makes that silence countable
    // rather than indistinguishable from a swallowed reply.
    const venueStatus = await loadVenueStatus(invoked.venueId)
    if (isVenueProcessingHalted(venueStatus)) {
      console.warn('[agent] venue is halted, not replying', {
        agentRunId,
        venueId: invoked.venueId,
        venueStatus,
      })
      return { status: 'venue_halted', venueStatus: venueStatus ?? 'unknown' }
    }

    // TAC-526: settle, claim, adopt. Sits here because this is where venue and
    // guest first exist, and before buildRuntimeContext, which is the first
    // expensive step (a Voyage embed and retrieval).
    //
    // Skipped entirely on an extension: the turn already opened, and
    // re-opening for a message that has ALREADY arrived is pure waste (and,
    // when the settle constant is nonzero, a second wait on top).
    //
    // Keyed on extension depth, NOT on `turn.claim === null`. Those differ on
    // exactly one path and it is a real one: a run that failed open (the store
    // was unreachable, so it holds no claim) would otherwise re-open on every
    // extension and could LOSE the claim mid-turn on the retry, discarding a
    // generation it had already paid for. Found in code review; the old
    // comment was false for it.
    let inbound = invoked
    if (entryExtensionDepth === 0) {
      const opened = await openCoalescedTurn(
        {
          venueId: invoked.venueId,
          guestId: invoked.guestId,
          messageId: invoked.message.id,
          messageCreatedAt: invoked.message.receivedAt,
          agentRunId,
        },
        coalesceDeps,
        turn.enabled,
      )
      if (opened.status === 'stand_down') {
        // Another run holds this conversation. It will answer this message
        // too, because it adopts the newest one it can see. Nothing generated,
        // nothing sent, and the ledger records which turn covered us.
        console.log('[agent] inbound folded into another turn', {
          agentRunId,
          inboundMessageId,
          intoAgentRunId: opened.intoAgentRunId,
        })
        trace.update({
          output: {
            status: 'coalesced',
            intoAgentRunId: opened.intoAgentRunId,
          },
        })
        skipLatencyEmit = true
        return {
          status: 'coalesced',
          intoAgentRunId: opened.intoAgentRunId,
          intoMessageId: opened.intoMessageId,
        }
      }
      if (opened.claimed)
        turn.claim = { venueId: invoked.venueId, guestId: invoked.guestId }
      if (opened.degraded !== null) {
        // Fail-open happened. Worth a line: the reply is going out unclaimed,
        // which is today's behaviour, but a run of these means the claim is
        // not protecting anyone.
        console.warn('[agent] inbound turn proceeding without a claim', {
          agentRunId,
          inboundMessageId,
          error: opened.degraded,
        })
      }
      if (opened.answerMessageId !== invoked.message.id) {
        // The settle caught a fragment. Answer the newest message; every
        // earlier one is already in the history turns via the existing
        // history query, so nothing the guest said is dropped.
        //
        // Guarded: a reload that fails costs the adoption, never the reply.
        try {
          inbound = await loadInbound(opened.answerMessageId)
          console.log('[agent] inbound turn adopted a newer message', {
            agentRunId,
            invokedFor: inboundMessageId,
            answering: inbound.message.id,
          })
        } catch (e) {
          console.warn('[agent] inbound turn could not adopt a newer message', {
            agentRunId,
            answerMessageId: opened.answerMessageId,
            error: e instanceof Error ? e.message : String(e),
          })
        }
      }
    }
    // What this turn covers. The handoff compares against it, so it must be
    // the message actually answered rather than the one we were invoked for.
    turn.answered = {
      id: inbound.message.id,
      createdAt: inbound.message.receivedAt,
    }

    // TAC-574: what this turn does with a photo, GIF or other attachment.
    // lib/agent/inbound-media.ts carries the ruling and the reasoning.
    //
    // AFTER `turn.answered`, and the order is load-bearing: a media-only
    // message answered through the text beside it swaps `inbound` to that
    // text below, but the turn still COVERS the media message, which is the
    // newer of the two. Recording the text instead would make the handoff
    // find the photo uncovered and run a second turn for it.
    //
    // Started here and awaited where it is needed, so an ordinary text turn
    // pays for the read alongside the context build rather than before it.
    // loadTurnMediaRows never rejects.
    const turnMediaRows = loadTurnMediaRows({
      venueId: inbound.venueId,
      guestId: inbound.guestId,
      around: inbound.message.receivedAt,
    })
    let mediaOnlyTurn = false
    if (isMediaOnly(inbound.message.body, inbound.mediaUrls)) {
      const rows = await turnMediaRows
      if (!rows.ok) {
        // Fail toward a human: with no rows to judge, the card is written.
        console.warn('[agent] media-only turn could not read its rows', {
          agentRunId,
          error: rows.error,
        })
      }
      const resolution = rows.ok
        ? resolveMediaOnlyTurn(turn.answered, rows.data)
        : ({ kind: 'card' } as const)
      if (resolution.kind === 'covered') {
        // The media arrived inside a turn whose reply or card went out after
        // it. A card now would be a reply AND a card for one burst.
        console.log('[agent] media-only message already covered by a turn', {
          agentRunId,
          mediaMessageId: turn.answered.id,
        })
        trace.update({
          output: { status: 'skipped_duplicate', mediaOnly: 'covered' },
        })
        skipLatencyEmit = true
        return { status: 'skipped_duplicate' }
      }
      mediaOnlyTurn = resolution.kind === 'card'
      if (resolution.kind === 'answer_text') {
        try {
          inbound = await loadInbound(resolution.textMessageId)
          console.log('[agent] media-only message answered through its text', {
            agentRunId,
            mediaMessageId: turn.answered.id,
            answering: inbound.message.id,
          })
        } catch (e) {
          console.warn('[agent] media-only turn could not load its text', {
            agentRunId,
            textMessageId: resolution.textMessageId,
            error: e instanceof Error ? e.message : String(e),
          })
          mediaOnlyTurn = true
        }
      }
      // An opted-out TEXT guest gets no card and hears nothing
      // (persistMediaOnlyCard's docstring has the two channels' rules), the
      // same outcome TAC-572 gives their text messages. Decided here, before
      // the wait and the context build. A failed read is treated as not opted
      // out, so the photo reaches a human.
      if (mediaOnlyTurn && inbound.message.channel !== 'instagram') {
        const optedOut = await readOptedOut({
          venueId: inbound.venueId,
          guestId: inbound.guestId,
        })
        if (!optedOut.ok) {
          // Counted, as TAC-572's own read is: a degrade nobody can count is
          // one nobody will notice. The card that follows cannot reach the
          // guest by itself; the operator dispatch refuses an opted-out send.
          console.warn('[agent] opt-out read failed on a media-only turn', {
            agentRunId,
            guestId: inbound.guestId,
            error: optedOut.error,
          })
          await capturePostHogEvent('opt_out_read_failed', agentRunId, {
            agentRunId,
            venueId: inbound.venueId,
            guestId: inbound.guestId,
            error: optedOut.error,
          })
        }
        if (optedOut.ok && optedOut.data) {
          console.log('[agent] media-only inbound not carded: opted out', {
            agentRunId,
            guestId: inbound.guestId,
          })
          trace.update({ output: { status: 'guest_opted_out' } })
          return { status: 'guest_opted_out' }
        }
      }
      // Wait for a caption before carding, looking every
      // MEDIA_ONLY_SETTLE_POLL_MS up to MEDIA_ONLY_SETTLE_MS. This run holds
      // the claim, so a text arriving now stands down into it; adopting it
      // here is the same extension the auto-send path makes before dispatch,
      // out of the same budget.
      for (
        let waited = 0;
        mediaOnlyTurn && mayExtend(turn) && waited < MEDIA_ONLY_SETTLE_MS;
        waited += MEDIA_ONLY_SETTLE_POLL_MS
      ) {
        await coalesceDeps.sleep(MEDIA_ONLY_SETTLE_POLL_MS)
        const uncovered = await findUncoveredInbound(
          { venueId: inbound.venueId, guestId: inbound.guestId },
          turn,
          coalesceDeps,
        )
        if (uncovered.status === 'found') {
          turn.extensionsUsed += 1
          console.log('[agent] media-only turn extending to a newer message', {
            agentRunId,
            extensionsUsed: turn.extensionsUsed,
            from: turn.answered.id,
            to: uncovered.message.id,
          })
          return await runInboundTurn(
            uncovered.message.id,
            agentRunId,
            turn,
            coalesceDeps,
          )
        }
      }
    }
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
        throw new Error(
          'conversation channel unresolved: the reply has nowhere to be routed',
        )
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
          newlyEligibleIntentionKeys: ctx.intentionDerivation.newlyEligible.map(
            (e) => e.key,
          ),
          rearmedIntentionKeys: ctx.intentionDerivation.newlyEligible
            .filter((e) => e.rearm)
            .map((e) => e.key),
          intentionBrakeEngaged: ctx.intentionDerivation.brakeEngaged,
          // TAC-575: a suppression nobody can count is not a guarantee.
          quietAfterWarmClose: ctx.intentionDerivation.quietAfterWarmClose,
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

    // TAC-574: no text anywhere in this turn, so there is nothing to classify
    // and nothing to generate. The owner gets a blank card. Before retrieval
    // and classification, so neither runs on an empty body.
    if (mediaOnlyTurn) {
      const carded = await persistMediaOnlyCard(ctx, agentRunId)
      trace.update({ output: { status: carded.status, mediaOnly: true } })
      return carded
    }
    // A turn with text: tell the agent what arrived beside it, if anything.
    // A failed read costs the acknowledgement, never the reply.
    const mediaRows = await turnMediaRows
    if (mediaRows.ok) {
      ctx.inboundMedia = mediaAlongsideText(
        {
          id: inbound.message.id,
          body: inbound.message.body,
          mediaUrls: inbound.mediaUrls,
          createdAt: inbound.message.receivedAt,
        },
        mediaRows.data,
      )
    } else {
      console.warn('[agent] inbound media read failed, no note rendered', {
        agentRunId,
        error: mediaRows.error,
      })
    }

    // TAC-540 part C: the voice-pack load starts HERE, alongside
    // classification, and is awaited at its old position further down.
    //
    // SAFE BECAUSE retrieveCorpusStage NEVER READS ctx.classification —
    // checked line by line, not assumed. Since decision 0008 it reads ONLY
    // `ctx.venue.id` (the pack is static per venue; there is no query at
    // all), which is set before this point. So its result is identical
    // whichever order the two run in, and classifyStage mutates nothing for
    // it to race on.
    //
    // NOT `Promise.allSettled` OVER THE PAIR, and that is the whole shape of
    // this change. Awaiting both together would make a classification failure
    // AND the crisis short-circuit wait for retrieval before returning —
    // adding latency to the crisis path, which is the one place in this file
    // where added latency is worst. Instead the rejection is claimed
    // immediately and the value is read at the old site.
    //
    // THE `.then(ok, err)` IS NOT DECORATION. Without it, a classification
    // failure returns while this promise is still open, and a rejection with
    // no handler attached is an unhandled rejection that can take the process
    // down. Claiming it here means every return path below is free to ignore
    // it.
    // Span keeps its historical name so Langfuse dashboards line up across
    // the decision-0008 boundary; since then it times a static pack load,
    // not a query.
    const retrieveSpan = trace.span('retrieve', { staticVoicePack: true })
    const retrievingCorpus = retrieveCorpusStage(ctx).then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error }),
    )

    // Classify
    // `generation()`, not `span()`: Langfuse only prices an observation of type
    // GENERATION, so a plain span records a model call at $0 however many tokens
    // it reports. The span NAME is unchanged, which is what select-trace-stages.ts
    // and the latency queries key on — neither reads the observation type.
    const classifySpan = trace.generation(
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
        model: ctx.classification.modelId,
        usage: toAgentUsage(ctx.classification.usage ?? {}),
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
      // TAC-540: the retrieve span was opened above, beside this one. Closed
      // here so a classification failure does not leave a span that reads in
      // Langfuse as "retrieval hung" — on part D's own ticket.
      retrieveSpan.end({ output: { discarded: 'classification_failed' } })
      return { status: 'failed', stage: 'classification', error: errMsg }
    }

    // TAC-348: crisis-safety short-circuit. Fires immediately after
    // classification, before the voice pack is awaited or generation runs.
    // retrieveCorpusStage fails CLOSED on the inbound path (throws on an
    // empty pack or a load failure), so a crisis message at a venue with a
    // broken corpus read cannot wait until inside generateStage — silence on
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
      const crisisSpan = trace.span('crisis_safety', {
        category: ctx.classification.category,
      })
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
          crisisSpan.end({
            level: 'WARNING',
            output: { outcome: dispatched.kind },
          })
          retrieveSpan.end({ output: { discarded: 'crisis_safety' } })
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
          if (dispatched.undelivered.cardId !== null)
            pushSendFailureCard(ctx, dispatched.undelivered.cardId)
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
        // The retrieval started beside classification is discarded on this
        // path (the ticket's ruling). Its span is closed rather than left
        // open, so a crisis trace does not read as a hung retrieval.
        retrieveSpan.end({ output: { discarded: 'crisis_safety' } })
        return { status: 'sent', outboundMessageId }
      } catch (e) {
        // scheduleAndSend already fired the appropriate stage-specific alert.
        const errMsg = e instanceof Error ? e.message : String(e)
        const stage: 'send' | 'persist' = errMsg.includes('persist failed')
          ? 'persist'
          : 'send'
        crisisSpan.end({
          level: 'ERROR',
          statusMessage: errMsg,
          output: { stage },
        })
        retrieveSpan.end({ output: { discarded: 'crisis_safety' } })
        return { status: 'failed', stage, error: errMsg }
      }
    }

    // TAC-572: the guest's opt-out, decided once per turn by decideOptOutTurn
    // (lib/guests/opt-out.ts, which carries the rules and the rulings).
    //
    // BELOW THE CRISIS SHORT-CIRCUIT, so an opted-out guest in crisis still
    // gets the crisis reply: that path already outranks every hold in this
    // file, and silence is worst on exactly that turn. AFTER classification
    // rather than before context build, because the Instagram rule reads the
    // category ("thanks" after the confirmation must not opt them back in).
    //
    // THE READ FAILS OPEN. An unreadable row is treated as not opted out, so
    // the guest who wrote to us is answered; an `opt_out` turn still records,
    // because recording does not depend on the read. The proactive paths fail
    // the other way (isOptedOut in instagram-scan-greeting.ts suppresses), and
    // the asymmetry is deliberate: nobody asked for those messages.
    const optOutIds = { venueId: ctx.venue.id, guestId: ctx.guest.id }
    const optedOutRead = await readOptedOut(optOutIds)
    if (!optedOutRead.ok) {
      console.warn('[agent] opt-out read failed, treating as not opted out', {
        agentRunId,
        guestId: ctx.guest.id,
        error: optedOutRead.error,
      })
      // An event as well as a line: this is the one path on which an
      // opted-out SMS guest can be answered, and a degrade nobody can count
      // is one nobody will notice.
      await capturePostHogEvent('opt_out_read_failed', agentRunId, {
        agentRunId,
        venueId: ctx.venue.id,
        guestId: ctx.guest.id,
        error: optedOutRead.error,
      })
    }
    const optOutDecision = decideOptOutTurn({
      channel: ctx.conversationChannel,
      optedOut: optedOutRead.ok ? optedOutRead.data : false,
      category: ctx.classification.category,
      body: inbound.message.body,
      isRetry: turn.retryDepth > 0,
    })
    if (optOutDecision.action === 'silence') {
      console.log('[agent] inbound not answered: guest is opted out', {
        agentRunId,
        guestId: ctx.guest.id,
        channel: ctx.conversationChannel,
        category: ctx.classification.category,
      })
      trace.update({
        output: {
          status: 'guest_opted_out',
          category: ctx.classification.category,
        },
      })
      retrieveSpan.end({ output: { discarded: 'guest_opted_out' } })
      return { status: 'guest_opted_out' }
    }
    if (optOutDecision.action === 'record') {
      // Awaited, so the opt-out is saved BEFORE the confirmation goes out and
      // "we'll stop" is never said ahead of the fact. One retry, then a red
      // alert, and the confirmation still sends: a guest who asked to stop and
      // heard nothing is the compliance failure, and the alert is what makes
      // the unrecorded opt-out somebody's problem rather than nobody's.
      let recorded = await recordOptOut(optOutIds)
      if (!recorded.ok) recorded = await recordOptOut(optOutIds)
      if (recorded.ok) {
        console.log('[agent] opt-out recorded', {
          agentRunId,
          guestId: ctx.guest.id,
          newlyOptedOut: recorded.data.changed,
        })
      } else {
        await fireRedAlert({
          agentRunId,
          venueId: ctx.venue.id,
          guestId: ctx.guest.id,
          kind: 'inbound',
          stage: 'persist',
          errorMessage: `opt-out NOT recorded, confirmation still sent: ${recorded.error}`,
          extra: { step: 'opt_out_record' },
        })
      }
    }
    if (optOutDecision.action === 'clear') {
      let cleared = await clearOptOut(optOutIds)
      if (!cleared.ok) cleared = await clearOptOut(optOutIds)
      if (cleared.ok) {
        console.log('[agent] guest opted back in', {
          agentRunId,
          guestId: ctx.guest.id,
          via: optOutDecision.reOptIn,
        })
      } else {
        // The reply still goes: they wrote to us and this message is the one
        // that earns an answer. But they are still opted out in the database,
        // so every proactive path keeps skipping them until someone looks.
        await fireRedAlert({
          agentRunId,
          venueId: ctx.venue.id,
          guestId: ctx.guest.id,
          kind: 'inbound',
          stage: 'persist',
          errorMessage: `re-opt-in NOT recorded, guest is still opted out: ${cleared.error}`,
          extra: { step: 'opt_out_clear', via: optOutDecision.reOptIn },
        })
      }
      turn.reOptIn = optOutDecision.reOptIn
    }
    // Read from the turn, not the decision: on an extension the opt-out is
    // already cleared and the decision above is 'none'.
    ctx.reOptIn = turn.reOptIn

    // TAC-540: show the guest typing dots, if this turn looks headed for an
    // auto-send.
    //
    // BELOW THE CRISIS SHORT-CIRCUIT, NOT ABOVE IT, and that placement is a
    // decision rather than an accident of ordering. The ticket lists
    // "crisis-routed" among the cases that need typing_off — but a crisis
    // turn DOES dispatch a reply, so it would not need one. Putting the
    // typing_on below the short-circuit makes that list consistent with no
    // special case: a crisis turn never turns the dots on, so there is
    // nothing to turn off. It also leaves the crisis path's timing exactly as
    // it was, which matters more here than anywhere else in this file.
    //
    // `mayAutoSendAfterClassification` is a PREDICTION from what is knowable
    // this early; most of the gate's triggers need a draft. Dots can go on
    // and the draft can still queue, and `stopTypingUnlessSent` is what
    // corrects that. Fire-and-forget: nothing below waits on it.
    if (mayAutoSendAfterClassification(ctx)) startTyping(turn, ctx)

    // TAC-575: this message armed "how is it so far?" before anyone had read
    // it. Now it is classified, decide whether it really is an order report
    // (orderTurnVerdict says why this cannot be decided at arming).
    //
    // BEFORE the eligibility write below, and that placement is the point. A
    // message that turns out not to be an order must leave NO row: an
    // eligibility row would keep the required question open for two hours and
    // put it on the guest's next "ok cool".
    if (
      ctx.intentionDerivation.newlyEligible.some(
        (e) => e.key === 'hows_it_so_far',
      )
    ) {
      const verdict = orderTurnVerdict({
        category: ctx.classification.category,
        praisedExperience: ctx.classification.praisedExperience === true,
      })
      if (verdict !== 'ask') {
        ctx.openIntentions = ctx.openIntentions.filter(
          (o) => o.key !== 'hows_it_so_far',
        )
        ctx.intentionDerivation = {
          ...ctx.intentionDerivation,
          newlyEligible: ctx.intentionDerivation.newlyEligible.filter(
            (e) => e.key !== 'hows_it_so_far',
          ),
        }
      }
      // They said how it is in the same breath as what it is. That IS the
      // visit's check-in, so it is recorded without a question having been
      // asked: the sign-off and the next-visit follow-up read this row either
      // way.
      if (
        (verdict === 'good' || verdict === 'bad') &&
        ctx.visitLocalDate !== null
      ) {
        const checkinGuestId = ctx.guest.id
        waitUntil(
          recordVisitCheckinAsked(createAdminClient(), {
            venueId: ctx.venue.id,
            guestId: checkinGuestId,
            venueLocalDate: ctx.visitLocalDate,
            orderMessageId: ctx.currentMessage.id,
            orderedAt: ctx.currentMessage.receivedAt,
            askedAt: ctx.currentMessage.receivedAt,
            answer: verdict,
          }).then((recorded) => {
            if (!recorded.ok) {
              console.error('[agent] visit check-in write failed', {
                agentRunId,
                guestId: checkinGuestId,
                error: recorded.error,
              })
              return
            }
            console.log('[agent] visit check-in answered on the order turn', {
              agentRunId,
              guestId: checkinGuestId,
              answer: verdict,
              outcome: recorded.data,
            })
          }),
        )
      }
      console.log('[agent] order turn read', { agentRunId, verdict })
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
              console.warn(
                '[agent] intention eligibility write failed (continuing)',
                {
                  agentRunId,
                  error: outcome.error,
                },
              )
            }
          })
          .catch((e) => {
            console.error(
              '[agent] recordIntentionEligibility threw unexpectedly',
              {
                agentRunId,
                error: e instanceof Error ? e.message : String(e),
              },
            )
          }),
      )
    }

    // TAC-575: if this guest was asked how their order is on this visit, read
    // this message as their answer. Post-classify because both signals are the
    // classifier's (visit-checkin.ts says why no new model call is needed), and
    // before generation because it never blocks one: fire and forget, like the
    // extractor below.
    //
    // The row was loaded at context build, so the turn that SENDS the question
    // never reaches here with one, and the guest's order message is never read
    // as its own answer.
    if (
      ctx.visitCheckin !== null &&
      isAwaitingCheckinAnswer(ctx.visitCheckin, ctx.currentMessage.receivedAt)
    ) {
      const checkin = ctx.visitCheckin
      const answer = nextCheckinAnswer(
        checkin.answer,
        classifyCheckinAnswer({
          category: ctx.classification.category,
          praisedExperience: ctx.classification.praisedExperience === true,
        }),
      )
      // Until they say it is good, the venue asks nothing else. Read from what
      // the row will say AFTER this message, so "it's great" lifts the hold on
      // the turn it arrives and the name ask can follow it. Set before
      // renderableIntentions runs, like ctx.reviewAsk below.
      const answerNow = answer ?? checkin.answer
      ctx.visitCheckinHold = answerNow !== 'good'
      // THREE TURNS THE CHECK-BACK MUST NOT RIDE, even when the clock says it
      // is due. Removed from the eligibility write too, as for the order turn
      // above: a row would keep a required question open on their next message.
      //
      //   they have just said how it is    good or bad answers it before it
      //                                    is asked.
      //   this message IS their answer     the row had no answer and now has
      //                                    one. "haven't tried it yet" must
      //                                    not get "and how is it?" back in
      //                                    the same breath. Their answer also
      //                                    restarts the wait
      //                                    (resolveCheckbackDueAt).
      //   they are signing off             a goodbye is not a turn to put a
      //                                    question on. If they go quiet the
      //                                    timer still checks back.
      const firstAnswerThisTurn = checkin.answer === null && answer !== null
      if (
        answerNow === 'good' ||
        answerNow === 'bad' ||
        firstAnswerThisTurn ||
        ctx.classification.category === SIGN_OFF_CATEGORY
      ) {
        ctx.openIntentions = ctx.openIntentions.filter(
          (o) => o.key !== 'check_back_on_order',
        )
        ctx.intentionDerivation = {
          ...ctx.intentionDerivation,
          newlyEligible: ctx.intentionDerivation.newlyEligible.filter(
            (e) => e.key !== 'check_back_on_order',
          ),
        }
      }
      if (answer !== null) {
        const checkinGuestId = ctx.guest.id
        waitUntil(
          recordVisitCheckinAnswer(createAdminClient(), {
            id: checkin.id,
            venueId: ctx.venue.id,
            guestId: checkinGuestId,
            expected: checkin.answer,
            answer,
            answeredAt: ctx.currentMessage.receivedAt,
          }).then((written) => {
            if (!written.ok) {
              // Logged, not swallowed: an unrecorded answer means this guest
              // gets a check-back they did not need, or no review ask.
              console.error('[agent] visit check-in answer write failed', {
                agentRunId,
                guestId: checkinGuestId,
                answer,
                error: written.error,
              })
              return
            }
            console.log('[agent] visit check-in answer', {
              agentRunId,
              guestId: checkinGuestId,
              answer,
              previous: checkin.answer,
              outcome: written.data,
            })
          }),
        )
      }
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
            console.warn(
              '[agent] inbound self-reported order extraction failed (continuing)',
              {
                agentRunId,
                error: outcome.error,
              },
            )
          }
        })
        .catch((e) => {
          console.error('[agent] extractReportedOrder threw unexpectedly', {
            agentRunId,
            error: e instanceof Error ? e.message : String(e),
          })
        }),
    )

    // TAC-386: arm the inquiry follow-up. Non-blocking by design (waitUntil),
    // the same posture as extractReportedOrder above and for the same reason: a
    // slow or failed write must never delay or block the reply. It never throws
    // and reports its own outcome, so a failure costs a missed follow-up rather
    // than a broken turn.
    //
    // Placed here, post-classify, because `followUpWorthy` is what it reads, and
    // after the crisis short-circuit's early return above, so a guest in crisis
    // never arms one. The module re-checks crisisSafety anyway; the placement is
    // not the only thing stopping it.
    waitUntil(
      scheduleInquiryFollowup(ctx)
        .then((outcome) => {
          if (outcome.kind === 'armed') {
            console.log('[agent] inquiry follow-up armed', {
              agentRunId,
              dueAt: outcome.dueAt.toISOString(),
            })
          } else if (outcome.kind === 'failed') {
            console.warn(
              '[agent] inquiry follow-up could not be armed (continuing)',
              { agentRunId, error: outcome.error },
            )
          } else {
            // Every other outcome is an ordinary decision not to arm one, and
            // they are the common case. Logged at debug volume because the
            // reason is the only interesting part when a follow-up is missing.
            console.log('[agent] inquiry follow-up not armed', {
              agentRunId,
              outcome: outcome.kind,
              reason: 'reason' in outcome ? outcome.reason : undefined,
            })
          }
        })
        .catch((e) => {
          console.error('[agent] scheduleInquiryFollowup threw unexpectedly', {
            agentRunId,
            error: e instanceof Error ? e.message : String(e),
          })
        }),
    )

    // The once-ever Google review ask. Placed here, post-classify, because
    // `praisedExperience` is what it reads, and after the crisis
    // short-circuit's early return above, so a guest in crisis never sees
    // one (the predicate re-checks crisisSafety anyway; the placement is not
    // the only thing stopping it). This is the ONLY write to ctx.reviewAsk
    // anywhere — buildRuntimeContext initializes it null and every other
    // path leaves it there — which is what makes the ask structurally
    // impossible on followups, declines and the holding message.
    //
    // Setting it BEFORE renderableIntentions runs below is load-bearing: the
    // raised ask vetoes the intentions block (one ask per turn), and both
    // the prompt mapper and the recording gate read that veto through the
    // same predicate.
    ctx.reviewAsk = deriveReviewAsk(ctx)
    if (ctx.reviewAsk !== null) {
      console.log('[agent] review ask raised', {
        agentRunId,
        linkLabel: ctx.reviewAsk.label,
      })
      waitUntil(
        captureReviewAskRaised({
          agentRunId,
          venueId: ctx.venue.id,
          guestId: ctx.guest.id,
          linkLabel: ctx.reviewAsk.label,
          inboundBody: ctx.currentMessage.body,
        }).catch(() => {}),
      )
    }

    // Voice pack. TAC-540: the load was STARTED above, next to
    // classification; this is where its result is consumed, unchanged in
    // position, in outcome and in what it alerts on. A turn that returned
    // before here — a classification failure, the crisis short-circuit — has
    // discarded it, which is the ticket's own ruling and now costs one DB
    // read on those paths (decision 0008 removed the Voyage embed and RPC).
    const corpusResult = await retrievingCorpus
    try {
      if (!corpusResult.ok) throw corpusResult.error
      ctx.corpus = corpusResult.value
      retrieveSpan.end({
        output: { packSize: ctx.corpus.length },
        content: trace.captureContent
          ? buildCorpusContent(ctx.corpus)
          : undefined,
      })
      console.log('[agent] inbound voice pack loaded', {
        agentRunId,
        packSize: ctx.corpus.length,
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
      const contextQueryLength = buildContextQuery(ctx).length
      const knowledgeSpan = trace.span('retrieve_knowledge', {
        queryLength: ctx.currentMessage?.body.length ?? 0,
        // TAC-547: 2 when a contextual arm ran, 1 when there was no usable
        // prior turn. A venue sitting at 1 on every turn is the signal that
        // the context window is filtering everything out.
        armCount: contextQueryLength > 0 ? 2 : 1,
        contextQueryLength,
      })
      // TAC-547: two arms — the guest's message alone, and a contextual query
      // carrying the last turns that reached them — merged into one slate. A
      // turn with no usable prior runs ONE arm and is byte-identical to what
      // this call did before.
      ctx.knowledgeCorpus = await retrieveKnowledgeWithContextStage(
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
    // A GENERATION, not a span: this is the most expensive model call in the turn
    // and Langfuse prices only GENERATION observations. Recorded as a plain span
    // it reported $0 however many tokens it burned.
    const generateSpan = trace.generation('generate', {
      category: ctx.classification.category,
    })
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
          output: {
            status: 'queued',
            outboundMessageId: card.outboundMessageId,
            generationFailed: true,
          },
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
    gen.result.attemptHistory.forEach((attempt, i) => {
      const attemptSpan = generateSpan.span(`generate.attempt_${i + 1}`, {
        attempt: i + 1,
      })
      attemptSpan.end({
        output: { attempt: i + 1 },
        content: buildGenerateAttemptContent(attempt),
      })
    })
    generateSpan.end({
      output: {
        attempts: gen.result.attempts,
        promptVersion: gen.result.promptVersion,
        // Prompt-cache accounting. This span is the ONLY surface the cache is
        // visible on: a hit and a fast uncached call have identical latency,
        // and a breakpoint that quietly stops reading raises no error. Query
        // these in Langfuse alongside the latency percentiles — see CLAUDE.md
        // "Latency and cost". A busy venue sitting at cacheReadTokens 0 means
        // the prefix is drifting per message or the TTL is too short.
        cacheReadTokens: gen.result.cacheReadTokens,
        cacheWriteTokens: gen.result.cacheWriteTokens,
        bodyLength: gen.result.body.length,
      },
      content: trace.captureContent
        ? buildGenerateContent(gen.result)
        : undefined,
      // Native pricing, summed over every attempt. Separate from the output
      // fields above on purpose: these two are what the metrics API can
      // aggregate, the output object can only be scraped per observation.
      model: gen.result.modelId,
      usage: toAgentUsage(gen.result.usage ?? {}),
    })
    generatedBody = gen.result.body
    console.log('[agent] inbound generated', {
      agentRunId,
      attempts: gen.result.attempts,
    })

    // TAC-540: refresh the dots, and this second call is REQUIRED rather than
    // belt-and-braces. Meta turns the indicator off "after 20 seconds or
    // after a response is sent"
    // (developers.facebook.com/docs/graph-api/reference/page/messages/), and
    // generation alone runs to ~11s at p90 on top of classification's ~2.8s.
    // Without this the dots would routinely die before the four checks, the
    // gate and the send had even started.
    //
    // Only when the dots are already showing: if this turn was predicted to
    // queue, finishing a generation is not new evidence that it will not.
    //
    // NOT quite "only when site 1 fired", and the difference is the extension
    // path: TAC-526 re-enters runInboundTurn with the SAME turn state, so a
    // pass whose own classification predicts a queue can still refresh dots
    // an earlier pass turned on. That is correct — they ARE showing, and the
    // single exit still takes them away — but the guarantee is about
    // `typingShownFor`, not about this function having run before.
    if (turn.typingShownFor !== null) startTyping(turn, ctx)

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

    // TAC-573: the guest confirmed they have not been in, so the visit they
    // reported earlier in this conversation stops counting. Independent of the
    // approval gate, for the reason the arrival capture just below is: what the
    // guest told us is true whether our reply is sent, queued or dropped.
    //
    // DEFINED here and CALLED at each of the four places this turn's generation
    // becomes final: the silence, drop and queue branches, and the send path
    // AFTER its extension check. Not called here, because the send path can
    // still find a newer message from the guest and re-enter with it, and
    // "wait, I did come in Tuesday" a few seconds behind "never been" must be
    // answered by the re-entered turn before anything is retracted.
    //
    // The model's 'retracted' is necessary and never sufficient.
    // generateMessage already forced the field to 'none' unless the
    // `## Visit they told you about` block rendered, and retractReportedVisits
    // touches only the rows build-runtime-context selected: guest-reported, from
    // this conversation, not on a day the guest scanned. Non-blocking and it
    // never throws, the extractReportedOrder posture: a failed write costs a
    // visit that keeps counting, which is where things stood before.
    const retractionCtx = ctx
    const retractionConfirmed =
      gen.result.reportedVisitCorrection === 'retracted'
    const retractConfirmedVisit = (): void => {
      if (!retractionConfirmed) return
      waitUntil(
        retractReportedVisits(retractionCtx)
          .then((outcome) => {
            if (outcome.kind === 'retracted') {
              console.log('[agent] inbound reported visit retracted', {
                agentRunId,
                guestId: retractionCtx.guest.id,
                transactionIds: outcome.transactionIds,
                lastVisit: outcome.lastVisit,
              })
            } else if (outcome.kind === 'failed') {
              console.warn(
                '[agent] inbound reported visit retraction failed (continuing)',
                {
                  agentRunId,
                  guestId: retractionCtx.guest.id,
                  error: outcome.error,
                },
              )
            }
          })
          .catch((e) => {
            console.error('[agent] retractReportedVisits threw unexpectedly', {
              agentRunId,
              error: e instanceof Error ? e.message : String(e),
            })
          }),
      )
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
      venue: ctx.venue,
      guestId: ctx.guest.id,
      // TAC-363: the model's referencesCommitmentId no longer selects the row.
      // Every open obligation this guest holds is swept, so a guest owed two
      // things has both surfaced when they walk in.
      activeCommitments: ctx.activeCommitments,
      now: ctx.recognition.computedAt,
    })
    if (arrival.kind === 'imminent_won') {
      // TAC-363: one push per obligation that actually transitioned. This loop
      // IS the "every open obligation is surfaced" acceptance criterion — a
      // guest owed two comps who walks in produces two heads-up cards, because
      // staff need to hand over both. Batching them into one push would be a
      // cross-repo Contract change: the payload carries a single commitmentId
      // and the operator app routes the tap on it.
      console.log(
        '[agent] inbound arrival imminent — transitioned to pending_ack',
        {
          agentRunId,
          commitmentIds: arrival.commitmentRows.map((r) => r.id),
          failedCount: arrival.failedCount,
        },
      )
      for (const commitmentRow of arrival.commitmentRows) {
        waitUntil(
          sendCommitmentArrivalPush({
            commitmentId: commitmentRow.id,
            venueId: commitmentRow.venue_id,
            guestId: commitmentRow.guest_id,
            guestFirstName: ctx.guest.firstName,
            type: commitmentRow.type,
            description: commitmentRow.description,
            code: commitmentRow.code,
            expectedArrival: commitmentRow.expected_arrival,
            arrivalSignal: 'imminent',
            venueTimezone: ctx.venue.timezone,
            agentRunId,
          }).catch((e) => {
            console.error(
              'apns: sendCommitmentArrivalPush threw unexpectedly',
              {
                agentRunId,
                commitmentId: commitmentRow.id,
                error: e instanceof Error ? e.message : String(e),
              },
            )
          }),
        )
      }
      if (arrival.failedCount > 0) {
        // Some of this guest's obligations did not move. They stay `open`, so
        // nothing is lost, but staff will not see them on this arrival.
        console.warn(
          '[agent] inbound arrival: some obligations failed to transition',
          {
            agentRunId,
            failedCount: arrival.failedCount,
            transitionedCount: arrival.commitmentRows.length,
          },
        )
      }
    } else if (arrival.kind === 'scheduled_recorded') {
      console.log(
        '[agent] inbound arrival scheduled — cron will fire at expected_arrival',
        {
          agentRunId,
          commitmentIds: arrival.commitmentRows.map((r) => r.id),
          expectedArrival: arrival.commitmentRows[0]?.expected_arrival ?? null,
          failedCount: arrival.failedCount,
        },
      )
    } else if (arrival.kind === 'closed_venue_skipped') {
      // TAC-363 ruling 1(a). The guest said they are heading over while the
      // venue is shut. Nothing is recorded and no operator is woken; the reply
      // is what tells them when the venue opens.
      console.log('[agent] inbound arrival ignored — venue closed', {
        agentRunId,
      })
    } else if (arrival.kind === 'no_open_obligations') {
      console.log(
        '[agent] inbound arrival with nothing owed to record it against',
        {
          agentRunId,
        },
      )
    } else if (
      arrival.kind === 'imminent_lost' ||
      arrival.kind === 'scheduled_lost'
    ) {
      console.log(
        '[agent] inbound arrival CAS lost (commitment already transitioned)',
        {
          agentRunId,
          kind: arrival.kind,
        },
      )
    } else if (arrival.kind === 'invalid_signal') {
      console.warn('[agent] inbound arrival capture invalid', {
        agentRunId,
        reason: arrival.reason,
      })
    } else if (arrival.kind === 'failed') {
      console.warn(
        '[agent] inbound arrival capture dispatch failed (continuing)',
        {
          agentRunId,
          error: arrival.error,
          errorCode: arrival.errorCode,
        },
      )
    }

    // Decision 0003, rewritten 2026-09-29: the four post-generation LLM
    // checks no longer run here. They run AFTER dispatch, off the guest's
    // critical path, in runPostSendChecks (see the send branch below and
    // ./post-send-checks.ts for the full contract). The gate keeps every
    // DETERMINISTIC protection: fidelity floors, the model's own self-flag,
    // the comp regex, commitment-type gating, unverified URLs, pending-slot
    // rules, per-category policy, hold_all_outbound — and the two structural
    // halves the deferred checks used to ride alongside:
    //   - the PURE cancellation resolution below (no model call), so a draft
    //     whose emission cancels a real commitment still queues (trigger 13)
    //     and a dangling id still holds (trigger 16);
    //   - the closed-venue EMISSION check, which the gate computes itself
    //     from the generation and the venue's hours.
    // The neutral literals are the gate's own documented defaults for
    // "this check did not run" ('skipped' / null), passed explicitly because
    // the cancellation slot must carry the live resolution rather than its
    // default.
    const approval = await applyApprovalPolicyStage(
      ctx,
      gen.result,
      { status: 'skipped' },
      { status: 'skipped' },
      {
        resolution: resolveCancellation(
          gen.result.cancelsCommitmentId,
          ctx.activeCommitments,
        ),
        claim: 'skipped',
      },
      { status: 'skipped' },
    )
    console.log('[agent] inbound approval decision', {
      agentRunId,
      action: approval.action,
      primaryTrigger:
        approval.action === 'queue' ? approval.primaryTrigger : null,
      triggers: approval.action === 'queue' ? approval.triggers : [],
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
    // TAC-397 case 2: this message needed no answer and the guest already
    // holds a conversation card. Nothing is written and nothing is sent, so
    // the card answering their earlier question is untouched — which is the
    // whole point. Before this, "haha" regenerated that card into a reply to
    // "haha" and the earlier question was lost.
    //
    // No PostHog event and no Slack relay (2026-09-22 ruling, question 4):
    // this is the expected outcome on a very common turn shape, not an
    // incident. The trace still records it, so a single run is explainable.
    if (approval.action === 'silence') {
      retractConfirmedVisit()
      console.log(
        '[agent] inbound draft silenced: nothing to answer, a card is already waiting',
        {
          agentRunId,
          guestId: ctx.guest.id,
          category: ctx.classification.category,
        },
      )
      trace.update({
        output: { status: 'silenced', category: ctx.classification.category },
        content: { silencedDraft: gen.result.body },
      })
      return { status: 'silenced' }
    }

    if (approval.action === 'drop') {
      retractConfirmedVisit()
      console.warn(
        '[agent] inbound draft dropped: a pending card holds its slot',
        {
          agentRunId,
          reason: approval.reason,
          protectedDraftId: approval.protectedDraftId,
          triggers: approval.triggers,
        },
      )
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
    // TAC-423 (ruled 2026-09-22): the opener turn records like every other
    // turn. TAC-332 used to exclude it here, on the grounds that the opener
    // scripted its own question about whether the guest was new, so the
    // classifier could only return a correct negative or a false positive that
    // would permanently close a one-shot goal. The September rewrite inverted
    // that premise by pointing the opener's question at understand_order, and
    // the rewrite in serializers.ts removes the scripted question altogether:
    // what the opener turn now asks IS the first intention line, so refusing to
    // record it was refusing to record the one ask this turn reliably makes.
    //
    // Measured before the change, at Le Mil's: five guests enrolled by scanning,
    // understand_order armed for every one of them and recorded as asked once.
    //
    // (A residual recorded here until TAC-575: learn_name used to be open on
    // the opener turn too, so a false-positive name prompt could close it for
    // good. No replies_only intention is open on a guest's first reply now.)
    const renderedIntentions = renderableIntentions(
      ctx.openIntentions,
      ctx.classification.category,
      ctx.pendingQuestion !== null,
      ctx.reviewAsk !== null,
      ctx.visitCheckinHold,
    )

    if (approval.action === 'queue') {
      retractConfirmedVisit()
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
            callerPolicy: 'regen',
            // TAC-397: keep what a correction replaced, and let 23505 recovery
            // re-decide with the same disposition the gate used.
            captureReplacedDraft: approval.captureReplacedDraft,
            conversationDisposition: approval.conversationDisposition,
            // TAC-401: the commitment the prose-promise check named, so the
            // card an operator approves creates a real guest_commitments row.
            // Without this line the check catches the promise and the promise
            // still goes untracked, which is the entire ticket.
            promisedCommitment: approval.promisedCommitment,
            // TAC-513: the cancellation this card carries, applied when an
            // operator approves or edits it.
            pendingCancellation: approval.pendingCancellation,
            // TAC-385 PR 1: carry the rendered set onto the card so
            // dispatchOperatorOutbound can record the ask if an operator
            // approves or edits it. Nulled by the persist layer under
            // blankBody.
            renderedIntentions,
          },
        )
        if (persistResult.action === 'silenced') {
          // TAC-397: unreachable while the gate returns silence before persist
          // is called, which it does for every 'no_answer' turn. Handled
          // rather than cast away, because that guarantee lives in stages.ts
          // and this is where a null id would otherwise be typed `string`.
          console.warn('[agent] persist returned silenced in race recovery', {
            agentRunId,
            guestId: ctx.guest.id,
          })
          return { status: 'silenced' }
        }
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
          console.warn(
            '[agent] inbound draft dropped in race recovery: a pending card took its slot',
            {
              agentRunId,
              reason: persistResult.reason,
              protectedDraftId: persistResult.protectedDraftId,
            },
          )
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
        const {
          outboundMessageId,
          action: persistAction,
          priorReviewReason,
        } = persistResult
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
        // primaryTrigger internally (model_flagged / comp_regex_backstop
        // fire; previous_pending_held skips) and is `never throws` so the
        // .catch is defensive belt-and-braces.
        if (shouldSendDraftFlaggedPush(approval.primaryTrigger)) {
          waitUntil(
            sendDraftFlaggedPush({
              agentRunId,
              venueId: ctx.venue.id,
              guestId: ctx.guest.id,
              guestFirstName: ctx.guest.firstName,
              draftId: outboundMessageId,
              primaryTrigger: approval.primaryTrigger,
              guestQuestion: ctx.currentMessage?.body ?? null,
              guestCategory: ctx.classification?.category ?? null,
              guestIsCrisis: ctx.classification?.crisisSafety ?? false,
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
        queueSpan.end({
          level: 'ERROR',
          statusMessage: errMsg,
          output: { stage: 'persist' },
        })
        return { status: 'failed', stage: 'persist', error: errMsg }
      }
    }

    // TAC-526: the extension. A message that landed while this run was
    // generating means the guest has moved past what we are about to send, so
    // adopt it and generate again rather than answering a stale turn.
    //
    // ONLY ON THE AUTO-SEND PATH, never the queue path above: a draft waiting
    // for an operator is TAC-397's `resolveConversationDisposition`, and this
    // ticket does not touch it. The boundary is a run in progress (here)
    // versus a draft already waiting (there).
    //
    // NOT ON THE CRISIS PATH either, and that is structural rather than a
    // check: the crisis short-circuit returns hundreds of lines above this,
    // before retrieval. A crisis reply is fixed and unconditional, and
    // deferring it to a newer fragment is the worst failure this feature could
    // have.
    //
    // NOT ON AN OPT_OUT TURN (TAC-572). The opt-out is already recorded by
    // here, so re-entering would re-decide against an opted-out guest on a
    // different message: "thanks" would silence the turn and discard the
    // confirmation, and anything else would opt the guest straight back in
    // inside the turn that opted them out. The confirmation goes out as
    // generated, and the newer message becomes its own turn at the handoff,
    // where the opt-out rules apply to it as they would a minute later.
    if (ctx.classification.category !== 'opt_out' && mayExtend(turn)) {
      const uncovered = await findUncoveredInbound(
        { venueId: ctx.venue.id, guestId: ctx.guest.id },
        turn,
        coalesceDeps,
      )
      // Only 'found' extends. 'unreadable' sends what we have, which is the
      // right direction HERE and the wrong one at the handoff — see
      // findUncoveredInbound's own docstring for why the two callers differ.
      if (uncovered.status === 'found') {
        turn.extensionsUsed += 1
        console.log('[agent] inbound turn extending to a newer message', {
          agentRunId,
          extensionsUsed: turn.extensionsUsed,
          from: ctx.currentMessage.id,
          to: uncovered.message.id,
        })
        // Re-enter with the SAME claim and the SAME agentRunId: one turn, one
        // claim, one ledger row. A fresh handleInbound would mint a second run
        // id and a second row for one guest action, which is what breaks the
        // ledger's denominator.
        return await runInboundTurn(
          uncovered.message.id,
          agentRunId,
          turn,
          coalesceDeps,
        )
      }
    }

    // TAC-573: past the extension check, so this generation is the turn's last.
    retractConfirmedVisit()

    // Send + persist. TAC-284: demo guests skip the read receipt and typing
    // indicators (TAC-421 removed the pre-send sleep this also used to skip)
    // and, when applyApprovalPolicyStage short-circuited the gate, the send is
    // stamped review_reason='demo_bypass' (approval.reason is undefined on a
    // normal untriggered send).
    // TAC-568: does this reply close the guest's first conversation?
    //
    // ONE WAY IN, decided by closesFirstConversation: the guest said goodbye
    // and we answered with one. TAC-575 removed the second (the turn that
    // learned their name); a guest who simply goes quiet is the pause timer's.
    //
    // Decided BEFORE the send, and the marker is CLAIMED before the send too,
    // because the claim is what makes "once per guest, ever" a fact Postgres
    // enforces rather than an argument about ordering. This is the timer's own
    // claim-before-the-side-effect rule (warm-close-timeout.ts), applied on the
    // path that actually talks to a guest who is still in the conversation.
    //
    // The pause timer cannot race this: its candidate scan only produces a guest
    // whose NEWEST message is our outbound, and an inbound turn in flight means
    // the guest's own message is newest. The CAS is the belt anyway.
    //
    // TAC-572: never on an opt_out turn. The confirmation is the last thing a
    // guest who asked to stop should read, and a close that invites them back
    // in riding behind it is a message they did not ask for.
    const claimedWarmClose =
      ctx.classification.category !== 'opt_out' &&
      closesFirstConversation({
        guestSignedOff: ctx.classification.category === SIGN_OFF_CATEGORY,
        agentSaidGoodbye: gen.result.closedTheConversation,
        isFirstConversation: ctx.firstConversation,
        warmCloseText: ctx.venue.warmCloseText,
      })
        ? await claimWarmCloseForTurn(ctx, agentRunId)
        : null

    const sendSpan = trace.span('send', { bodyLength: gen.result.body.length })
    try {
      const dispatched = await dispatchReply(ctx, gen.result, {
        skipHumanFeelDelay: ctx.guest.isDemo === true,
        reviewReason: approval.reason,
        // TAC-568: the fixed close rides as this response's own last bubble,
        // 1.5s after the goodbye. '' whenever the claim was not taken — which
        // includes a guest who has already been closed by either path.
        warmCloseBubble: claimedWarmClose?.text ?? '',
        // TAC-436 ruling 4: the SAME hoisted value the queue branch stores
        // and this branch records against, so what a card carries and what
        // an auto-send carries cannot drift. The recording below is what
        // actually closes the intentions.
        //
        // TAC-554 gave this a SECOND job, so it is no longer audit-only on
        // this path: dispatch reads its length through intentionTailFor to
        // decide whether the getting-to-know-you question earns its own
        // message. Passing it is now load-bearing rather than bookkeeping.
        renderedIntentions,
        // TAC-469: the Instagram reply check. If this message already has an
        // answer (usually one staff typed in the Instagram app), send nothing.
        // Ignored on the text arm.
        replyCheck: { inboundMessageId: ctx.currentMessage.id },
        onUndelivered: 'card',
      })
      if (dispatched.kind !== 'sent') {
        sendSpan.end({
          level: 'WARNING',
          output: { outcome: dispatched.kind },
        })
        trace.update({ output: { status: dispatched.kind } })
        // TAC-568: nothing reached the guest, so the close did not happen. Give
        // the marker back rather than spending this guest's one close on a
        // message they never saw. An Instagram guest then gets the timer's
        // own two-hour window; on SMS this turn was the only chance, which is
        // the more reason to release rather than keep a claim nothing spent.
        await releaseClaimedWarmClose(claimedWarmClose, agentRunId)
        return undeliveredAgentResult(ctx, dispatched)
      }
      const {
        outboundMessageId,
        providerMessageId,
        generationId,
        bubbleCount,
      } = dispatched
      if (dispatched.undelivered !== null) {
        // TAC-568: the close is the LAST bubble, so a partly delivered reply is
        // precisely the case where it did not go out. Release before anything
        // else reads the marker.
        await releaseClaimedWarmClose(claimedWarmClose, agentRunId)
        // Part of a split Instagram reply went out; the rest became a card (or
        // couldn't, and the Slack event says why).
        console.warn('[agent] inbound reply partly delivered', {
          agentRunId,
          outboundMessageId,
          reason: dispatched.undelivered.reason,
          cardId: dispatched.undelivered.cardId,
        })
        if (dispatched.undelivered.cardId !== null)
          pushSendFailureCard(ctx, dispatched.undelivered.cardId)
      }
      // Decision 0003 rewrite: the four post-generation checks run HERE, off
      // the critical path, against the reply that just went out. waitUntil
      // composes with the webhook's outer keep-alive window; the module never
      // throws and flushes its own spans. Only the sent path runs them — a
      // queued draft is already in front of an operator, and drop/silence
      // sent nothing to check.
      waitUntil(
        runPostSendChecks({
          ctx,
          generation: gen.result,
          agentRunId,
          outboundMessageId,
          trace,
        }),
      )
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
      // The once-ever review-ask stamp. Judged against deliveredBody, not
      // gen.result.body: on a partly delivered Instagram split the ask is the
      // LAST bubble, so it is exactly the text most likely to have died, and
      // stamping an ask the guest never saw would spend their one ask on
      // nothing (the same reason intention recording below reads
      // deliveredBody). Fire-and-forget: the send already happened, so a
      // marker failure is a possible second ask later — logged, never a
      // broken turn.
      if (
        ctx.reviewAsk !== null &&
        bodyContainsReviewLink(dispatched.deliveredBody, ctx.reviewAsk.url)
      ) {
        const reviewAskLabel = ctx.reviewAsk.label
        const reviewAskVenueId = ctx.venue.id
        const reviewAskGuestId = ctx.guest.id
        waitUntil(
          markReviewAsked({
            venueId: reviewAskVenueId,
            guestId: reviewAskGuestId,
            now: new Date(),
          })
            .then(async (marked) => {
              if (!marked.ok) {
                console.warn(
                  '[agent] review-ask marker write failed; guest may be asked again',
                  { agentRunId, error: marked.error },
                )
                return
              }
              await captureReviewAskSent({
                agentRunId,
                via: 'auto_send',
                venueId: reviewAskVenueId,
                guestId: reviewAskGuestId,
                messageId: outboundMessageId,
                outcome: marked.data,
              })
              console.log('[agent] review ask sent', {
                agentRunId,
                outcome: marked.data,
                linkLabel: reviewAskLabel,
              })
            })
            .catch((e) => {
              console.error('[agent] markReviewAsked threw unexpectedly', {
                agentRunId,
                error: e instanceof Error ? e.message : String(e),
              })
            }),
        )
      }
      // TAC-575: the "how is it so far?" question reached the guest, so this
      // visit now has a check-in. Everything later in the visit reads this row.
      //
      // TWO SIGNALS, EITHER ONE WRITES THE ROW, because each misses a case the
      // other catches:
      //
      //   the sent field   the question rode in `intentionQuestion` as the exact
      //                    tail of the reply (decision 0007) and the delivered
      //                    body contains it. Deterministic, and written at once.
      //   the classifier   the post-send classifier below says this reply
      //                    raised hows_it_so_far. That is the only thing that
      //                    sees a question the model wrote into `body`, which
      //                    TAC-554 measured it doing routinely; the field is
      //                    then empty, or dropped for the body's own `?`.
      //
      // A classifier false positive writes a row for a question never asked,
      // which costs one check-back. A missing row costs the visit its
      // check-back, its sign-off ask and the hold on other questions, so the
      // wider net is the cheaper mistake.
      //
      // `eligibleAt` is when the guest named their order: the intention's
      // anchor is that message's arrival, which is also what "ten minutes after
      // the order" is measured from. It is this turn's message unless the
      // question could not go out on the order turn and is going out late.
      //
      // AUTO-SEND ONLY. A reply held for approval writes no row even if an
      // operator sends it, so that visit gets no check-back, no hold on other
      // questions and no review ask at the sign-off. It is still not asked
      // twice: the operator path records the intention's prompt, and arming
      // reads that too (build-runtime-context, promptedThisVisit). A known
      // limit, stated on the PR.
      const askedHowItIs = renderedIntentions.find(
        (o) => o.key === 'hows_it_so_far',
      )
      const sentQuestion = gen.result.intentionQuestion.trim()
      const checkinVenueId = ctx.venue.id
      const checkinGuestId = ctx.guest.id
      const checkinLocalDate = ctx.visitLocalDate
      const orderMessage = {
        id: ctx.currentMessage.id,
        receivedAt: ctx.currentMessage.receivedAt,
      }
      // One writer for both signals below. Idempotent by the table's unique
      // index, so being called by both costs a 23505 and nothing else.
      const recordAskedHowItIs = async (
        via: 'sent_field' | 'classifier',
      ): Promise<void> => {
        if (askedHowItIs === undefined || checkinLocalDate === null) return
        const orderedAt = askedHowItIs.eligibleAt
        const recorded = await recordVisitCheckinAsked(createAdminClient(), {
          venueId: checkinVenueId,
          guestId: checkinGuestId,
          venueLocalDate: checkinLocalDate,
          orderMessageId:
            orderedAt.getTime() === orderMessage.receivedAt.getTime()
              ? orderMessage.id
              : null,
          orderedAt,
          askedAt: new Date(),
        })
        if (!recorded.ok) {
          console.error('[agent] visit check-in write failed', {
            agentRunId,
            guestId: checkinGuestId,
            via,
            error: recorded.error,
          })
          return
        }
        console.log('[agent] visit check-in asked', {
          agentRunId,
          guestId: checkinGuestId,
          venueLocalDate: checkinLocalDate,
          via,
          outcome: recorded.data,
        })
      }
      if (
        askedHowItIs !== undefined &&
        sentQuestion !== '' &&
        dispatched.deliveredBody.includes(sentQuestion)
      ) {
        waitUntil(recordAskedHowItIs('sent_field'))
      }
      // TAC-575: this reply worked the check-back in, so the visit's one
      // check-back is spent. Claimed and stamped sent in one write, AFTER the
      // send, because here the question has already gone: the timer's
      // claim-before-send order protects against a send that might not
      // happen, and this one did. The timer cannot race it. It needs our
      // message to be the newest and to have sat for CHECKBACK_QUIET_FLOOR_MS,
      // and this write lands seconds after the reply.
      //
      // The same two signals as the question above, for the same reason.
      const checkedBack = renderedIntentions.find(
        (o) => o.key === 'check_back_on_order',
      )
      const checkbackRowId = ctx.visitCheckin?.id ?? null
      const recordCheckedBack = async (
        via: 'sent_field' | 'classifier',
      ): Promise<void> => {
        if (checkedBack === undefined || checkbackRowId === null) return
        const claim = await claimVisitCheckback(createAdminClient(), {
          id: checkbackRowId,
          venueId: checkinVenueId,
          guestId: checkinGuestId,
          now: new Date(),
          sent: true,
        })
        if (claim.status === 'failed') {
          // The timer may now send a second check-back. Visible, not silent.
          console.error('[agent] visit check-back claim failed', {
            agentRunId,
            guestId: checkinGuestId,
            via,
            error: claim.error,
          })
          return
        }
        console.log('[agent] visit check-back asked in conversation', {
          agentRunId,
          guestId: checkinGuestId,
          via,
          outcome: claim.status,
        })
      }
      const checkbackSeenInField =
        checkedBack !== undefined &&
        sentQuestion !== '' &&
        dispatched.deliveredBody.includes(sentQuestion)
      if (checkbackSeenInField) {
        waitUntil(recordCheckedBack('sent_field'))
      }
      // TAC-575, ruled 2026-10-06: COUNT THE CASE NEITHER SIGNAL CATCHES. The
      // model can write the check-back into `body` and the classifier can miss
      // it; nothing then claims the row and the guest can be checked back on a
      // second time. That is an accepted limit, but an unmeasured one, so when
      // the check-back was the turn's one rendered question, neither signal
      // recorded it, and the reply that went out still asks SOMETHING, say so.
      //
      // "Looks like one" is a bare `?` in what the guest received. Crude on
      // purpose and safe on this population: on this turn the prompt told the
      // model the reply asks nothing but the check-back, so a question mark in
      // it is the check-back far more often than not. Our outbound copy always
      // punctuates a question (the detector composeReplyWithIntention uses).
      // A false positive costs a log line, and the message id is on it.
      const checkbackLooksUnrecorded = (classifierRaisedIt: boolean): boolean =>
        checkedBack !== undefined &&
        !checkbackSeenInField &&
        !classifierRaisedIt &&
        dispatched.deliveredBody.includes('?')
      const warnCheckbackUnrecorded = (
        classifier: 'not_raised' | 'failed',
      ): void => {
        console.warn(
          '[agent] visit check-back may have gone out unrecorded; a second can follow',
          {
            agentRunId,
            guestId: checkinGuestId,
            classifier,
            // The row id, not the text: the body is the guest's conversation
            // and this is a console line. The message is one lookup away.
            outboundMessageId,
          },
        )
      }
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
                // TAC-575: the second signal. See recordAskedHowItIs.
                if (outcome.raisedKeys.includes('hows_it_so_far')) {
                  await recordAskedHowItIs('classifier')
                }
                const classifierSawCheckback = outcome.raisedKeys.includes(
                  'check_back_on_order',
                )
                if (classifierSawCheckback) {
                  await recordCheckedBack('classifier')
                }
                if (checkbackLooksUnrecorded(classifierSawCheckback)) {
                  warnCheckbackUnrecorded('not_raised')
                }
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
                // TAC-575: no verdict at all is also "the classifier did not
                // record it".
                if (checkbackLooksUnrecorded(false)) {
                  warnCheckbackUnrecorded('failed')
                }
                // Ruling 4: nothing re-asks, but these closed without a
                // verdict. Alerted so a run of them is visible.
                console.warn(
                  '[agent] intention classifier failed twice; rendered intentions closed',
                  {
                    agentRunId,
                    closedKeys: outcome.closedKeys,
                    error: outcome.classifierError,
                  },
                )
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
              console.error(
                '[agent] recordIntentionPrompts threw unexpectedly',
                {
                  agentRunId,
                  error: e instanceof Error ? e.message : String(e),
                },
              )
            }),
        )
      }
      // TAC-568: the close went out as this response's last bubble. The marker
      // was already claimed before the send (see claimWarmCloseForTurn), so
      // nothing is written here — this only reports it.
      //
      // WHY THE CLAIM MOVED. Before TAC-568 the model WROTE the close itself and
      // this block recorded that it had, after the fact. Now the close is a fixed
      // string this code appends, so "did we send it" and "is it marked" are one
      // decision and belong in one statement. Marking after the send would leave
      // a window in which a second path could claim the same guest.
      if (claimedWarmClose !== null && dispatched.undelivered === null) {
        await captureWarmCloseSent({
          agentRunId,
          venueId: ctx.venue.id,
          guestId: ctx.guest.id,
          via: 'in_conversation',
          answersMessageId: ctx.currentMessage?.id ?? null,
          markerOutcome: 'marked',
        })
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
        attempts: gen.result.attempts,
        matchCount: ctx.corpus.length,
      })
      trace.update({
        output: {
          status: 'sent',
          outboundMessageId,
        },
        content: { outboundDraft: gen.result.body },
      })
      return { status: 'sent', outboundMessageId }
    } catch (e) {
      // scheduleAndSend already fired the appropriate stage-specific alert.
      const errMsg = e instanceof Error ? e.message : String(e)
      const stage: 'send' | 'persist' = errMsg.includes('persist failed')
        ? 'persist'
        : 'send'
      // TAC-568: RELEASE HERE TOO, and this arm is the one that bites.
      //
      // The two returns above release on a dispatch that reported failure. A
      // dispatch that THROWS took neither, so the marker stayed claimed for a
      // close that never went out — and `failed` is a retrying status
      // (shouldRetryTurn in coalesce-turn.ts), so the retry read `already_marked`
      // and the guest could never be closed by any path. Permanently, on one
      // transient send error.
      //
      // Safe on every throwing case, because scheduleAndSend only throws while
      // NOTHING has been committed (`persistedIds.length === 0`); once a bubble
      // is out it truncates instead. The close is the LAST bubble, so a throw
      // always means it did not reach the guest. The release is CAS-scoped to
      // the exact timestamp this turn wrote, so it cannot clear a marker the
      // pause timer set in between.
      //
      // Not covered: a throw between claimWarmCloseForTurn and this `try`. That
      // is two statements with no I/O, and `claimedWarmClose` is out of scope in
      // the outer catch, so closing it would mean restructuring rather than
      // adding a line. Stated rather than silently left.
      await releaseClaimedWarmClose(claimedWarmClose, agentRunId)
      sendSpan.end({
        level: 'ERROR',
        statusMessage: errMsg,
        output: { stage },
      })
      return { status: 'failed', stage, error: errMsg }
    }
  } catch (unexpected) {
    const errMsg =
      unexpected instanceof Error ? unexpected.message : String(unexpected)
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
    // `entryExtensionDepth === 0` keeps one turn to one measurement: an
    // extension re-enters this function, and both calls would otherwise emit,
    // double-counting a single turn. The outermost call's elapsed covers the
    // settle and every extension, which is the number worth having.
    if (!skipLatencyEmit && entryExtensionDepth === 0) {
      const totalElapsedMs = Date.now() - start
      if (isAgentLatencyHigh('inbound', totalElapsedMs)) {
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
