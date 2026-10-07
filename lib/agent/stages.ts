import { computeCalendar } from './calendar'
import {
  captureCancellationCheckUnavailable,
  captureCancellationClaimUnbacked,
  captureClassificationLowConfidence,
  captureDashViolationPersisted,
  captureDemoBypassedApprovalGate,
  captureEmojiDirectiveViolated,
  captureMechanicOfferBackstopCaught,
  captureClosedVenueArrivalCaught,
  captureProsePromiseCaught,
  captureProsePromiseCheckUnavailable,
  captureRegenerationTriggered,
  captureUnverifiedUrlHeld,
  CLASSIFICATION_CONFIDENCE_LOW_THRESHOLD,
  CLASSIFICATION_CONFIDENCE_REROUTE_THRESHOLD,
  type CheckDisposition,
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
  verifyCancellationClaim,
  verifyMechanicOffer,
  verifyClosedVenueArrival,
  verifyProsePromise,
  type VoiceCorpusChunk as AiVoiceCorpusChunk,
} from '@/lib/ai'
import { resolveEmojiDirective } from '@/lib/ai/emoji-cadence'
// TAC-401: imported BY PATH, not from the barrel above.
import { VERIFY_PROSE_PROMISE_TRUNCATED_ERROR_CODE } from '@/lib/ai/verify-prose-promise'
// TAC-513: imported BY PATH for the same reason as the line above.
import { VERIFY_CANCELLATION_CLAIM_TRUNCATED_ERROR_CODE } from '@/lib/ai/verify-cancellation-claim'
// TAC-363: imported BY PATH for the same reason as the lines above.
import { VERIFY_CLOSED_VENUE_ARRIVAL_TRUNCATED_ERROR_CODE } from '@/lib/ai/verify-closed-venue-arrival'
import { isVenueClosed, resolveVenueOpenState } from './venue-open-state'
import {
  type CancellationResolution,
  type PendingCancellation,
  isEmptyArrivalCapture,
  isEmptyCommitmentEmission,
  type PendingCommitment,
  pendingFromEmission,
  resolveCancellation,
} from '@/lib/schemas/guest-commitment'
import {
  resolveCategoryPolicy,
  resolvePolicyDecision,
  resolveReviewAskDisposition,
} from '@/lib/schemas/approval-policy'
import { parseVenueLinks } from '@/lib/schemas/venue-info'
import { loadVoicePack, retrieveKnowledgeContext } from '@/lib/rag'
import { fireRedAlert } from './alerts'
import { matchComp } from './comp-backstop'
import { isFloorCategory, matchForwardCommitment } from './complaint-floor'
import { canAutoSendComplaintTurn } from './complaint-routing'
import { REPORTED_ORDER_WINDOW_DAYS } from './extract-reported-order'
import { renderableIntentions } from './intentions/derive'
import { getPrimaryTagPreference } from './knowledge-tag-mapping'
import {
  buildContextQuery,
  CONTEXT_TURNS,
  KNOWLEDGE_MERGE_RULE,
  mergeKnowledgeMatches,
  type MergeRule,
} from './retrieval-context'
import { looksLikeQuestion } from './looks-like-question'
import {
  commitmentIdentityOf,
  type CommitmentIdentity,
  anyKnowledgeGapCard,
  type ConversationDisposition,
  decideSlotAction,
  EMPTY_PENDING_ROWS,
  isKnowledgeGapCard,
  loadPendingRowsBySlot,
  occupantOfSlot,
  otherSlotOccupied,
  resolveConversationDisposition,
  silencesConversationTurn,
  type PendingSlot,
  resolveDraftCarrierIdentity,
  pendingSlotOf,
  type SlotDropReason,
} from './pending-slots'
import type {
  Classification,
  CorpusMatch,
  FollowupTrigger,
  KnowledgeMatch,
  RuntimeContext,
  Visit,
} from './types'
import type { MessageCategory } from '@/lib/ai'

// STRONG_MATCH_SIMILARITY / MIN_STRONG_MATCHES / CORPUS_RETRIEVE_LIMIT lived
// here until decision 0008 (2026-09-29): voice is a static per-venue pack
// (lib/rag/voice-pack.ts), not a similarity retrieval, so there is no match
// to score. The inbound fail-closed direction survives as the empty-pack
// throw in retrieveCorpusStage below.
//
// SEND_FIDELITY_FLOOR (0.4) and AUTO_SEND_FIDELITY_FLOOR (0.6) also lived
// here until the v1.80.0 schema diet. Both gated on the model's voiceFidelity
// self-score, and neither ever fired in production: across 110 scored sends
// the minimum was 0.72, the refuse branch never ran, and the
// fidelity_below_auto_send_floor trigger queued zero drafts. The score and
// both floors were removed together ("distrust any gate whose true-positive
// history you cannot produce").
export const KNOWLEDGE_RETRIEVE_LIMIT = 4

/**
 * The agent's knowledge gate: minimum per-query cosine similarity for a
 * knowledge_corpus chunk to reach the prompt.
 *
 * **CURRENTLY IDENTICAL TO `lib/rag`'s `SIMILARITY_FLOOR` (0.3), THEREFORE
 * FILTERS NOTHING TODAY.** `retrieveKnowledgeContext` already drops anything
 * below 0.3 on the same field with the same `>=`, so every chunk reaching
 * `filterByRelevance` has cleared this bar before it is applied. Stated first
 * because a constant whose guard silently does nothing is how a field goes
 * 102 days unread while everyone assumes it works (see `approval_policy` in
 * CLAUDE.md). It is inert. Do not reason from it as a live filter.
 *
 * **It exists anyway, and not as a raise-it-later placeholder** — that
 * argument is the trap, not the escape from it. `SIMILARITY_FLOOR` lives in
 * `lib/rag/retrieve.ts` and serves retrieval generally, voice corpus
 * included. This is the agent's knowledge threshold specifically. They
 * coincide at 0.3 today and the coincidence is not a guarantee: someone
 * tuning `SIMILARITY_FLOOR` for a different caller must not silently move
 * what the agent will ground a guest-facing reply in.
 *
 * ── Why it is 0.3 and not 0.5 ──────────────────────────────────────────
 *
 * The change from 0.5 was NOT a no-op. At 0.5 this filter was deleting the
 * 0.3–0.5 band that `SIMILARITY_FLOOR` had already admitted. Measured on the
 * headline query, "whats underrated here" went from 0 chunks to 4.
 *
 * TAC-350 set 0.5 as a proxy for topicality: below is off-topic, above is
 * on-topic. TAC-358 measured that proxy against Le Mil's live corpus and
 * **the distributions invert.** "where is the bathroom" — genuinely
 * unanswerable here — scores 0.5439, above EVERY answerable terse
 * recommendation question (max 0.4971: the Blossom Tonic chunk, which
 * literally reads "the most underrated item on the menu", ranked #1 and
 * deleted three thousandths under the floor).
 *
 * No threshold fixes that, and three were tested. An absolute floor is boxed
 * in (any guard above 0.3250 kills a real answer, any below 0.3991 admits a
 * weather question). A relative margin admits the top match for every query
 * by construction. Peak shape separates no better — "where is the bathroom"
 * has a sharper peak than every on-topic query but one. A chunk rewritten to
 * contain the question verbatim still scored 0.4871. Cosine here tracks query
 * length and specificity, not answerability.
 *
 * So this stopped trying to judge relevance, and the semantic call moved to
 * the model's own `knowledge_gap` self-report.
 *
 * Measured before the change rather than assumed: queue volume does not rise.
 * 5/36 queued at 0.5 versus 3/36 at 0.30 across two runs of 18 queries
 * through the real generate + verify path, and off-topic questions arriving
 * with four irrelevant chunks declined cleanly rather than fabricating. n=2
 * at temperature 0.7, so the supported claim is no evidence of an increase,
 * not evidence of a decrease.
 *
 * `knowledgeChunksToProse`'s header was reframed in the SAME change and the
 * two cannot be separated: those declines were measured under the old "facts
 * you can ground replies in" wording, and admitting weaker chunks under a
 * header that calls them facts is what invites building on them.
 *
 * Applied per-chunk, not as an all-or-nothing top-match gate. Shared with
 * `lib/voices/regenerate-with-critique.ts` via the exported
 * `filterByRelevance` (TAC-366) — changing this value reaches both paths.
 */
export const KNOWLEDGE_RELEVANCE_FLOOR = 0.3

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
 * handle-followup) and the PostHog event helper can reuse the
 * literal strings without copy-paste drift.
 */
export const APPROVAL_TRIGGERS = {
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
  // TAC-355: deterministic backstop. Fires unconditionally when
  // GenerateMessageResult.selfTalkViolationPersisted is true — the reply
  // still contains self-correction or a reference to the agent's own
  // instructions/rules/AI-nature after every regen attempt inside
  // generateMessage's loop (lib/ai/self-talk-detector.ts). Never a send:
  // unlike the dash regex (THE-225), which ships anyway on exhaustion, a
  // guest reading agent self-talk learns they're texting a bot, which is
  // categorical harm regardless of rate.
  SELF_TALK_DETECTED: 'self_talk_detected',
  // TAC-509: deterministic backstop for a link nobody curated. Fires
  // unconditionally when GenerateMessageResult.unverifiedUrls is non-empty —
  // the reply still carries a link that is not on the venue's
  // `venue_info.links` allowlist after every regen attempt inside
  // generateMessage's loop (lib/ai/url-detector.ts).
  //
  // Never a send, for the same reason SELF_TALK_DETECTED is not: a wrong link
  // looks right. lemils.com/products/* resolves to a live Shopify store, so a
  // fabricated slug is a 404 in the guest's hand rather than an obvious error,
  // and the guest acts on it before anyone here knows.
  //
  // The allowlist is CURATED, never derived — not from retrieved knowledge,
  // not from the composed prompt, not from venue_info.contact. So this trigger
  // firing means "a human never approved this link", which is a different and
  // stronger claim than "we could not ground it".
  UNVERIFIED_URL: 'unverified_url',
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
  // unparseable check queues rather than degrading to pre-check behavior.
  // An unauthorized perk grant costs the owner money and control; a failed
  // check costs one unnecessary review.
  MECHANIC_OFFER_BACKSTOP: 'mechanic_offer_backstop',
  // TAC-401: independent post-generation check for a promise made in PROSE
  // with no structured commitment behind it. THE PRIMARY CONTROL for that
  // failure (ruled 2026-09-15, question 1, option c), not a secondary layer.
  //
  // Both controls that were supposed to cover it measured near zero on the
  // same 220 replies: the model's own `requiresOperatorApproval` self-flag
  // fired 0 times and caught 0 of the 4 genuine uncarried promises, and the
  // comp regex fired 5 times and caught 0 of them (3 apology idioms, 1
  // fabricated comp). Nothing may depend on the self-flag; it stays only as a secondary signal.
  //
  // Unlike every other backstop here, this one can PRODUCE the carrier: the
  // check names the commitment type and description, which ride the queue
  // decision onto messages.pending_commitment so an operator approving the
  // card creates a real guest_commitments row through the path that already
  // exists. That is what makes the promise tracked — expiry, heads-up
  // surfacing and dedup all apply from that point — rather than an obligation
  // no system in the product knows about.
  PROSE_PROMISE_BACKSTOP: 'prose_promise_backstop',
  // TAC-401: the prose-promise check produced no readable verdict.
  //
  // FAILS CLOSED on every failure mode, after one retry on a transient fault
  // (ruled 2026-09-21).
  //
  // This one must never be loosened: it has no prior to degrade to — the
  // self-flag caught 0 of 220 and the ruling forbids depending on it — so
  // failing open here returns to nothing at all. The retry is what pays for
  // the closed posture on a check this broad: the flood case narrows from "any
  // hiccup" to "a fault that survives two immediate attempts".
  //
  // A DISTINCT trigger rather than folding into PROSE_PROMISE_BACKSTOP:
  // telling an operator a promise was caught on a turn where nothing was
  // caught is the wrong-reason-copy problem TAC-364 exists for. It also means a sustained
  // outage is countable in SQL separately from a wave of real catches.
  //
  // Deliberately carries NO carrier: we do not know what was promised, so
  // nothing is recorded and approving that card creates no commitment. The
  // alternative is inventing a description, which would land in
  // guest_commitments.description and render as a fact nobody wrote.
  PROSE_PROMISE_CHECK_FAILED: 'prose_promise_check_failed',
  // TAC-363: the reply confirms an arrival at a venue that is CLOSED.
  //
  // Deterministic and structural: the generation emitted an `imminent`
  // arrivalCapture and the venue's own hours say it is shut. No model
  // judgement is involved, which is the point — TAC-301 part 1 put a
  // `- Status:` line in the prompt telling the model the venue is closed, and
  // on 2026-09-14 the model read it and said "See you soon" anyway. That is
  // this repo's recurring pattern (TAC-314, TAC-327, TAC-329, TAC-330,
  // TAC-338): a correctly worded instruction losing to content rendered
  // closer to generation. The relationship this has to the status line is the
  // one COMP_REGEX_BACKSTOP has to MODEL_FLAGGED.
  //
  // SCOPED TO `imminent` (ruled 2026-09-21, narrowing the ticket's literal
  // proposal). A `scheduled` capture while closed is a guest arranging
  // tomorrow morning at 11pm, which is correct behaviour and holds nothing;
  // gating it would queue the most common out-of-hours arrival conversation
  // and protect nobody, since nobody sets off on the strength of it. The
  // commitment half of the literal proposal is dropped for a different
  // reason: comp, hold and discount already queue on every turn via
  // COMMITMENT_TYPE_GATED regardless of hours, so its only net-new coverage
  // was a recommendation, which ruling 4(a) has just removed from the arrival
  // path entirely.
  CLOSED_VENUE_ARRIVAL_EMITTED: 'closed_venue_arrival_emitted',
  // TAC-363: independent text backstop for the same failure, covering the
  // shape the structural trigger above cannot see.
  //
  // A reply that reads as a same-moment confirmation while emitting NO
  // structured field — "see you soon" with nothing attached — passes every
  // other trigger by construction and auto-sends. The 2026-09-15 ruling added
  // this check for exactly that gap.
  //
  // FAILS CLOSED, and 'flagged' and 'check_failed' ride ONE trigger, following
  // MECHANIC_OFFER_BACKSTOP rather than the prose-promise split. That split
  // exists so an operator is never told "a claim was caught" on a turn where
  // nothing was caught; here the operator's decision is identical either way
  // (the venue is shut and this reply may be sending someone over, read it),
  // which is the test that precedent turns on.
  CLOSED_VENUE_ARRIVAL_BACKSTOP: 'closed_venue_arrival_backstop',
  // TAC-513: the draft carries a structured cancellation, resolved against
  // this guest's own open commitments. ALWAYS queues, whatever else is true:
  // taking back something a guest was promised is an operator decision, and
  // there is no auto-send path for one.
  //
  // The mirror of COMMITMENT_TYPE_GATED, and ranked directly below it. On a
  // reply that both offers and cancels, the label the operator reads should be
  // the one about money going OUT, which is the exposure this repo has bled on
  // twice.
  //
  // The one path where a cancellation is not queued is the TAC-284 demo
  // bypass, which overrides every trigger by design. schedule-and-send applies
  // the cancellation inline there, so a demo guest's ledger still follows
  // their words.
  COMMITMENT_CANCELLATION_GATED: 'commitment_cancellation_gated',
  // TAC-513: the reply TELLS the guest a promise is cancelled and nothing
  // carries it. The 2026-09-21 incident exactly: comp GWPZ stayed `open` while
  // the guest was told it was gone.
  //
  // Fires on two shapes, deliberately folded into one trigger because the
  // operator's decision is identical and the copy is true of both: the
  // independent check read a cancellation in the body with no carrier, OR the
  // model emitted an id that did not resolve against this guest's own
  // commitments. The PostHog event carries the unresolved id and the open
  // count, which is where the two are told apart.
  //
  // NEVER SENDS. Unlike PROSE_PROMISE_BACKSTOP it carries no carrier and never
  // mints one: minting an obligation from a second reading of prose is
  // protective, minting a cancellation is destructive.
  PROSE_CANCELLATION_BACKSTOP: 'prose_cancellation_backstop',
  // TAC-513 (split out on the 2026-09-22 ruling): the model emitted a
  // commitment id that resolves to NOTHING for this guest, while the body
  // reads clean.
  //
  // This shipped folded into PROSE_CANCELLATION_BACKSTOP above, and the fold
  // was wrong in the one way that matters on a card: that trigger's copy says
  // "This tells the guest a promise is cancelled", which is simply FALSE of a
  // reply whose text says nothing of the kind. An operator reading it goes
  // looking for a sentence that is not there. Same wrong-reason-copy problem
  // TAC-364 exists for, and the same one PROSE_CANCELLATION_CHECK_FAILED was
  // kept separate to avoid.
  //
  // The HOLD is unchanged and still right: an emission reaching for a
  // commitment that is not there is worth a human's glance whatever the prose
  // says. Only the sentence the operator reads is different.
  //
  // Mutually exclusive with PROSE_CANCELLATION_BACKSTOP by construction (that
  // one takes precedence whenever the body claims it), so the two can never
  // both describe one card.
  UNRESOLVED_CANCELLATION_ID: 'unresolved_cancellation_id',
  // TAC-513: the cancellation-claim check produced no readable verdict.
  //
  // FAILS CLOSED on every failure mode, like PROSE_PROMISE_CHECK_FAILED and
  // for the same reason: there is no prior to degrade to. A DISTINCT trigger
  // rather than folding into the line above, per TAC-367 and TAC-364: telling
  // an operator a cancellation was caught on a turn where nothing was caught
  // is the wrong-reason-copy problem.
  PROSE_CANCELLATION_CHECK_FAILED: 'prose_cancellation_check_failed',
  // The once-ever Google review ask (lib/agent/review-ask.ts). Fires when the
  // draft carries a composed review ask AND the venue's approval_policy says
  // asks queue (resolveReviewAskDisposition; the code default is queue,
  // fleet-wide). NOT a risk finding: this is an expected, policy-driven
  // queue — the launch posture is every ask in front of an operator until
  // the praise classifier's precision is proven on real traffic, and the
  // flip to auto-send is one Studio JSONB edit ("reviewAsk": "auto_send"),
  // no deploy. The link itself is independently safe either way: it is on
  // the curated allowlist or UNVERIFIED_URL fires.
  REVIEW_ASK: 'review_ask',
} as const

/**
 * Union of every trigger code that can land on `messages.review_reason`.
 * Consumed by the operator-queue normalizer (lib/operator/queue.ts) to
 * keep the human-readable label map exhaustive at compile time — adding
 * a new trigger above without a corresponding label there is a TS error.
 */
export type ApprovalTrigger =
  (typeof APPROVAL_TRIGGERS)[keyof typeof APPROVAL_TRIGGERS]

/**
 * TAC-364: `messages.review_reason` for a card written by
 * `persistGenerationFailureCard` (handle-inbound.ts) after generation has
 * crashed twice.
 *
 * DELIBERATELY NOT A MEMBER OF `APPROVAL_TRIGGERS`. The gate never fires it —
 * a crash produces no `GenerateMessageResult`, so `applyApprovalPolicyStage`
 * cannot run at all and the card is written directly. Putting it in the union
 * would claim it is a gate outcome, and would force an entry in
 * `PUSH_POLICY`'s total map for a value the gate can never emit. It lives here
 * rather than in handle-inbound.ts because `isKnowledgeGapCard` below and
 * `findPendingQuestion` (pending-question.ts) both compare against it, and
 * both are imported BY handle-inbound — the other direction is circular.
 *
 * TAC-309 shipped these cards stamped `knowledge_gap`, which reuses the
 * timer, the holding message and the priority wiring unchanged — correct
 * mechanically, but it makes the operator-facing copy false: "a guest asked
 * something I don't have an answer for" is not what happened. The crash path
 * gets its own value so the copy can be true, and joins the two predicates
 * below so nothing else about its handling changes.
 *
 * Mirrors `CRISIS_SAFETY_REVIEW_REASON` (lib/agent/crisis-safety.ts) and
 * `OPERATOR_DECLINE_PRIMARY_TRIGGER` (lib/agent/handle-operator-decline.ts):
 * a review_reason owned by the path that stamps it, outside the policy union.
 */
export const GENERATION_FAILED_REVIEW_REASON = 'generation_failed'

/**
 * TAC-574: `messages.review_reason` on the blank card written for a turn with
 * media and no text (lib/agent/inbound-media.ts has the ruling; the writer is
 * persistMediaOnlyCard in handle-inbound.ts). Outside the policy union like
 * the value above: no gate fires it, the path stamps it itself.
 *
 * Here rather than in inbound-media.ts so lib/operator/queue.ts and
 * lib/notifications/send.ts can import the one constant without loading that
 * module's database client.
 *
 * NOT in KNOWLEDGE_GAP_CARD_REVIEW_REASONS, and that is a decision. That
 * family is "the guest asked something and is owed an answer", which arms the
 * unanswered-question block on later turns. A photo is not a question.
 */
export const MEDIA_ONLY_REVIEW_REASON = 'media_only_inbound'

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
  // TAC-513: directly below the offer, and the ordering is a judgement. On a
  // reply that both offers and cancels, the operator should read the label
  // about money going OUT first: an unnoticed new comp costs the venue, where
  // an unnoticed cancellation costs a card they were going to read anyway.
  APPROVAL_TRIGGERS.COMMITMENT_CANCELLATION_GATED,
  // TAC-355: ranked directly after COMMITMENT_TYPE_GATED — parity with it,
  // not below it. This backstop is the PRIMARY defense for the mechanic-
  // grant failure mode (see its own comment on APPROVAL_TRIGGERS above), so
  // an unauthorized-perk signal should carry the same operator-facing
  // priority as an unauthorized comp/hold/discount.
  APPROVAL_TRIGGERS.MECHANIC_OFFER_BACKSTOP,
  // TAC-401: third, in the same obligation group as the two above and ABOVE
  // every regex and self-report trigger below.
  //
  // It is the primary control for the uncarried-promise failure, and it is the
  // only trigger in the group that can arrive carrying the commitment itself —
  // so on a co-firing turn its label is the one that tells the operator what
  // decision they are actually making. It deliberately outranks
  // COMP_REGEX_BACKSTOP and MODEL_FLAGGED, the two signals this check replaces
  // as the control (both measured at 0 catches on the 4 genuine promises), and
  // COMPLAINT_COMMITMENT_FLOOR, whose copy names the complaint rather than the
  // promise.
  //
  // Below COMMITMENT_TYPE_GATED because that one is a structured emission and
  // this one is a model judgement on prose, and below
  // MECHANIC_OFFER_BACKSTOP to leave TAC-355's parity with the structural gate
  // undisturbed.
  APPROVAL_TRIGGERS.PROSE_PROMISE_BACKSTOP,
  // TAC-513: beside its sibling. A reply that lies to the guest about what
  // they are owed outranks the softer signals below, and ranks under the
  // promise backstop for the same money-first reason as the pair above.
  APPROVAL_TRIGGERS.PROSE_CANCELLATION_BACKSTOP,
  // TAC-513: directly below the shape it was split from. The two are mutually
  // exclusive, so this ordering never decides between them; it decides against
  // everything else, and it sits ABOVE PROSE_CANCELLATION_CHECK_FAILED because
  // an id that resolves to nothing is a finding about this draft where a failed
  // check is an absence of one. Those two CAN co-fire.
  APPROVAL_TRIGGERS.UNRESOLVED_CANCELLATION_ID,
  // TAC-308: second, deliberately not first. The ticket asked for "top of
  // priority," but that request was reasoning about the TIMER — and the timer
  // anchors on messages.pending_until, not on review_reason, so rank decides
  // only which label the operator card shows. Ranked below
  // COMMITMENT_TYPE_GATED because a comp/hold/discount losing its label is the
  // worse failure (this repo has bled from an unlabelled comp signal twice),
  // and above everything else because a knowledge-gap card is the only card
  // with a running clock and a guest sitting in silence. A gap-only turn —
  // the overwhelmingly common case — still wins the label.
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
  // TAC-509: ranked directly above SELF_TALK_DETECTED. Both are deterministic
  // loop backstops that mean "the text is confirmed broken", and neither is a
  // money exposure, so both sit below every resource-commitment trigger. This
  // one outranks self-talk because the guest ACTS on a wrong link: self-talk
  // tells them they are texting a bot, a bad link sends them to a 404. Label
  // only, like every entry in this array.
  // TAC-363: both closed-venue arrival triggers sit here, below every money
  // and fabrication signal and above the two deterministic text backstops.
  //
  // Below, because no money and no invented fact is at stake. Above
  // UNVERIFIED_URL, because both are "the guest acts on this" failures and a
  // wasted trip to a locked door costs them more than a dead link does.
  // Structural above model judgement mirrors COMMITMENT_TYPE_GATED above
  // PROSE_PROMISE_BACKSTOP.
  //
  // The two are mutually exclusive by construction — the backstop skips
  // whenever the structural condition already fired — so this ordering is
  // documentation rather than a live tie-break.
  APPROVAL_TRIGGERS.CLOSED_VENUE_ARRIVAL_EMITTED,
  APPROVAL_TRIGGERS.CLOSED_VENUE_ARRIVAL_BACKSTOP,
  APPROVAL_TRIGGERS.UNVERIFIED_URL,
  APPROVAL_TRIGGERS.SELF_TALK_DETECTED,
  // v1.23.0: below MODEL_FLAGGED so a self-flagged or structurally-typed
  // commitment keeps the more specific operator label; ABOVE
  // PREVIOUS_PENDING_HELD so a regenerated draft carrying a fresh complaint
  // promise still fires a push rather than being treated as a silent re-draft.
  APPROVAL_TRIGGERS.COMPLAINT_COMMITMENT_FLOOR,
  APPROVAL_TRIGGERS.PREVIOUS_PENDING_HELD,
  // TAC-401: ranked below every trigger that names something about this draft.
  // It reports an ABSENCE of information about the reply ("we could not check"),
  // so any trigger naming something concrete is the more useful operator label,
  // and it still ranks above the two venue-wide policy signals because it is at
  // least specific to this message.
  APPROVAL_TRIGGERS.PROSE_PROMISE_CHECK_FAILED,
  // TAC-513: beside its sibling, and low for the same reason
  // the other check-failed trigger: it reports an ABSENCE of signal, so any
  // concrete co-firing finding is the more useful operator label.
  APPROVAL_TRIGGERS.PROSE_CANCELLATION_CHECK_FAILED,
  // The review ask is an expected, policy-driven queue, not a risk finding —
  // every claim-about-this-draft trigger above keeps its label on a co-fire
  // (a co-firing comp still reads as a comp). It sits ABOVE the two
  // venue-wide policy signals because on the overwhelmingly common ask-only
  // turn, "this asks for a review, your call" is the decision the card
  // actually puts in front of the operator, and it is more specific than a
  // category route or a blanket hold.
  APPROVAL_TRIGGERS.REVIEW_ASK,
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
 * The single source of truth for the knowledge-gap safety property, consumed
 * by `applyApprovalPolicyStage` to decide whether the KNOWLEDGE_GAP trigger
 * fires (and therefore whether the body is blanked and a clock armed).
 *
 * Not `knowledgeGap` alone, in two directions it would get wrong:
 *
 *   - OUTBOUND runs. The trigger requires `currentMessage !== null`, but a
 *     manual followup (Command Center "Follow Up") skips the approval gate
 *     entirely and dispatches — a knowledgeGap=true emission there would
 *     reach a real guest unblanked. Reachable, not theoretical: the
 *     `## Unanswered question` block renders on followups too, and its
 *     `acknowledged` copy explicitly tells the model to set knowledgeGap
 *     again.
 *   - DEMO guests. TAC-284's bypass returns `action:'send'` unconditionally,
 *     so the gate's queue decision never happens.
 *
 * (Until the v1.80.0 schema diet this predicate had a second consumer:
 * generateStage used it to exempt queued turns from SEND_FIDELITY_FLOOR.
 * The floor is gone; the queue/blank/clock decision remains.)
 */
export function knowledgeGapWillQueue(
  ctx: Pick<RuntimeContext, 'currentMessage' | 'guest'>,
  knowledgeGap: boolean,
): boolean {
  return (
    knowledgeGap === true &&
    ctx.currentMessage !== null &&
    ctx.guest.isDemo !== true
  )
}

// TAC-394: KNOWLEDGE_GAP_CARD_REVIEW_REASONS and isKnowledgeGapCard moved to
// ./pending-slots, so the persist layer can use them without importing this
// file. Re-exported here so every existing import keeps working. The moved
// review_reason values are literals there and must match APPROVAL_TRIGGERS
// and GENERATION_FAILED_REVIEW_REASON.
export {
  isKnowledgeGapCard,
  KNOWLEDGE_GAP_CARD_REVIEW_REASONS,
} from './pending-slots'

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
export async function classifyStage(
  ctx: RuntimeContext,
): Promise<Classification> {
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
    // TAC-397: passed through unmodified, for the same reason crisisSafety is.
    // A correction is a fact about what the guest wrote, not about how
    // confident the category call was.
    correctsPendingReply: r.data.correctsPendingReply,
    // TAC-386: passed through unmodified, for the same reason the two above
    // are. Whether our answer is the kind a guest acts on is a fact about what
    // they wrote, not about how confident the category call was.
    followUpWorthy: r.data.followUpWorthy,
    // Passed through unmodified, for the same reason the three above are.
    // Whether the guest praised their experience is a fact about what they
    // wrote, not about how confident the category call was.
    praisedExperience: r.data.praisedExperience,
    // Passed through unmodified so the orchestrator can price the `classify`
    // generation in Langfuse. These describe the call that was made, so the
    // confidence reroute above must not touch them.
    modelId: r.data.modelId,
    usage: r.data.usage,
  }
}

/**
 * Internal: load the venue's static voice pack (decision 0008, 2026-09-29).
 * The SAME pack for every message — voice is one consistent style, so there
 * is no query, no embedding and no similarity here. Selection rule and the
 * production measurement behind the budgets: lib/rag/voice-pack.ts.
 *
 * Fail direction, unchanged from the retrieval era: CLOSED on inbound. A DB
 * failure or an empty pack throws, because a generation with no venue voice
 * behind it is the thing this product cannot ship. Followups proceed with
 * whatever loaded (THE-231: operator-initiated, and generateStage handles an
 * empty corpus gracefully — ragChunksToProse drops the block entirely).
 * What this deliberately deletes: the per-turn Voyage dependency, which was
 * a whole outage mode (embedding down = no inbound replies venue-wide).
 */
export async function retrieveCorpusStage(
  ctx: RuntimeContext,
): Promise<CorpusMatch[]> {
  const r = await loadVoicePack({ venueId: ctx.venue.id })
  if (!r.ok) {
    throw new Error(`retrieveCorpusStage: ${r.error}`)
  }
  if (ctx.currentMessage && r.data.length === 0) {
    throw new Error(
      'retrieveCorpusStage: empty_voice_pack (venue has no usable voice_corpus entries)',
    )
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
// TAC-366: exported so lib/voices/regenerate-with-critique.ts applies the
// IDENTICAL filter rather than reimplementing it. Sharing the helper (not a
// copy) is what makes the two paths move together when the floor changes —
// the same discipline TAC-183 applied to the four retrieval thresholds. The
// analytics-isolation rule between these paths is about telemetry, not about
// values or pure helpers.
export function filterByRelevance(chunks: KnowledgeMatch[]): KnowledgeMatch[] {
  return chunks.filter((c) => c.similarity >= KNOWLEDGE_RELEVANCE_FLOOR)
}

export async function retrieveKnowledgeStage(
  ctx: RuntimeContext,
  category: MessageCategory | null,
  // TAC-367: the retrieval query is now the CALLER'S, stated explicitly, and
  // there is no fallback. This parameter replaces a derived query that ended
  // `?? \`Followup ${reason} for ${firstName}\`` — a template string with no
  // referent in any corpus, which nonetheless returned a full 4/4 slate on
  // every measured variant at Le Mil's because cosine always ranks something
  // highest. That default was the defect this ticket began from, and it was
  // reachable by any caller without a guest message.
  //
  // Required, not optional-with-a-default, deliberately: the next caller on a
  // path with no inbound must DECIDE what its query is, and be unable to
  // inherit a wrong one by saying nothing. An empty string is a legitimate
  // answer meaning "do not retrieve" and returns [] below.
  query: string,
): Promise<KnowledgeMatch[]> {
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

/**
 * TAC-547: knowledge retrieval with conversation context.
 *
 * Two arms in parallel — the guest's current message alone (exactly what
 * production did before this, and exactly what `retrieveKnowledgeStage`
 * still does), and a contextual query carrying the last turns that reached
 * the guest — merged into one slate.
 *
 * WHY TWO CALLS TO THE EXISTING STAGE rather than one widened function: each
 * arm keeps its own tag-preference fallback and its own graceful degrade for
 * free, and `retrieveKnowledgeStage` stays byte-identical.
 *
 * NO PRIOR TURN → ONE ARM. When `buildContextQuery` returns '' (a first
 * message, a conversation older than the window, nothing delivered) this
 * returns `retrieveKnowledgeStage`'s array directly: no second embed, no
 * second RPC, no merge. That is what makes a standalone first message
 * byte-identical to today rather than merely similar.
 *
 * That early return is DEFENCE IN DEPTH, and honestly inert today:
 * `retrieveKnowledgeStage`
 * short-circuits an empty query to [] on its own, so the merge of
 * [armA, []] reproduces armA exactly. It is kept because it makes the
 * guarantee independent of that second guard — if an empty query ever stopped
 * meaning "return nothing", this path would still run one arm — and because
 * it states the intent where a reader looks for it.
 *
 * DEGRADATION. `allSettled`, so one arm's rejection cannot take the other
 * down. Arm B failing leaves arm A alone — exactly today's behaviour. Arm A
 * failing leaves arm B alone, which is strictly better than today's []. Both
 * failing gives [], as today.
 */
export async function retrieveKnowledgeWithContextStage(
  ctx: RuntimeContext,
  category: MessageCategory | null,
  query: string,
  options?: { turns?: number; rule?: MergeRule },
): Promise<KnowledgeMatch[]> {
  const contextQuery = buildContextQuery(ctx, options?.turns ?? CONTEXT_TURNS)
  if (contextQuery === '') return retrieveKnowledgeStage(ctx, category, query)

  const settled = await Promise.allSettled([
    retrieveKnowledgeStage(ctx, category, query),
    retrieveKnowledgeStage(ctx, category, contextQuery),
  ])
  const arms = settled.map((s) => (s.status === 'fulfilled' ? s.value : []))
  for (const s of settled) {
    if (s.status === 'rejected') {
      console.warn(
        `[agent] knowledge retrieval arm rejected for venue=${ctx.venue.id}: ${
          s.reason instanceof Error ? s.reason.message : String(s.reason)
        }`,
      )
    }
  }
  return mergeKnowledgeMatches(arms, {
    rule: options?.rule ?? KNOWLEDGE_MERGE_RULE,
    limit: KNOWLEDGE_RETRIEVE_LIMIT,
    floor: KNOWLEDGE_RELEVANCE_FLOOR,
  })
}

export type GenerateOutcome =
  | { status: 'success'; result: GenerateMessageResult }
  | { status: 'failed'; error: string; errorCode?: string }

/**
 * Internal: call lib/ai's generateMessage and emit the generation-stage
 * observability events.
 *
 * Through v1.79.0 this stage also refused drafts whose voiceFidelity
 * self-score fell below SEND_FIDELITY_FLOOR (0.4). The v1.80.0 schema diet
 * removed the score and the floor with it: the refuse branch never ran in
 * production (110 scored sends, minimum 0.72), so 'refused' left
 * GenerateOutcome in the same change.
 */
export async function generateStage(
  ctx: RuntimeContext,
  category: Classification['category'],
): Promise<GenerateOutcome> {
  if (!ctx.corpus)
    return { status: 'failed', error: 'corpus missing on context' }
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
    // TAC-495: picks the channel copy. Every path that generates goes through
    // here or the Voices regen, which passes the same field.
    channel: ctx.conversationChannel,
  })
  if (!r.ok) return { status: 'failed', error: r.error, errorCode: r.errorCode }

  if (r.data.attempts > 1) {
    await captureRegenerationTriggered({
      agentRunId: ctx.agentRunId,
      venueId: ctx.venue.id,
      guestId: ctx.guest.id,
      attempts: r.data.attempts,
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
      inboundBody: ctx.currentMessage?.body ?? null,
      finalGeneratedBody: r.data.body,
    })
  }

  // TAC-362: the per-message emoji prohibition was ignored. Ships anyway
  // (same posture as the dash check above) — this exists so a change in the
  // measured 0-in-240 compliance rate is queryable instead of invisible.
  if (r.data.emojiDirectiveViolated) {
    await captureEmojiDirectiveViolated({
      agentRunId: ctx.agentRunId,
      venueId: ctx.venue.id,
      guestId: ctx.guest.id,
      category,
      emojiPolicy: ctx.venue.brandPersona.emojiPolicy,
      finalGeneratedBody: r.data.body,
    })
  }

  return { status: 'success', result: r.data }
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
    (commitmentType === 'comp' ||
      commitmentType === 'hold' ||
      commitmentType === 'discount'),
  )
}

/**
 * TAC-363: did this generation emit an arrival the guest could act on NOW?
 *
 * `imminent` only. A `scheduled` capture says the guest is coming at a named
 * later time, which is correct behaviour at a closed venue and holds nothing —
 * see CLOSED_VENUE_ARRIVAL_EMITTED for why the ticket's literal condition was
 * narrowed to this.
 *
 * Knows nothing about venue hours: the caller pairs it with isVenueClosed.
 * Kept separate so the gate and the backstop's own skip check ask the same
 * question of the emission rather than each writing their own.
 */
function isClosedVenueArrivalEmitted(
  generation: Pick<GenerateMessageResult, 'arrivalCapture'>,
): boolean {
  if (isEmptyArrivalCapture(generation.arrivalCapture)) return false
  return generation.arrivalCapture.signal === 'imminent'
}

/**
 * TAC-355: what verifyMechanicOfferStage found, when it ran. Four states,
 * not two — the fail-closed decision (see MECHANIC_OFFER_BACKSTOP's own
 * comment on APPROVAL_TRIGGERS) means "the check errored" is a DISTINCT,
 * queue-worthy outcome from "the check ran and found nothing."
 *
 * Every post-generation check in this file has one failure policy: closed
 * after one retry on a transient fault.
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
 * This runs on BOTH the inbound and followup paths — a mechanic can be
 * offered on a proactive outbound message exactly as easily as in reply to a
 * guest's question, so there is no inbound-only concept to gate on here.
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
  generation: Pick<
    GenerateMessageResult,
    'body' | 'requiresOperatorApproval' | 'commitment'
  >,
  disposition: CheckDisposition = 'held',
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
      `[agent] mechanic-offer backstop degraded (${disposition === 'held' ? 'failing CLOSED' : 'post-send, reply already dispatched'}) for venue=${ctx.venue.id}: ${r.error}${r.errorCode ? ` (${r.errorCode})` : ''}`,
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
    disposition,
  })

  return { status: 'flagged', mechanicId: r.data.mechanicId }
}

/**
 * TAC-401: what verifyProsePromiseStage found, when it ran.
 *
 * Four states, the same shape both sibling backstops settled on. `flagged`
 * carries the commitment the check named — ALREADY MINTED, with its
 * verification code, so the code that reaches the card is the code that was
 * decided here rather than one regenerated at each persist site.
 *
 * `commitment: null` on a `flagged` result is a real outcome, not a missing
 * value: the check is certain the reply promises something and could not name
 * a usable type and description for it. The draft still queues; it just
 * carries no carrier, so approving it creates no guest_commitments row.
 */
export type ProsePromiseBackstopResult =
  | { status: 'skipped' }
  | { status: 'clean' }
  | { status: 'flagged'; commitment: PendingCommitment | null }
  | { status: 'check_failed' }

/**
 * TAC-401: the primary control for a promise made in prose with no structured
 * commitment behind it.
 *
 * Sibling to verifyMechanicOfferStage, and the
 * ruling (2026-09-15, question 2) picked this shape deliberately: option (b),
 * changing generation so a promise cannot be written without a carrier, has
 * effectively been tried. `# Commitments` (system-template.ts) already tells
 * the model that "I'll make it right" must be recorded as a comp, and 0 of 220
 * replies recorded one. Asking harder is not a plan.
 *
 * Skips (returns 'skipped' without calling the model) when:
 *   - the guest is a demo guest — TAC-284's bypass ships regardless of any
 *     trigger, so the call buys nothing.
 *   - isCommitmentTypeGated is already true — the draft carries an actionable
 *     OBLIGATION carrier, so the card is already correct and
 *     commitment_type_gated already queues it. This is the one skip that makes
 *     the check provably redundant, and it is what ruling 3's "never mints a
 *     second one" means at the call boundary.
 *   - the body is empty — nothing to read.
 *
 * It deliberately does NOT skip on isModelFlagged. Ruling 1: nothing may
 * depend on the self-flag. A model-flagged draft queues but still carries no
 * carrier, so skipping there would leave the obligation untracked on approval,
 * which is the whole ticket.
 *
 * A RECOMMENDATION emission does not skip either. A recommendation is not an
 * obligation and the same reply can still promise a comp in prose; the trigger
 * fires, and resolveDraftCarrier keeps the model's own carrier (ruling 3).
 *
 * FAILS CLOSED on every failure, after ONE immediate retry on a transient
 * fault (ruled 2026-09-21). Truncation is not retried — retrying a cap that
 * was already hit spends a second call to hit it again, and the fix is the
 * cap. The retry is what pays for the closed posture on a check this broad:
 * without it a single Haiku hiccup queues a reply, and with it the flood case
 * narrows to a fault that survives two immediate attempts, which is an outage
 * rather than a blip.
 *
 * Never loosen this: the check has no prior to degrade to — the self-flag
 * caught 0 of 220 and the ruling forbids depending on it — so failing open
 * returns to nothing at all.
 */
export async function verifyProsePromiseStage(
  ctx: Pick<
    RuntimeContext,
    'agentRunId' | 'guest' | 'venue' | 'classification' | 'currentMessage'
  >,
  generation: Pick<GenerateMessageResult, 'body' | 'commitment'>,
  disposition: CheckDisposition = 'held',
): Promise<ProsePromiseBackstopResult> {
  if (ctx.guest.isDemo === true) return { status: 'skipped' }
  if (isCommitmentTypeGated(generation)) return { status: 'skipped' }
  if (generation.body.trim().length === 0) return { status: 'skipped' }

  // TAC-527: built once, passed twice. The retry below used to restate this
  // literal. A duplicated input object is where the two calls silently
  // diverge.
  //
  // `currentMessage` is null on every PROACTIVE turn by the inbound-XOR-outbound
  // invariant (followups, the holding message), so those paths pass null,
  // buildUserPrompt renders no guest line, and the composed prompt is
  // byte-identical to v1.0.0's. Their behaviour is unchanged by this ticket.
  const verifyInput = {
    replyBody: generation.body,
    guestInboundBody: ctx.currentMessage?.body ?? null,
  }

  let r = await verifyProsePromise(verifyInput)
  let retried = false
  // One immediate retry, transient faults only. Truncation is excluded by
  // errorCode rather than by message text, which is provider-formatted and
  // not a contract.
  if (!r.ok && r.errorCode !== VERIFY_PROSE_PROMISE_TRUNCATED_ERROR_CODE) {
    retried = true
    r = await verifyProsePromise(verifyInput)
  }

  if (!r.ok) {
    const truncated = r.errorCode === VERIFY_PROSE_PROMISE_TRUNCATED_ERROR_CODE
    console.warn(
      `[agent] prose-promise check ${truncated ? 'TRUNCATED' : 'degraded'} (${disposition === 'held' ? 'failing CLOSED' : 'post-send, reply already dispatched'}) for venue=${ctx.venue.id}: ${r.error}${r.errorCode ? ` (${r.errorCode})` : ''}`,
    )
    await captureProsePromiseCheckUnavailable({
      agentRunId: ctx.agentRunId,
      venueId: ctx.venue.id,
      guestId: ctx.guest.id,
      outcome: truncated ? 'truncated' : 'errored',
      retried,
      error: r.error,
      errorCode: r.errorCode,
      disposition,
    })
    return { status: 'check_failed' }
  }

  if (!r.data.promisesSomething) return { status: 'clean' }

  // Minted ONCE, here. Every downstream site reads this value rather than
  // rebuilding it, so the code on the card is the code in the alert.
  const commitment =
    r.data.commitmentType !== null && r.data.commitmentDescription !== null
      ? pendingFromEmission({
          type: r.data.commitmentType,
          description: r.data.commitmentDescription,
        })
      : null

  // Ruling 3 as narrowed (2026-09-21): an obligation this check finds replaces
  // a recommendation generation emitted. The stage skips on
  // isCommitmentTypeGated, so a non-empty emission reaching this line is
  // necessarily a recommendation — and it is only displaced when this check
  // actually named something to displace it with.
  const replacedRecommendation =
    commitment !== null && !isEmptyCommitmentEmission(generation.commitment)

  await captureProsePromiseCaught({
    agentRunId: ctx.agentRunId,
    venueId: ctx.venue.id,
    guestId: ctx.guest.id,
    category: ctx.classification?.category ?? null,
    commitmentType: r.data.commitmentType,
    commitmentDescription: r.data.commitmentDescription,
    replacedRecommendation,
    // TAC-527: the same value handed to the check, so the alert shows what the
    // verdict was actually formed against rather than what it might have been.
    guestInboundBody: verifyInput.guestInboundBody,
    replyBody: generation.body,
    disposition,
  })

  return { status: 'flagged', commitment }
}

/**
 * TAC-363: what verifyClosedVenueArrivalStage found, when it ran.
 *
 * Four states, the same shape the three sibling backstops settled on.
 */
export type ClosedVenueArrivalBackstopResult =
  | { status: 'skipped' }
  | { status: 'clean' }
  | { status: 'flagged' }
  | { status: 'check_failed' }

/**
 * TAC-363: independent text check for a reply that confirms an arrival while
 * the venue is closed.
 *
 * WHEN IT RUNS. Four skips. Listed with the cheap one first rather than in
 * code order — `isDemo` and an empty body are checked before it — because the
 * venue-state skip is the one that decides what this costs:
 *
 *   1. The venue is not positively CLOSED. During service, and at any venue
 *      whose hours or timezone cannot be read, there is no question to ask —
 *      so the overwhelming majority of turns cost nothing. `unknown` skipping
 *      is ruling 2(a) again, reached through isVenueClosed rather than a
 *      second comparison that could disagree with it.
 *   2. The structural trigger already covers this turn. The generation emitted
 *      an imminent arrivalCapture, so the draft is queueing either way and a
 *      Haiku call would only prove it twice.
 *   3. Demo guest, matching every sibling backstop.
 *   4. An empty body, which there is nothing to judge.
 *
 * THE COST, stated because the skip list reads like there isn't one: at a
 * venue whose hours ARE filled in, every out-of-hours inbound now makes an
 * extra Haiku call. Le Mil's is open 7am to 3pm, so that is 16 hours of the
 * day. It is concurrent with the other four checks and adds no sequential
 * latency, but it is not free.
 *
 * FAILS CLOSED on every failure mode, with one immediate retry on a transient
 * fault and none on truncation — a cap already hit is hit again. This is the
 * ticket's own stated fail direction: a false positive costs one unnecessary
 * operator review, a false negative sends a guest to a locked door.
 *
 * Runs on the followup path as well as inbound. A proactive message can
 * confirm an arrival just as easily as a reply can, and followups fire from a
 * cron whose local-hour filter does not know the venue's opening time.
 */
export async function verifyClosedVenueArrivalStage(
  ctx: Pick<RuntimeContext, 'agentRunId' | 'guest' | 'venue' | 'recognition'>,
  generation: Pick<GenerateMessageResult, 'body' | 'arrivalCapture'>,
  disposition: CheckDisposition = 'held',
): Promise<ClosedVenueArrivalBackstopResult> {
  if (ctx.guest.isDemo === true) return { status: 'skipped' }
  if (generation.body.trim().length === 0) return { status: 'skipped' }
  // The same `now` the recognition snapshot and the arrival dispatch use, so
  // the gate cannot reach a different verdict from the one capture reached a
  // few lines earlier on the same turn.
  if (!isVenueClosed(ctx.venue, ctx.recognition.computedAt))
    return { status: 'skipped' }
  if (isClosedVenueArrivalEmitted(generation)) return { status: 'skipped' }

  let r = await verifyClosedVenueArrival({ replyBody: generation.body })
  let retried = false
  // One immediate retry, transient faults only. Truncation is excluded by
  // errorCode rather than by message text, which is provider-formatted and
  // not a contract.
  if (
    !r.ok &&
    r.errorCode !== VERIFY_CLOSED_VENUE_ARRIVAL_TRUNCATED_ERROR_CODE
  ) {
    retried = true
    r = await verifyClosedVenueArrival({ replyBody: generation.body })
  }

  if (!r.ok) {
    const truncated =
      r.errorCode === VERIFY_CLOSED_VENUE_ARRIVAL_TRUNCATED_ERROR_CODE
    console.warn(
      `[agent] closed-venue arrival check ${truncated ? 'TRUNCATED' : 'degraded'} (${disposition === 'held' ? 'failing CLOSED' : 'post-send, reply already dispatched'}) for venue=${ctx.venue.id}: ${r.error}${r.errorCode ? ` (${r.errorCode})` : ''}${retried ? ' (after one retry)' : ''}`,
    )
    return { status: 'check_failed' }
  }

  if (!r.data.confirmsArrival) return { status: 'clean' }

  await captureClosedVenueArrivalCaught({
    agentRunId: ctx.agentRunId,
    venueId: ctx.venue.id,
    guestId: ctx.guest.id,
    source: 'text_backstop',
    replyBody: generation.body,
    disposition,
  })

  return { status: 'flagged' }
}

/**
 * TAC-513: what this turn said about cancelling, from two independent angles.
 *
 * `resolution` is the model's OWN structured emission, resolved against the
 * guest's live open + pending_ack list. `claim` is a second, independent read
 * of the drafted body that knows nothing about the emission.
 *
 * Two fields rather than one verdict because they answer different questions
 * and the gate needs both: a reply can carry a cancellation and be fine, claim
 * one and carry nothing (the incident), or carry an id for a commitment that is
 * not this guest's. Collapsing them would lose the distinction the operator
 * copy depends on.
 */
export type CancellationBackstopResult = {
  resolution: CancellationResolution
  claim: 'skipped' | 'clean' | 'flagged' | 'check_failed'
}

/**
 * TAC-513: resolve the model's cancellation emission, and independently read
 * the body for a cancellation it claims but did not carry.
 *
 * Sibling to verifyMechanicOfferStage and verifyProsePromiseStage. See lib/ai/verify-cancellation-claim.ts for why this
 * is a separate check rather than a second question on TAC-401's.
 *
 * Skips the model call (never the resolution, which is pure and always runs)
 * when:
 *   - the guest is a demo guest. TAC-284's bypass ships regardless of any
 *     trigger, so the call buys nothing. The resolution still runs, because
 *     schedule-and-send applies the cancellation inline on that path and the
 *     demo guest's ledger still has to match their words.
 *   - the emission RESOLVED. The draft already carries a real cancellation and
 *     commitment_cancellation_gated already queues it, so the body cannot be
 *     claiming something the system has not done.
 *   - the body is empty. Nothing to read.
 *
 * It deliberately does NOT skip when the guest has no active commitments. A
 * reply that tells a guest a promise is cancelled when no promise exists is
 * just as wrong as one that names the wrong promise, and gating on a non-empty
 * list would make the check blind to exactly that case.
 *
 * FAILS CLOSED on every failure, after ONE immediate retry on a transient
 * fault, matching verifyProsePromiseStage. Truncation is not retried: retrying
 * a cap that was already hit spends a second call to hit it again. The closed
 * posture is easier to justify here than anywhere else in this file, because
 * the cost of failing open is a reply that lies to a guest about what they are
 * owed, and the cost of failing closed is one operator glance.
 */
export async function verifyCancellationClaimStage(
  ctx: Pick<
    RuntimeContext,
    'agentRunId' | 'guest' | 'venue' | 'classification' | 'activeCommitments'
  >,
  generation: Pick<GenerateMessageResult, 'body' | 'cancelsCommitmentId'>,
  disposition: CheckDisposition = 'held',
): Promise<CancellationBackstopResult> {
  const resolution = resolveCancellation(
    generation.cancelsCommitmentId,
    ctx.activeCommitments,
  )

  if (ctx.guest.isDemo === true) return { resolution, claim: 'skipped' }
  if (resolution.status === 'resolved') return { resolution, claim: 'skipped' }
  if (generation.body.trim().length === 0)
    return { resolution, claim: 'skipped' }

  let r = await verifyCancellationClaim({ replyBody: generation.body })
  let retried = false
  // One immediate retry, transient faults only. Truncation is excluded by
  // errorCode rather than by message text, which is provider-formatted and not
  // a contract.
  if (!r.ok && r.errorCode !== VERIFY_CANCELLATION_CLAIM_TRUNCATED_ERROR_CODE) {
    retried = true
    r = await verifyCancellationClaim({ replyBody: generation.body })
  }

  if (!r.ok) {
    const truncated =
      r.errorCode === VERIFY_CANCELLATION_CLAIM_TRUNCATED_ERROR_CODE
    console.warn(
      `[agent] cancellation-claim check ${truncated ? 'TRUNCATED' : 'degraded'} (${disposition === 'held' ? 'failing CLOSED' : 'post-send, reply already dispatched'}) for venue=${ctx.venue.id}: ${r.error}${r.errorCode ? ` (${r.errorCode})` : ''}`,
    )
    await captureCancellationCheckUnavailable({
      agentRunId: ctx.agentRunId,
      venueId: ctx.venue.id,
      guestId: ctx.guest.id,
      outcome: truncated ? 'truncated' : 'errored',
      retried,
      error: r.error,
      errorCode: r.errorCode,
      disposition,
    })
    return { resolution, claim: 'check_failed' }
  }

  if (!r.data.claimsCancellation) {
    // The body reads clean, but an id the model emitted resolved to nothing,
    // and the gate holds on that alone (trigger 16). Without this the hold
    // fires with no event anywhere, which was the one shape nothing could
    // count. The card now has its own copy for it (the 2026-09-22 split), so
    // this flag is no longer about compensating for a wrong sentence; it is
    // what separates a model inventing a cancellation in prose from one
    // reaching for a commitment id that is not there, which have different
    // fixes.
    if (resolution.status === 'unresolved') {
      await captureCancellationClaimUnbacked({
        agentRunId: ctx.agentRunId,
        venueId: ctx.venue.id,
        guestId: ctx.guest.id,
        category: ctx.classification?.category ?? null,
        unresolvedCommitmentId: resolution.claimedId,
        activeCommitmentCount: ctx.activeCommitments.length,
        replyBody: generation.body,
        bodyClaimedIt: false,
        disposition,
      })
    }
    return { resolution, claim: 'clean' }
  }

  await captureCancellationClaimUnbacked({
    agentRunId: ctx.agentRunId,
    venueId: ctx.venue.id,
    guestId: ctx.guest.id,
    category: ctx.classification?.category ?? null,
    unresolvedCommitmentId:
      resolution.status === 'unresolved' ? resolution.claimedId : null,
    activeCommitmentCount: ctx.activeCommitments.length,
    replyBody: generation.body,
    bodyClaimedIt: true,
    disposition,
  })

  return { resolution, claim: 'flagged' }
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
 * sibling pending draft exists. TAC-264 closes this loop structurally with a
 * partial unique index on pending rows; since TAC-394 that is migration 041's
 * pair, one per (venue_id, guest_id, slot). A colliding INSERT is caught by the
 * index, and persistOrRegenQueuedDraft re-reads the slots and decides with
 * decideSlotAction, the same function this gate uses.
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
      // TAC-401: the commitment the prose-promise check named, already minted
      // with its verification code. Non-null ONLY when that check flagged a
      // promise AND could name a usable type and description for it.
      //
      // It reaches messages.pending_commitment through the persist layer, so
      // an operator approving the card creates a real guest_commitments row
      // and the promise enters the lifecycle — expiry, heads-up surfacing,
      // dedup. That is the difference between a caught promise and a tracked
      // one, and it is the whole reason the check names the commitment rather
      // than only flagging the reply.
      //
      // The model's own emission still wins wherever it made one (ruling 3),
      // which the persist layer applies through the same resolveDraftCarrier
      // the gate used for the slot decision.
      promisedCommitment: PendingCommitment | null
      // TAC-513: the cancellation this draft carries, or null. Non-null ONLY
      // when the model emitted an id that RESOLVED against this guest's own
      // open + pending_ack list.
      //
      // It reaches messages.pending_cancellation through the persist layer, so
      // an operator approving the card cancels the commitment at the moment
      // the guest is told it is cancelled. Skip writes nothing, because a
      // skipped draft never reaches the dispatch path.
      //
      // Never supplied by the backstop check, unlike promisedCommitment above.
      // That asymmetry is the ticket's safety property: recording an
      // obligation nobody carried is protective, removing one is not.
      pendingCancellation: PendingCancellation | null
      compMatchedPattern: string | null
      // TAC-264: when non-null, the persist layer UPDATEs this row in place
      // (regenerate) instead of INSERTing a new pending row. TAC-394: it is the
      // card in THIS draft's slot, chosen by decideSlotAction, so the persist
      // layer never regenerates over the other slot's card.
      existingPendingDraftId: string | null
      /**
       * TAC-397: keep the body this card held before the regen overwrites it.
       * True only on a correction — the one regen a guest actually asked for.
       */
      captureReplacedDraft: boolean
      /**
       * TAC-397: this turn's disposition, threaded so 23505 race recovery
       * decides a card the gate never saw exactly as the gate decided the one
       * it read. Same reason `callerPolicy` is threaded.
       */
      conversationDisposition: ConversationDisposition | null
      // TAC-394: which of the guest's pending slots this draft lands in, and
      // whether the OTHER slot already holds a card.
      //
      // TAC-397 CORRECTS what used to be written here. It read "the guest's
      // TWO pending slots (migration 041)" and "whether this draft is the
      // guest's second card"; both are now false. Migration 054 gives the
      // conversation slot one card per inbound, so a guest can hold several,
      // and `otherSlotOccupied` is FALSE for a second conversation card
      // because the other slot is the obligation one. It answers "does this
      // guest also have an obligation card", not "is this their second card" —
      // which matters because `draft_queued.otherSlotOccupied` goes to PostHog
      // under the old reading. `QueueDraft.otherPendingDraftsForGuest` is the
      // field that counts every other card.
      slot: PendingSlot
      otherSlotOccupied: boolean
      // TAC-308: when set, the persist layer stamps messages.pending_until,
      // arming the holding-message timer. `undefined` means "leave the column
      // alone" — omitted on INSERT (so the column stays null), absent from the
      // UPDATE payload (so an existing clock is PRESERVED rather than pushed
      // out by a chatty guest). Explicit rather than derived from the trigger
      // set, because the timeout regen also queues with a knowledge_gap
      // trigger and must NOT re-arm the clock it just fired.
      pendingUntil?: Date
      // TAC-309: persist this card with NO body, discarding what the model
      // wrote. True whenever the SELF-REPORTED knowledge_gap trigger fired,
      // including when it co-fires with commitment_type_gated — a model that
      // admitted it couldn't ground the answer has no business pre-writing a
      // comp, so pending_commitment is nulled alongside the body.
      blankBody: boolean
    }
  // TAC-397: the guest's message needed no answer and a card is already
  // waiting, so nothing is generated into a row, nothing is regenerated, and
  // nothing is sent. "haha" no longer overwrites the answer to the question
  // before it.
  //
  // DISTINCT from `drop` below, which means a draft competed for a slot and
  // lost. Nothing competed here, and there was never a reply worth keeping —
  // so a drop's alert (a guest said something and unexpectedly got nothing)
  // would be wrong about this, and `captureDraftDropped`'s Slack relay would
  // fire on the single most common turn shape there is.
  //
  // Deliberately carries no analytics today (2026-09-22 ruling, question 4):
  // this is the EXPECTED outcome, not an incident. Recorded as a candidate on
  // the ticket if TAC-519 shows the absence of a record is itself the problem.
  | { action: 'silence' }
  // A draft that would queue into a slot whose card it must not overwrite is
  // discarded: not sent, not persisted, and the guest is silent on this turn.
  // Three reasons, all decided by decideSlotAction (./pending-slots):
  //
  //   knowledge_gap_card_protected (TAC-308): a knowledge-gap card holds the
  //     slot and this turn queues for a reason other than gapping itself.
  //     Losing the outstanding question is worse than losing a reply that
  //     needed review anyway.
  //   obligation_slot_taken (TAC-394): the obligation slot holds a DIFFERENT
  //     commitment, and the existing card wins. Rare (one production instance
  //     fleet-wide, on 2026-08-07, during an incident), so the alert names both
  //     commitments and the guest: whoever reads it may be reading it
  //     mid-incident.
  //   slot_occupied (TAC-394): a manual followup would queue into an occupied
  //     slot. A Follow Up click never overwrites a card; it is refused, loudly.
  | {
      action: 'drop'
      reason: SlotDropReason
      triggers: string[]
      protectedDraftId: string
      // The protected card's commitment (null when it carries none), and the
      // discarded draft's (null when it carried none or its body was blanked).
      protectedCommitment: CommitmentIdentity | null
      droppedCommitment: CommitmentIdentity | null
    }

/**
 * TAC-540: is this turn, on what we know right after classification, headed
 * for an auto-send?
 *
 * A PREDICTION, NOT A GUARANTEE, and reading it as one is the mistake to
 * avoid. It exists to decide whether to show the guest typing dots before the
 * expensive half of the turn runs, so it can only consult what is knowable
 * that early. Most of `applyApprovalPolicyStage`'s triggers are not: the
 * fidelity floor, the model's self-flag, the comp regex and all four
 * post-generation backstops need a draft that does not exist yet. A turn can
 * pass this and still queue.
 *
 * THAT IS WHY `typing_off` IS THE MECHANISM AND THIS IS THE OPTIMISATION. The
 * correction on every non-send exit is what makes "a guest never watches dots
 * for a reply that is not coming" true; this only keeps the dots off the turns
 * we can already tell will not send, so the correction is rare rather than
 * routine.
 *
 * The two conditions mirror the gate, and each names the trigger it mirrors
 * so a reader can check them against it:
 *
 *   - the category's own policy       -> trigger 8, category_requires_approval
 *   - venues.hold_all_outbound        -> trigger 6, hold_all_outbound
 *
 * TAC-565 REMOVED A THIRD, "the venue is not positively closed". Replies
 * still auto-send after hours — closed-hours answers, hours questions — and
 * withholding the dots there left the guest on Seen for the whole generation
 * on exactly the turns that feel slowest. Ruled: dots whenever a reply is
 * being written for auto-send, open or closed. The clause was never a gate
 * trigger of its own (trigger 17 needs an emitted arrival), so nothing about
 * WHAT sends changed with it — only whether the guest watches it being
 * written.
 *
 * WHAT THAT COSTS, since the clause was not arbitrary: a closed venue is
 * where a draft is most likely to end up in front of an operator. Trigger 17
 * is closed-only by construction, and `verifyClosedVenueArrivalStage` skips
 * itself while open — the one way its trigger fires at an open venue is the
 * orchestrator degrading a throw out of that stage to `check_failed`, which
 * does not re-read the venue's state. So the `typing_off` correction runs
 * more often after hours than during service: the guest watches dots for a
 * few seconds and then they stop, which is the correction working. What it is
 * NOT is a guest left watching dots for a reply that is never coming — that
 * is the property `stopTypingUnlessSent` holds, and it holds on a closed
 * venue exactly as it does on an open one.
 *
 * `hold_all_outbound` is not in the ticket's own wording and is included
 * anyway: at a venue carrying it, EVERY reply queues, so without it the dots
 * would be false on every single turn there rather than occasionally. It can
 * only ever narrow what this returns.
 *
 * DEMO GUESTS: the gate short-circuits to `send` for them (TAC-284), and this
 * does not model that. A demo guest at a holding venue gets no dots and still
 * gets a reply — a missing tick, never a false one, which is the safe
 * direction and not worth a special case in a prediction.
 *
 * Pure. No I/O, no model call, and nothing here decides whether a reply goes
 * out.
 */
export function mayAutoSendAfterClassification(ctx: RuntimeContext): boolean {
  if (
    ctx.venue.holdAllOutbound === true &&
    ctx.classification?.category !== 'opt_out'
  ) {
    return false
  }
  if (
    resolveCategoryPolicy(
      ctx.venue.approvalPolicy,
      ctx.classification?.category,
    ) !== 'auto_send'
  ) {
    return false
  }
  // No third condition. TAC-565 removed it: the venue's hours are
  // deliberately not read here. See the header.
  return true
}

export async function applyApprovalPolicyStage(
  ctx: RuntimeContext,
  generation: GenerateMessageResult,
  // TAC-355: result of verifyMechanicOfferStage, run by the orchestrator.
  // 'skipped' | 'clean' never fire the trigger; 'flagged' | 'check_failed'
  // both do — the fail-closed branch is deliberate, see
  // MECHANIC_OFFER_BACKSTOP's own comment above.
  mechanicOfferBackstop: MechanicOfferBackstopResult = { status: 'skipped' },
  // TAC-401: result of verifyProsePromiseStage, run by the orchestrator
  // CONCURRENTLY with the two checks above (ruled 2026-09-21, ruling 2) rather
  // than in sequence. 'skipped' | 'clean' never fire a trigger; 'flagged'
  // fires PROSE_PROMISE_BACKSTOP and carries the commitment the check named;
  // 'check_failed' fires PROSE_PROMISE_CHECK_FAILED. Both of those queue —
  // this check fails closed on every failure, not only on truncation.
  prosePromiseBackstop: ProsePromiseBackstopResult = { status: 'skipped' },
  // TAC-513: result of verifyCancellationClaimStage, run by the orchestrator
  // alongside the three checks above. Two independent facts: `resolution` is
  // the model's own emission resolved against this guest's live commitments,
  // `claim` is an independent read of the body.
  //
  // A resolved resolution fires COMMITMENT_CANCELLATION_GATED and carries the
  // cancellation onto the draft. A flagged claim, or an emission that did not
  // resolve, fires PROSE_CANCELLATION_BACKSTOP and carries nothing.
  // 'check_failed' fires PROSE_CANCELLATION_CHECK_FAILED. All of them queue.
  cancellationBackstop: CancellationBackstopResult = {
    resolution: { status: 'none' },
    claim: 'skipped',
  },
  // TAC-363: result of verifyClosedVenueArrivalStage, run by the orchestrator
  // alongside the four checks above. 'skipped' | 'clean' never fire a trigger;
  // 'flagged' and 'check_failed' both fire CLOSED_VENUE_ARRIVAL_BACKSTOP,
  // which is the fail-closed posture the ticket specifies.
  //
  // The STRUCTURAL half of this pair needs no parameter: it reads the
  // generation's own emission and the venue's hours, both already here.
  closedVenueArrivalBackstop: ClosedVenueArrivalBackstopResult = {
    status: 'skipped',
  },
): Promise<ApprovalDecision> {
  const triggers: string[] = []

  // (Trigger 1 was the 0.4–0.6 voice-fidelity band until the v1.80.0 schema
  // diet; it queued zero drafts in its lifetime. The numbering below is
  // historical and kept so the trigger comments stay greppable by ticket.)

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
  // TAC-394: one ordered read covering BOTH of the guest's pending slots
  // (migration 041). Which card this draft competes with is decided below, once
  // the trigger set says whether the body is blanked and so which slot the
  // draft lands in. A failed read fails OPEN, as findPendingDraft did, and
  // migration 041's indexes are the backstop.
  //
  // TAC-307 made manual followups (the Command Center Follow Up button) run
  // approval POLICY and deliberately kept them away from regenerate-in-place: a
  // Follow Up click must never overwrite a draft an operator is about to
  // approve. Before TAC-394 that was done by skipping this read entirely, which
  // left a hole: a manual followup that queued INSERTed blind, hit the unique
  // index, and race recovery UPDATEd the card anyway. Now the read runs for
  // manual followups too, previous_pending_held never fires for them, and one
  // that would queue into an occupied slot is refused below ('slot_occupied').
  // One that sends still coexists with the card, as before: a send writes
  // review_state='auto_sent', outside both indexes.
  const isManualFollowup = ctx.followupTrigger?.reason === 'manual'
  const pendingRows =
    (await loadPendingRowsBySlot(ctx.venue.id, ctx.guest.id)) ??
    EMPTY_PENDING_ROWS

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
  if (
    ctx.venue.holdAllOutbound === true &&
    ctx.classification?.category !== 'opt_out'
  ) {
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

  // Trigger 10 (TAC-355): deterministic self-talk backstop. Unconditional —
  // no category scoping, no demo-guest exemption beyond the bypass below.
  if (generation.selfTalkViolationPersisted) {
    triggers.push(APPROVAL_TRIGGERS.SELF_TALK_DETECTED)
  }

  // Trigger 10b (TAC-509): a link that is not on the venue's curated
  // allowlist survived every regen attempt. Unconditional, no category
  // scoping — a wrong link is wrong on every category — and the demo-guest
  // bypass below is the only thing that lets one through.
  if (generation.unverifiedUrls.length > 0) {
    triggers.push(APPROVAL_TRIGGERS.UNVERIFIED_URL)
    await captureUnverifiedUrlHeld({
      agentRunId: ctx.agentRunId,
      venueId: ctx.venue.id,
      guestId: ctx.guest.id,
      category: ctx.classification?.category ?? null,
      unverifiedUrls: generation.unverifiedUrls,
      allowedUrlCount: parseVenueLinks(ctx.venue.venueInfo.links).length,
      generatedBody: generation.body,
    })
  }

  // Trigger 10c: the once-ever Google review ask. The draft carries a
  // composed ask (non-empty only when the `## Ask for a review` block
  // genuinely rendered — composeReplyWithReviewAsk normalizes an un-offered
  // emission to ''), and the venue's policy says asks queue, which is the
  // code default fleet-wide. Flipping a venue to auto-send is a Studio edit
  // of approval_policy.reviewAsk; no category scoping, because the ask is
  // not a category (see the schema field's comment). The demo-guest bypass
  // below overrides this like every trigger, which is the intended
  // on-device test path.
  if (
    generation.reviewAsk !== '' &&
    resolveReviewAskDisposition(ctx.venue.approvalPolicy) ===
      'operator_approval'
  ) {
    triggers.push(APPROVAL_TRIGGERS.REVIEW_ASK)
  }

  // Trigger 11 (TAC-355): independent mechanic-offer verification backstop.
  // Fires on 'flagged' (the check found a gated mechanic offered) OR
  // 'check_failed' (the check errored/timed out/didn't parse) — fail CLOSED.
  // 'skipped' and 'clean' never fire.
  if (
    mechanicOfferBackstop.status === 'flagged' ||
    mechanicOfferBackstop.status === 'check_failed'
  ) {
    triggers.push(APPROVAL_TRIGGERS.MECHANIC_OFFER_BACKSTOP)
  }

  // Trigger 12 (TAC-401): the independent prose-promise check. 'flagged' means
  // the reply commits the venue to something of value with no structured
  // commitment behind it; 'check_failed' means we could not find out.
  //
  // The two are separate triggers on purpose — see PROSE_PROMISE_CHECK_FAILED
  // on APPROVAL_TRIGGERS. Both queue: this check fails CLOSED on every failure
  // mode.
  if (prosePromiseBackstop.status === 'flagged') {
    triggers.push(APPROVAL_TRIGGERS.PROSE_PROMISE_BACKSTOP)
  }
  if (prosePromiseBackstop.status === 'check_failed') {
    triggers.push(APPROVAL_TRIGGERS.PROSE_PROMISE_CHECK_FAILED)
  }

  // Trigger 17 (TAC-363): the venue is CLOSED and this reply may send the
  // guest over anyway.
  //
  // The structural half is deterministic and reads nothing but the emission
  // and the venue's own hours — no model judgement, which is the whole point.
  // TAC-301 part 1 put a `- Status: CLOSED` line in the prompt and on
  // 2026-09-14 the model read it and replied "See you soon" regardless. This
  // fires whatever the model concluded.
  //
  // `isVenueClosed` is true only for a POSITIVE closed verdict, so a venue
  // whose hours or timezone cannot be read behaves as open and nothing fires
  // (ruling 2(a)). The same `now` as the recognition snapshot, so the gate and
  // the arrival dispatch cannot disagree about the clock within one turn.
  const closedVenueArrivalEmitted =
    isClosedVenueArrivalEmitted(generation) &&
    isVenueClosed(ctx.venue, ctx.recognition.computedAt)
  if (closedVenueArrivalEmitted) {
    triggers.push(APPROVAL_TRIGGERS.CLOSED_VENUE_ARRIVAL_EMITTED)
    // Captured here rather than in a stage, because this half has no stage —
    // it is a field comparison, not a model call. Same in-gate placement
    // UNVERIFIED_URL uses for the same reason. `source` is what keeps the two
    // halves countable apart afterwards.
    await captureClosedVenueArrivalCaught({
      agentRunId: ctx.agentRunId,
      venueId: ctx.venue.id,
      guestId: ctx.guest.id,
      source: 'structured',
      replyBody: generation.body,
      // The structural half always fires in the gate, pre-send, and its
      // trigger queues the draft — 'held' on every path.
      disposition: 'held',
    })
  }
  // Both non-clean states, one trigger — see CLOSED_VENUE_ARRIVAL_BACKSTOP.
  if (
    closedVenueArrivalBackstop.status === 'flagged' ||
    closedVenueArrivalBackstop.status === 'check_failed'
  ) {
    triggers.push(APPROVAL_TRIGGERS.CLOSED_VENUE_ARRIVAL_BACKSTOP)
  }

  // Trigger 13 (TAC-513): the draft carries a real cancellation, resolved
  // against this guest's own open commitments. ALWAYS queues.
  //
  // Unconditional by design: there is no auto-send path for taking back
  // something a guest was promised, and no fidelity score or venue policy that
  // makes one. The single exception is the TAC-284 demo bypass, which
  // short-circuits this whole function and is handled in schedule-and-send.
  if (cancellationBackstop.resolution.status === 'resolved') {
    triggers.push(APPROVAL_TRIGGERS.COMMITMENT_CANCELLATION_GATED)
  }

  // Trigger 14 (TAC-513): the reply SAYS a promise is cancelled and nothing
  // carries it. The 2026-09-21 incident.
  //
  // Neither this nor trigger 16 ever carries a carrier. Minting a cancellation
  // from a second reading of prose is destructive where TAC-401's minting is
  // protective.
  if (cancellationBackstop.claim === 'flagged') {
    triggers.push(APPROVAL_TRIGGERS.PROSE_CANCELLATION_BACKSTOP)
  }

  // Trigger 16 (TAC-513, split from 14 on the 2026-09-22 ruling): the model
  // emitted an id that resolves to nothing, and the body does NOT read as
  // claiming a cancellation.
  //
  // `else`-shaped on purpose rather than two independent conditions: when the
  // body claims it AND the id is unresolved, that is the incident's own shape
  // and trigger 14's stronger sentence is the one to show. Writing it as
  // `claim !== 'flagged'` keeps them mutually exclusive by construction, so no
  // card can ever carry both descriptions of itself.
  //
  // It DOES co-fire with trigger 15: an unreadable check does not make the
  // unresolved id any less unresolved. That one is ranked below this.
  if (
    cancellationBackstop.claim !== 'flagged' &&
    cancellationBackstop.resolution.status === 'unresolved'
  ) {
    triggers.push(APPROVAL_TRIGGERS.UNRESOLVED_CANCELLATION_ID)
    // Decision 0003 rewrite: on the inbound path the claim check is deferred
    // post-send (`claim === 'skipped'`), so the stage that used to emit for
    // this hold never runs pre-send — and "the hold fires with no event
    // anywhere" is the exact shape the stage's own comment warns about.
    // Emitted HERE only when the claim was skipped, so paths that ran the
    // stage pre-send (followups, the holding message) do not double-fire.
    // Known widening: a demo guest's or empty-body draft's unresolved id now
    // emits too, where it used to be silent. That is a fix, not a cost.
    if (cancellationBackstop.claim === 'skipped') {
      await captureCancellationClaimUnbacked({
        agentRunId: ctx.agentRunId,
        venueId: ctx.venue.id,
        guestId: ctx.guest.id,
        category: ctx.classification?.category ?? null,
        unresolvedCommitmentId: cancellationBackstop.resolution.claimedId,
        activeCommitmentCount: ctx.activeCommitments.length,
        replyBody: generation.body,
        bodyClaimedIt: false,
        disposition: 'held',
      })
    }
  }

  // Trigger 15 (TAC-513): the cancellation-claim check produced no readable
  // verdict. Fails CLOSED on every failure mode, like its TAC-401 sibling.
  if (cancellationBackstop.claim === 'check_failed') {
    triggers.push(APPROVAL_TRIGGERS.PROSE_CANCELLATION_CHECK_FAILED)
  }

  // Is this turn a knowledge-gap-card turn. The protected-card carve-out and
  // the drop logic key on this. Clock arming is narrower (TAC-484): see the
  // pendingUntil computation below.
  const isGapTurn = knowledgeGapFired

  // ---- Pending-row resolution (TAC-308, TAC-394) ----
  //
  // Trigger 4's lookup ran in enumeration order above; its PUSH happens here,
  // because whether it fires depends on what every other trigger decided.
  //
  // TAC-394: everything below concerns the card in THIS draft's slot. The slot
  // is decided by the carrier the draft will persist: a comp, hold or discount
  // lands in the obligation slot, anything else (including a blanked body,
  // whose carrier TAC-309 nulls) in the conversation slot. The card in the
  // OTHER slot never holds this draft back, never fires previous_pending_held,
  // and is never regenerated over. That is the fix for the 2026-09-14
  // incident, where an hours question queued behind a pending comp card and
  // regenerated over it.
  //
  // Within the slot, a knowledge-gap card is a pending row with a live
  // `pending_until`: an operator is on the hook for an answer and a clock is
  // running. Three cases, and they are genuinely different:
  //
  //   1. This turn is independently sendable (no trigger fired at all).
  //      Send it. TAC-264's no-demotion invariant would otherwise queue it and
  //      route it into UPDATE-in-place, which BOTH silences the guest AND
  //      overwrites the card. What that invariant actually guards is a
  //      REGENERATED VERSION OF THE SAME DRAFT going out from under an
  //      operator; a reply to a different question is not that. Narrowed to
  //      knowledge-gap cards only, so the invariant stays absolute everywhere
  //      it was designed to apply. The send writes review_state='auto_sent',
  //      which is outside both of migration 041's indexes.
  //   2. This turn also gaps. UPDATE the card in place (the standard
  //      regen path) and PRESERVE its original pending_until, so a guest
  //      asking a second unanswerable question can't push the clock out.
  //   3. This turn queues for any other reason. The card wins; the new draft
  //      is dropped below.
  //
  // Every other pending row keeps the pre-TAC-308 behavior exactly.
  const blankBody = knowledgeGapFired
  // TAC-401: the carrier this check supplied, when it supplied one. Null on
  // every other status, and null when the check flagged a promise it could not
  // name — both mean "no carrier from here", and resolveDraftCarrierIdentity
  // treats them identically.
  const promisedCommitment: PendingCommitment | null =
    prosePromiseBackstop.status === 'flagged'
      ? prosePromiseBackstop.commitment
      : null
  // TAC-513: the cancellation carrier, from the model's own resolved emission
  // and nothing else.
  //
  // `blankBody` nulls it for TAC-309's reason unchanged: a blank knowledge-gap
  // card's dispatched text is operator-authored, so the model's emission is
  // not a claim about it, and an operator approving a card they cannot read
  // must not thereby cancel a guest's comp.
  const pendingCancellation: PendingCancellation | null =
    !blankBody && cancellationBackstop.resolution.status === 'resolved'
      ? cancellationBackstop.resolution.cancellation
      : null
  // TAC-401: the model's own actionable emission still wins (ruling 3). This
  // differs from the pre-TAC-401 call only when generation emitted nothing
  // actionable AND the check named something, so a draft carrying a
  // recommendation keeps it and lands in the conversation slot exactly as
  // before.
  const draftCommitment = resolveDraftCarrierIdentity(
    generation.commitment,
    promisedCommitment,
    blankBody,
  )
  const slot: PendingSlot = pendingSlotOf(draftCommitment)
  const slotOccupant = occupantOfSlot(pendingRows, slot)
  const existingIsKnowledgeGapCard =
    slotOccupant !== null && isKnowledgeGapCard(slotOccupant)
  const protectedCardCarveOutBase =
    existingIsKnowledgeGapCard && triggers.length === 0

  // TAC-397: which of the three cases this turn is, for the conversation slot.
  // Computed here because `pendingRows` is already read and `ctx.classification`
  // is already in scope — the same place hold_all_outbound and
  // complaint_commitment_floor read it. No new query, no new stage.
  //
  // The obligation slot never consults it: comps, holds and discounts keep
  // TAC-394's rules exactly.
  //
  // NULL on a run with no guest message. That is not a shorthand for
  // `own_card`: it keeps the conversation slot on its pre-TAC-397 path,
  // because every proactive run shares migration 054's sentinel key and a
  // second card for one would 23505 into a red alert. See decideSlotAction.
  const rawConversationDisposition =
    ctx.currentMessage === null
      ? null
      : resolveConversationDisposition({
          hasConversationOccupant: pendingRows.conversation.length > 0,
          category: ctx.classification?.category ?? null,
          correctsPendingReply:
            ctx.classification?.correctsPendingReply ?? false,
          inboundBody: ctx.currentMessage.body,
        })
  // TAC-513 × TAC-397: a draft that WITHDRAWS a promise is never silenced.
  //
  // `silencesConversationTurn` excludes an obligation carrier by slot, for the
  // reason stated there — if the model answered "haha" with a comp, that is a
  // comp and an operator sees it. A cancellation carrier gets no such
  // protection from the slot, because `pendingSlotOf` reads the commitment and
  // never the cancellation, so a resolved withdrawal would be discarded along
  // with the draft. Overriding the disposition here rather than teaching the
  // silence predicate about cancellations keeps ONE decision: it threads to
  // the persist layer and to 23505 recovery, so the gate and decideSlotAction
  // cannot disagree about this turn.
  const conversationDisposition =
    rawConversationDisposition === 'no_answer' && pendingCancellation !== null
      ? 'own_card'
      : rawConversationDisposition

  // TAC-397: previous_pending_held now fires ONLY on a correction, i.e. exactly
  // when the persist layer is about to overwrite a card in place. That is what
  // makes its label true.
  //
  // Before this it fired on ANY occupied slot, and TAC-394's QA established it
  // was false every single time it rendered: same-slot occupancy forced a regen
  // or a drop, never an insert, so the row carrying "Held behind an earlier
  // message to this guest" was always the row that message had just replaced.
  // The operator was told to clear something that no longer existed.
  //
  // The consequence, decided by the ticket and not by this line: a clean answer
  // to a guest's SECOND question now auto-sends where it used to queue, because
  // an occupied slot is no longer a trigger on its own. It still passes every
  // other gate on its own merits.
  const isCorrectionRegen =
    slot === 'conversation' &&
    !isManualFollowup &&
    conversationDisposition === 'correction' &&
    slotOccupant !== null

  // TAC-397: a CORRECTION beats TAC-308's protected-card carve-out.
  //
  // The carve-out exists so a turn that fires nothing else SENDS rather than
  // queueing and regenerating over a knowledge-gap card. That is still right
  // for an unrelated turn — which now gets its own card anyway — but wrong for
  // a correction, which is BY DEFINITION about the card's own question. Left
  // in, a correction with an otherwise-clean draft suppressed the only trigger
  // it would have fired, returned `send`, and never rewrote the card: the
  // guest's amendment went unanswered while the stale card kept its clock and
  // an operator approved an answer to a question the guest had changed.
  const protectedCardCarveOut = protectedCardCarveOutBase && !isCorrectionRegen

  if (
    slotOccupant !== null &&
    !protectedCardCarveOut &&
    !isManualFollowup &&
    (slot === 'obligation' || isCorrectionRegen)
  ) {
    triggers.push(APPROVAL_TRIGGERS.PREVIOUS_PENDING_HELD)
  }

  // TAC-397: case 2 — this message needs no answer and a card is already
  // waiting. Return before ANY of the remaining gate logic.
  //
  // It has to be here rather than beside decideSlotAction below, and the
  // reason is the whole mechanism: a clean reply to "haha" fires no trigger at
  // all, so `triggers.length === 0` returns `send` a few lines down and the
  // draft is already gone by the time the slot decision runs. The shared
  // predicate keeps this in step with decideSlotAction's own silence branch.
  //
  // BEFORE the demo bypass, deliberately. The bypass exists to remove approval
  // friction on a teammate's own phone; silence is not friction, it is the
  // correct answer to "haha". Letting a demo guest through here would restore
  // the exact behaviour this ticket removes, on the one phone most likely to
  // be used to test it.
  if (
    silencesConversationTurn({
      slot,
      callerPolicy: isManualFollowup ? 'never_regen' : 'regen',
      disposition: conversationDisposition,
      hasOccupant: pendingRows.conversation.length > 0,
    })
  ) {
    return { action: 'silence' }
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

  // TAC-394: where this queued draft goes, decided by the same pure function
  // that 23505 race recovery calls in schedule-and-send.ts, so a card the gate
  // never saw gets exactly the treatment a card it did see gets. The full order
  // is at decideSlotAction. The drops that can come back:
  //
  // TAC-308 case 3: a knowledge-gap card holds the slot and this turn queues
  // for some reason OTHER than gapping itself. Regen-in-place would overwrite
  // the question an operator is about to answer, and the slot's index forbids a
  // second pending row, so the draft is discarded rather than stored.
  //
  // TAC-394: the obligation slot holds a DIFFERENT commitment (a comp for
  // another item, or another gated type). The existing card wins and this
  // draft is dropped with an alert naming both commitments. And a manual
  // followup that would queue into any occupied slot is refused.
  //
  // `checkDidNotComplete` exempts a turn whose check did not complete from the
  // protected-card drop. prose_promise_check_failed reports an ABSENCE of
  // information about the reply, not a finding against it, and is deliberately
  // excluded from isGapTurn. Without the exemption the trigger it pushes makes
  // triggers.length > 0, which cancels the protected-card carve-out and DROPS a
  // turn that fired no trigger at all before. A guest already waiting on a
  // knowledge-gap card would get silence because a Haiku call failed twice -
  // the one outcome worse than either failing open or failing closed.
  const checkDidNotComplete = prosePromiseBackstop.status === 'check_failed'
  const slotDecision = decideSlotAction({
    rows: pendingRows,
    draftCommitment,
    isGapTurn,
    checkDidNotComplete,
    callerPolicy: isManualFollowup ? 'never_regen' : 'regen',
    conversationDisposition,
  })
  // Unreachable: the early return above already handled every silence this
  // gate can produce. Narrowed here so the queue projection below can read
  // `draftId` without TypeScript widening it away.
  if (slotDecision.action === 'silence') {
    return { action: 'silence' }
  }
  if (slotDecision.action === 'drop') {
    return {
      action: 'drop',
      reason: slotDecision.reason,
      triggers,
      protectedDraftId: slotDecision.protectedDraftId,
      protectedCommitment: commitmentIdentityOf(
        occupantOfSlot(pendingRows, slotDecision.slot)?.pending_commitment ??
          null,
      ),
      droppedCommitment: draftCommitment,
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
  //   - gap turn beside a gap card in the OTHER slot → undefined (TAC-394).
  //     The clock is the guest's, not the slot's: the timeout scan fires per
  //     card, so a second clock would send the guest a second holding message.
  //     anyKnowledgeGapCard covers the same-slot cases above as well.
  //
  // TAC-484: a self-report (knowledgeGapFired) arms the clock only when the
  // inbound it replies to actually READS as a question (looksLikeQuestion,
  // ./looks-like-question.ts). The holding message text is "still tracking
  // that down, sorry for the wait" — a wait that does not exist when nothing
  // was asked. `knowledgeGapFired` already implies `ctx.currentMessage !==
  // null` (see knowledgeGapWillQueue), but TypeScript can't narrow through
  // that boolean, so the check is repeated here to read `.body` safely.
  const pendingUntil =
    knowledgeGapFired &&
    ctx.currentMessage !== null &&
    looksLikeQuestion(ctx.currentMessage.body) &&
    !anyKnowledgeGapCard(pendingRows)
      ? new Date(Date.now() + KNOWLEDGE_GAP_WINDOW_MS)
      : undefined

  return {
    action: 'queue',
    triggers,
    primaryTrigger: pickPrimaryTrigger(triggers),
    // TAC-401: the carrier the prose-promise check produced, threaded to the
    // persist layer so an operator approving the card creates a real
    // guest_commitments row. Null whenever the check supplied nothing, and
    // resolveDraftCarrier in the persist layer applies the same precedence the
    // gate used above — the model's own emission wins.
    promisedCommitment,
    // TAC-513: the cancellation carrier, threaded to the persist layer so an
    // operator approving the card cancels the commitment at the same moment
    // the guest is told it is cancelled. Null unless the model's own emission
    // resolved against this guest's list.
    pendingCancellation,
    compMatchedPattern: comp.matched ? comp.pattern : null,
    existingPendingDraftId:
      slotDecision.action === 'regen' ? slotDecision.draftId : null,
    captureReplacedDraft:
      slotDecision.action === 'regen' && slotDecision.captureReplacedDraft,
    conversationDisposition,
    slot,
    otherSlotOccupied: otherSlotOccupied(pendingRows, draftCommitment),
    pendingUntil,
    // TAC-309: blank on a self-reported gap. The model ADMITTED it could not
    // ground the answer, so the body is an acknowledged guess and an operator
    // approving it in one swipe is the failure being prevented.
    blankBody,
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

function computeToday(
  timezone: string,
  now: Date = new Date(),
): NonNullable<AiRuntimeContext['today']> {
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

  return {
    isoDate,
    dayOfWeek,
    venueLocalTime,
    venueTimezone: timezone,
    calendar: computeCalendar(timezone, now),
  }
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
    // TAC-536: a scan greeting renders `## Guest just arrived` instead, which
    // states what is known about this guest's conversation and visits. The
    // follow-up block's framing (days since a visit, a re-engagement reason)
    // has nothing to say about someone standing at the counter now.
    case 'instagram_scan_arrival':
    // TAC-560: a warm close renders `## Closing this conversation` instead. The
    // follow-up block's framing (days since a visit, a re-engagement reason) has
    // nothing to say about a conversation that went quiet ten minutes ago, and
    // naming a past visit is exactly what its own category instruction forbids.
    case 'warm_close':
    // TAC-386: an inquiry follow-up renders `## Following up on what they asked`
    // instead. The follow-up block's framing is "you visited N days ago", which
    // is exactly the assertion ruling 11 bars this message from making: it knows
    // what the guest asked and what we said, and nothing about whether they came
    // in.
    case 'inquiry_followup':
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
// block instructs the model to greet and ask what the guest got (TAC-423),
// which is understand_order's own question, not a tracked intention line, so
// there is no legitimate path for a turn-one send to raise a first-touch
// intention, and running the classifier there has no upside, only
// false-positive risk.
// Reusing this flag rather than inventing a new turn-index check keeps the
// two call sites (what renders the opener, what's allowed to record against
// it) structurally unable to disagree about what "the opener turn" means.
// `buildAiRuntime` below calls this with `new Date()`, identical to its
// prior inline `Date.now()` call — zero behavior change there.
export function computeFirstTouchAfterQrScan(
  ctx: RuntimeContext,
  now: Date,
): boolean {
  return (
    ctx.currentMessage !== null &&
    ctx.guest.createdVia === 'qr_scan' &&
    ctx.recentMessages.length === 0 &&
    now.getTime() - ctx.guest.createdAt.getTime() <=
      REPORTED_ORDER_WINDOW_DAYS * MS_PER_DAY
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
/**
 * TAC-367: the operator's note on a manual followup, normalized — or null.
 *
 * Exported and shared rather than reimplemented, because it now has two
 * consumers that must agree: `buildAiRuntime` renders it as the
 * `## Operator instruction` block, and `handle-followup.ts` uses it as the
 * knowledge-retrieval query. If those two ever disagreed, the model would be
 * grounded against text other than the instruction it was given — the exact
 * class of drift this ticket spent the day removing elsewhere.
 *
 * Scoped to `reason === 'manual'` because that is the only trigger the
 * Command Center button produces and the only one carrying a hint. Returns
 * null for a missing, non-string, or whitespace-only note.
 */
export function operatorInstructionQuery(
  trigger: Pick<FollowupTrigger, 'reason' | 'metadata'> | null,
): string | null {
  if (!trigger || trigger.reason !== 'manual') return null
  const raw = trigger.metadata?.hint
  return typeof raw === 'string' && raw.trim().length > 0 ? raw.trim() : null
}

/**
 * TAC-380 trap 4: the prompt lines for the intentions this turn renders.
 *
 * Reads renderableIntentions, the SAME predicate handle-inbound's recording
 * gate reads, and the sharing is load-bearing. When the post-send classifier
 * fails twice, recording closes every intention it was handed, so if the two
 * sites disagreed about what rendered, a guest could have an intention closed
 * that they never saw. undefined rather than [] when nothing renders, which
 * omits the block.
 */
function renderedIntentionLines(ctx: RuntimeContext): string[] | undefined {
  const rendered = renderableIntentions(
    ctx.openIntentions,
    ctx.classification?.category ?? null,
    ctx.pendingQuestion !== null,
    ctx.reviewAsk !== null,
  )
  return rendered.length > 0 ? rendered.map((o) => o.promptLine) : undefined
}

export function buildAiRuntime(
  ctx: RuntimeContext,
  // TAC-362: injectable so both branches of the emoji coin are reachable
  // without stubbing globals, defaulted here at the boundary so the pure
  // module stays pure. Same split scheduleAndSend uses for
  // resolveDispatchBubbles.
  rng: () => number = Math.random,
): AiRuntimeContext {
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
      // TAC-367: shared with handle-followup.ts's retrieval query, so the
      // text the model is instructed with and the text it is grounded
      // against cannot diverge.
      const hint = operatorInstructionQuery(ctx.followupTrigger)
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
        rewardDescription:
          ctx.followupTrigger.perkMechanic.rewardDescription ?? '',
      }
    : undefined

  // TAC-362: flip this message's emoji coin. This function is the only place
  // holding BOTH halves — the venue's emojiPolicy and the rng — the same
  // reason TAC-301's open/closed join lives here rather than in a serializer.
  // Returns null for policies that don't vary per message (never,
  // sparingly), which renders no block and leaves the persona's standing
  // statement in charge. `?? undefined` because the runtime field is
  // optional, not nullable.
  const emojiDirective =
    resolveEmojiDirective(ctx.venue.brandPersona.emojiPolicy, rng) ?? undefined

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
    inboundMedia: ctx.inboundMedia ?? undefined,
    perkBeingUnlocked,
    additionalContext,
    operatorInstruction,
    // TAC-301: openState is resolved here rather than in the serializer
    // because this is the only place that holds both halves — the venue's
    // hours (ctx.venue.venueInfo) and the validated timezone. `venueInfoToProse`
    // sees the hours but not the clock; `runtimeToProse` sees the clock but not
    // the hours. Leaving the join to the model is what produced the bug.
    // TAC-363: the verdict itself now comes from resolveVenueOpenState, shared
    // with arrival capture and the approval gate so the three cannot drift.
    // `timezoneSubstituted` still guards the RENDER for the reason it always
    // did — `computeToday` above is handed FALLBACK_TIMEZONE when the venue's
    // own is unusable, and a verdict resolved against a zone the venue does not
    // live in would be confidently wrong. The helper reaches the same answer on
    // its own (the venue's real timezone makes `venueLocalNow` throw, which
    // resolves to `unknown`), so this branch is belt and braces rather than the
    // only thing standing between a bad zone and a wrong verdict.
    today: {
      ...computeToday(timezone, now),
      openState: timezoneSubstituted
        ? { state: 'unknown' }
        : resolveVenueOpenState(ctx.venue, now),
    },
    recentMessages: ctx.recentMessages,
    mechanics: ctx.mechanics,
    // TAC-234: thread the recent transactions through to the AI module's
    // RuntimeContext. The serializer gates rendering by category (welcome /
    // opt_out skip) and on non-emptiness. recognition state is surfaced as
    // a `Guest relationship: <state>` line near the inbound framing.
    recentVisits: ctx.recentVisits,
    // TAC-573: only the item names cross into the AI module. The ids stay on
    // the agent side, where retractReportedVisits reads them off ctx.
    reportedVisits: ctx.retractableReportedVisits.map((v) => ({
      items: v.items,
    })),
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
    // TAC-324 / TAC-380: the intentions this turn RENDERS, as prompt lines in
    // priority order. Not simply ctx.openIntentions; see renderedIntentionLines.
    openIntentions: renderedIntentionLines(ctx),
    firstTouchAfterQrScan,
    // TAC-567: carried, never recomputed. build-runtime-context resolved it
    // against the same conversationWindowMs the intention derivation used, so
    // the prompt and the derivation cannot disagree about which turn is a first
    // conversation.
    firstConversation: ctx.firstConversation,
    // TAC-575: inbound turns only. A proactive turn's own instruction may be
    // to ask something.
    askNothing:
      ctx.currentMessage !== null &&
      ctx.followupTrigger === null &&
      (ctx.firstConversation || ctx.intentionDerivation.quietAfterWarmClose),
    // TAC-572: null on every turn but the one that opted the guest back in.
    reOptIn: ctx.reOptIn ?? undefined,
    // TAC-389: only handle-operator-decline.ts sets this, on the trigger it
    // hands to buildRuntimeContext. Every other path (inbound, cron follow-up,
    // ordinary Command Center manual follow-up) leaves it false, so the
    // `## Active commitments` intro is unchanged everywhere else.
    isOperatorDecline: ctx.followupTrigger?.isOperatorDecline === true,
    // TAC-536: mapped straight through, never re-derived. Null on every turn
    // but a scan greeting, and the serializer omits the block on null.
    scanArrival: ctx.scanArrival,
    // TAC-386: undefined rather than null on every other turn, matching how the
    // optional RuntimeContext fields around it read.
    inquiryFollowup: ctx.inquiryFollowup ?? undefined,
    // The once-ever review ask. Set only by handle-inbound's eligibility
    // predicate (lib/agent/review-ask.ts); null → undefined so the serializer
    // omits the `## Ask for a review` block and composeReplyWithReviewAsk
    // reads "not offered". Never co-present with a non-empty openIntentions —
    // renderableIntentions above vetoes the block when this is set.
    reviewAsk: ctx.reviewAsk ?? undefined,
    // TAC-362: this message's emoji call. undefined for the policies that
    // don't vary (never, sparingly) — the serializer then renders no block.
    emojiDirective,
    // TAC-308: the outstanding knowledge-gap question. Rendered as
    // `## Unanswered question` immediately before the unsent-drafts block
    // (the history itself is chat turns, not a block).
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
      resolveCategoryPolicy(
        ctx.venue.approvalPolicy,
        ctx.classification?.category,
      ) === 'operator_approval',
  }
}
