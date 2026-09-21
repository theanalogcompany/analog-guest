import {
  captureClassificationLowConfidence,
  captureCorpusRetrievalBelowThreshold,
  captureDashViolationPersisted,
  captureDemoBypassedApprovalGate,
  captureEmojiDirectiveViolated,
  captureGroundingVerifierUnavailable,
  captureMechanicOfferBackstopCaught,
  captureProsePromiseCaught,
  captureProsePromiseCheckUnavailable,
  captureRegenerationTriggered,
  captureUngroundedClaimCaught,
  captureUnverifiedUrlHeld,
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
  verifyProsePromise,
  type VoiceCorpusChunk as AiVoiceCorpusChunk,
} from '@/lib/ai'
import { resolveEmojiDirective } from '@/lib/ai/emoji-cadence'
// TAC-367: imported BY PATH, not from the '@/lib/ai' barrel above, because
// stages.test.ts vi.mocks that barrel — a bare constant arriving as
// `undefined` would make the fail-closed branch silently unreachable in
// every test that exercises it. Same reasoning as emoji-cadence.ts's
// deliberate exclusion from the barrel (TAC-362).
import { VERIFY_GROUNDING_TRUNCATED_ERROR_CODE } from '@/lib/ai/verify-grounding'
// TAC-401: imported BY PATH for the same reason as the line above — this
// file's tests `vi.mock` the '@/lib/ai' barrel, and a bare constant arriving
// `undefined` would make the no-retry branch silently unreachable in every
// one of them.
import { VERIFY_PROSE_PROMISE_TRUNCATED_ERROR_CODE } from '@/lib/ai/verify-prose-promise'
import { resolveOpenState } from '@/lib/schemas'
import {
  isEmptyCommitmentEmission,
  type PendingCommitment,
  pendingFromEmission,
} from '@/lib/schemas/guest-commitment'
import { resolveCategoryPolicy, resolvePolicyDecision } from '@/lib/schemas/approval-policy'
import { parseVenueLinks } from '@/lib/schemas/venue-info'
import { retrieveContext, retrieveKnowledgeContext } from '@/lib/rag'
import { fireRedAlert } from './alerts'
import { matchComp } from './comp-backstop'
import { isFloorCategory, matchForwardCommitment } from './complaint-floor'
import { canAutoSendComplaintTurn } from './complaint-routing'
import { REPORTED_ORDER_WINDOW_DAYS } from './extract-reported-order'
import { renderableIntentions } from './intentions/derive'
import { getPrimaryTagPreference } from './knowledge-tag-mapping'
import {
  commitmentIdentityOf,
  type CommitmentIdentity,
  anyKnowledgeGapCard,
  decideSlotAction,
  EMPTY_PENDING_ROWS,
  isKnowledgeGapCard,
  loadPendingRowsBySlot,
  otherSlotOccupant,
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
 * `verify-grounding` (`knowledge_gap_backstop`), which reads meaning.
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
  // knowledgeGap is false). Clock arming, the protected-card carve-out and
  // the SEND_FIDELITY_FLOOR exemption treat both triggers identically. BODY
  // BLANKING NO LONGER DOES (TAC-301 part 1.5): a self-reported gap blanks,
  // a backstop catch KEEPS its body, because on this path the model never
  // admitted to guessing and the flag can be wrong. See the blankBody
  // rationale at the queue return below. See also isKnowledgeGapCard and
  // knowledgeGapWillQueue's sibling logic.
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
  // unparseable check queues rather than degrading to pre-check behavior —
  // a deliberate divergence from verifyGroundingStage (TAC-350), which fails
  // open. An unauthorized perk grant costs the owner money and control; a
  // failed check costs one unnecessary review.
  MECHANIC_OFFER_BACKSTOP: 'mechanic_offer_backstop',
  // TAC-367: the grounding backstop produced a verdict we could not READ —
  // `finishReason: 'length'`, the output cap cut the JSON off mid-object.
  // Fails CLOSED, which is a deliberate narrowing of verifyGroundingStage's
  // otherwise fail-OPEN posture, scoped to this one cause:
  //
  //   - Truncation is a verdict the model PRODUCED. Discarding it is
  //     discarding evidence, not tolerating its absence. It is also load-
  //     correlated rather than random — the verifier reasons longest on the
  //     replies hardest to ground, which is exactly the population a
  //     fabrication check exists for. Same correlation TAC-309 found on the
  //     generator, where the model reasoned longest on questions it could
  //     not answer cleanly and truncation preferentially killed the
  //     knowledge-gap path.
  //   - Transient faults (network, provider 5xx, timeout) still fail OPEN.
  //     That rationale is unchanged and still correct: grounding runs on
  //     every inbound, so queuing every hiccup closed would convert a rare
  //     provider blip into a fleet-wide queue flood — a worse failure than
  //     the one being fixed.
  //
  // DISTINCT trigger rather than folding into KNOWLEDGE_GAP_BACKSTOP, even
  // though MECHANIC_OFFER_BACKSTOP sets the opposite precedent by covering
  // both 'flagged' and 'check_failed' under one code. Reusing it here would
  // tell the operator "ungrounded claim caught" for a turn where nothing was
  // caught and the check merely failed to parse — a third instance of the
  // wrong-reason-copy problem TAC-364 was filed for. The cost is that every
  // Record<ApprovalTrigger, …> total map needs a decision for this code,
  // which is the mechanism working rather than friction (see CLAUDE.md
  // "sets keyed on approval triggers must be TOTAL maps").
  //
  // Deliberately NOT part of `isGapTurn`: see its definition below.
  GROUNDING_CHECK_FAILED: 'grounding_check_failed',
  // TAC-401: independent post-generation check for a promise made in PROSE
  // with no structured commitment behind it. THE PRIMARY CONTROL for that
  // failure (ruled 2026-09-15, question 1, option c), not a secondary layer.
  //
  // Both controls that were supposed to cover it measured near zero on the
  // same 220 replies: the model's own `requiresOperatorApproval` self-flag
  // fired 0 times and caught 0 of the 4 genuine uncarried promises, and the
  // comp regex fired 5 times and caught 0 of them (3 apology idioms, 1
  // fabricated comp). What held the promises that were held was the grounding
  // check and the mechanic-offer check — neither a commitment control, both
  // firing for unrelated reasons, and both fail-open on paths this one covers.
  // Nothing may depend on the self-flag; it stays only as a secondary signal.
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
  // FAILS CLOSED, and unlike GROUNDING_CHECK_FAILED that is true of EVERY
  // failure mode here, not only truncation. The grounding check fails open on
  // a transient fault because it degrades to a defensible prior — the model's
  // own knowledgeGap self-report, which that check is a second opinion on.
  // This check has no prior to degrade to: the self-flag caught 0 of 220 and
  // the ruling forbids depending on it, so failing open returns to nothing at
  // all. A transient fault is retried once first (ruled 2026-09-21), which is
  // what pays for the closed posture: the flood case narrows from "any
  // hiccup" to "a fault that survives two immediate attempts".
  //
  // A DISTINCT trigger rather than folding into PROSE_PROMISE_BACKSTOP, for
  // the reason TAC-367 split GROUNDING_CHECK_FAILED out: telling an operator
  // a promise was caught on a turn where nothing was caught is the
  // wrong-reason-copy problem TAC-364 exists for. It also means a sustained
  // outage is countable in SQL separately from a wave of real catches.
  //
  // Deliberately carries NO carrier: we do not know what was promised, so
  // nothing is recorded and approving that card creates no commitment. The
  // alternative is inventing a description, which would land in
  // guest_commitments.description and render as a fact nobody wrote.
  PROSE_PROMISE_CHECK_FAILED: 'prose_promise_check_failed',
} as const

/**
 * Union of every trigger code that can land on `messages.review_reason`.
 * Consumed by the operator-queue normalizer (lib/operator/queue.ts) to
 * keep the human-readable label map exhaustive at compile time — adding
 * a new trigger above without a corresponding label there is a TS error.
 */
export type ApprovalTrigger = (typeof APPROVAL_TRIGGERS)[keyof typeof APPROVAL_TRIGGERS]

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
  // TAC-401: third, in the same obligation group as the two above and ABOVE
  // every grounding, regex and self-report trigger below.
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
  // TAC-509: ranked directly above SELF_TALK_DETECTED. Both are deterministic
  // loop backstops that mean "the text is confirmed broken", and neither is a
  // money exposure, so both sit below every resource-commitment trigger. This
  // one outranks self-talk because the guest ACTS on a wrong link: self-talk
  // tells them they are texting a bot, a bad link sends them to a 404. Label
  // only, like every entry in this array.
  APPROVAL_TRIGGERS.UNVERIFIED_URL,
  APPROVAL_TRIGGERS.SELF_TALK_DETECTED,
  // v1.23.0: below MODEL_FLAGGED so a self-flagged or structurally-typed
  // commitment keeps the more specific operator label; ABOVE
  // PREVIOUS_PENDING_HELD so a regenerated draft carrying a fresh complaint
  // promise still fires a push rather than being treated as a silent re-draft.
  APPROVAL_TRIGGERS.COMPLAINT_COMMITMENT_FLOOR,
  APPROVAL_TRIGGERS.PREVIOUS_PENDING_HELD,
  APPROVAL_TRIGGERS.FIDELITY_BELOW_AUTO_SEND_FLOOR,
  // TAC-367: ranked below every trigger that names something about this
  // draft, and above the two venue-wide policy signals. It is the only
  // trigger that reports an ABSENCE of signal — "we could not check" — so
  // whenever it co-fires with any concrete finding the concrete finding is
  // the more useful operator label. It still outranks the policy triggers
  // because it is at least specific to this message.
  APPROVAL_TRIGGERS.GROUNDING_CHECK_FAILED,
  // TAC-401: beside GROUNDING_CHECK_FAILED and for the identical reason. It
  // reports an ABSENCE of information about the reply, so any trigger naming
  // something concrete is the more useful operator label, and it still ranks
  // above the two venue-wide policy signals because it is at least specific to
  // this message.
  APPROVAL_TRIGGERS.PROSE_PROMISE_CHECK_FAILED,
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

// TAC-394: KNOWLEDGE_GAP_CARD_REVIEW_REASONS and isKnowledgeGapCard moved to
// ./pending-slots, so the persist layer can use them without importing this
// file. Re-exported here so every existing import keeps working. The moved
// review_reason values are literals there; stages.test.ts pins them against
// APPROVAL_TRIGGERS and GENERATION_FAILED_REVIEW_REASON.
export { isKnowledgeGapCard, KNOWLEDGE_GAP_CARD_REVIEW_REASONS } from './pending-slots'

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
    // TAC-495: picks the channel copy. Every path that generates goes through
    // here or the Voices regen, which passes the same field.
    channel: ctx.conversationChannel,
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
 * TAC-350, widened by TAC-367. What verifyGroundingStage concluded.
 *
 * Was `{ claims: string[] } | null`, where null flattened four different
 * situations into one: skipped, the call degrading, the call truncating, and
 * the call running clean. That was fine while every non-finding meant "do
 * nothing" — and it stopped being fine the moment truncation needed to queue,
 * because a two-state shape has nowhere to put "we could not read the
 * verdict" that is distinguishable from "there was nothing to report."
 *
 * Four states now, mirroring TAC-355's MechanicOfferBackstopResult exactly
 * rather than inventing a second vocabulary for the same idea. `truncated` is
 * the only one that queues besides `flagged`; see GROUNDING_CHECK_FAILED.
 */
export type GroundingBackstopResult =
  | { status: 'skipped' }
  | { status: 'clean' }
  | { status: 'flagged'; claims: string[] }
  | { status: 'truncated' }

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
 * TAC-376: no longer inbound-only. Three call sites now reach here —
 * handle-inbound.ts, handle-followup.ts (both engine and manual followups),
 * and handle-holding-message.ts (the knowledge-gap holding message) — per the
 * 2026-09-17 ruling: same verifier, same triggers, same failure posture as
 * inbound, no parallel check built for the no-guest-message case.
 * `isProactive` is derived HERE, from `ctx.currentMessage === null`, rather
 * than threaded in by callers — same boundary this stage already owned for
 * its other two skip conditions, so the two orchestrators that used to pass
 * `null` for this stage's result just start getting a real one.
 *
 * Skips (returns null without calling the model) when:
 *   - the guest is a demo guest — TAC-284's bypass ships regardless of any
 *     trigger, so spending a Haiku call here buys nothing.
 *   - the model already self-reported knowledgeGap=true — trust it; this is
 *     also what keeps the added cost to roughly half of inbound traffic
 *     (only turns where the model claims confidence pay for the check). A
 *     followup/holding-message generation always has knowledgeGap=false (the
 *     field only means something on the inbound path), so neither of those
 *     two callers ever hits this skip either — every one of their turns pays
 *     for the check.
 *
 * Fails OPEN on a TRANSIENT AI-call error (network hiccup, provider 5xx,
 * timeout) — returns `clean`, logged via console.warn, not fireRedAlert.
 * This is a SECOND, additional safety net on top of the model's own
 * self-report; a transient failure degrades to exactly pre-TAC-350 behavior
 * (trust the model), never to something worse. Queuing every transient
 * failure closed would turn a rare Haiku hiccup into a broad, unrelated
 * availability regression for a check whose entire population already passed
 * self-report. Same posture on a proactive turn (2026-09-17 ruling, question
 * 3) — nobody is waiting on a followup or a holding message the way a guest
 * is waiting on an inbound reply, but the ruling kept the SAME posture rather
 * than tightening it, so this file has one failure policy, not two.
 *
 * TAC-367 carves ONE cause out of that: output TRUNCATION fails CLOSED,
 * returning `truncated`, which queues via GROUNDING_CHECK_FAILED. The
 * distinction is that the model produced a verdict and the cap made it
 * unreadable — discarding it silently discards evidence — and that it
 * correlates with the replies hardest to ground rather than occurring at
 * random. Either way the stage now EMITS (captureGroundingVerifierUnavailable):
 * a fail-open path with no signal is how the truncation hole went unobserved
 * from TAC-301 part 1.5 until it was measured.
 *
 * Deliberately reuses the SAME venueInfo + knowledgeCorpus the generator saw
 * (ctx.venue.venueInfo, ctx.knowledgeCorpus) rather than re-fetching either —
 * "what the verifier checks against" must never drift from "what the
 * generator actually had."
 */
export async function verifyGroundingStage(
  ctx: Pick<RuntimeContext, 'agentRunId' | 'currentMessage' | 'guest' | 'venue' | 'knowledgeCorpus'>,
  generation: Pick<GenerateMessageResult, 'knowledgeGap' | 'body' | 'userPrompt'>,
): Promise<GroundingBackstopResult> {
  if (ctx.guest.isDemo === true) return { status: 'skipped' }
  if (generation.knowledgeGap === true) return { status: 'skipped' }

  const isProactive = ctx.currentMessage === null

  const r = await verifyGrounding({
    inboundBody: ctx.currentMessage?.body ?? '',
    replyBody: generation.body,
    venueInfo: ctx.venue.venueInfo,
    knowledgeChunks: ctx.knowledgeCorpus ?? undefined,
    isProactive,
    // TAC-301 part 1.5: hand over the generator's OWN composed user prompt,
    // unmodified. Do not rebuild this from ctx — the identity is the point.
    // Everything the generator knew about this guest and this moment lives
    // here (## Right now, ## What this guest can access, ## Active
    // commitments, ## Visit history, ## Guest context, ## Recent
    // conversation), and without it every fact drawn from those blocks reads
    // to the verifier as unsupported. Six of six were measured doing exactly
    // that against Le Mil's live config. (## Operator instruction renders on
    // the followup path too, since TAC-376, so it can now appear here.)
    runtimeContext: generation.userPrompt,
  })
  if (!r.ok) {
    // TAC-367: truncation and transient faults both land here and are NOT
    // the same event. Emit either way — the whole reason the truncation hole
    // survived unnoticed is that this branch was a console.warn and nothing
    // else, so neither PostHog nor Slack ever saw a turn where the only
    // fabrication check that fires under real traffic did not run.
    const truncated = r.errorCode === VERIFY_GROUNDING_TRUNCATED_ERROR_CODE
    console.warn(
      `[agent] grounding backstop ${truncated ? 'TRUNCATED' : 'degraded'} for venue=${ctx.venue.id}: ${r.error}${r.errorCode ? ` (${r.errorCode})` : ''}`,
    )
    // Decided BEFORE the emit, deliberately. The emit cannot throw today
    // (capturePostHogEvent and postToSlack both swallow their own errors),
    // but if one ever did, this stage would reject, handle-inbound's
    // allSettled would degrade it to `skipped`, and the truncation would
    // silently fail OPEN — the exact hole this ticket closes. Computing the
    // verdict first makes that structurally impossible instead of true only
    // by transitive luck.
    const verdict: GroundingBackstopResult = truncated
      ? { status: 'truncated' }
      : { status: 'clean' }
    await captureGroundingVerifierUnavailable({
      agentRunId: ctx.agentRunId,
      venueId: ctx.venue.id,
      guestId: ctx.guest.id,
      outcome: truncated ? 'truncated' : 'degraded',
      failedClosed: truncated,
      error: r.error,
      errorCode: r.errorCode,
    })
    return verdict
  }
  if (!r.data.hasUngroundedClaim) return { status: 'clean' }

  await captureUngroundedClaimCaught({
    agentRunId: ctx.agentRunId,
    venueId: ctx.venue.id,
    guestId: ctx.guest.id,
    // TAC-376: no inbound on a proactive turn (followup / holding message).
    // `(none — proactive)` reads as a fact on the Slack card rather than as
    // an empty, unexplained pair of quotes.
    inboundBody: ctx.currentMessage?.body ?? '(none — proactive)',
    replyBody: generation.body,
    ungroundedClaims: r.data.ungroundedClaims,
  })

  return { status: 'flagged', claims: r.data.ungroundedClaims }
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
 * queue-worthy outcome from "the check ran and found nothing."
 *
 * TAC-367: this used to contrast with GroundingBackstopFinding's two-state
 * shape. That type is gone — GroundingBackstopResult is now the same
 * four-state shape as this one — so the two backstops no longer differ in
 * SHAPE at all. They still differ in POSTURE, and that is the distinction
 * worth keeping straight: this one fails closed on EVERY failure, grounding
 * fails closed only on truncation and stays fail-open for transient faults.
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
 * Third sibling to verifyGroundingStage and verifyMechanicOfferStage, and the
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
 * The divergence from verifyGroundingStage's fail-OPEN posture is deliberate
 * and is the one thing to understand before changing it: grounding degrades to
 * a defensible prior, the model's own self-report, which it is a second
 * opinion on. This check has no prior — the self-flag caught 0 of 220 and the
 * ruling forbids depending on it — so failing open returns to nothing at all.
 */
export async function verifyProsePromiseStage(
  ctx: Pick<RuntimeContext, 'agentRunId' | 'guest' | 'venue' | 'classification'>,
  generation: Pick<GenerateMessageResult, 'body' | 'commitment'>,
): Promise<ProsePromiseBackstopResult> {
  if (ctx.guest.isDemo === true) return { status: 'skipped' }
  if (isCommitmentTypeGated(generation)) return { status: 'skipped' }
  if (generation.body.trim().length === 0) return { status: 'skipped' }

  let r = await verifyProsePromise({ replyBody: generation.body })
  let retried = false
  // One immediate retry, transient faults only. Truncation is excluded by
  // errorCode rather than by message text, which is provider-formatted and
  // not a contract.
  if (!r.ok && r.errorCode !== VERIFY_PROSE_PROMISE_TRUNCATED_ERROR_CODE) {
    retried = true
    r = await verifyProsePromise({ replyBody: generation.body })
  }

  if (!r.ok) {
    const truncated = r.errorCode === VERIFY_PROSE_PROMISE_TRUNCATED_ERROR_CODE
    console.warn(
      `[agent] prose-promise check ${truncated ? 'TRUNCATED' : 'degraded'} (failing CLOSED) for venue=${ctx.venue.id}: ${r.error}${r.errorCode ? ` (${r.errorCode})` : ''}`,
    )
    await captureProsePromiseCheckUnavailable({
      agentRunId: ctx.agentRunId,
      venueId: ctx.venue.id,
      guestId: ctx.guest.id,
      outcome: truncated ? 'truncated' : 'errored',
      retried,
      error: r.error,
      errorCode: r.errorCode,
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
    replyBody: generation.body,
  })

  return { status: 'flagged', commitment }
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
      // TAC-364: the verbatim claims the grounding verifier flagged, threaded
      // to the persist layer so they land on messages.ungrounded_claims and
      // reach the operator card.
      //
      // THREE-STATE, and the null is load-bearing:
      //   string[] non-empty → the check ran and flagged these
      //   []                 → the check RAN and found nothing
      //   null               → the check DID NOT RUN
      //
      // That last distinction is the question TAC-367 existed because nobody
      // could answer: a grounding check that silently didn't run was invisible
      // everywhere, and the whole point of recording this on the row is to be
      // able to ask it later in SQL. Collapsing "didn't run" into "found
      // nothing" would rebuild the blind spot in a new column on day one, and
      // it is free to avoid while the column is new.
      //
      // `truncated` maps to NULL, not `[]`: the check ran but produced no
      // readable verdict, so we have no claim information — which is what NULL
      // says. `[]` would assert it found nothing, and the paired
      // review_reason ('grounding_check_failed' → "I couldn't finish checking
      // this one") already carries the didn't-complete signal, so the two read
      // coherently together.
      //
      // The WIRE still collapses both to `[]` — see QueueDraft in
      // lib/operator/queue.ts for why the client doesn't get this distinction.
      ungroundedClaims: string[] | null
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
      compMatchedPattern: string | null
      // TAC-264: when non-null, the persist layer UPDATEs this row in place
      // (regenerate) instead of INSERTing a new pending row. TAC-394: it is the
      // card in THIS draft's slot, chosen by decideSlotAction, so the persist
      // layer never regenerates over the other slot's card.
      existingPendingDraftId: string | null
      // TAC-394: which of the guest's two pending slots this draft lands in
      // (migration 041), and whether the OTHER slot already holds a card,
      // i.e. whether this draft is the guest's second card.
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
      //
      // FALSE for knowledge_gap_backstop (TAC-301 part 1.5), which is the one
      // asymmetry between the two gap triggers. There the model claimed no
      // gap and the verifier's flag is a second opinion that can be wrong;
      // blanking destroyed correct replies in production.
      blankBody: boolean
    }
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

export async function applyApprovalPolicyStage(
  ctx: RuntimeContext,
  generation: GenerateMessageResult,
  // TAC-350: result of verifyGroundingStage, run by the orchestrator between
  // generateStage and this gate (needs an async AI call the gate itself
  // can't make mid-synchronous-evaluation). Four states (TAC-367): 'skipped'
  // (followup, demo, or the model already self-reported), 'clean' (ran and
  // found nothing, OR degraded on a transient fault — deliberately
  // indistinguishable, that IS the fail-open posture), 'flagged' (fires
  // KNOWLEDGE_GAP_BACKSTOP), 'truncated' (fires GROUNDING_CHECK_FAILED).
  // `null` is accepted for callers that didn't run the stage at all and is
  // normalized to 'skipped' below.
  groundingBackstop: GroundingBackstopResult | null = null,
  // TAC-355: result of verifyMechanicOfferStage, run by the orchestrator
  // alongside verifyGroundingStage (both are independent Haiku calls with no
  // dependency on each other). 'skipped' | 'clean' never fire the trigger;
  // 'flagged' | 'check_failed' both do — the fail-closed branch is
  // deliberate, see MECHANIC_OFFER_BACKSTOP's own comment above.
  mechanicOfferBackstop: MechanicOfferBackstopResult = { status: 'skipped' },
  // TAC-401: result of verifyProsePromiseStage, run by the orchestrator
  // CONCURRENTLY with the two checks above (ruled 2026-09-21, ruling 2) rather
  // than in sequence. 'skipped' | 'clean' never fire a trigger; 'flagged'
  // fires PROSE_PROMISE_BACKSTOP and carries the commitment the check named;
  // 'check_failed' fires PROSE_PROMISE_CHECK_FAILED. Both of those queue —
  // this check fails closed on every failure, not only on truncation.
  prosePromiseBackstop: ProsePromiseBackstopResult = { status: 'skipped' },
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
    (await loadPendingRowsBySlot(ctx.venue.id, ctx.guest.id)) ?? EMPTY_PENDING_ROWS

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

  // Trigger 9b (TAC-350): independent grounding backstop. Only ever reaches
  // 'flagged' when the orchestrator ran verifyGroundingStage AND it found
  // something — which itself only happens when generation.knowledgeGap was
  // false. Mutually exclusive with trigger 9 by construction, same as
  // COMP_REGEX_BACKSTOP is independent of MODEL_FLAGGED.
  //
  // TAC-367: `null` (caller didn't run it) is normalized to 'skipped' rather
  // than handled separately — the gate has never distinguished "not run" from
  // "ran and found nothing", and the harness + followup callers both rely on
  // being able to omit the argument entirely.
  const grounding: GroundingBackstopResult = groundingBackstop ?? { status: 'skipped' }
  const backstopFired = grounding.status === 'flagged'
  if (backstopFired) {
    triggers.push(APPROVAL_TRIGGERS.KNOWLEDGE_GAP_BACKSTOP)
  }

  // Trigger 9c (TAC-367): the grounding check produced a verdict that could
  // not be read (output truncation). Fails CLOSED — see
  // GROUNDING_CHECK_FAILED for why this one cause diverges from the
  // fail-open posture the transient-fault path keeps.
  if (grounding.status === 'truncated') {
    triggers.push(APPROVAL_TRIGGERS.GROUNDING_CHECK_FAILED)
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

  // Trigger 12 (TAC-401): the independent prose-promise check. 'flagged' means
  // the reply commits the venue to something of value with no structured
  // commitment behind it; 'check_failed' means we could not find out.
  //
  // The two are separate triggers on purpose — see PROSE_PROMISE_CHECK_FAILED
  // on APPROVAL_TRIGGERS. Both queue: this check fails CLOSED on every failure
  // mode, the deliberate divergence from the grounding backstop above.
  if (prosePromiseBackstop.status === 'flagged') {
    triggers.push(APPROVAL_TRIGGERS.PROSE_PROMISE_BACKSTOP)
  }
  if (prosePromiseBackstop.status === 'check_failed') {
    triggers.push(APPROVAL_TRIGGERS.PROSE_PROMISE_CHECK_FAILED)
  }

  // TAC-350: the umbrella "is this turn a knowledge-gap-card turn" signal,
  // covering EITHER the self-reported trigger or the independent backstop.
  // Clock arming and the protected-card drop key on this, so a
  // caught-but-unflagged fabrication is never sent and always queued, exactly
  // like an honest self-report.
  //
  // BODY BLANKING IS THE EXCEPTION and no longer keys on this (TAC-301 part
  // 1.5) — see the blankBody rationale at the return below.
  //
  // TAC-367: GROUNDING_CHECK_FAILED is deliberately NOT part of this. A
  // truncated check is an absence of information about the reply, not a
  // finding against it, and everything keyed on isGapTurn has a guest-facing
  // consequence that would be wrong to trigger on that basis:
  //   - it arms messages.pending_until, so an unread verdict would put a
  //     "still looking into it" holding message in front of a guest whose
  //     reply was most likely fine, for a question they may not have asked;
  //   - it grants the protected-card carve-out, which silently DROPS the
  //     guest's next turn if that turn queues for any other reason.
  // A truncated check queues the draft for a human to glance at. That is the
  // whole intended consequence, and it needs none of the above.
  const isGapTurn = knowledgeGapFired || backstopFired

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
    prosePromiseBackstop.status === 'flagged' ? prosePromiseBackstop.commitment : null
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
  const slotOccupant = pendingRows[slot]
  const existingIsKnowledgeGapCard = slotOccupant !== null && isKnowledgeGapCard(slotOccupant)
  const protectedCardCarveOut = existingIsKnowledgeGapCard && triggers.length === 0

  if (slotOccupant !== null && !protectedCardCarveOut && !isManualFollowup) {
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

  // TAC-394: where this queued draft goes, decided by the same pure function
  // that 23505 race recovery calls in schedule-and-send.ts, so a card the gate
  // never saw gets exactly the treatment a card it did see gets. The full order
  // is at decideSlotAction. The drops that can come back:
  //
  // TAC-308 case 3: a knowledge-gap card holds the slot and this turn queues
  // for some reason OTHER than gapping itself. Regen-in-place would overwrite
  // the question an operator is about to answer, and the slot's index forbids a
  // second pending row, so the draft is discarded rather than stored. TAC-350: a
  // turn the backstop caught is just as much "gapping itself" as a
  // self-reported one, which is why this keys on isGapTurn.
  //
  // TAC-367: a TRUNCATED grounding check is exempt too, and this is the one
  // place `isGapTurn` alone gives the wrong answer. Excluding `truncated` from
  // `isGapTurn` is right FORWARD (don't arm a clock, don't make this card
  // protected for later turns) and wrong BACKWARD: without the exemption the
  // trigger pushed above makes `triggers.length > 0`, which cancels the
  // protected-card carve-out and would DROP a turn that, before TAC-367, fired
  // no trigger at all and SENT. A draft nobody could read the verdict for is
  // handed to an operator, never destroyed: queuing regenerates in place over
  // the card and preserves its original `pending_until` (the UPDATE payload
  // omits the column), so the guest's question keeps its clock.
  //
  // TAC-394: the obligation slot holds a DIFFERENT commitment (a comp for
  // another item, or another gated type). The existing card wins and this
  // draft is dropped with an alert naming both commitments. And a manual
  // followup that would queue into any occupied slot is refused.
  // TAC-401 widened this from grounding's truncation alone, and the rename
  // came with it: the flag was never "truncation was the only trigger", it is
  // "a check on this turn did not complete".
  //
  // The exemption is the one TAC-367 spells out twenty lines above, and
  // prose_promise_check_failed has the identical property: it reports an
  // ABSENCE of information about the reply, not a finding against it, and it
  // is deliberately excluded from isGapTurn. Without the exemption the trigger
  // it pushes makes triggers.length > 0, which cancels the protected-card
  // carve-out and DROPS a turn that fired no trigger at all before this ticket
  // and SENT. A guest already waiting on a knowledge-gap card would get
  // silence because a Haiku call failed twice — the one outcome worse than
  // either failing open or failing closed.
  const checkDidNotComplete =
    grounding.status === 'truncated' || prosePromiseBackstop.status === 'check_failed'
  const slotDecision = decideSlotAction({
    rows: pendingRows,
    draftCommitment,
    isGapTurn,
    checkDidNotComplete,
    callerPolicy: isManualFollowup ? 'never_regen' : 'regen',
  })
  if (slotDecision.action === 'drop') {
    return {
      action: 'drop',
      reason: slotDecision.reason,
      triggers,
      protectedDraftId: slotDecision.protectedDraftId,
      protectedCommitment: commitmentIdentityOf(
        pendingRows[slotDecision.slot]?.pending_commitment ?? null,
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
  //     A self-reported gap card and a backstop-flagged comp are the realistic
  //     pair. anyKnowledgeGapCard covers the same-slot cases above as well.
  //
  // TAC-350: keyed on isGapTurn, not knowledgeGapFired alone — a fresh
  // backstop catch arms the clock exactly like a fresh self-reported gap;
  // both are "the guest asked something and got no grounded answer."
  const pendingUntil =
    isGapTurn && !anyKnowledgeGapCard(pendingRows)
      ? new Date(Date.now() + KNOWLEDGE_GAP_WINDOW_MS)
      : undefined

  return {
    action: 'queue',
    triggers,
    primaryTrigger: pickPrimaryTrigger(triggers),
    // TAC-364. All four grounding states map here, and the mapping is the
    // whole point of the field being nullable — see ApprovalDecision above.
    //
    //   flagged   → the claims
    //   clean     → []    the check ran and found nothing
    //   skipped   → null  the check did not run (followup, demo guest, or the
    //                     model self-reported a gap so we trusted it)
    //   truncated → null  it ran but the verdict was unreadable, so we have no
    //                     claim information — 'grounding_check_failed' on
    //                     review_reason is what says it didn't complete
    //
    // Known and accepted, inherited from TAC-367 rather than introduced here:
    // a TRANSIENT fault also returns `clean`, so it records as "ran and found
    // nothing". That indistinguishability IS the fail-open posture, and the
    // degraded case is reported by captureGroundingVerifierUnavailable rather
    // than by this column.
    ungroundedClaims:
      grounding.status === 'flagged'
        ? grounding.claims
        : grounding.status === 'clean'
          ? []
          : null,
    // TAC-401: the carrier the prose-promise check produced, threaded to the
    // persist layer so an operator approving the card creates a real
    // guest_commitments row. Null whenever the check supplied nothing, and
    // resolveDraftCarrier in the persist layer applies the same precedence the
    // gate used above — the model's own emission wins.
    promisedCommitment,
    compMatchedPattern: comp.matched ? comp.pattern : null,
    existingPendingDraftId: slotDecision.action === 'regen' ? slotDecision.draftId : null,
    slot,
    otherSlotOccupied: otherSlotOccupant(pendingRows, draftCommitment) !== null,
    pendingUntil,
    // TAC-301 part 1.5 REVERSES TAC-350 here, deliberately: blank on a
    // self-reported gap, KEEP the body on a backstop catch.
    //
    // TAC-309's reason for blanking is specific to the self-report path. There
    // the model ADMITTED it could not ground the answer, so the body is an
    // acknowledged guess and an operator approving it in one swipe is the
    // failure being prevented.
    //
    // On the backstop path the model admitted nothing. The body is its
    // confident answer, and the verifier's flag is a second opinion that can
    // be WRONG — on 2026-09-13 it was wrong twice in the first two minutes
    // after deploy, on replies that were entirely correct ("we're closed for
    // the night, back at 7 tomorrow"). Blanking destroyed a correct message
    // and left the operator an empty card with nothing to approve or edit,
    // so the guest got silence instead of an answer that already existed.
    //
    // Keeping the body makes a false positive recoverable in one swipe instead
    // of destructive. Two costs are accepted knowingly rather than by
    // omission, both surfaced in code review:
    //
    //   1. `ungroundedClaims` does NOT reach the card. It goes to PostHog /
    //      Slack (captureUngroundedClaimCaught) and the Langfuse span; the
    //      operator sees a fluent draft plus the generic "unverified claim"
    //      label and has to spot which part is wrong themselves. Worse on a
    //      co-firing turn, where PRIMARY_TRIGGER_PRIORITY hands the label to
    //      commitment_type_gated and nothing on the card mentions grounding
    //      at all. Blanking used to make one-swipe approval structurally
    //      impossible; it no longer is. Surfacing the claim list on the card
    //      is the real fix and is deliberately NOT in this change.
    //   2. pending_commitment now rides along with the body. It was stripped
    //      before because it was INVISIBLE on a blank card; the body being
    //      visible is a convention that it names the commitment, not a
    //      guarantee that it does.
    //
    // Both are judged better than destroying a correct reply, which is what
    // the previous behavior did twice in production within two minutes.
    //
    // pendingUntil above stays keyed on isGapTurn. Deliberate even though the
    // card now holds a viable answer: nothing has been SENT, so from the
    // guest's side they are still waiting, and the holding message ("still on
    // it") stays accurate about their experience rather than about the card.
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
  )
  return rendered.length > 0 ? rendered.map((o) => o.promptLine) : undefined
}

export function buildAiRuntime(
  ctx: RuntimeContext,
  // TAC-362: injectable so tests can pin both branches of the emoji coin
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
        rewardDescription: ctx.followupTrigger.perkMechanic.rewardDescription ?? '',
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
    // TAC-324 / TAC-380: the intentions this turn RENDERS, as prompt lines in
    // priority order. Not simply ctx.openIntentions; see renderedIntentionLines.
    openIntentions: renderedIntentionLines(ctx),
    firstTouchAfterQrScan,
    // TAC-362: this message's emoji call. undefined for the policies that
    // don't vary (never, sparingly) — the serializer then renders no block.
    emojiDirective,
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