import { generateObject, NoObjectGeneratedError } from 'ai'
import { z } from 'zod'
import {
  ArrivalCaptureEmissionSchema,
  CommitmentEmissionSchema,
} from '@/lib/schemas/guest-commitment'
import { GuestContextPatchSchema } from '@/lib/schemas/guest-context'
import { isMessageChannel } from '@/lib/schemas/message-channel'
import { parseVenueLinks } from '@/lib/schemas/venue-info'
import { captureGenerationTruncated } from '@/lib/analytics/posthog'
import { logger } from '@/lib/observability/logger'
import { getGenerationModel } from './client'
import { composePrompt } from './compose-prompt'
import { containsEmoji } from './emoji-cadence'
import {
  appendFurtherHelpOffer,
  decideFurtherHelpOffer,
  type FurtherHelpOfferReason,
} from './further-help-offer'
import { PROMPT_VERSION } from './prompts/system-template'
import { matchSelfTalk } from './self-talk-detector'
import { isTaskDraft } from './task-draft'
import { findUnverifiedUrls, URL_TOKEN_SPLITTER } from './url-detector'
import type {
  AIResult,
  GenerateMessageAttempt,
  GenerateMessageInput,
  GenerateMessageResult,
} from './types'

export const MAX_ATTEMPTS = 3

/**
 * Output-token ceiling for one generation attempt.
 *
 * TAC-309 raised this from 500. The measured picture, from Langfuse on live
 * Mock Sextant traffic:
 *
 *   successful single attempts   4.1-5.7s, ~121-299 emitted tokens
 *   the 2026-08-08 crash         13.7s, single call, "could not parse the
 *                                response" — at the observed ~33 tok/s that
 *                                is ~450 tokens, i.e. the old 500 cap
 *
 * The object serializes `body` FIRST and `knowledgeGap` / `contextUpdate` /
 * `commitment` / `arrivalCapture` LAST, so running out of budget truncates
 * mid-JSON and the whole emission fails to parse. (`reasoning`, the only
 * unbounded non-body field, was removed in the v1.80.0 schema diet.)
 *
 * The correlation that makes this worse than it looks: the model reasons
 * LONGEST on questions it can't answer cleanly, which is exactly the
 * knowledge-gap case. Truncation preferentially killed the path TAC-308 built
 * to catch those questions.
 *
 * 500 predates TAC-296 / TAC-297 / TAC-308, each of which appended a required
 * field to the tail while the cap stood still — the same failure class as
 * TAC-300's optional-parameter budget, without the guardrail. 1500 is ~5x the
 * largest emission observed. Raising it costs nothing on normal runs: output
 * tokens bill on what's actually produced, and generation stops at the end of
 * the object.
 */
export const MAX_OUTPUT_TOKENS = 1500

/**
 * errorCode returned when a generation attempt was cut off at
 * MAX_OUTPUT_TOKENS rather than failing for a content reason.
 *
 * Structural, not a string match on the SDK's message: callers need to tell
 * the two apart because retrying a truncation just runs into the same
 * ceiling, and the AI SDK reports both as "could not parse the response."
 */
export const AI_ERROR_TRUNCATED = 'ai_generation_truncated'
// THE-225: hard-block regex companion to the R3 voice rule. Em dash (U+2014)
// or en dash (U+2013) anywhere in the body is a violation. Sonnet still
// occasionally emits dashes despite the rule text; this is the deterministic
// backstop.
const DASH_REGEX = /[—–]/

/**
 * Dash replacement, not regeneration (2026-09-23).
 *
 * THE-225 originally spent a whole extra generation call on a dash: the body
 * was thrown away and Sonnet was asked again with a standing constraint. That
 * is ~6s (p50) of guest-facing latency to fix a single character, on a path
 * that auto-sends by default. Regenerating also re-rolls the ENTIRE body, so a
 * draft that was good apart from one dash could come back worse on an axis
 * nothing was checking.
 *
 * The substitution is what the constraint text asked the model for anyway
 * ("use a period or a comma instead"), applied deterministically.
 *
 * Whitespace around the dash is absorbed so both dash idioms land on the same
 * shape — ` — ` and `—` alike become `, `:
 *
 *   "dandelion root — in tonic"  ->  "dandelion root, in tonic"
 *   "dandelion root—in tonic"    ->  "dandelion root, in tonic"
 *
 * A dash that ends the body would otherwise leave a trailing ", ", so the
 * result is trimmed. A dash landing directly after existing comma punctuation
 * would otherwise double it, so ", ," collapses back to ", ".
 *
 * THREE EDGE CASES, each found by probing this function rather than reasoned
 * about, and each a real guest-facing defect:
 *
 *   1. URLs are left alone. `https://x.com/a—b` is one token, and rewriting
 *      the dash inside it produces a broken link. Worse than broken: the
 *      substitution runs BEFORE findUnverifiedUrls, so the mangled URL is
 *      what gets checked, fails the allowlist it would otherwise have passed,
 *      and queues a draft for a link the model got RIGHT.
 *   2. A leading dash would produce a body opening on ", ".
 *   3. A body that is ONLY a dash empties out completely. An empty body is
 *      refused downstream by sendMessage's `message_must_have_content` guard,
 *      so it cannot ship blank — but the guest gets silence and a red alert
 *      instead of a reply, which is a worse outcome than the dash. So an
 *      emptying substitution is REFUSED: the original body is returned and
 *      `dashViolationPersisted` fires, which is exactly the backstop that
 *      flag exists to be.
 */
export function replaceDashes(body: string): string {
  // Split on URL tokens and substitute only in the gaps between them. Reuses
  // url-detector's pattern rather than inventing a second one — two URL
  // regexes in one file would drift, and this one already encodes the
  // bare-domain and trailing-noise rules TAC-509 tuned.
  const substituted = body
    .split(URL_TOKEN_SPLITTER)
    .map((segment, i) =>
      // Odd indices are the captured URL tokens; leave them verbatim.
      i % 2 === 1 ? segment : segment.replace(/\s*[—–]\s*/g, ', '),
    )
    .join('')
    .replace(/,\s*,/g, ',')
    .replace(/,\s*$/, '')
    .replace(/^\s*,\s*/, '')
    .trim()
  // Refuse a substitution that would empty a non-empty body (case 3 above).
  return substituted === '' && body.trim() !== '' ? body : substituted
}

// TAC-355: deterministic backstop for reasoning/self-correction leaking into
// a guest-facing body ("...dandelion root — actually wait, no dashes."). Runs
// in the SAME per-attempt loop as the dash check, sharing its attempt budget
// deliberately — the two failures are correlated (the motivating incident
// WAS dash avoidance), so a message that trips one is likely to trip the
// other, and the terminal state here is a queue, not a send, so a shared
// small budget is already safe. Unlike a dash, a self-talk violation that
// persists through every attempt must NOT ship — see
// GenerateMessageResult.selfTalkViolationPersisted and
// lib/agent/stages.ts's SELF_TALK_DETECTED trigger.
const SELF_TALK_CONSTRAINT =
  'Constraint: do not include a self-correction, any visible reasoning, or any reference to your own instructions, rules, or nature as an AI (for example "actually wait, no dashes" or "as an AI"). Write it as a normal reply.'

// TAC-509: deterministic backstop for a link nobody curated. Runs in the SAME
// per-attempt loop as the dash and self-talk checks, sharing their attempt
// budget. Like self-talk and unlike the dash regex, a violation that survives
// every attempt must NOT ship — see unverifiedUrlsPersisted below and
// lib/agent/stages.ts's UNVERIFIED_URL trigger.
//
// The constraint names the offending links. The model cannot fix a link it
// cannot see it got wrong, and the usual miss is one character in a slug.
//
// Phrased as a standing fact about those links rather than as a report on the
// previous attempt, so it stays TRUE on every later attempt it is carried
// into: a link that is not on the list is not on the list whether or not the
// attempt just completed used it.
function unverifiedUrlConstraint(urls: readonly string[]): string {
  const quoted = urls.map((u) => `"${u}"`).join(', ')
  const isAre = urls.length === 1 ? 'is not a link' : 'are not links'
  return `Constraint: ${quoted} ${isAre} the venue has approved, and must not appear in your reply. Use only a link from the "## Links" section, copied exactly as written there, or no link at all. Do not guess a web address and do not build one from a pattern.`
}

// Exported for the measurement scripts; the generation pipeline uses the
// schema directly via the `schema:` arg below.
export const GeneratedMessageSchema = z.object({
  body: z.string().min(1),
  // v1.80.0 schema diet: `voiceFidelity` and `reasoning` used to sit here.
  // The fidelity self-score never gated anything in practice (110 production
  // scores, min 0.72, zero below either floor; the trigger queued 0 drafts
  // ever) and `reasoning` was the only unbounded non-body field — together
  // they were ~40% of the emitted output tokens on a p50 turn. Removing them
  // is a latency cut, not a behaviour change.
  // TAC-212: model self-flag for resource commitments (comps, refunds,
  // mechanic commitments where the runtime context marked the mechanic
  // requires_operator_approval=true). When true, the approval-policy gate
  // queues the draft (review_state='pending') and skips Sendblue dispatch.
  // approvalReason is a one-clause human-readable rationale; empty string
  // when requiresOperatorApproval=false. Both fields rigidly populated on
  // every generation — no .optional() because the structured-output
  // validator is more reliable with explicit presence.
  requiresOperatorApproval: z.boolean(),
  approvalReason: z.string(),
  // v1.24.0: what this turn is doing on a complaint. Drives the ONLY
  // exemption from comp_complaint's category routing — a turn that is
  // genuinely just asking auto-sends; anything else queues for an operator.
  // REQUIRED, not optional, for two reasons: the TAC-212 precedent that
  // Anthropic's validator is more reliable with explicit presence, and
  // because a required field costs ZERO against the TAC-300 24-optional
  // budget (the counter counts properties absent from `required`), keeping
  // the schema at 20. Non-complaint turns emit 'none'. See
  // lib/agent/complaint-routing.ts for how it is consumed and why the model's
  // claim is necessary but never sufficient.
  complaintIntent: z.enum(['clarifying', 'resolving', 'none']),
  // TAC-308: true when the reply answers a guest question the model could not
  // ground in the runtime context — venue knowledge, venue_info, or the voice
  // corpus. The KNOWLEDGE_GAP approval trigger routes the turn to the operator
  // queue with a live messages.pending_until, and the guest gets nothing on
  // that turn.
  //
  // TAC-309: the model still WRITES a body (the dash regex and the fidelity
  // self-assessment both operate on real text), but that body is DISCARDED at
  // the persist boundary and the card is stored blank. TAC-308 shipped it
  // prefilled; the first live card read "Not sure on the specific matcha we
  // source. I can find out if that matters for your order." — the exact
  // promise phrasing the same ticket had just deleted from the corpus. A
  // visible guess is something an operator swipes rather than replaces, so
  // there is now nothing to swipe.
  //
  // REQUIRED, not optional, for the same two reasons as complaintIntent: the
  // TAC-212 precedent that Anthropic's validator is more reliable with
  // explicit presence, and because a required field costs ZERO against the
  // TAC-300 24-optional budget (the counter counts properties absent from
  // `required`). Turns that answer nothing, or answer it confidently, emit
  // false.
  knowledgeGap: z.boolean(),
  // TAC-296: agent-emitted patch for guests.context. Field is REQUIRED on
  // every emission (per the TAC-212 precedent — Anthropic's structured-output
  // validator is more reliable with explicit presence), but both inner fields
  // are optional so the agent emits `{}` for the no-op case. The orchestrator
  // calls isEmptyContextUpdate before any DB hit. GuestContextPatchSchema is
  // aggressively permissive (every nested field optional, unknown keys
  // stripped) so a malformed near-miss patch doesn't trigger the regen loop —
  // the model's MESSAGE quality is what regen exists to fix, not its
  // context-capture spelling.
  contextUpdate: z.object({
    structured: GuestContextPatchSchema.optional(),
    observation: z.string().optional(),
  }),
  // TAC-297: agent emits a commitment object when the reply offers something
  // we'll have ready for the guest — comp, hold, off-menu rec, discount. Same
  // rigid-presence / optional-inner posture as contextUpdate (TAC-296). When
  // type ∈ {comp, hold, discount}, the approval-policy gate's
  // COMMITMENT_TYPE_GATED trigger fires regardless of requiresOperatorApproval
  // — structural backstop per the TAC-297 plan-review call #2.
  commitment: CommitmentEmissionSchema,
  // TAC-297: agent emits an arrivalCapture object when the guest's inbound
  // signals arrival in response to an active commitment surfaced in the
  // ## Active commitments user-prompt block. signal='imminent' triggers
  // immediate transitionToPendingAck + push; signal='scheduled' stores
  // expected_arrival for the hourly cron to fire.
  arrivalCapture: ArrivalCaptureEmissionSchema,
  // TAC-513: the commitment this reply WITHDRAWS, by id, copied verbatim from
  // the `id:` on a line of the ## Active commitments block. Empty string when
  // the reply cancels nothing, which is almost every turn.
  //
  // A BARE REQUIRED STRING rather than a nested optional object, for the reason
  // knowledgeGap is a bare required boolean: Anthropic counts only optionals
  // against the 24-property cap, this schema sits at exactly 20 against a repo
  // budget of 22, and a nested
  // `{ commitmentId?: string }` would cost 2 and land on the budget line.
  // The sentinel is '' and the schema does not police it; resolveCancellation
  // does, against the guest's own rendered list.
  //
  // BY ID, NOT BY CODE. The 4-char verification code is not unique (31-char
  // alphabet, no constraint) and is NULL on every recommendation, so it cannot
  // address half the rows it would need to. TAC-302 is the recorded failure:
  // through v1.17.0 the id was missing from the block, the model reached for
  // the code instead, and every arrival capture no-op'd.
  cancelsCommitmentId: z.string(),
  // TAC-560: did THIS reply close the guest's first conversation, in the way the
  // venue's own voice rules describe (the line is open, here is what you can
  // message us about anytime)?
  //
  // A BARE REQUIRED BOOLEAN, for the reason knowledgeGap is: Anthropic counts
  // only optionals against the 24-property cap, this schema sits at exactly 20
  // against a repo budget of 22, and a required
  // field costs nothing there.
  //
  // WHAT IT IS FOR. The close is once per guest EVER, from either path, and the
  // timer needs to know the in-conversation close already went out. Nothing
  // structural marks that turn: it is an ordinary reply to "thanks!", stored
  // under whatever the classifier picked. So the model reports it.
  //
  // ONE READER SINCE v1.98.0: the offer-more-help decision treats a reply the
  // model reports as a sign-off as one that takes no offer line (below, and
  // further-help-offer.ts). Between TAC-575 and then nothing read it:
  // handle-inbound.ts used to write guests.warm_close_sent_at from this
  // report; the goodbye path now decides before generation, and then (ruled
  // 2026-10-06) stopped signing off on a reply at all. Removing the field now
  // changes that veto as well as the schema and the prompt section.
  //
  // SELF-REPORT IS NOT TRUSTED ALONE, on this repo's own record (TAC-350: 8 of 8
  // fabrications self-reported clean). The timer carries an independent belt: a
  // last inbound that classified `acknowledgment` IS the sign-off turn, so it
  // stands down whatever this field said. Both signals point the same way, and
  // over-marking (no close) is the cheaper mistake than under-marking (two).
  closedTheConversation: z.boolean(),
  // TAC-554: the getting-to-know-you question this reply is asking, alone, and
  // NOT in `body`. Empty string on every turn that is not asking one, which is
  // most turns.
  //
  // WHY A SEPARATE FIELD AT ALL. Jaipal ruled that a question raised from the
  // `## What you're hoping to get to` block always goes out as its own message
  // bubble, after the answer. A persona rule saying exactly that failed twice
  // on device on 2026-09-29, and dispatch is why: resolveDispatchBubbles splits
  // on sentence boundaries it can detect, so one of those replies rode a fair
  // coin and lost, and the other had no detectable boundary before its question
  // and could not have split at any probability. Bubble structure is not
  // something prompt wording can reach.
  //
  // WHAT THIS FIELD IS NOT: it is not the text we send as a second message
  // directly from here. composeReplyWithIntention CONCATENATES it back onto the
  // body immediately below, so `GenerateMessageResult.body` stays the complete
  // reply exactly as it always has, and every check that reads the body — the
  // dash substitution, self-talk, unverified links, the
  // prose-promise and cancellation checks, the comp regex — still sees the
  // question. The field rides alongside as the exact TAIL of the body, true by
  // construction because we did the joining. Dispatch peels it off.
  //
  // A BARE REQUIRED STRING, the cancelsCommitmentId reasoning verbatim:
  // Anthropic counts only optionals against the 24-property cap, this schema
  // sits at 20 against a repo budget of 22, and
  // a required string costs zero.
  intentionQuestion: z.string(),
  // The review invitation this reply is making, alone, and NOT in `body`.
  // Empty string on every turn the runtime context carries no `## Ask for a
  // review` block, which is almost every turn.
  //
  // Same mechanism as intentionQuestion above, one field over:
  // composeReplyWithReviewAsk CONCATENATES it back onto the body, so `body`
  // stays the complete reply and every backstop — including the unverified-url
  // detector, which is what verifies the link the ask carries — still reads
  // it. Dispatch peels it off as its own last bubble.
  //
  // A BARE REQUIRED STRING, the intentionQuestion reasoning verbatim:
  // Anthropic counts only optionals against the 24-property cap and a
  // required string costs zero.
  reviewAsk: z.string(),
  // The offer-more-help line, written apart from the reply so code can decide
  // from the finished reply whether it is sent (further-help-offer.ts), and
  // the model's own report that the reply gave how-to instructions, the one
  // of that rule's three conditions that leaves no mark in the text. Both
  // REQUIRED, so neither costs a slot against the 24-optional cap. '' and
  // false on almost every turn. After `body` on purpose: the model has
  // written the reply before it describes it.
  furtherHelpOffer: z.string(),
  gaveInstructions: z.boolean(),
  // TAC-573: what this reply is doing about a visit the guest told us about
  // and is now contradicting. 'none' on every turn the runtime carries no
  // `## Visit they told you about` block, which is almost every turn.
  //
  // A REQUIRED ENUM, the complaintIntent reasoning verbatim: explicit presence
  // is what Anthropic's validator handles most reliably, and a required field
  // costs zero against the 24-optional cap.
  //
  // DECLARED LAST on purpose: structured output is generated in declaration
  // order, so the model has written the reply before it labels it, and the
  // label describes what it actually said.
  //
  // NOT TRUSTED ALONE. generateMessage forces it to 'none' when the block did
  // not render, and lib/agent/retract-reported-visit.ts only ever retracts rows
  // code selected. See that file for the one thing left to the prompt.
  reportedVisitCorrection: z.enum(['none', 'checking', 'retracted']),
})

/**
 * A one-line-regex duplicate of hasRenderableContent in
 * lib/agent/sentence-split.ts, deliberately, with a pointer in each file.
 *
 * lib/agent imports lib/ai and never the reverse, so sharing it would mean
 * either a cycle or a new shared module for one predicate. The two also do
 * different jobs: here it NORMALIZES a contentless question to '' so nothing
 * downstream ever sees one, and there it DEFENDS against a caller that didn't.
 * Both are one line, and the duplication is bounded and stated rather than
 * discovered.
 */
function hasRenderableContent(piece: string): boolean {
  return /[\p{L}\p{N}]/u.test(piece)
}

/** Letters and digits only, case-folded. */
function normalizeForDuplicate(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '')
}

/**
 * If the answer already ends with the question, cut it off.
 *
 * THE ONE FAILURE A STRUCTURAL MECHANISM CANNOT PREVENT is the model putting
 * the question in BOTH fields, which would compose to "...what's your name?
 * what's your name?" — a duplicated question in the guest's thread. Approved
 * 2026-09-29 on the condition that its firing rate is reported rather than
 * silent, which is what `intentionQuestionDuplicateStripped` on the result is
 * for: a guard nobody can count is how comp_regex_backstop became an illusion.
 *
 * It only ever REMOVES a trailing duplicate, never adds or reorders, so the
 * worst case is a slightly shorter answer rather than wrong text.
 *
 * Comparison is on letters and digits alone, case-folded, so the model
 * re-punctuating or re-casing its own sentence still matches. The scan walks
 * back from the end and stops as soon as the candidate suffix is longer than
 * the question, which is sound because prepending characters can only keep or
 * grow a normalized length.
 */
export function stripTrailingDuplicate(
  answer: string,
  question: string,
): string {
  const q = normalizeForDuplicate(question)
  if (q === '') return answer
  for (let i = answer.length - 1; i >= 0; i -= 1) {
    const candidate = normalizeForDuplicate(answer.slice(i))
    if (candidate.length > q.length) break
    if (candidate === q) return answer.slice(0, i).trim()
  }
  return answer
}

/**
 * Join the model's two halves into the one complete reply, and hand back the
 * tail dispatch will peel off again.
 *
 * Called at the replaceDashes seam, which is the single normalization point
 * every downstream read already flows through. THE ORDER MATTERS: replaceDashes
 * runs on each part BEFORE they are joined, so `body` ends with
 * `intentionQuestion` character for character. Substituting on the joined
 * string instead would let a dash inside the question change it after the fact
 * and break the identity dispatch relies on.
 */
export function composeReplyWithIntention(
  rawBody: string,
  rawQuestion: string,
): {
  body: string
  intentionQuestion: string
  duplicateStripped: boolean
  droppedForBodyQuestion: boolean
} {
  const answerIn = replaceDashes(rawBody)
  const question = replaceDashes(rawQuestion)

  // Normalize a question that is absent, whitespace, or has nothing a guest
  // would read (see hasRenderableContent) to '' here, once, so no downstream
  // reader has to think about it. This is also where replaceDashes' refusal
  // case lands: a field containing only an em dash comes back as "—".
  if (question.trim() === '' || !hasRenderableContent(question)) {
    return {
      body: answerIn,
      intentionQuestion: '',
      duplicateStripped: false,
      droppedForBodyQuestion: false,
    }
  }

  const answer = stripTrailingDuplicate(answerIn, question)
  const duplicateStripped = answer !== answerIn

  // The model put the whole reply in the field, or the answer was nothing but
  // a repeat of the question. One message, which is the question.
  if (answer.trim() === '') {
    return {
      body: question,
      intentionQuestion: question,
      duplicateStripped,
      droppedForBodyQuestion: false,
    }
  }

  // TAC-567, ruled 2026-09-30: NEVER TWO QUESTIONS IN ONE TURN. The reply keeps
  // its own question and the intention bubble is dropped, which is the
  // direction the ruling names ("no intention bubble is added that turn").
  //
  // On device a first-visit turn read "that's a good one to start with 🌸 how'd
  // you like it?" and then, as its own bubble, "by the way, what's your name?".
  // Two questions for a guest to answer in one turn, and the prompt cannot
  // reliably prevent it: the same lesson as TAC-554's, one layer on. So this is
  // structural, at the one seam where the two halves meet.
  //
  // THE DETECTOR IS A BARE QUESTION MARK IN THE ANSWER, not looksLikeQuestion.
  // This reads OUR OWN outbound, where the venue's copy always punctuates
  // ("never drop a question mark"), so recall is near-total on this population
  // and the wider detector would only add false positives. See the recall
  // argument recorded on weAskedAQuestion in lib/agent/warm-close.ts, which
  // widens for the opposite reason on the opposite population.
  //
  // A FALSE POSITIVE COSTS ONE TURN, NOT THE INTENTION. Nothing is written here,
  // and the post-send classifier reads the sent body, which now carries no
  // getting-to-know-you question, so the intention is not recorded as raised and
  // comes back open on the next turn. The failure direction is a question asked
  // later, never a question asked twice.
  //
  // ONE EXCEPTION, and it is pre-existing policy rather than something this gate
  // introduces: when classifyIntentionPrompts fails twice, recording closes
  // everything renderableIntentions offered it, pessimistically (TAC-380 ruling
  // 4, see record.ts). On a turn where this gate fired, the dropped question's
  // intention is in that set and closes having never been asked. The gate does
  // enlarge the population of turns where the block rendered and nothing was
  // asked, so it enlarges the exposure; it does not change the rule.
  //
  // Downstream needs nothing: intentionQuestion is '' so intentionTailFor
  // returns '' on both dispatch arms, exactly as on a turn that asked nothing.
  if (answer.includes('?')) {
    return {
      body: answer,
      intentionQuestion: '',
      duplicateStripped,
      droppedForBodyQuestion: true,
    }
  }

  return {
    body: `${answer} ${question}`,
    intentionQuestion: question,
    duplicateStripped,
    droppedForBodyQuestion: false,
  }
}

/**
 * Join the reply and the review invitation, mirroring
 * composeReplyWithIntention one seam later. A MIRROR, not a generalization:
 * the two gates differ in kind (rendered-intentions count there, an
 * offered-flag here), and one N-tail composer over both would couple them.
 * Bounded, stated duplication — the hasRenderableContent reasoning.
 *
 * Runs on the ALREADY-COMPOSED body, which is what makes the precedence
 * structural: a surviving intention question put a `?` into the body, so the
 * review ask drops and the order can never invert. (In practice the two never
 * co-render — the review-ask turn suppresses the intentions block — so this
 * is belt.)
 *
 * `offered` is whether the runtime actually carried the `## Ask for a review`
 * block this turn. When false, ANY emission is normalized to '' — a followup
 * or decline turn can never grow a review ask the prompt never offered, no
 * matter what the model hallucinates into the field.
 */
export function composeReplyWithReviewAsk(
  rawBody: string,
  rawAsk: string,
  offered: boolean,
): {
  body: string
  reviewAsk: string
  duplicateStripped: boolean
  droppedForBodyQuestion: boolean
} {
  const answerIn = replaceDashes(rawBody)
  const ask = replaceDashes(rawAsk)

  if (!offered || ask.trim() === '' || !hasRenderableContent(ask)) {
    return {
      body: answerIn,
      reviewAsk: '',
      duplicateStripped: false,
      droppedForBodyQuestion: false,
    }
  }

  const answer = stripTrailingDuplicate(answerIn, ask)
  const duplicateStripped = answer !== answerIn

  // The model put the whole reply in the field, or the answer was nothing but
  // a repeat of the ask. One message, which is the ask.
  if (answer.trim() === '') {
    return {
      body: ask,
      reviewAsk: ask,
      duplicateStripped,
      droppedForBodyQuestion: false,
    }
  }

  // Never two asks in one turn — TAC-567's rule, applied to this tail. The
  // reply keeps its own question; nothing is stamped (the guest only stops
  // being eligible when the link actually reaches them), so the failure
  // direction is an invitation extended later, never two asks at once.
  if (answer.includes('?')) {
    return {
      body: answer,
      reviewAsk: '',
      duplicateStripped,
      droppedForBodyQuestion: true,
    }
  }

  return {
    body: `${answer} ${ask}`,
    reviewAsk: ask,
    duplicateStripped,
    droppedForBodyQuestion: false,
  }
}

/**
 * Generate an outbound message in the venue's voice.
 *
 * Calls the model up to MAX_ATTEMPTS (3) times, retrying only on a self-talk
 * or unverified-link violation, and returns the last attempt. (Through
 * v1.79.0 a voice-fidelity self-score below 0.7 also retried; the score was
 * removed in the v1.80.0 schema diet because it never gated anything in
 * production — see GeneratedMessageSchema.)
 *
 * Pure transformer. No DB writes. The caller is responsible for persisting
 * the message.
 */
export async function generateMessage(
  input: GenerateMessageInput,
): Promise<AIResult<GenerateMessageResult>> {
  if (
    typeof input !== 'object' ||
    input === null ||
    typeof input.persona !== 'object' ||
    input.persona === null ||
    typeof input.venueInfo !== 'object' ||
    input.venueInfo === null ||
    !Array.isArray(input.ragChunks) ||
    typeof input.runtime !== 'object' ||
    input.runtime === null ||
    // TAC-495: null is a real answer (unknown channel). Anything else that is
    // not a channel, such as an undefined smuggled past the type by a cast,
    // fails here as a value rather than silently becoming the SMS copy.
    (input.channel !== null && !isMessageChannel(input.channel))
  ) {
    return { ok: false, error: 'invalid_input' }
  }

  // TAC-509: the curated link allowlist for this venue. Computed ONCE, above
  // the loop, so every attempt is judged against the same list.
  //
  // `venue_info.links` and nothing else. Deliberately NOT derived from the
  // retrieved knowledge chunks, the composed prompt or `venue_info.contact`:
  // a link is sendable because a human put it on a list, not because it turned
  // up somewhere in context. An empty list is a normal state and means no link
  // may be sent at all.
  const allowedUrls = parseVenueLinks(input.venueInfo.links).map((l) => l.url)

  const {
    systemPrompt,
    cacheableSystemPrefix,
    volatileSystemSuffix,
    userPrompt,
    historyTurns,
    conversationTranscript,
  } = composePrompt(input)
  // Same bytes as systemPrompt, split at the stability boundary so a cache
  // breakpoint can sit between them. (Through v1.79.0 a voice-fidelity
  // instruction was suffixed here; the v1.80.0 schema diet removed the field
  // and the instruction with it.)
  const volatileSystemBlock = volatileSystemSuffix

  // Hoisted out of the try so the catch's diagnostic log can include which
  // attempt was in-flight when generateObject threw.
  let attempts = 0

  try {
    let lastResult: {
      body: string
      requiresOperatorApproval: boolean
      approvalReason: string
      complaintIntent: z.infer<typeof GeneratedMessageSchema>['complaintIntent']
      knowledgeGap: boolean
      contextUpdate: {
        structured?: z.infer<typeof GuestContextPatchSchema>
        observation?: string
      }
      commitment: z.infer<typeof CommitmentEmissionSchema>
      arrivalCapture: z.infer<typeof ArrivalCaptureEmissionSchema>
      cancelsCommitmentId: string
      intentionQuestion: string
      reviewAsk: string
      furtherHelpOffer: string
      closedTheConversation: boolean
      reportedVisitCorrection: z.infer<
        typeof GeneratedMessageSchema
      >['reportedVisitCorrection']
    } | null = null
    const attemptHistory: GenerateMessageAttempt[] = []
    // THE-225, made STICKY by the TAC-509 follow-up (ruled 2026-09-21).
    //
    // Once a check has fired on ANY attempt of this call, its constraint stays
    // in every later attempt's prompt. It used to be rebuilt from scratch each
    // iteration out of only the just-completed attempt's violations, so a
    // directive was dropped the moment its own check passed even when the loop
    // carried on for a different reason.
    //
    // That drop was safe BY CONSTRUCTION while the dash was the only
    // non-fidelity check: a dash-clean attempt that also passed fidelity broke
    // the loop, so nothing came after it to reintroduce a dash. TAC-355
    // (self-talk) and TAC-509 (unverified links) each added a reason to keep
    // looping past a dash-clean body, and the loop returns the LAST attempt
    // rather than the best one, so the dropped directive started costing
    // real drafts. The live case, Le Mil's 2026-09-21: attempt 1 had a dash
    // and an unlisted link, attempt 2 fixed the dash and kept the link so the
    // dash constraint left the prompt, attempt 3 worked on the link and put a
    // dash back. That body is what was held.
    //
    // Every constraint is therefore worded as a STANDING RULE rather than as
    // feedback about the previous attempt ("do not use a dash character",
    // never "your previous attempt contained a dash"). A sticky directive
    // phrased as a report becomes a false statement the moment it outlives the
    // attempt it describes.
    //
    // null on the first attempt — the parent userPrompt is sent verbatim.
    let regenFeedback: string | null = null
    let selfTalkConstraintActive = false
    // Summed over every attempt in this call, so a regen that re-reads the
    // same prefix shows up as two reads rather than being averaged away.
    let cacheReadTokens = 0
    let cacheWriteTokens = 0
    // THE SAME SUMMING, for the buckets Langfuse prices natively. Summed rather
    // than last-attempt because a retry is a second Sonnet call that was really
    // paid for: 12.6% of generations run one (measured 2026-09-29) and reporting
    // only the final attempt would hide that cost entirely.
    //
    // uncachedInputTokens is kept separate from cacheRead/cacheWrite because
    // Langfuse's input buckets are DISJOINT and it sums them for cost - see
    // AgentUsage in lib/observability/langfuse.ts. Do not add them together here.
    let uncachedInputTokens = 0
    let outputTokens = 0
    // The model the provider actually served, last attempt wins. Every attempt in
    // one call uses the same model, so last-wins and first-wins agree; reading it
    // from the response rather than from getGenerationModel() is what makes a
    // provider-side alias change visible instead of silently mis-attributed.
    let servedModelId: string | undefined
    // TAC-554: whether the duplicate guard fired on the attempt that shipped.
    // Assigned per attempt alongside lastResult, so it describes the same
    // attempt the body came from rather than any earlier one.
    let duplicateStripped = false
    // TAC-567: whether the two-question gate fired on the shipped attempt.
    let droppedForBodyQuestion = false
    // Whether the one-ask-per-turn gate dropped the review ask on the shipped
    // attempt. Same per-attempt assignment discipline as the two flags above.
    let reviewAskDropped = false
    let offerReason: FurtherHelpOfferReason = 'no_offer_written'
    // TAC-573: whether the visit-correction gate dropped an ask on the shipped
    // attempt.
    let askDroppedForCorrection = false
    // Whether the task-draft gate dropped the question on the shipped attempt.
    let droppedForTaskDraft = false
    // Order-preserving and deduped, so a link flagged on attempt 1 is still
    // named on attempt 3 alongside anything new attempt 2 invented.
    const unverifiedUrlsSeen: string[] = []

    for (let i = 0; i < MAX_ATTEMPTS; i++) {
      attempts++
      const userPromptForAttempt = regenFeedback
        ? `${userPrompt}\n\n${regenFeedback}`
        : userPrompt
      const {
        object: rawObject,
        usage,
        providerMetadata,
        response,
      } = await generateObject({
        model: getGenerationModel(),
        // Two adjacent system messages, not one `system` string: the provider
        // maps each to its own Anthropic system text block and honours a
        // per-block cache_control (see @ai-sdk/anthropic's convert step). The
        // breakpoint goes on the first — template + persona + venue info,
        // stable for the (venue, channel) pair and ~10k tokens on its own,
        // comfortably over Sonnet 4.6's 1024-token cacheable minimum.
        //
        // The second block is deliberately UNCACHED: it carries the retrieved
        // RAG and knowledge chunks plus the category instructions, all of
        // which change per message. Marking it too would write a fresh entry
        // every call and read none, paying the write premium for nothing.
        //
        // ttl '1h', not the 5m default, CHOSEN FROM THE TRAFFIC (measured
        // 2026-09-23 over the last 500 inbound rows). A cache entry only pays
        // off if the next message to the same venue lands inside the window,
        // and pilot traffic is bursty with long quiet stretches:
        //
        //   venue           gap <= 5min     gap <= 60min
        //   4c523772           61%              82%
        //   5cd8231f           69%              82%
        //   a17e75d6           52%              78%
        //
        // A 5m window misses roughly a third of messages and pays the write
        // premium on each miss. 1h doubles the write premium (2x vs 1.25x)
        // but lifts the hit rate to ~82%, which is cheaper on net at these
        // volumes AND is the difference between the cache helping most
        // replies and helping half of them. Re-derive this if traffic shape
        // changes — the query is in CLAUDE.md under "Latency and cost".
        messages: [
          {
            role: 'system',
            content: cacheableSystemPrefix,
            providerOptions: {
              anthropic: { cacheControl: { type: 'ephemeral', ttl: '1h' } },
            },
          },
          { role: 'system', content: volatileSystemBlock },
          ...historyTurns,
          { role: 'user', content: userPromptForAttempt },
        ],
        schema: GeneratedMessageSchema,
        maxOutputTokens: MAX_OUTPUT_TOKENS,
      })
      // Prompt-cache accounting, summed across attempts.
      //
      // Without this the cache is INVISIBLE: a cache hit and a fast uncached
      // call look identical on the latency graph, and the failure mode that
      // actually matters — a breakpoint that silently never reads, because
      // the prefix drifted or the TTL expired — produces no error at all,
      // just cacheRead stuck at 0 forever. Latency alone cannot distinguish
      // "the cache is working" from "the model was quick today".
      //
      // cachedInputTokens is the AI SDK's provider-independent read count;
      // cacheCreationInputTokens is Anthropic-specific and only on
      // providerMetadata. Both are optional at the type level and absent on
      // a provider that does not cache, hence the ?? 0.
      cacheReadTokens += usage?.cachedInputTokens ?? 0
      cacheWriteTokens +=
        (providerMetadata?.anthropic?.cacheCreationInputTokens as
          number | null | undefined) ?? 0
      // inputTokens is the SDK's TOTAL (noCache + cacheRead + cacheWrite), so the
      // uncached portion comes off inputTokenDetails. Subtracting here instead
      // would double-bill every cached token once this reaches Langfuse.
      uncachedInputTokens += usage?.inputTokenDetails?.noCacheTokens ?? 0
      outputTokens += usage?.outputTokens ?? 0
      servedModelId = response?.modelId ?? servedModelId
      // Dashes are substituted, never regenerated. Done HERE rather than at
      // return so every downstream read — the break condition below, the
      // attempt history, the shipped body — sees one body, and so a dash can
      // never be the reason another generation call is spent.
      // TAC-554: compose the two halves into one complete reply here, at the
      // seam replaceDashes already owned, so every read below — the break
      // condition, the attempt history, the shipped body, and every backstop
      // downstream — sees ONE body carrying the question, exactly as it did
      // before this field existed.
      // TAC-573. Two things, both decided here because this is the seam that
      // already owns what rides on the reply.
      //
      // The field means nothing without the block: a model that reports a
      // correction on a turn that showed it no reported visit is normalized to
      // 'none', so nothing downstream ever acts on it.
      //
      // And ruled 2026-10-06: a gentle check, or a reply accepting that the
      // guest has not been in, carries no name ask and no other intention. Like
      // TAC-567 one gate over, the prompt cannot be relied on for that, so the
      // question and the review ask are dropped before they are composed. As
      // there, nothing is written and nothing closes: the intention comes back
      // open on a later turn.
      const reportedVisitCorrection =
        (input.runtime.reportedVisits?.length ?? 0) > 0
          ? rawObject.reportedVisitCorrection
          : 'none'
      const correcting = reportedVisitCorrection !== 'none'
      const droppedForCorrection =
        correcting &&
        (rawObject.intentionQuestion.trim() !== '' ||
          rawObject.reviewAsk.trim() !== '')
      if (droppedForCorrection) {
        console.warn(
          '[ai] generateMessage: dropped an ask, the reply is correcting a reported visit',
        )
      }
      // TAC-575: a question the model emits on a turn that showed it no
      // intentions block is dropped rather than folded into the reply. The
      // field means nothing without the block, exactly as
      // reportedVisitCorrection does above, and since TAC-575 the block is
      // absent on purpose on the turns that must carry no question (a guest's
      // first reply, the replies after a warm close). Nothing was rendered, so
      // nothing is recorded and nothing closes.
      const droppedForNoBlock =
        (input.runtime.openIntentions?.length ?? 0) === 0 &&
        rawObject.intentionQuestion.trim() !== ''
      if (droppedForNoBlock) {
        console.warn(
          '[ai] generateMessage: dropped an intention question, no intentions block was rendered this turn',
        )
      }
      // Ruled 2026-10-07: a getting-to-know-you question never rides on a
      // reply that sends a link or makes a recommendation. The category gate
      // (renderableIntentions) keeps the block off a turn that is asking for
      // something; this is the draft's own half, for a reply that turned into
      // a task anyway. A link in the answer or an emitted commitment (a
      // recommendation, a hold, a comp) is the signal, read off the generation
      // with no further model call (isTaskDraft).
      //
      // Only when every rendered line is a getting-to-know-you one: the field
      // does not say which line the model took, and a question about the
      // visit's order is not this rule's to drop. Nothing is written and
      // nothing closes, the same cost as the two drops above.
      const taskDraft =
        input.runtime.conversationPacedIntentionsOnly === true &&
        rawObject.intentionQuestion.trim() !== '' &&
        isTaskDraft(rawObject.body, rawObject.commitment)
      if (taskDraft) {
        console.warn(
          '[ai] generateMessage: dropped a getting-to-know-you question, the reply carries a link or a commitment',
        )
      }
      const composed = composeReplyWithIntention(
        rawObject.body,
        correcting || droppedForNoBlock || taskDraft
          ? ''
          : rawObject.intentionQuestion,
      )
      if (composed.duplicateStripped) {
        console.warn(
          '[ai] generateMessage: stripped a duplicated intention question from the answer',
        )
      }
      // TAC-567: logged, not silent. The gate edits guest-facing text by
      // removing a question the model meant to ask, and a guard nobody can count
      // is how comp_regex_backstop came to look like it was working.
      if (composed.droppedForBodyQuestion) {
        console.warn(
          '[ai] generateMessage: dropped the intention question, the reply already asked one',
        )
      }
      // The review-ask compose runs on the ALREADY-COMPOSED body, which is
      // what makes the precedence structural (a surviving intention question
      // is a `?` in the body, so the ask drops) — and it runs BEFORE the URL
      // check below, so findUnverifiedUrls judges the body WITH the ask's
      // link in it.
      const withAsk = composeReplyWithReviewAsk(
        composed.body,
        correcting ? '' : rawObject.reviewAsk,
        input.runtime.reviewAsk != null,
      )
      if (withAsk.duplicateStripped) {
        console.warn(
          '[ai] generateMessage: stripped a duplicated review ask from the answer',
        )
      }
      if (withAsk.droppedForBodyQuestion) {
        console.warn(
          '[ai] generateMessage: dropped the review ask, the reply already asked a question',
        )
      }
      // The offer-more-help line, decided LAST and from the finished reply:
      // the two asks above are already in or out, so "this reply asks
      // something" is a fact about the text, and an offer never lands behind a
      // tail dispatch is about to peel off as its own message.
      const offerLine = replaceDashes(rawObject.furtherHelpOffer).trim()
      // The model put the line in the reply as well as in the field. One copy.
      const beforeOffer =
        offerLine === ''
          ? withAsk.body
          : stripTrailingDuplicate(withAsk.body, offerLine)
      const offerDecision = decideFurtherHelpOffer({
        body: beforeOffer,
        offer: offerLine,
        category: input.category,
        gaveInstructions: rawObject.gaveInstructions,
        commitment: rawObject.commitment,
        repliesToGuest: input.runtime.inboundMessage != null,
        signsOff:
          rawObject.closedTheConversation ||
          input.runtime.signOff != null ||
          input.runtime.timedClose === true,
        onComplaintTurn: rawObject.complaintIntent !== 'none',
        carriesAnAsk:
          composed.intentionQuestion !== '' || withAsk.reviewAsk !== '',
        knowledgeGap: rawObject.knowledgeGap,
        correctingVisit: correcting,
      })
      // Logged like the drops above: a line the model wrote and code withheld
      // is guest-facing text removed, and has to be countable.
      if (
        !offerDecision.append &&
        offerDecision.reason !== 'no_offer_written'
      ) {
        console.warn(
          `[ai] generateMessage: withheld the offer-more-help line (${offerDecision.reason})`,
        )
      }
      const object = {
        ...rawObject,
        body:
          offerDecision.append && beforeOffer.trim() !== ''
            ? appendFurtherHelpOffer(beforeOffer, offerLine)
            : withAsk.body,
        intentionQuestion: composed.intentionQuestion,
        reviewAsk: withAsk.reviewAsk,
        furtherHelpOffer:
          offerDecision.append && beforeOffer.trim() !== '' ? offerLine : '',
        reportedVisitCorrection,
      }
      offerReason = offerDecision.reason
      lastResult = object
      askDroppedForCorrection = droppedForCorrection
      droppedForTaskDraft = taskDraft
      duplicateStripped = composed.duplicateStripped
      droppedForBodyQuestion = composed.droppedForBodyQuestion
      reviewAskDropped = withAsk.droppedForBodyQuestion
      attemptHistory.push({
        body: object.body,
        requiresOperatorApproval: object.requiresOperatorApproval,
        approvalReason: object.approvalReason,
        complaintIntent: object.complaintIntent,
        knowledgeGap: object.knowledgeGap,
        contextUpdate: object.contextUpdate,
        commitment: object.commitment,
        arrivalCapture: object.arrivalCapture,
        cancelsCommitmentId: object.cancelsCommitmentId,
        intentionQuestion: object.intentionQuestion,
        reviewAsk: object.reviewAsk,
        closedTheConversation: object.closedTheConversation,
        reportedVisitCorrection: object.reportedVisitCorrection,
        userPromptOverride:
          userPromptForAttempt !== userPrompt
            ? userPromptForAttempt
            : undefined,
      })
      // No dash check here on purpose: replaceDashes already ran on this body,
      // so there is nothing left to catch and nothing a further attempt could
      // fix. The two checks below still gate the loop.
      const hasSelfTalk = matchSelfTalk(object.body).matched
      const badUrls = findUnverifiedUrls(object.body, allowedUrls)
      if (!hasSelfTalk && badUrls.length === 0) break
      // Accumulate, never reset. Both compose (a body can trip more than
      // one at once — the motivating incident tripped two) rather than one
      // winning over the other, and each stays set for the rest of the call.
      if (hasSelfTalk) selfTalkConstraintActive = true
      for (const url of badUrls) {
        if (!unverifiedUrlsSeen.includes(url)) unverifiedUrlsSeen.push(url)
      }
      const feedbackParts: string[] = []
      if (selfTalkConstraintActive) feedbackParts.push(SELF_TALK_CONSTRAINT)
      if (unverifiedUrlsSeen.length > 0) {
        feedbackParts.push(unverifiedUrlConstraint(unverifiedUrlsSeen))
      }
      // Reaching this line means a check fired this attempt, so feedbackParts
      // is non-empty by construction; the guard is belt only.
      regenFeedback =
        feedbackParts.length > 0 ? feedbackParts.join('\n\n') : null
    }

    if (lastResult === null) {
      return {
        ok: false,
        error: 'no_result_returned',
        errorCode: 'ai_generation_failed',
      }
    }

    return {
      ok: true,
      data: {
        body: lastResult.body,
        // TAC-212: model self-flag for the approval-policy gate. Carries
        // through to applyApprovalPolicyStage and is recorded on the
        // draft_queued PostHog event when the gate queues.
        requiresOperatorApproval: lastResult.requiresOperatorApproval,
        complaintIntent: lastResult.complaintIntent,
        approvalReason: lastResult.approvalReason,
        // TAC-308: final-attempt knowledge-gap flag. applyApprovalPolicyStage
        // turns this into the KNOWLEDGE_GAP trigger (inbound only), which
        // queues the draft and arms messages.pending_until.
        knowledgeGap: lastResult.knowledgeGap,
        // TAC-296: final-attempt context update. Orchestrator's context-write
        // step (between generateStage success and applyApprovalPolicyStage)
        // calls updateGuestContext with this payload.
        contextUpdate: lastResult.contextUpdate,
        // TAC-297: final-attempt commitment emission. Orchestrator threads
        // this onto messages.pending_commitment for gated paths (intent
        // carrier through the approval queue) or materializes inline for
        // recommendation auto-sends. Empty emission shape `{}` is the
        // no-op; isEmptyCommitmentEmission short-circuits before any DB hit.
        commitment: lastResult.commitment,
        // TAC-297: final-attempt arrival capture. Orchestrator dispatches
        // independently of the approval-gate outcome — what the agent
        // UNDERSTOOD from the inbound is independent of what the agent
        // SAID back (TAC-296 precedent).
        arrivalCapture: lastResult.arrivalCapture,
        cancelsCommitmentId: lastResult.cancelsCommitmentId,
        // TAC-560: did this reply close the guest's first conversation? Not
        // read by anything since TAC-575; see the schema field above.
        closedTheConversation: lastResult.closedTheConversation,
        // TAC-573: already normalized to 'none' when the block did not render.
        // handle-inbound.ts retracts on 'retracted', whatever the gate decides.
        reportedVisitCorrection: lastResult.reportedVisitCorrection,
        askDroppedForVisitCorrection: askDroppedForCorrection,
        // TAC-554: the exact tail of `body`. Dispatch splits there so the
        // question goes out as its own last message. '' means this turn asked
        // nothing, and dispatch then behaves exactly as it did before.
        intentionQuestion: lastResult.intentionQuestion,
        // Whether the duplicate guard fired on the shipped attempt. Carried so
        // the guard is countable — it edits guest-facing text, and that was
        // approved on the condition it is reported rather than silent.
        intentionQuestionDuplicateStripped: duplicateStripped,
        // TAC-567: whether the two-question gate dropped this turn's bubble.
        // Carried for the same reason as the line above: it edits guest-facing
        // text, so its firing rate has to be countable rather than inferred.
        intentionQuestionDroppedForBodyQuestion: droppedForBodyQuestion,
        intentionQuestionDroppedForTaskDraft: droppedForTaskDraft,
        // The exact tail of `body` when non-empty, the intentionQuestion
        // identity one field over. Dispatch peels it off as its own last
        // bubble; '' means this turn carries no review ask.
        reviewAsk: lastResult.reviewAsk,
        // Whether the one-ask-per-turn gate dropped the review ask this turn.
        // Countable for the same reason the two intention flags are; nothing
        // is stamped on a drop, so the guest stays eligible.
        reviewAskDroppedForBodyQuestion: reviewAskDropped,
        // The offer line as sent, '' when none was. The exact tail of `body`,
        // like the two asks; dispatch sends it as its own last message. The reason says which fact sent it or which
        // veto stopped one the model wrote, so the rule's firing is countable.
        furtherHelpOffer: lastResult.furtherHelpOffer,
        furtherHelpOfferReason: offerReason,
        attempts,
        attemptHistory,
        systemPrompt,
        userPrompt,
        conversation: conversationTranscript,
        promptVersion: PROMPT_VERSION,
        cacheReadTokens,
        cacheWriteTokens,
        // The same three cache/input numbers again, in the shape toAgentUsage
        // consumes, so the orchestrator can price the `generate` generation
        // without reassembling them. cacheReadTokens/cacheWriteTokens above stay
        // because the prompt-cache accounting in the span's output object is
        // documented and queried; these two representations must agree.
        modelId: servedModelId,
        usage: {
          inputTokens: uncachedInputTokens + cacheReadTokens + cacheWriteTokens,
          outputTokens,
          totalTokens:
            uncachedInputTokens +
            cacheReadTokens +
            cacheWriteTokens +
            outputTokens,
          cachedInputTokens: cacheReadTokens,
          inputTokenDetails: {
            noCacheTokens: uncachedInputTokens,
            cacheWriteTokens,
          },
        },
        // THE-225: recompute on the final shipped body rather than threading
        // loop state. Equivalent and lets us drop the variable.
        //
        // Since replaceDashes runs on every attempt this is now expected to be
        // false on every call, and the PostHog event it feeds
        // (captureDashViolationPersisted, lib/agent/stages.ts) should go quiet
        // rather than disappear. Kept deliberately: it is the only thing that
        // would notice replaceDashes failing to hold — a new dash-like
        // codepoint the regex does not cover, or a caller that reintroduces a
        // dash downstream of this function. An alarm that never fires is the
        // point; delete it only alongside the substitution itself.
        dashViolationPersisted: DASH_REGEX.test(lastResult.body),
        // TAC-355: same recompute-on-final-body pattern as dashViolationPersisted.
        // Unlike the dash case, a true here means the draft must NOT ship —
        // see lib/agent/stages.ts's SELF_TALK_DETECTED trigger.
        selfTalkViolationPersisted: matchSelfTalk(lastResult.body).matched,
        // TAC-509: same recompute-on-final-body pattern. Like self-talk and
        // unlike a dash, a true here must NOT ship — lib/agent/stages.ts's
        // UNVERIFIED_URL trigger queues the draft. The links themselves ride
        // along so the operator event can say which ones were wrong; a gate
        // whose true-positive history cannot be produced on demand is an
        // unproven gate (CLAUDE.md, "Gotchas worth carrying everywhere").
        unverifiedUrls: findUnverifiedUrls(lastResult.body, allowedUrls),
        // TAC-362: same recompute-on-final-body pattern as the two above.
        // Only meaningful when this turn's directive was 'none' — 'allowed'
        // and absent have nothing to violate. Ships either way (the measured
        // violation rate is 0 in 240 responses); lib/agent/stages.ts emits a
        // PostHog observation so a change in that rate announces itself
        // instead of being discovered in a UAT session.
        emojiDirectiveViolated:
          input.runtime.emojiDirective === 'none' &&
          containsEmoji(lastResult.body),
      },
    }
  } catch (e) {
    // Diagnostic logging for THE-159 (will be replaced by structured alerts).
    // When generateObject can't parse Sonnet's response into the schema, the
    // top-level error message ("No object generated: response did not match
    // schema") drops everything useful — raw text, cause, Zod issue paths.
    // Walk the error to surface them so the next failure is debuggable from
    // Vercel logs alone. Logs ARE in addition to the existing alert: we still
    // return the failure result below, which the orchestrator turns into an
    // AgentResult.failed and fires fireRedAlert.
    if (NoObjectGeneratedError.isInstance(e)) {
      const cause = e.cause
      const causeName = cause instanceof Error ? cause.name : null
      const causeMessage = cause instanceof Error ? cause.message : null
      const innerCause =
        cause instanceof Error
          ? (cause as Error & { cause?: unknown }).cause
          : undefined
      const issues =
        innerCause &&
        typeof innerCause === 'object' &&
        innerCause !== null &&
        'issues' in innerCause
          ? (innerCause as { issues: unknown }).issues
          : undefined
      logger.info('[agent] generation diagnostic', {
        attempts,
        text: e.text ? e.text.slice(0, 1000) : null,
        finishReason: e.finishReason,
        usage: e.usage,
        message: e.message,
        causeName,
        causeMessage,
        zodIssues: issues ?? null,
      })
      // TAC-309: surface truncation without a Vercel log dig. `finishReason:
      // 'length'` means the emission hit MAX_OUTPUT_TOKENS and was cut
      // mid-JSON — a fixable ceiling problem, not a model-behavior problem,
      // and the two are indistinguishable from the generic parse error alone.
      // It took a UAT session to find the first one. Fire-and-forget; a
      // failure to report a failure must not deepen it.
      if (e.finishReason === 'length') {
        // Awaited, not floated: on Vercel a pending fetch can be lost when the
        // function freezes, and this is the alert that makes truncation
        // visible at all. The path has already failed, so the added latency
        // costs nothing anyone is waiting on.
        await captureGenerationTruncated({
          attempts,
          maxOutputTokens: MAX_OUTPUT_TOKENS,
          promptVersion: PROMPT_VERSION,
          truncatedTextPreview: e.text ? e.text.slice(0, 500) : null,
        })
      }
    }
    const message = e instanceof Error ? e.message : String(e)
    const truncated =
      NoObjectGeneratedError.isInstance(e) && e.finishReason === 'length'
    return {
      ok: false,
      error: message,
      errorCode: truncated ? AI_ERROR_TRUNCATED : 'ai_generation_failed',
    }
  }
}
