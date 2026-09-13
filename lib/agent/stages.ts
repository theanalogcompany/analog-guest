import {
  captureClassificationLowConfidence,
  captureCorpusRetrievalBelowThreshold,
  captureDashViolationPersisted,
  captureDemoBypassedApprovalGate,
  captureMechanicOfferBackstopCaught,
  captureRegenerationTriggered,
  captureUngroundedClaimCaught,
  captureVoiceFidelityLow,
  CLASSIFICATION_CONFIDENCE_LOW_THRESHOLD,
  CLASSIFICATION_CONFIDENCE_REROUTE_THRESHOLD,
  CORPUS_TOP_SIMILARITY_LOW_THRESHOLD,
  VOICE_FIDELITY_LOW_THRESHOLD,
} from '@/lib/analytics/posthog'
import {
  classifyMessage,
  type FollowupAnchorVisit,
  type FollowupContext,
  type FollowupReason,
  generateMessage,
  type GenerateMessageResult,
  type KnowledgeCorpusChunk as AiKnowledgeCorpusChunk,
  type RuntimeContext as AiRuntimeContext,
  verifyGrounding,
  verifyMechanicOffer,
  type VoiceCorpusChunk as AiVoiceCorpusChunk,
} from '@/lib/ai'
import { createAdminClient } from '@/lib/db/admin'
import { resolveOpenState } from '@/lib/schemas'
import { resolveCategoryPolicy, resolvePolicyDecision } from '@/lib/schemas/approval-policy'
import { retrieveContext, retrieveKnowledgeContext } from '@/lib/rag'
import { fireRedAlert } from './alerts'
import { matchComp } from './comp-backstop'
import { isFloorCategory, matchForwardCommitment } from './complaint-floor'
import { canAutoSendComplaintTurn } from './complaint-routing'
import { REPORTED_ORDER_WINDOW_DAYS } from './extract-reported-order'
import { getPrimaryTagPreference } from './knowledge-tag-mapping'
import type {
  Classification,
  CorpusMatch,
  FollowupTrigger,
  KnowledgeMatch,
  RuntimeContext,
  Visit,
} from './types'
import type { MessageCategory } from '@/lib/ai'

export const STRONG_MATCH_SIMILARITY = 0.3
export const MIN_STRONG_MATCHES = 1
export const SEND_FIDELITY_FLOOR = 0.4
// TAC-212: voice fidelity below this queues the draft for operator review;
// above auto-sends (subject to the rest of applyApprovalPolicyStage).
// Sits above SEND_FIDELITY_FLOOR — < 0.4 still refuses, 0.4..0.6 queues,
// >= 0.6 evaluates the resource-commitment + sticky-pending triggers.
export const AUTO_SEND_FIDELITY_FLOOR = 0.6
export const CORPUS_RETRIEVE_LIMIT = 8
export const KNOWLEDGE_RETRIEVE_LIMIT = 4

/**
 * TAC-350: minimum cosine similarity for a knowledge_corpus chunk to be
 * treated as actually relevant to the guest's question, rather than padding.
 *
 * `lib/rag/retrieve.ts`'s own `SIMILARITY_FLOOR` (0.3) is a much looser bar
 * shared with voice-corpus retrieval, and in practice it almost never
 * excludes anything once a venue's knowledge corpus has more than a handful
 * of rows — every one of 12 representative queries run against Le Mil's live
 * corpus during the TAC-350 audit returned a full KNOWLEDGE_RETRIEVE_LIMIT
 * chunks above 0.3, including for a genuinely unanswerable question (wifi
 * password) where every returned chunk was topically unrelated. That matters
 * because `knowledgeChunksToProse` frames whatever it's given as "facts...
 * you can ground replies in" — presenting four irrelevant chunks under that
 * header on a genuinely unanswerable question invites fabrication instead of
 * the "no specific venue knowledge matched" framing that should fire.
 *
 * 0.5 is calibrated against that same audit data: across 7 queries with a
 * genuinely on-topic answer in Le Mil's corpus (menu items, sourcing,
 * catering, pastries, roasting cadence) the weakest top match was 0.5170;
 * across 5 genuinely off-topic queries (wifi, bathroom, weather, dog-
 * friendly, parking) the strongest top match was 0.4900 — a clean, if
 * narrow, empirical gap. This is calibrated against ONE venue's corpus and
 * embedding distribution; revisit if a differently-sized or differently-
 * written corpus shows the gap doesn't hold.
 *
 * Applied per-chunk (not just as an all-or-nothing top-match gate) so a
 * strong match isn't diluted by weaker padding chunks riding along beside it.
 *
 * Side effect worth knowing: the tag-preference fallback retry in
 * retrieveKnowledgeStage now fires on zero RELEVANT results rather than zero
 * RETURNED results, so it fires measurably more often than before this floor
 * existed — an accepted cost (one extra Voyage embed call, no caching between
 * the two calls) of a floor calibrated against real production data.
 */
export const KNOWLEDGE_RELEVANCE_FLOOR = 0.5

/**
 * TAC-308: how long an operator has to answer a knowledge-gap card before the
 * guest gets a holding message, in milliseconds.
 *
 * This is a FLOOR, not an SLA. `messages.pending_until` is the earliest the
 * holding message may fire; the timer is an external HTTP cron (cron-job.org)
 * hitting /api/cron/pending-timeout every minute, so the message lands within
 * roughly 6 minutes of the floor. The cost of lateness is a guest waiting
 * slightly longer inside a silence they are already in, whereas firing EARLY
 * would talk over an operator who was about to answer. Never shorten the
 * check to compensate for jitter.
 *
 * Shared constant, not per-venue, per the ticket's out-of-scope list.
 */
export const KNOWLEDGE_GAP_WINDOW_MS = 5 * 60 * 1000

/**
 * TAC-212 approval-policy triggers. Used as both the keys for the
 * `triggers: string[]` array on a queue decision AND the lookup keys for
 * PRIMARY_TRIGGER_PRIORITY. Exported so the orchestrator (handle-inbound,
 * handle-followup), the PostHog event helper, and tests can reuse the
 * literal strings without copy-paste drift.
 */
export const APPROVAL_TRIGGERS = {
  FIDELITY_BELOW_AUTO_SEND_FLOOR: 'fidelity_below_auto_send_floor',
  MODEL_FLAGGED: 'model_flagged',
  COMP_REGEX_BACKSTOP: 'comp_regex_backstop',
  PREVIOUS_PENDING_HELD: 'previous_pending_held',
  // TAC-297: structural gate fires when the agent emits a commitment with
  // type ∈ {comp, hold, discount}. Independent of requiresOperatorApproval —
  // the structured emission IS the backstop, stronger than the NL comp regex
  // and covers holds without leaky NL matching (per the TAC-297 plan-review
  // call #2). Recommendation type does NOT fire this trigger.
  COMMITMENT_TYPE_GATED: 'commitment_type_gated',
  // TAC-XXX: per-venue blanket hold. Fires when venues.hold_all_outbound is
  // true AND the message is not a compliance reply (opt_out confirmation).
  // Venue-wide policy rather than a per-message signal, so it's ranked LAST in
  // PRIMARY_TRIGGER_PRIORITY — a co-firing comp/commitment carries more
  // operator-actionable information and should win the review_reason label.
  HOLD_ALL_OUTBOUND: 'hold_all_outbound',
  // v1.23.0: deterministic category floor. Fires when a complaint-category
  // reply carries first-person forward-commitment grammar, REGARDLESS of what
  // the model concluded about its own commitment. Exists because the
  // 2026-08-07 incident was the model reasoning its way around the self-flag
  // line ("a remake isn't a monetary credit"), so widening the prompt's
  // enumeration alone would only relocate the line it argued past. See
  // lib/agent/complaint-floor.ts for the measured precision numbers.
  COMPLAINT_COMMITMENT_FLOOR: 'complaint_commitment_floor',
  // v1.24.0: per-category routing from venue_configs.approval_policy. Fires
  // BEFORE the model has said anything meaningful — it inspects the
  // classification, not the draft. Today it routes comp_complaint, so a guest
  // reporting a bad experience gets a warm, comp-forward draft that a human
  // authorizes rather than an agent deciding on its own. One exemption — a
  // genuine clarifying question (canAutoSendComplaintTurn) — and since
  // TAC-307 it applies ONLY when the hold came from the fleet-wide code
  // default. A hold a venue chose explicitly is absolute.
  CATEGORY_REQUIRES_APPROVAL: 'category_requires_approval',
  // TAC-308: the model answered a guest question it could not ground in venue
  // knowledge. Queues the draft AND arms messages.pending_until, which is the
  // only trigger that starts a clock — if no operator answers before it
  // elapses, the timer cron sends the guest a holding message. Inbound-only:
  // a followup has no guest question to leave unanswered.
  KNOWLEDGE_GAP: 'knowledge_gap',
  // TAC-350: independent grounding backstop. `KNOWLEDGE_GAP` is pure
  // self-report (GenerateMessageResult.knowledgeGap) — the TAC-350 audit
  // found 8/8 observed fabrications had knowledgeGap=false, so self-report
  // alone missed every one of them. This trigger fires from a SECOND,
  // independent check (verifyGroundingStage / lib/ai/verify-grounding.ts)
  // that inspects the reply against the same source material the generator
  // saw, and is only ever invoked when the model's own self-report was
  // false — same relationship COMP_REGEX_BACKSTOP has to MODEL_FLAGGED.
  // Deliberately a DISTINCT trigger rather than folding into KNOWLEDGE_GAP,
  // so analytics can separate "the model was honest about not knowing" from
  // "the model was caught stating something it shouldn't have." The two are
  // mutually exclusive on any single turn (this trigger only runs when
  // knowledgeGap is false), but every OTHER piece of knowledge-gap-card
  // behavior — body blanking, clock arming, protected-card carve-out, the
  // SEND_FIDELITY_FLOOR exemption — must treat both triggers identically
  // regardless of which one fires. See isKnowledgeGapCard and
  // knowledgeGapWillQueue's sibling logic below.
  KNOWLEDGE_GAP_BACKSTOP: 'knowledge_gap_backstop',
  // TAC-355: deterministic backstop. Fires unconditionally when
  // GenerateMessageResult.selfTalkViolationPersisted is true — the reply
  // still contains self-correction or a reference to the agent's own
  // instructions/rules/AI-nature after every regen attempt inside
  // generateMessage's loop (lib/ai/self-talk-detector.ts). Never a send:
  // unlike the dash regex (THE-225), which ships anyway on exhaustion, a
  // guest reading agent self-talk learns they're texting a bot, which is
  // categorical harm regardless of rate.
  SELF_TALK_DETECTED: 'self_talk_detected',
  // TAC-355: independent verification-call backstop for the mechanic-
  // approval gate. `requiresOperatorApproval` self-flag and the structural
  // COMMITMENT_TYPE_GATED trigger both missed a real approval-gated mechanic
  // grant (Referral Surprise, le-mils-coffee) — audited and confirmed
  // structural, not a misconfiguration: nothing in the prompt links a
  // mechanic grant from "## What this guest can access" to commitment.type,
  // and at least one live venue has zero of its gated mechanics mapping
  // cleanly onto that vocabulary. This is the PRIMARY mechanism for that
  // failure mode, not a secondary layer (unlike COMP_REGEX_BACKSTOP's
  // relationship to MODEL_FLAGGED) — see lib/ai/verify-mechanic-offer.ts and
  // verifyMechanicOfferStage below. FAILS CLOSED: an errored, timed-out, or
  // unparseable check queues rather than degrading to pre-check behavior —
  // a deliberate divergence from verifyGroundingStage (TAC-350), which fails
  // open. An unauthorized perk grant costs the owner money and control; a
  // failed check costs one unnecessary review.
  MECHANIC_OFFER_BACKSTOP: 'mechanic_offer_backstop',
} as const

/**
 * Union of every trigger code that can land on `messages.review_reason`.
 * Consumed by the operator-queue normalizer (lib/operator/queue.ts) to
 * keep the human-readable label map exhaustive at compile time — adding
 * a new trigger above without a corresponding label there is a TS error.
 */
export type ApprovalTrigger = (typeof APPROVAL_TRIGGERS)[keyof typeof APPROVAL_TRIGGERS]

/**
 * Priority order for picking the `primaryTrigger` (the value that lands on
 * messages.review_reason and shows up first in the operator queue UI). NOT
 * the order triggers are evaluated in (that's enumeration order, which
 * controls the `triggers: string[]` array — `triggers[0]` is the first one
 * that fired during evaluation).
 *
 * Severity rationale: structured commitment type (TAC-297) outranks comp
 * regex because the structured signal carries explicit type information
 * (the operator queue UI sees "hold" vs "comp" vs "discount" directly
 * rather than just "regex matched some comp prose"). Irreversible financial
 * commitments (comp regex hit) outrank model self-flag because the regex is
 * deterministic + the failure mode it protects against is a comp going out
 * unreviewed. Model-flagged resource commitments outrank sticky-pending
 * because operator attention should land on the new commitment, not on "we
 * already had a pending draft." Soft signals (fidelity_below_auto_send_floor)
 * come last.
 */
export const PRIMARY_TRIGGER_PRIORITY = [
  APPROVAL_TRIGGERS.COMMITMENT_TYPE_GATED,
  // TAC-355: ranked directly after COMMITMENT_TYPE_GATED — parity with it,
  // not below it. This backstop is the PRIMARY defense for the mechanic-
  // grant failure mode (see its own comment on APPROVAL_TRIGGERS above), so
  // an unauthorized-perk signal should carry the same operator-facing
  // priority as an unauthorized comp/hold/discount.
  APPROVAL_TRIGGERS.MECHANIC_OFFER_BACKSTOP,
  // TAC-308: second, deliberately not first. The ticket asked for "top of
  // priority," but that request was reasoning about the TIMER — and the timer
  // anchors on messages.pending_until, not on review_reason, so rank decides
  // only which label the operator card shows. Ranked below
  // COMMITMENT_TYPE_GATED because a comp/hold/discount losing its label is the
  // worse failure (this repo has bled from an unlabelled comp signal twice),
  // and above everything else because a knowledge-gap card is the only card
  // with a running clock and a guest sitting in silence. A gap-only turn —
  // the overwhelmingly common case — still wins the label.
  //
  // TAC-350: KNOWLEDGE_GAP_BACKSTOP ranks ABOVE the self-reported
  // KNOWLEDGE_GAP, mirroring COMP_REGEX_BACKSTOP's rank above MODEL_FLAGGED
  // — a caught claim is a more specific, more useful operator label than an
  // honest "I don't know." The two can never co-fire on the same turn (the
  // backstop only runs when knowledgeGap is already false), so this ordering
  // is a documentation choice today, not a live tie-break — but a real one,
  // consistent with the existing backstop-outranks-self-report pattern.
  APPROVAL_TRIGGERS.KNOWLEDGE_GAP_BACKSTOP,
  APPROVAL_TRIGGERS.KNOWLEDGE_GAP,
  APPROVAL_TRIGGERS.COMP_REGEX_BACKSTOP,
  APPROVAL_TRIGGERS.MODEL_FLAGGED,
  // TAC-355: a hard, deterministic catch (once it fires, the guest-facing
  // text is confirmed broken), but ranked below every resource/financial-
  // commitment trigger above — this is a voice-quality/product-premise
  // failure, not a money-or-perk exposure. Confirmed via the operator card
  // (analog-operator/components/queue/queue-card.tsx) already rendering the
  // full draft body regardless of which trigger wins the primary label, so
  // this ranking only affects the displayed reason string, never visibility
  // of the actual self-talk text.
  APPROVAL_TRIGGERS.SELF_TALK_DETECTED,
  // v1.23.0: below MODEL_FLAGGED so a self-flagged or structurally-typed
  // commitment keeps the more specific operator label; ABOVE
  // PREVIOUS_PENDING_HELD so a regenerated draft carrying a fresh complaint
  // promise still fires a push rather than being treated as a silent re-draft.
  APPROVAL_TRIGGERS.COMPLAINT_COMMITMENT_FLOOR,
  APPROVAL_TRIGGERS.PREVIOUS_PENDING_HELD,
  APPROVAL_TRIGGERS.FIDELITY_BELOW_AUTO_SEND_FLOOR,
  // v1.24.0: category routing is a POLICY signal, not a claim about this
  // draft. Every trigger above names a concrete risk in the specific message
  // and should carry the operator-facing label instead. Ranked above
  // hold_all_outbound because per-category routing is more specific than a
  // venue-wide hold, and BELOW previous_pending_held so a regenerated
  // complaint turn doesn't re-push at an operator already holding the card.
  APPROVAL_TRIGGERS.CATEGORY_REQUIRES_APPROVAL,
  // TAC-XXX: blanket venue hold is the least-specific signal — ranked last so
  // any concrete per-message trigger above carries the operator-facing label.
  APPROVAL_TRIGGERS.HOLD_ALL_OUTBOUND,
] as const

/**
 * TAC-309: will a knowledge-gap emission on THIS run actually be queued?
 *
 * The single source of truth for the knowledge-gap safety property, because
 * two places need it and they must not drift:
 *
 *   1. `applyApprovalPolicyStage` — whether the KNOWLEDGE_GAP trigger fires
 *      (and therefore whether the body is blanked and a clock armed).
 *   2. `generateStage` — whether the run is exempt from SEND_FIDELITY_FLOOR.
 *
 * (2) is only safe because of (1). The exemption's whole justification is
 * "nothing reaches the guest on this turn, and the scored body is discarded
 * anyway." That holds ONLY when the turn is genuinely queued. Keying the
 * exemption on `knowledgeGap` alone broke it in two directions:
 *
 *   - OUTBOUND runs. The trigger requires `currentMessage !== null`, but a
 *     manual followup (Command Center "Follow Up") skips the approval gate
 *     entirely and dispatches. A model emitting knowledgeGap=true at
 *     voiceFidelity 0.2 would have shipped that text to a real guest,
 *     unblanked. Reachable, not theoretical: the `## Unanswered question`
 *     block renders on followups too, and its `acknowledged` copy explicitly
 *     tells the model to set knowledgeGap again.
 *   - DEMO guests. TAC-284's bypass returns `action:'send'` unconditionally,
 *     so the gate's queue decision never happens. The fidelity floor used to
 *     be the last thing standing there.
 *
 * Same shape as `willBeReviewed` in buildAiRuntime, and the same reasoning:
 * a relaxation is only safe when something downstream is guaranteed to catch
 * it.
 */
export function knowledgeGapWillQueue(
  ctx: Pick<RuntimeContext, 'currentMessage' | 'guest'>,
  knowledgeGap: boolean,
): boolean {
  return knowledgeGap === true && ctx.currentMessage !== null && ctx.guest.isDemo !== true
}

/**
 * TAC-308: is this pending row a knowledge-gap card?
 *
 * Two conditions, OR'd, and the OR is load-bearing:
 *
 *   pending_until IS NOT NULL — the clock is still running. Catches the card
 *     even when a co-firing trigger (a comp commitment on the same turn) won
 *     `review_reason` and the label doesn't say "knowledge_gap".
 *   review_reason = 'knowledge_gap' — the clock has already fired. The timer
 *     CLEARS pending_until as its CAS claim, so after a holding message goes
 *     out the first condition stops matching. Without this second one the
 *     card would silently lose its eviction protection five minutes after
 *     being created, which is the original data-loss bug on a delay.
 *
 * Residual, accepted: a draft that BOTH gapped and committed a comp gets
 * review_reason='commitment_type_gated', so once its clock fires it is no
 * longer recognized. Rare (the model has to do both in one turn) and it
 * degrades to pre-TAC-308 behavior rather than to something worse. Closing it
 * needs a column, which the ticket ruled out.
 *
 * TAC-350: the review_reason leg checks BOTH `knowledge_gap` (self-reported)
 * and `knowledge_gap_backstop` (independently caught) — a card protected by
 * the backstop trigger must get identical eviction protection to one the
 * model flagged itself, or a regen of a backstop-caught card would silently
 * lose its clock the moment the label won by a co-firing trigger changed.
 */
export function isKnowledgeGapCard(row: {
  review_reason?: string | null
  pending_until?: string | null
}): boolean {
  // Positive identification only. `typeof === 'string'` rather than
  // `!== null` because an ABSENT field (a caller that didn't select the
  // column, a hand-built row) is `undefined`, and `undefined !== null` is
  // true — which would classify every ordinary pending draft as a protected
  // knowledge-gap card and silently start dropping replies that used to
  // send. Unknown means "not a gap card": the fail-safe direction is the
  // pre-TAC-308 behavior, not the new one.
  return (
    typeof row.pending_until === 'string' ||
    row.review_reason === APPROVAL_TRIGGERS.KNOWLEDGE_GAP ||
    row.review_reason === APPROVAL_TRIGGERS.KNOWLEDGE_GAP_BACKSTOP
  )
}

function pickPrimaryTrigger(triggers: readonly string[]): string {
  // Caller guarantees triggers.length > 0; the fallback to triggers[0]
  // covers the impossible case of a trigger appearing in the array but
  // missing from PRIMARY_TRIGGER_PRIORITY (future-add safety).
  for (const t of PRIMARY_TRIGGER_PRIORITY) {
    if (triggers.includes(t)) return t
  }
  return triggers[0]
}

/**
 * Internal: classify the inbound message via lib/ai. Throws on AI failure
 * with a prefixed error message; caller catches and fires the appropriate
 * red alert.
 */
export async function classifyStage(ctx: RuntimeContext): Promise<Classification> {
  if (!ctx.currentMessage) {
    throw new Error('classifyStage: no inbound message on context')
  }
  const r = await classifyMessage({
    inboundBody: ctx.currentMessage.body,
    persona: ctx.venue.brandPersona,
    venueInfo: ctx.venue.venueInfo,
    recentMessages: ctx.recentMessages,
    guestState: ctx.recognition.state,
  })
  if (!r.ok) {
    throw new Error(`classifyStage: ${r.error}`)
  }

  // 3-tier routing: < 0.3 → `unknown` (holding ack); 0.3..0.7 → classifier's
  // pick + observation event; >= 0.7 → classifier's pick + silent.
  const autoRoutedToUnknown =
    r.data.classifierConfidence < CLASSIFICATION_CONFIDENCE_REROUTE_THRESHOLD

  if (r.data.classifierConfidence < CLASSIFICATION_CONFIDENCE_LOW_THRESHOLD) {
    await captureClassificationLowConfidence({
      agentRunId: ctx.agentRunId,
      venueId: ctx.venue.id,
      guestId: ctx.guest.id,
      category: r.data.category,
      classifierConfidence: r.data.classifierConfidence,
      inboundLength: ctx.currentMessage.body.length,
      inboundBody: ctx.currentMessage.body,
      autoRoutedToUnknown,
    })
  }

  return {
    category: autoRoutedToUnknown ? 'unknown' : r.data.category,
    classifierConfidence: r.data.classifierConfidence,
    reasoning: r.data.reasoning,
    // TAC-348: passed through unmodified — independent of the confidence
    // reroute above. A crisis signal should hold even when the category call
    // itself is uncertain.
    crisisSafety: r.data.crisisSafety,
  }
}

/**
 * Internal: retrieve voice-corpus matches and enforce the orchestrator's
 * threshold rule — at least MIN_STRONG_MATCHES (1) chunk scoring at or above
 * STRONG_MATCH_SIMILARITY (0.3). Below that, fail closed; the prompt doesn't
 * have enough venue voice to ground a generation.
 *
 * TODO(THE-158): per-category thresholds — generic messages like "hi"
 * shouldn't need the same corpus depth as topic-specific ones. Calibrate
 * against real corpus data after first 100 inbound messages.
 */
export async function retrieveCorpusStage(ctx: RuntimeContext): Promise<CorpusMatch[]> {
  const query =
    ctx.currentMessage?.body ??
    (ctx.followupTrigger
      ? `Followup ${ctx.followupTrigger.reason} for ${ctx.guest.firstName ?? 'guest'}`
      : '')
  if (!query) {
    throw new Error('retrieveCorpusStage: no query available (no inbound, no followup)')
  }
  const r = await retrieveContext({
    venueId: ctx.venue.id,
    query,
    limit: CORPUS_RETRIEVE_LIMIT,
  })
  if (!r.ok) {
    throw new Error(`retrieveCorpusStage: ${r.error}`)
  }
  const strongCount = r.data.filter((m) => m.similarity >= STRONG_MATCH_SIMILARITY).length
  // THE-231: only fail closed on the inbound path. Followups are operator-
  // initiated (cron trigger or Command Center button); the synthetic followup
  // query — "Followup manual for {firstName}" — rarely embeds anywhere near
  // the venue's actual voice corpus, so the strong-match gate was failing
  // every Follow Up button click. Proceed with whatever surfaced (even zero);
  // generateStage handles an empty corpus gracefully (ragChunksToProse drops
  // the block entirely). The captureCorpusRetrievalBelowThreshold event below
  // still fires on both paths so the visibility doesn't change.
  if (ctx.currentMessage && strongCount < MIN_STRONG_MATCHES) {
    throw new Error(
      `retrieveCorpusStage: insufficient_corpus_matches (got ${strongCount} above ${STRONG_MATCH_SIMILARITY}, need ${MIN_STRONG_MATCHES}; total ${r.data.length})`,
    )
  }

  // Observability event: thin retrieval. Looser bar than the gate above —
  // retrieval succeeded structurally but the best match is weak, suggesting
  // the prompt may lack venue-voice grounding.
  const topSimilarity = r.data.length > 0 ? Math.max(...r.data.map((m) => m.similarity)) : 0
  if (topSimilarity < CORPUS_TOP_SIMILARITY_LOW_THRESHOLD) {
    const topMatch = r.data.length > 0
      ? r.data.reduce((a, b) => (a.similarity >= b.similarity ? a : b))
      : null
    await captureCorpusRetrievalBelowThreshold({
      agentRunId: ctx.agentRunId,
      venueId: ctx.venue.id,
      guestId: ctx.guest.id,
      totalMatches: r.data.length,
      strongMatchCount: strongCount,
      topSimilarity,
      inboundBody: ctx.currentMessage?.body ?? null,
      topMatchPreview: topMatch ? topMatch.text.slice(0, 200) : null,
    })
  }

  return r.data
}

/**
 * Pure predicate: should knowledge_corpus retrieval fire for this run?
 *
 *   - inbound (currentMessage present)         → true (every reply benefits
 *     from grounding; the agent doesn't know in advance whether the guest's
 *     question is substantive)
 *   - followup with reason='event' or 'manual' → true (substantive outbound:
 *     event invites raise follow-up questions; manual notes are operator-
 *     authored and typically content-heavy)
 *   - followup with reason='day_*'             → false (routine cron-triggered
 *     "thinking of you" message; pure voice exercise)
 *
 * Voice retrieval is always-on; this predicate gates only knowledge.
 */
export function shouldRetrieveKnowledge(ctx: RuntimeContext): boolean {
  if (ctx.currentMessage !== null) return true
  const reason = ctx.followupTrigger?.reason
  return reason === 'event' || reason === 'manual'
}

/**
 * Internal: retrieve knowledge_corpus matches for grounding. Degrades
 * gracefully on Voyage / DB failure — logs the error and returns []. The
 * generation can still proceed (without knowledge grounding); knowledge is
 * opportunistic context, not structural.
 *
 * Asymmetric to retrieveCorpusStage on purpose. Voice failure breaks voice
 * fidelity (the whole point of the message). Knowledge failure means the
 * reply lacks topical grounding — still a coherent message in the venue's
 * voice, just less specific. Different roles, different policies.
 *
 * TAC-242: when the inbound's classification category has a primary-tag
 * preference, the first call passes it as primary_tag_filter. If the
 * preference yields zero matches (sparse corpus for that topic), retry
 * without the filter — cosine on the raw query is the universal floor.
 */
// TAC-350: drop chunks that cleared lib/rag's looser SIMILARITY_FLOOR but
// aren't actually relevant enough to this specific query to ground an
// answer. See KNOWLEDGE_RELEVANCE_FLOOR's own comment for the calibration.
function filterByRelevance(chunks: KnowledgeMatch[]): KnowledgeMatch[] {
  return chunks.filter((c) => c.similarity >= KNOWLEDGE_RELEVANCE_FLOOR)
}

export async function retrieveKnowledgeStage(
  ctx: RuntimeContext,
  category: MessageCategory | null,
): Promise<KnowledgeMatch[]> {
  const query =
    ctx.currentMessage?.body ??
    (ctx.followupTrigger
      ? `Followup ${ctx.followupTrigger.reason} for ${ctx.guest.firstName ?? 'guest'}`
      : '')
  if (!query) return []

  const preference = getPrimaryTagPreference(category)

  const r = await retrieveKnowledgeContext({
    venueId: ctx.venue.id,
    query,
    limit: KNOWLEDGE_RETRIEVE_LIMIT,
    primaryTagPreference: preference,
  })
  if (!r.ok) {
    console.warn(
      `[agent] knowledge retrieval degraded for venue=${ctx.venue.id}: ${r.error}${r.errorCode ? ` (${r.errorCode})` : ''}`,
    )
    return []
  }

  const filtered = filterByRelevance(r.data)

  // TAC-350: the zero-result fallback now triggers on zero RELEVANT results,
  // not just zero returned rows — a tag-filtered search whose only hits are
  // below the relevance floor deserves the same untagged cosine-only retry a
  // literally-empty result already got, before giving up entirely.
  if (preference !== undefined && filtered.length === 0) {
    const fallback = await retrieveKnowledgeContext({
      venueId: ctx.venue.id,
      query,
      limit: KNOWLEDGE_RETRIEVE_LIMIT,
    })
    if (!fallback.ok) {
      console.warn(
        `[agent] knowledge retrieval (fallback) degraded for venue=${ctx.venue.id}: ${fallback.error}`,
      )
      return []
    }
    return filterByRelevance(fallback.data)
  }

  return filtered
}

export type GenerateOutcome =
  | { status: 'success'; result: GenerateMessageResult }
  | { status: 'refused'; attemptScores: number[]; finalScore: number }
  | { status: 'failed'; error: string; errorCode?: string }

/**
 * Internal: call lib/ai's generateMessage and apply the orchestrator's
 * send-floor.
 *
 * lib/ai's internal regeneration loop uses 0.7 as its loop-exit threshold
 * (it tries up to 3 times to cross 0.7). This stage applies a separate
 * orchestrator-level rule on the final returned voiceFidelity:
 *   < SEND_FIDELITY_FLOOR (0.4) → 'refused' (don't send; alert)
 *   >= 0.4                       → 'success' (send, even if below 0.7)
 *
 * The two thresholds answer different questions: 0.7 is "good enough to stop
 * trying"; 0.4 is "good enough to send to a human".
 */
export async function generateStage(
  ctx: RuntimeContext,
  category: Classification['category'],
): Promise<GenerateOutcome> {
  if (!ctx.corpus) return { status: 'failed', error: 'corpus missing on context' }
  // lib/rag types sourceType as plain string; lib/ai narrows it to a closed
  // union. The DB check constraint on voice_corpus.source_type guarantees
  // runtime values are inside that union, so the per-field cast is sound.
  // (TODO in lib/rag: tighten the type when the corpus management UI ships.)
  const ragChunks: AiVoiceCorpusChunk[] = ctx.corpus.map((c) => ({
    id: c.id,
    text: c.text,
    sourceType: c.sourceType as AiVoiceCorpusChunk['sourceType'],
    // lib/rag exposes cosine `similarity` (0–1); lib/ai's prompt composer
    // expects `relevanceScore?`. Same semantics — pass through.
    relevanceScore: c.similarity,
  }))
  // knowledgeCorpus is null when retrieval was gated off (composer omits the
  // block), [] when it fired and matched nothing (composer renders the
  // explicit "no venue knowledge matched" block — TAC-242). Pass through
  // with the same similarity → relevanceScore mapping voice uses, plus the
  // primary/secondary tag split for the new prompt rendering.
  const knowledgeChunks: AiKnowledgeCorpusChunk[] | undefined =
    ctx.knowledgeCorpus === null
      ? undefined
      : ctx.knowledgeCorpus.map((c) => ({
          id: c.id,
          text: c.text,
          sourceType: c.sourceType,
          primaryTags: c.primaryTags,
          secondaryTags: c.secondaryTags,
          relevanceScore: c.similarity,
        }))
  const r = await generateMessage({
    category,
    persona: ctx.venue.brandPersona,
    venueInfo: ctx.venue.venueInfo,
    ragChunks,
    knowledgeChunks,
    runtime: buildAiRuntime(ctx),
  })
  if (!r.ok) return { status: 'failed', error: r.error, errorCode: r.errorCode }

  // Observability events: emit before the floor-check return so they fire
  // for both refused (< 0.4) and below-0.5-but-above-0.4 sends.
  if (r.data.voiceFidelity < VOICE_FIDELITY_LOW_THRESHOLD) {
    await captureVoiceFidelityLow({
      agentRunId: ctx.agentRunId,
      venueId: ctx.venue.id,
      guestId: ctx.guest.id,
      voiceFidelity: r.data.voiceFidelity,
      attempts: r.data.attempts,
      attemptScores: r.data.attemptScores,
      category,
      inboundBody: ctx.currentMessage?.body ?? null,
      generatedBody: r.data.body,
    })
  }
  if (r.data.attempts > 1) {
    await captureRegenerationTriggered({
      agentRunId: ctx.agentRunId,
      venueId: ctx.venue.id,
      guestId: ctx.guest.id,
      attempts: r.data.attempts,
      attemptScores: r.data.attemptScores,
      finalFidelity: r.data.voiceFidelity,
      inboundBody: ctx.currentMessage?.body ?? null,
      finalGeneratedBody: r.data.body,
    })
  }
  // THE-225: dash check exhausted regen attempts and the body still has a
  // dash. Ship anyway (refusing on punctuation would be worse than violating
  // it) and surface the failure on PostHog + Slack alongside the other
  // generation-stage silent failures.
  if (r.data.dashViolationPersisted) {
    await captureDashViolationPersisted({
      agentRunId: ctx.agentRunId,
      venueId: ctx.venue.id,
      guestId: ctx.guest.id,
      category,
      attempts: r.data.attempts,
      attemptScores: r.data.attemptScores,
      finalFidelity: r.data.voiceFidelity,
      inboundBody: ctx.currentMessage?.body ?? null,
      finalGeneratedBody: r.data.body,
    })
  }

  // TAC-309: a knowledge-gap turn is exempt from the send floor.
  //
  // The floor exists to stop a poorly-voiced message reaching a guest. On a
  // knowledge-gap turn NOTHING reaches the guest — the draft is queued, and
  // TAC-309 discards its body before persisting, so the text being scored is
  // thrown away. Refusing here would gate CARD CREATION on the voice quality
  // of a body that never exists, and the result is silence: the refused
  // branch returns without a card, so the guest gets nothing and no operator
  // learns they asked. That is the third silent-drop door, alongside the
  // generation crash this ticket also closes.
  //
  // The holding message stays fidelity-gated (handle-holding-message.ts runs
  // the real gates). That one does reach the guest, and on this path it is
  // the only text that does.
  //
  // knowledgeGapWillQueue, not `knowledgeGap` alone: the exemption is only
  // sound when the turn is genuinely queued. Manual followups skip the gate
  // and demo guests bypass it, and in both cases the body WOULD reach a
  // guest — unblanked, since blanking is also the gate's job.
  if (
    r.data.voiceFidelity < SEND_FIDELITY_FLOOR &&
    !knowledgeGapWillQueue(ctx, r.data.knowledgeGap)
  ) {
    return {
      status: 'refused',
      attemptScores: r.data.attemptScores,
      finalScore: r.data.voiceFidelity,
    }
  }
  return { status: 'success', result: r.data }
}

/**
 * TAC-350: what verifyGroundingStage found, when it found something. `null`
 * from the stage means "no backstop signal" — covers being skipped entirely,
 * the AI call degrading, and the AI call running and finding nothing to
 * flag. The caller (applyApprovalPolicyStage) only ever needs to know
 * whether there's a finding to act on, never why there isn't one.
 */
export type GroundingBackstopFinding = { claims: string[] }

/**
 * TAC-350: independent grounding backstop. Runs a second, deterministic-in-
 * spirit check (lib/ai/verify-grounding.ts) against a reply the model has
 * ALREADY self-certified as grounded (`knowledgeGap === false`) — the exact
 * population the TAC-350 audit found fabricating: all 8 observed cases had
 * knowledgeGap=false, so self-report alone caught none of them. Same
 * relationship the COMP_REGEX_BACKSTOP trigger has to MODEL_FLAGGED — a
 * second, independent check for a self-report that's already proven
 * unreliable under real traffic.
 *
 * Skips (returns null without calling the model) when:
 *   - not inbound (ctx.currentMessage === null) — a followup isn't
 *     answering a specific guest question, mirrors knowledgeGapWillQueue.
 *   - the guest is a demo guest — TAC-284's bypass ships regardless of any
 *     trigger, so spending a Haiku call here buys nothing.
 *   - the model already self-reported knowledgeGap=true — trust it; this is
 *     also what keeps the added cost to roughly half of inbound traffic
 *     (only turns where the model claims confidence pay for the check).
 *
 * Fails OPEN on an AI-call error (network hiccup, Voyage-shaped failure,
 * etc.) — logged via console.warn, not fireRedAlert. This is a SECOND,
 * additional safety net on top of the model's own self-report; a failure
 * here degrades to exactly today's pre-TAC-350 behavior (trust the model),
 * never to something worse. Queuing every transient failure closed would
 * turn a rare Haiku hiccup into a broad, unrelated availability regression
 * for a check whose entire population already passed self-report.
 *
 * Deliberately reuses the SAME venueInfo + knowledgeCorpus the generator saw
 * (ctx.venue.venueInfo, ctx.knowledgeCorpus) rather than re-fetching either —
 * "what the verifier checks against" must never drift from "what the
 * generator actually had."
 */
export async function verifyGroundingStage(
  ctx: Pick<RuntimeContext, 'agentRunId' | 'currentMessage' | 'guest' | 'venue' | 'knowledgeCorpus'>,
  generation: Pick<GenerateMessageResult, 'knowledgeGap' | 'body'>,
): Promise<GroundingBackstopFinding | null> {
  if (ctx.currentMessage === null) return null
  if (ctx.guest.isDemo === true) return null
  if (generation.knowledgeGap === true) return null

  const r = await verifyGrounding({
    inboundBody: ctx.currentMessage.body,
    replyBody: generation.body,
    venueInfo: ctx.venue.venueInfo,
    knowledgeChunks: ctx.knowledgeCorpus ?? undefined,
  })
  if (!r.ok) {
    console.warn(
      `[agent] grounding backstop degraded for venue=${ctx.venue.id}: ${r.error}${r.errorCode ? ` (${r.errorCode})` : ''}`,
    )
    return null
  }
  if (!r.data.hasUngroundedClaim) return null

  await captureUngroundedClaimCaught({
    agentRunId: ctx.agentRunId,
    venueId: ctx.venue.id,
    guestId: ctx.guest.id,
    inboundBody: ctx.currentMessage.body,
    replyBody: generation.body,
    ungroundedClaims: r.data.ungroundedClaims,
  })

  return { claims: r.data.ungroundedClaims }
}

/**
 * TAC-355: true when the model self-flagged a resource commitment via
 * requiresOperatorApproval. Extracted so verifyMechanicOfferStage's skip
 * condition ("don't spend a Haiku call re-confirming a signal that already
 * fired") can't independently drift from the trigger's own push logic inside
 * applyApprovalPolicyStage below.
 */
export function isModelFlagged(
  generation: Pick<GenerateMessageResult, 'requiresOperatorApproval'>,
): boolean {
  return generation.requiresOperatorApproval === true
}

/**
 * TAC-355: true when the structural commitment.type gate (TAC-297) would
 * fire — type is comp/hold/discount AND description is non-empty. Same
 * extraction rationale as isModelFlagged above.
 */
export function isCommitmentTypeGated(
  generation: Pick<GenerateMessageResult, 'commitment'>,
): boolean {
  const commitmentType = generation.commitment.type
  const commitmentDescription = generation.commitment.description?.trim()
  return Boolean(
    commitmentDescription &&
      (commitmentType === 'comp' || commitmentType === 'hold' || commitmentType === 'discount'),
  )
}

/**
 * TAC-355: what verifyMechanicOfferStage found, when it ran. Four states,
 * not two — the fail-closed decision (see MECHANIC_OFFER_BACKSTOP's own
 * comment on APPROVAL_TRIGGERS) means "the check errored" is a DISTINCT,
 * queue-worthy outcome from "the check ran and found nothing," unlike
 * GroundingBackstopFinding's two-state shape (null covers both skip and
 * clean-error-degradation because that backstop fails OPEN).
 */
export type MechanicOfferBackstopResult =
  | { status: 'skipped' }
  | { status: 'clean' }
  | { status: 'flagged'; mechanicId: string }
  | { status: 'check_failed' }

/**
 * TAC-355: independent verification backstop for the mechanic-approval gate.
 * Runs a second, Haiku-based check (lib/ai/verify-mechanic-offer.ts) against
 * a reply the model has NOT already self-flagged as a resource commitment
 * via either existing signal — the exact population the TAC-355 audit found
 * both existing gates structurally unable to cover (a mechanic grant with no
 * nameable item, or no product at all, never maps onto commitment.type, and
 * nothing in the prompt links a mechanic grant to that field in the first
 * place; see the audit trail on the ticket).
 *
 * Unlike verifyGroundingStage (TAC-350), this runs on BOTH the inbound and
 * followup paths — a mechanic can be offered on a proactive outbound message
 * exactly as easily as in reply to a guest's question, so there is no
 * inbound-only concept to gate on here (contrast knowledge-gap grounding,
 * which is inherently about answering a guest's question).
 *
 * Skips (returns 'skipped' without calling the model) when:
 *   - the guest is a demo guest — TAC-284's bypass ships regardless of any
 *     trigger, so spending a Haiku call here buys nothing.
 *   - isModelFlagged or isCommitmentTypeGated is already true — trust the
 *     existing signal; the draft is already going to queue.
 *   - no eligible mechanic this turn has requiresOperatorApproval=true — the
 *     overwhelmingly common case (per the TAC-355 audit's live-data pull,
 *     only 7 mechanics across 3 venues carry the flag at all), so most turns
 *     pay zero added cost.
 *
 * FAILS CLOSED on an AI-call error ('check_failed', not 'skipped' or
 * 'clean') — the deliberate divergence from every other backstop in this
 * file. An unauthorized perk grant costs the owner money and control; a
 * failed check costs one unnecessary review.
 */
export async function verifyMechanicOfferStage(
  ctx: Pick<RuntimeContext, 'agentRunId' | 'guest' | 'venue' | 'mechanics'>,
  generation: Pick<GenerateMessageResult, 'body' | 'requiresOperatorApproval' | 'commitment'>,
): Promise<MechanicOfferBackstopResult> {
  if (ctx.guest.isDemo === true) return { status: 'skipped' }
  if (isModelFlagged(generation) || isCommitmentTypeGated(generation)) {
    return { status: 'skipped' }
  }

  const gatedMechanics = ctx.mechanics.filter((m) => m.requiresOperatorApproval)
  if (gatedMechanics.length === 0) return { status: 'skipped' }

  const r = await verifyMechanicOffer({
    replyBody: generation.body,
    eligibleGatedMechanics: gatedMechanics.map((m) => ({
      id: m.id,
      name: m.name,
      rewardDescription: m.rewardDescription,
      qualification: m.qualification,
    })),
  })
  if (!r.ok) {
    console.warn(
      `[agent] mechanic-offer backstop degraded (failing CLOSED) for venue=${ctx.venue.id}: ${r.error}${r.errorCode ? ` (${r.errorCode})` : ''}`,
    )
    return { status: 'check_failed' }
  }
  // Keyed on offersGatedMechanic ALONE, not also on mechanicId !== 'none' —
  // lib/ai/verify-mechanic-offer.ts already resolves the ambiguous
  // "flagged but couldn't identify which one" shape defensively (substitutes
  // a placeholder id rather than ever returning 'none' alongside
  // offersGatedMechanic=true), so trusting the boolean here is both
  // sufficient and correct. Code review caught an earlier version of this
  // check ALSO testing `r.data.mechanicId === 'none'` — with the OR, that
  // ambiguous shape resolved to 'clean' (a false negative), the exact
  // failure mode a fail-closed backstop cannot afford.
  if (!r.data.offersGatedMechanic) {
    return { status: 'clean' }
  }

  await captureMechanicOfferBackstopCaught({
    agentRunId: ctx.agentRunId,
    venueId: ctx.venue.id,
    guestId: ctx.guest.id,
    mechanicId: r.data.mechanicId,
    replyBody: generation.body,
  })

  return { status: 'flagged', mechanicId: r.data.mechanicId }
}

/**
 * TAC-212 approval-policy gate. Runs after generateStage returns success;
 * decides whether to dispatch via Sendblue (action='send') or persist as a
 * pending draft for operator review (action='queue').
 *
 * Four triggers compose. Any one fires → queue. The triggers[] array
 * preserves enumeration order (the order checks fired). primaryTrigger is
 * picked via PRIMARY_TRIGGER_PRIORITY so the operator queue UI surfaces the
 * most severe signal first.
 *
 * Fail-OPEN on the sticky-pending DB read (returns send rather than queue
 * when the lookup throws) — refusing to send because of an observability
 * read failure is worse than the rare race of a draft auto-sending while a
 * sibling pending draft exists. TAC-264 closes this loop structurally via
 * the partial unique index on `messages (venue_id, guest_id) WHERE
 * review_state='pending'` (migration 020) — concurrent INSERTs from rapid
 * inbounds get caught by the index and recovered to UPDATE inside
 * persistOrRegenQueuedDraft.
 *
 * TAC-264: queue decisions carry `existingPendingDraftId` so the persist
 * layer knows whether to INSERT a fresh pending row or UPDATE the existing
 * one in place (regenerate). When non-null, PREVIOUS_PENDING_HELD is also
 * in `triggers`, structurally guaranteeing the gate returns action='queue'
 * — no-demotion-on-regeneration is enforced by the trigger, not by the
 * orchestrator. (The orchestrator-layer override per the TAC-264 plan
 * review is the dispatch of existingPendingDraftId to the persist layer;
 * the trigger does the queue-vs-send decision.)
 *
 * Not invoked when the followup trigger reason is `manual` — that path
 * bypasses the gate entirely (the Command Center Follow Up button is an
 * explicit operator action; operator already approved by clicking).
 *
 * TAC-284: when `ctx.guest.isDemo === true` the gate short-circuits to
 * `{ action: 'send', reason: 'demo_bypass' }` regardless of trigger
 * evaluation — every trigger including the comp regex backstop is
 * overridden. The orchestrator stamps `messages.review_reason='demo_bypass'`
 * on the send so the row is self-describing. See applyApprovalPolicyStage.
 */
export type ApprovalDecision =
  // `reason` is only present on the demo-bypass send. A normal
  // (untriggered) send leaves it undefined. The orchestrator threads
  // `reason` into scheduleAndSend's `reviewReason` option so the demo
  // bypass lands on messages.review_reason.
  | { action: 'send'; reason?: 'demo_bypass' }
  | {
      action: 'queue'
      triggers: string[]
      primaryTrigger: string
      compMatchedPattern: string | null
      // TAC-264: when non-null, the persist layer UPDATEs this row in place
      // (regenerate) instead of INSERTing a new pending row. Captured from
      // findPendingDraft() during trigger 4 evaluation so the persist layer
      // doesn't need a second round-trip.
      existingPendingDraftId: string | null
      // TAC-308: when set, the persist layer stamps messages.pending_until,
      // arming the holding-message timer. `undefined` means "leave the column
      // alone" — omitted on INSERT (so the column stays null), absent from the
      // UPDATE payload (so an existing clock is PRESERVED rather than pushed
      // out by a chatty guest). Explicit rather than derived from the trigger
      // set, because the timeout regen also queues with a knowledge_gap
      // trigger and must NOT re-arm the clock it just fired.
      pendingUntil?: Date
      // TAC-309: persist this card with NO body, discarding what the model
      // wrote. True whenever the knowledge_gap trigger fired — no exceptions,
      // including when it co-fires with commitment_type_gated (the comp detail
      // survives on pending_commitment, and a model that couldn't ground the
      // answer has no business pre-writing one).
      blankBody: boolean
    }
  // TAC-308: the guest already has a knowledge-gap card holding the one
  // pending slot migration 020 allows, and THIS turn would queue for some
  // reason other than gapping itself. We can't store a second pending row and
  // we won't overwrite the card an operator is about to answer, so the new
  // draft is discarded: not sent, not persisted. The guest is silent on this
  // turn. That cost is accepted deliberately — the turn needed a human
  // anyway, and losing the outstanding question is worse than losing a reply
  // that was never going to reach the guest without review.
  | {
      action: 'drop'
      reason: 'knowledge_gap_card_protected'
      triggers: string[]
      protectedDraftId: string
    }

export async function applyApprovalPolicyStage(
  ctx: RuntimeContext,
  generation: GenerateMessageResult,
  // TAC-350: result of verifyGroundingStage, run by the orchestrator between
  // generateStage and this gate (needs an async AI call the gate itself
  // can't make mid-synchronous-evaluation). `null` when there's no backstop
  // signal — includes every skip case (followup, demo, model already
  // self-reported) as well as a clean AI-call result with nothing flagged.
  groundingBackstop: GroundingBackstopFinding | null = null,
  // TAC-355: result of verifyMechanicOfferStage, run by the orchestrator
  // alongside verifyGroundingStage (both are independent Haiku calls with no
  // dependency on each other). 'skipped' | 'clean' never fire the trigger;
  // 'flagged' | 'check_failed' both do — the fail-closed branch is
  // deliberate, see MECHANIC_OFFER_BACKSTOP's own comment above.
  mechanicOfferBackstop: MechanicOfferBackstopResult = { status: 'skipped' },
): Promise<ApprovalDecision> {
  const triggers: string[] = []

  // Trigger 1: voice fidelity in the 0.4–0.6 band → queue.
  // (< 0.4 already refused by generateStage upstream; >= 0.6 passes here.)
  if (generation.voiceFidelity < AUTO_SEND_FIDELITY_FLOOR) {
    triggers.push(APPROVAL_TRIGGERS.FIDELITY_BELOW_AUTO_SEND_FLOOR)
  }

  // Trigger 2: model self-flagged a resource commitment via the structured
  // output's requiresOperatorApproval field.
  if (isModelFlagged(generation)) {
    triggers.push(APPROVAL_TRIGGERS.MODEL_FLAGGED)
  }

  // Trigger 3: comp regex backstop — runs INDEPENDENTLY of trigger 2 so a
  // missed model self-flag on a comp commitment still queues.
  const comp = matchComp(generation.body)
  if (comp.matched) {
    triggers.push(APPROVAL_TRIGGERS.COMP_REGEX_BACKSTOP)
  }

  // Trigger 4: sticky pending — there's already a pending draft for this
  // (venue_id, guest_id). TAC-264 routes regeneration through the persist
  // layer using the captured row ID rather than the boolean signal alone.
  //
  // TAC-308 moves the PUSH of this trigger to the end of the function (see
  // "pending-row resolution" below) while keeping the LOOKUP here in
  // enumeration order. The carve-out has to know whether any OTHER trigger
  // fired, which isn't decided until trigger 9 has run. Consequence: when
  // previous_pending_held does fire it now appears LAST in `triggers[]`
  // rather than fourth. `triggers[]` order is observability only —
  // primaryTrigger is priority-selected via PRIMARY_TRIGGER_PRIORITY — so
  // nothing downstream keys on the position.
  //
  // TAC-307: SKIPPED ENTIRELY for a manual followup (the Command Center
  // Follow Up button). Removing that path's gate bypass brought it under
  // approval POLICY, which was the ticket's intent — but the bypass was doing
  // two unrelated jobs, and pending-detection was the other one. Left in, a
  // Follow Up click on a guest who already has a pending card would fire
  // previous_pending_held, route to persistOrRegenQueuedDraft's UPDATE-in-place
  // branch, and overwrite the draft the operator was about to approve — body,
  // review_reason and pending_commitment replaced, created_at preserved so the
  // card looks untouched in the queue. That is data loss on a human's work,
  // and it is a different axis from "does approval policy apply", so it keeps
  // its pre-TAC-307 behaviour: a pending card and an operator-sent manual
  // outbound can legitimately coexist on the same guest (migration 020's
  // partial index permits it — a manual send writes review_state='auto_sent').
  const isManualFollowup = ctx.followupTrigger?.reason === 'manual'
  const existingPending = isManualFollowup
    ? null
    : await findPendingDraft(ctx.venue.id, ctx.guest.id)

  // Trigger 5 (TAC-297): structural gate on commitment.type ∈ {comp, hold,
  // discount}. Fires regardless of requiresOperatorApproval self-flag.
  // Recommendation type does NOT gate. Requires the commitment to be
  // actionable (type + non-empty description) — a partial emission is treated
  // as no-op and won't fire the trigger.
  if (isCommitmentTypeGated(generation)) {
    triggers.push(APPROVAL_TRIGGERS.COMMITMENT_TYPE_GATED)
  }

  // Trigger 6 (TAC-XXX): per-venue blanket hold. When venues.hold_all_outbound
  // is true, hold every guest-facing content message for operator review —
  // EXCEPT compliance replies, which must auto-send instantly (TCPA/carrier
  // rules). Compliance == an opt_out confirmation, detected via the inbound
  // classification (the outbound reply inherits ctx.classification.category;
  // for the proactive/followup path category is never opt_out, so this gate
  // correctly holds proactive sends at a hold venue). The carve-out bypasses
  // ONLY this trigger — an opt_out reply still passes through triggers 1–5
  // above unchanged. Composes with (does not short-circuit) the other
  // triggers, so existingPendingDraftId still routes regen-in-place correctly.
  if (ctx.venue.holdAllOutbound === true && ctx.classification?.category !== 'opt_out') {
    triggers.push(APPROVAL_TRIGGERS.HOLD_ALL_OUTBOUND)
  }

  // Trigger 7 (v1.23.0): complaint-category floor. Deterministic — does not
  // consult generation.requiresOperatorApproval or generation.commitment at
  // all, which is the entire point: on 2026-08-07 the model correctly
  // reported BOTH as empty ("I'm not promising a monetary credit, just a
  // corrected drink") and the reply still gave away free product on a refund
  // request. Category scope keeps ordinary perk refusals out — "can i get a
  // free drink" classifies as mechanic_request, not comp_complaint.
  const forwardCommitment = isFloorCategory(ctx.classification?.category)
    ? matchForwardCommitment(generation.body)
    : { matched: false as const }
  if (forwardCommitment.matched) {
    triggers.push(APPROVAL_TRIGGERS.COMPLAINT_COMMITMENT_FLOOR)
  }

  // Trigger 8 (v1.24.0): per-category routing from venue_configs.approval_policy.
  // Unlike every trigger above, this one is decided by the CLASSIFICATION, not
  // by the draft — which is what lets the generation prompt know in advance
  // that a human will review this turn, and therefore permits it to be
  // comp-forward (see buildAiRuntime's willBeReviewed).
  //
  // The single exemption is a genuine clarifying question: making a guest wait
  // on an operator before you'll even ask what went wrong is worse service
  // than the cold reply this shipped to fix. Every check inside
  // canAutoSendComplaintTurn fails toward queue. Since TAC-307 that exemption
  // is available only on a code_default hold — see below.
  //
  // TAC-307 SUBORDINATES THE CARVE-OUT. It used to run alongside the policy
  // check (`policy === 'operator_approval' && !canAutoSendComplaintTurn(...)`),
  // which meant a turn the model labelled `clarifying` could auto-send THROUGH
  // a hold an operator had deliberately switched on. A control with exceptions
  // is not a control: the master switch is what gets reached for when
  // something is already wrong, so it has to mean what it says.
  //
  // The line is drawn at WHO CHOSE THE HOLD, not at which category it is:
  //   - source 'stored' / 'policy_default' → a human ticked this box or threw
  //     the master switch for this venue. ABSOLUTE. Nothing passes.
  //   - source 'code_default' → APPROVAL_POLICY_DEFAULT's fleet-wide
  //     comp_complaint route, which nobody chose per-venue. The carve-out
  //     still applies, because making a guest wait on an operator before
  //     you'll even ask what went wrong is worse service than the cold reply
  //     v1.24.0 shipped to fix.
  //
  // Every venue stores `perCategory: {}` today, so this is a no-op against
  // current behaviour — and the moment a category is ticked in Command
  // Center it becomes strictly stronger than the default it replaces.
  const policyDecision = resolvePolicyDecision(
    ctx.venue.approvalPolicy,
    ctx.classification?.category,
  )
  if (policyDecision.disposition === 'operator_approval') {
    const carveOutAvailable = policyDecision.source === 'code_default'
    const exemptedByClarifyingQuestion =
      carveOutAvailable &&
      canAutoSendComplaintTurn({
        complaintIntent: generation.complaintIntent,
        body: generation.body,
        commitment: generation.commitment,
      })
    if (!exemptedByClarifyingQuestion) {
      triggers.push(APPROVAL_TRIGGERS.CATEGORY_REQUIRES_APPROVAL)
    }
  }

  // Trigger 9 (TAC-308): the model answered a question it could not ground in
  // venue knowledge. Inbound-only — `ctx.currentMessage !== null` — because a
  // followup has no guest question outstanding, and letting a cron-triggered
  // proactive message arm a 5-minute holding-message clock would produce a
  // holding note for a question nobody asked.
  const knowledgeGapFired = knowledgeGapWillQueue(ctx, generation.knowledgeGap)
  if (knowledgeGapFired) {
    triggers.push(APPROVAL_TRIGGERS.KNOWLEDGE_GAP)
  }

  // Trigger 9b (TAC-350): independent grounding backstop. groundingBackstop
  // is only ever non-null when the orchestrator ran verifyGroundingStage AND
  // it found something — which itself only happens when generation.knowledgeGap
  // was false. Mutually exclusive with trigger 9 by construction, same as
  // COMP_REGEX_BACKSTOP is independent of MODEL_FLAGGED.
  const backstopFired = groundingBackstop !== null
  if (backstopFired) {
    triggers.push(APPROVAL_TRIGGERS.KNOWLEDGE_GAP_BACKSTOP)
  }

  // Trigger 10 (TAC-355): deterministic self-talk backstop. Unconditional —
  // no category scoping, no demo-guest exemption beyond the bypass below.
  if (generation.selfTalkViolationPersisted) {
    triggers.push(APPROVAL_TRIGGERS.SELF_TALK_DETECTED)
  }

  // Trigger 11 (TAC-355): independent mechanic-offer verification backstop.
  // Fires on 'flagged' (the check found a gated mechanic offered) OR
  // 'check_failed' (the check errored/timed out/didn't parse) — fail CLOSED,
  // the deliberate divergence from the grounding backstop's fail-open
  // posture. 'skipped' and 'clean' never fire.
  if (
    mechanicOfferBackstop.status === 'flagged' ||
    mechanicOfferBackstop.status === 'check_failed'
  ) {
    triggers.push(APPROVAL_TRIGGERS.MECHANIC_OFFER_BACKSTOP)
  }

  // TAC-350: the umbrella "is this turn a knowledge-gap-card turn" signal,
  // covering EITHER the self-reported trigger or the independent backstop.
  // Every place below that used to key on knowledgeGapFired alone (body
  // blanking, clock arming, the protected-card drop) now keys on this
  // instead, so a caught-but-unflagged fabrication gets identical treatment
  // to an honest self-report — never sent, always queued, always blanked.
  const isGapTurn = knowledgeGapFired || backstopFired

  // ---- Pending-row resolution (TAC-308) ----
  //
  // Trigger 4's lookup ran in enumeration order above; its PUSH happens here,
  // because whether it fires depends on what every other trigger decided.
  //
  // A knowledge-gap card is a pending row with a live `pending_until`: an
  // operator is on the hook for an answer and a clock is running. Three cases,
  // and they are genuinely different:
  //
  //   1. This turn is independently sendable (no trigger fired at all).
  //      Send it. TAC-264's no-demotion invariant would otherwise queue it and
  //      route it into UPDATE-in-place, which BOTH silences the guest AND
  //      overwrites the card. What that invariant actually guards is a
  //      REGENERATED VERSION OF THE SAME DRAFT going out from under an
  //      operator; a reply to a different question is not that. Narrowed to
  //      knowledge-gap cards only, so the invariant stays absolute everywhere
  //      it was designed to apply. Migration 020 permits the coexistence —
  //      the send writes review_state='auto_sent', which is outside the
  //      partial unique index.
  //   2. This turn also gaps. UPDATE the card in place (the standard
  //      regen path) and PRESERVE its original pending_until, so a guest
  //      asking a second unanswerable question can't push the clock out.
  //   3. This turn queues for any other reason. The card wins; the new draft
  //      is dropped below.
  //
  // Every other pending row keeps the pre-TAC-308 behavior exactly.
  const existingIsKnowledgeGapCard =
    existingPending !== null && isKnowledgeGapCard(existingPending)
  const protectedCardCarveOut =
    existingIsKnowledgeGapCard && triggers.length === 0

  if (existingPending !== null && !protectedCardCarveOut) {
    triggers.push(APPROVAL_TRIGGERS.PREVIOUS_PENDING_HELD)
  }

  // TAC-284: demo guest bypass. Evaluated AFTER all four triggers (so the
  // would-have-queued set — including the previous_pending_held DB read — is
  // accurate for the analytics event) but BEFORE the queue return. The
  // bypass is total: every trigger, including the comp regex backstop, is
  // overridden. Fail-CLOSED — only the literal boolean `true` bypasses;
  // `undefined` / `null` / a missing column all fall through to the normal
  // policy below. The demo_bypassed_approval_gate event fires only when the
  // bypass actually overrode a queue decision (triggers non-empty); a clean
  // demo reply that would have auto-sent anyway produces no event.
  if (ctx.guest.isDemo === true) {
    if (triggers.length > 0) {
      await captureDemoBypassedApprovalGate({
        agentRunId: ctx.agentRunId,
        venueId: ctx.venue.id,
        guestId: ctx.guest.id,
        wouldHaveQueuedTriggers: triggers,
        voiceFidelity: generation.voiceFidelity,
        generatedBody: generation.body,
        // TAC-307: distinguishes a hold this venue actually chose from the
        // fleet-wide comp_complaint code default. Drives the Slack relay —
        // see the note on DemoBypassedApprovalGateProps.
        policyHoldWasExplicit:
          policyDecision.disposition === 'operator_approval' &&
          policyDecision.source !== 'code_default',
      })
    }
    return { action: 'send', reason: 'demo_bypass' }
  }

  if (triggers.length === 0) {
    return { action: 'send' }
  }

  // TAC-308 case 3: a knowledge-gap card holds the slot and this turn queues
  // for some reason OTHER than gapping itself. Regen-in-place would overwrite
  // the question an operator is about to answer, and migration 020 forbids a
  // second pending row, so the draft is discarded rather than stored.
  // TAC-350: `!isGapTurn` (not `!knowledgeGapFired`) — a turn the backstop
  // caught is just as much "gapping itself" as a self-reported one, and must
  // NOT be dropped as if it were an unrelated reason to queue.
  if (existingPending !== null && existingIsKnowledgeGapCard && !isGapTurn) {
    return {
      action: 'drop',
      reason: 'knowledge_gap_card_protected',
      triggers,
      protectedDraftId: existingPending.id,
    }
  }

  // TAC-308: arm the clock only when this draft is BECOMING a knowledge-gap
  // card that isn't already one.
  //   - fresh INSERT on a gap turn          → now + window
  //   - regen of a gap card, clock running  → undefined, preserving its
  //     original deadline so a guest asking a second unanswerable question
  //     can't push it out
  //   - regen of a gap card, clock ALREADY FIRED → undefined, so the holding
  //     message stays one-per-card. The guest was told "we're on it" minutes
  //     ago; a second holding note for a second unanswered question would be
  //     the same sentence again. The operator still holds the card.
  //   - gap turn overwriting a NON-gap card → now + window (the row is a gap
  //     card as of this write, so it needs a clock; that overwrite is the
  //     pre-existing TAC-264 clobber, out of scope here)
  //   - any non-gap queue                   → undefined, column untouched
  //
  // TAC-350: keyed on isGapTurn, not knowledgeGapFired alone — a fresh
  // backstop catch arms the clock exactly like a fresh self-reported gap;
  // both are "the guest asked something and got no grounded answer."
  const pendingUntil =
    isGapTurn && !existingIsKnowledgeGapCard
      ? new Date(Date.now() + KNOWLEDGE_GAP_WINDOW_MS)
      : undefined

  return {
    action: 'queue',
    triggers,
    primaryTrigger: pickPrimaryTrigger(triggers),
    compMatchedPattern: comp.matched ? comp.pattern : null,
    existingPendingDraftId: existingPending?.id ?? null,
    pendingUntil,
    // TAC-350: blank the body on a backstop catch too — the whole point is
    // that this text is an unverified claim; showing it to the operator as
    // a one-swipe-approvable draft is the exact failure TAC-309 already
    // fixed for the self-reported case.
    blankBody: isGapTurn,
  }
}

/**
 * Read-side lookup for an existing pending draft for the (venue, guest)
 * pair. Hits the migration 018 partial index
 * `idx_messages_review_state_pending (venue_id, created_at) WHERE review_state='pending'`
 * — single cheap lookup. Returns the row's id + body when found (body is
 * captured for forensic logging and future no-op detection; not load-bearing
 * at the route level), or null on miss / DB error.
 *
 * Fails OPEN: any throw is caught + logged + returns null so the approval
 * gate proceeds to send rather than refusing on a DB read failure. The
 * sticky-pending signal is the lowest-stakes of the four triggers; the
 * regex backstop and model self-flag don't depend on it. The partial
 * unique index from migration 020 is the structural backstop against
 * concurrent rapid-inbound races that slip past this read.
 *
 * Exported for the test suite. TAC-264 renamed from hasPendingDraft (which
 * returned a boolean) to surface the row identity for the persist layer.
 * TAC-308 adds `pending_until` + `review_reason` so the gate can tell a
 * knowledge-gap card (protected from eviction) from an ordinary pending
 * draft — see isKnowledgeGapCard for why it takes both.
 */
export async function findPendingDraft(
  venueId: string,
  guestId: string,
): Promise<{
  id: string
  body: string
  pending_until: string | null
  review_reason: string | null
} | null> {
  try {
    const supabase = createAdminClient()
    const { data, error } = await supabase
      .from('messages')
      .select('id, body, pending_until, review_reason')
      .eq('venue_id', venueId)
      .eq('guest_id', guestId)
      .eq('direction', 'outbound')
      .eq('review_state', 'pending')
      .limit(1)
      .maybeSingle()
    if (error) {
      console.warn(
        `[agent] findPendingDraft lookup degraded for venue=${venueId} guest=${guestId}: ${error.message}`,
      )
      return null
    }
    return data
  } catch (e) {
    console.warn(
      `[agent] findPendingDraft threw for venue=${venueId} guest=${guestId}: ${
        e instanceof Error ? e.message : String(e)
      }`,
    )
    return null
  }
}

const FALLBACK_TIMEZONE = 'America/Los_Angeles'
// TAC-324: used only by the R1 carve-out freshness check in buildAiRuntime.
const MS_PER_DAY = 24 * 60 * 60 * 1000

function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz })
    return true
  } catch {
    return false
  }
}

function computeToday(timezone: string, now: Date = new Date()): NonNullable<AiRuntimeContext['today']> {
  // Caller (buildAiRuntime) is responsible for passing a validated timezone —
  // otherwise Intl.DateTimeFormat throws a RangeError mid-format.
  // en-CA renders dates as YYYY-MM-DD; en-GB renders 24h HH:MM. Both are
  // locale conventions we exploit to avoid manual formatting.
  const isoDate = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now)
  const dayOfWeek = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    weekday: 'long',
  }).format(now)
  const venueLocalTime = new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(now)

  return { isoDate, dayOfWeek, venueLocalTime, venueTimezone: timezone }
}

// TAC-244 / TAC-123: map the agent's FollowupTrigger.reason to the
// AI-runtime's FollowupReason. day_* → post_visit_day_*; cold_lapsed and
// perk_unlock pass through. event / manual return null — those have their
// own dedicated context surfaces (eventBeingInvited / operatorInstruction)
// and don't render the `## Follow-up context` block. The switch covers
// every FollowupTrigger reason; adding one without a case here is a tsc
// error because the function's return type wouldn't admit the implicit
// `undefined`.
function triggerReasonToFollowupReason(
  reason: FollowupTrigger['reason'],
): FollowupReason | null {
  switch (reason) {
    case 'day_1':
      return 'post_visit_day_1'
    case 'day_3':
      return 'post_visit_day_3'
    case 'day_7':
      return 'post_visit_day_7'
    case 'day_14':
      return 'post_visit_day_14'
    case 'cold_lapsed':
      return 'cold_lapsed'
    case 'perk_unlock':
      return 'perk_unlock'
    case 'event':
    case 'manual':
      return null
  }
}

// TAC-244 / TAC-123: derive the `followup` field for the AI runtime from
// the agent runtime's trigger + visit data. The single mapping point makes
// the inbound-XOR-outbound invariant structural: `followup` only ever
// materializes downstream of a `followupTrigger`, and `handleInbound`'s
// entry-point assertion guarantees `followupTrigger === null` there. Returns
// undefined when:
//   - no followup trigger (inbound path)
//   - trigger.reason maps to null (event / manual — dedicated surfaces) AND
//     trigger.additionalReasons is empty
//
// TAC-123 widens the seam to consume `trigger.additionalReasons[]` — when
// the engine aggregates multiple detector hits for one guest, the rest of
// the FollowupReasons ride here and the rendered block carries them all in
// `reasons[]` (the serializer's multi-reason weaving rider fires when
// `reasons.length > 1`). De-dup is order-preserving with the primary at the
// head so the rendered list reads "primary, then the others."
export function deriveFollowupContext(
  trigger: FollowupTrigger | null,
  recentVisits: readonly Visit[],
  lastVisitAt: Date | null,
  now: Date,
): FollowupContext | undefined {
  if (!trigger) return undefined
  const primary = triggerReasonToFollowupReason(trigger.reason)
  // Combine primary + additionalReasons (de-duplicated, order preserved with
  // primary first). When the primary is null (event/manual) but the engine
  // attached additionalReasons anyway — defensive — we still render any
  // valid additional reasons.
  const reasons: FollowupReason[] = []
  if (primary) reasons.push(primary)
  for (const extra of trigger.additionalReasons ?? []) {
    if (!reasons.includes(extra)) reasons.push(extra)
  }
  if (reasons.length === 0) return undefined

  // Anchor selection: if a post_visit_* reason is present, prefer
  // recentVisits[0] (carries items so the prompt can name what the guest
  // had). Otherwise (cold_lapsed-only or perk_unlock-only), fall back to
  // guests.last_visit_at (date-only minimal anchor). Mixed runs that include
  // post_visit_* + cold_lapsed/perk_unlock take the post_visit anchor —
  // freshest visit wins for items context.
  const hasPostVisit = reasons.some((r) => r.startsWith('post_visit_'))
  let anchor: FollowupAnchorVisit | undefined
  if (hasPostVisit && recentVisits[0]) {
    anchor = {
      visitedAt: recentVisits[0].visitedAt,
      items: recentVisits[0].items,
    }
  } else if (lastVisitAt) {
    // cold_lapsed / perk_unlock anchor: a deep-lapsed guest's last visit can
    // fall outside the recentVisits window (90d / 20 txn). items omitted —
    // we don't carry line items for visits older than the window, and a
    // perk_unlock-only run isn't about specific items anyway.
    anchor = { visitedAt: lastVisitAt }
  }
  // If no anchor available, the block still renders with daysSinceLastVisit=0
  // and the serializer omits the anchor line. The reasons themselves carry
  // useful framing even without the anchor.
  const daysSinceLastVisit = anchor
    ? Math.floor((now.getTime() - anchor.visitedAt.getTime()) / 86_400_000)
    : 0
  return { reasons, daysSinceLastVisit, anchorVisit: anchor }
}

// TAC-324: R1 carve-out signal. Every ingredient is already on the
// agent-side context, so this is computed from `ctx` directly (the single
// mapping seam) rather than threading a new field through
// build-runtime-context.ts — same pattern as `perkBeingUnlocked` below.
// `recentMessages.length === 0` (current inbound already excluded, 14-day
// lookback) is the "first inbound" test: a qr_scan guest's guest row and
// their triggering message row are created in the same webhook request
// (confirmed against app/api/webhooks/sendblue/route.ts), so there is no gap
// between "created" and "first message" to worry about on the true first
// turn. The additional age check is what distinguishes that true first turn
// from a guest who goes quiet for weeks and then sends a SECOND message that
// also happens to have no OTHER messages inside the 14-day lookback —
// without it, a three-weeks-later "do you have parking" would incorrectly
// re-fire the "just scanned" framing. Reuses REPORTED_ORDER_WINDOW_DAYS (not
// a new constant) as the "is this still a fresh first-touch moment" check,
// deliberately unlike deriveOpenIntentions' expiry (its own independent
// constant for a genuinely different concept, ask vs. listen). Code-review
// note: this reuse is NOT load-bearing as things stand today —
// recentMessages.length===0 already requires no message inside the 14-day
// MAX_HISTORY_DAYS lookback, so any stale re-trigger this age check would
// catch is already at least 14 days old, past every window constant in this
// file (7 or 3). Any value <= MAX_HISTORY_DAYS produces identical gating
// today. Kept as REPORTED_ORDER_WINDOW_DAYS anyway for the conceptual match
// (both are "is this still a fresh first-touch moment") and so the two don't
// silently diverge if MAX_HISTORY_DAYS ever changes.
//
// TAC-332: extracted into its own exported function (previously inlined in
// buildAiRuntime below) so `handle-inbound.ts` can reuse the SAME "is this
// the opener turn" signal to gate `recordIntentionPrompts` — the opener
// block instructs the model to greet + ask newness, never order, so there is
// no legitimate path for a turn-one send to raise a first-touch intention,
// and running the classifier there has no upside, only false-positive risk.
// Reusing this flag rather than inventing a new turn-index check keeps the
// two call sites (what renders the opener, what's allowed to record against
// it) structurally unable to disagree about what "the opener turn" means.
// `buildAiRuntime` below calls this with `new Date()`, identical to its
// prior inline `Date.now()` call — zero behavior change there.
export function computeFirstTouchAfterQrScan(ctx: RuntimeContext, now: Date): boolean {
  return (
    ctx.currentMessage !== null &&
    ctx.guest.createdVia === 'qr_scan' &&
    ctx.recentMessages.length === 0 &&
    now.getTime() - ctx.guest.createdAt.getTime() <= REPORTED_ORDER_WINDOW_DAYS * MS_PER_DAY
  )
}

/**
 * Map orchestrator RuntimeContext → lib/ai's RuntimeContext shape.
 * Exported so the Voices regen helper can reuse the same mapping without
 * duplicating timezone validation, follow-up framing, or the recentVisits
 * threading. Regen post-injects `critiqueToIncorporate` on top of the
 * returned object — this function deliberately doesn't know about that
 * field so the standard agent paths stay identical.
 */
export function buildAiRuntime(ctx: RuntimeContext): AiRuntimeContext {
  let additionalContext: string | undefined
  let operatorInstruction: string | undefined
  if (ctx.followupTrigger) {
    if (ctx.followupTrigger.reason === 'manual') {
      // Operator-initiated follow-up via the Command Center button. THE-232
      // splits the operator's note out of additionalContext into its own
      // dedicated field, which the serializer renders as a prominent
      // top-level "## Operator instruction" block. This makes the note the
      // dominant signal rather than an easy-to-miss line at the bottom of
      // the user prompt.
      //
      // The note still travels as content guidance, not voice mimicry — the
      // agent speaks in the venue persona regardless of how the operator
      // phrased their note. That voice discipline is reinforced in the
      // manual-category instructions and the new prompt block.
      const rawHint = ctx.followupTrigger.metadata?.hint
      const hint =
        typeof rawHint === 'string' && rawHint.trim().length > 0 ? rawHint.trim() : null
      if (hint) {
        operatorInstruction = hint
      } else if (ctx.pendingQuestion?.mode === 'writing_holding') {
        // TAC-308: the holding-message run reaches buildAiRuntime through a
        // synthetic 'manual' trigger (it needs the outbound path), but no
        // operator asked for it — the timer did. Emitting the generic
        // "the venue operator has asked you to follow up" line below would be
        // a false statement in the prompt, and it would compete with the
        // `## Unanswered question` block that carries the real brief. Leave
        // both operatorInstruction and additionalContext unset.
      } else {
        // No note — fall back to the generic framing as before, via
        // additionalContext. Without the block firing, Sonnet still needs
        // to know this was operator-initiated.
        additionalContext =
          'The venue operator has asked you to follow up with this guest. Use your judgment about what to say based on the conversation history and guest context.'
      }
    } else {
      // Cron-triggered follow-ups (day_1/day_3/etc., event). Existing path.
      const meta = ctx.followupTrigger.metadata
      additionalContext = meta
        ? `Followup trigger: ${ctx.followupTrigger.reason} (${JSON.stringify(meta)})`
        : `Followup trigger: ${ctx.followupTrigger.reason}`
    }
  }

  // Validate venue timezone. On failure, log + fire a meta-alert (Slack
  // surface so the broken venue config gets fixed) and proceed with a sane
  // fallback. Fire-and-forget — fireRedAlert never throws, and we don't want
  // generation to block on a webhook roundtrip.
  let timezone = ctx.venue.timezone
  // TAC-301: a substituted timezone is, by definition, input we did not
  // positively understand — resolving a confident open/closed verdict against
  // Los Angeles for a venue that isn't there is exactly the wrong-CLOSED the
  // resolver's governing rule exists to prevent. Track the substitution and
  // suppress the status line when it happened.
  let timezoneSubstituted = false
  if (!isValidTimezone(timezone)) {
    console.warn(
      `computeToday: invalid timezone "${timezone}" for venue ${ctx.venue.id}, falling back to ${FALLBACK_TIMEZONE}`,
    )
    void fireRedAlert({
      agentRunId: ctx.agentRunId,
      venueId: ctx.venue.id,
      guestId: ctx.guest.id,
      kind: ctx.currentMessage ? 'inbound' : 'followup',
      stage: 'venue_config_integrity',
      errorCode: 'invalid_timezone',
      errorMessage: `invalid timezone string: "${timezone}"`,
      extra: {
        providedTimezone: timezone,
        fallbackUsed: FALLBACK_TIMEZONE,
      },
    })
    timezone = FALLBACK_TIMEZONE
    timezoneSubstituted = true
  }

  // TAC-123: when the engine attached a perkMechanic to a perk_unlock
  // trigger, surface it as the AI runtime's `perkBeingUnlocked` so the
  // serializer renders the `## Perk being unlocked` block. The block is
  // outbound-only — handleInbound's entry-point assertion guarantees
  // followupTrigger=null on inbound, so perkBeingUnlocked is never set on
  // the inbound path. Only the typed `perkMechanic` channel populates this
  // — the engine never threads it through `metadata`.
  const perkBeingUnlocked = ctx.followupTrigger?.perkMechanic
    ? {
        name: ctx.followupTrigger.perkMechanic.name,
        qualification: ctx.followupTrigger.perkMechanic.qualification ?? '',
        rewardDescription: ctx.followupTrigger.perkMechanic.rewardDescription ?? '',
      }
    : undefined

  // TAC-332: extracted to the standalone computeFirstTouchAfterQrScan above
  // so handle-inbound.ts can reuse the same signal to gate
  // recordIntentionPrompts. `new Date()` here matches the prior inline
  // `Date.now()` call exactly — no behavior change.
  // One `now` for everything time-derived in this mapper, so the rendered
  // clock and the open/closed verdict can't straddle a minute boundary and
  // disagree — same single-timestamp discipline as the recognition snapshot's
  // `computedAt`.
  const now = new Date()
  const firstTouchAfterQrScan = computeFirstTouchAfterQrScan(ctx, now)

  return {
    guestName: ctx.guest.firstName ?? undefined,
    inboundMessage: ctx.currentMessage?.body,
    perkBeingUnlocked,
    additionalContext,
    operatorInstruction,
    // TAC-301: openState is resolved here rather than in the serializer
    // because this is the only place that holds both halves — the venue's
    // hours (ctx.venue.venueInfo) and the validated timezone. `venueInfoToProse`
    // sees the hours but not the clock; `runtimeToProse` sees the clock but not
    // the hours. Leaving the join to the model is what produced the bug.
    today: {
      ...computeToday(timezone, now),
      openState: timezoneSubstituted
        ? { state: 'unknown' }
        : resolveOpenState(ctx.venue.venueInfo.hours, timezone, now),
    },
    recentMessages: ctx.recentMessages,
    mechanics: ctx.mechanics,
    // TAC-234: thread the recent transactions through to the AI module's
    // RuntimeContext. The serializer gates rendering by category (welcome /
    // opt_out skip) and on non-emptiness. recognition state is surfaced as
    // a `Guest relationship: <state>` line near the inbound framing.
    recentVisits: ctx.recentVisits,
    recognition: { state: ctx.recognition.state },
    // TAC-296: thread parsed guest context (post-filterActiveLifeContext +
    // observations-truncated) through to the AI module. The serializer
    // (formatGuestContext) renders the `## Guest context` block between
    // visit history and recent conversation; empty context omits the block.
    guestContext: ctx.guest.context,
    // TAC-297: thread active commitments (open + pending_ack) to the AI
    // module. The serializer (formatActiveCommitments) renders the
    // `## Active commitments` block between guest context and recent
    // conversation; empty array omits the block.
    activeCommitments: ctx.activeCommitments,
    // TAC-324: thread open first-touch intentions (already gated to qr_scan
    // guests, inbound runs only, and current-turn-suppressed by
    // build-runtime-context.ts) as rendered prompt lines. The serializer
    // renders the `## What you're hoping to get to` block between mechanics
    // and follow-up context / visit history when non-empty.
    openIntentions:
      ctx.openIntentions.length > 0 ? ctx.openIntentions.map((o) => o.promptLine) : undefined,
    firstTouchAfterQrScan,
    // TAC-308: the outstanding knowledge-gap question. Rendered as
    // `## Unanswered question` immediately before `## Recent conversation`.
    // null → undefined so the serializer's presence check omits the block.
    pendingQuestion: ctx.pendingQuestion ?? undefined,
    // TAC-244: derive `followup` here at the single mapping seam.
    // `deriveFollowupContext` returns undefined on the inbound path
    // (followupTrigger=null) and on the event/manual trigger reasons
    // (dedicated context surfaces). The serializer
    // (formatFollowupContext) renders the `## Follow-up context` block
    // immediately BEFORE `## Visit history` when this field is present.
    followup: deriveFollowupContext(
      ctx.followupTrigger,
      ctx.recentVisits,
      ctx.guest.lastVisitAt,
      new Date(),
    ),
    // v1.24.0: the crux of warm-but-gated complaint handling. True only when
    // category routing guarantees this draft reaches an operator before the
    // guest sees it — which is exactly when the prompt may invite a comp.
    //
    // The `!== true` demo guard is load-bearing, not defensive: TAC-284's
    // bypass in applyApprovalPolicyStage returns action:'send' unconditionally
    // and overrides every trigger, so telling a demo guest's generation "a
    // human will review this" would produce a comp-forward draft that then
    // auto-sends to a real phone. Demo guests keep the restrictive prompt.
    //
    // TAC-307 SCOPES THIS TO COMPLAINT CATEGORIES. It used to be "policy holds
    // this category", full stop — which was harmless while a venue-wide
    // `default: 'operator_approval'` required hand-written SQL and no venue
    // had one. This ticket ships a master switch that sets exactly that, and
    // an unscoped flag would turn the comp-forward branch of
    // formatMechanicEligibility on for EVERY turn at a holding venue: the
    // agent would start proposing to make it up to a guest who asked whether
    // the cafe is open. Review being guaranteed is a necessary condition for
    // inviting generosity, never a sufficient one — the turn also has to be
    // the kind of turn generosity belongs in, which is what FLOOR_CATEGORIES
    // (comp_complaint today) names.
    willBeReviewed:
      ctx.guest.isDemo !== true &&
      isFloorCategory(ctx.classification?.category) &&
      resolveCategoryPolicy(ctx.venue.approvalPolicy, ctx.classification?.category) ===
        'operator_approval',
  }
}