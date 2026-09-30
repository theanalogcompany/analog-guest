// TAC-560: the timing rules behind the warm "line is open" close.
//
// Pure, split from the DB layer the way scan-arrival.ts and looks-like-question.ts
// are: every constant here decides something guest-facing, and a test should be
// able to drive the boundary without a database.
//
// THE SHAPE OF THE FLOW, so the constants read as one rule rather than three
// numbers (ruled 2026-09-29):
//
//   A guest scans the counter code, has their first conversation with the shop,
//   and then stops replying.
//
//   Ten minutes of silence after OUR last message sends the warm close: the
//   line is open, and here is what you can message us about anytime. Once per
//   guest, ever.
//
//   If our last message asked them something, they get one more interval before
//   we close over our own question.
//
//   Past two hours it is not sent at all.
//
// WHY A TIMER AT ALL. Le Mil's persona rule 15 already closes a first
// conversation warmly, but its trigger is "they say thanks, ok, or signal
// they're done" — it needs the guest to send something. A guest who simply
// stops replying never trips it, and the agent only speaks when a message
// arrives. The whole point of this module is the case where nothing arrives.
//
// WHAT THIS MODULE DELIBERATELY DOES NOT DECIDE:
//
//   Meta's 24-hour reply window. dispatch-instagram-reply.ts re-derives it
//   immediately before every Instagram send, and a second copy here would be a
//   second definition of the same deadline. Two hours is well inside it anyway.
//
//   Quiet hours. isQuietHour in followup-rules.ts is the one definition and the
//   processor calls it directly.

import { looksLikeQuestion } from './looks-like-question'

/**
 * How long the guest has to be silent, after our last message reached them,
 * before the venue closes the conversation.
 *
 * TEN MINUTES by default, from the ruling, and a venue setting:
 * `followup_rules.warm_close_pause_minutes`. This constant is the fallback the
 * schema's own default mirrors, not a second source of truth.
 */
export const WARM_CLOSE_PAUSE_MINUTES_DEFAULT = 10

/**
 * How late the close may still fire.
 *
 * TWO HOURS, from the ruling of 2026-09-29, which REPLACED an earlier plan to
 * defer a blocked close until the venue reopened. That version could have
 * delivered the close roughly sixteen hours after the conversation, which reads
 * oddly however warm the wording. Past two hours the moment has gone and the
 * close is simply skipped.
 *
 * Same reasoning as TAC-536's SCAN_GREETING_MAX_AGE_MS and TAC-428's rule that
 * an arrival push never fires after the arrival it announces: a catch-up that
 * asserts the present tense is worse than no catch-up.
 */
export const WARM_CLOSE_MAX_AGE_MS = 2 * 60 * 60 * 1000

/**
 * How much longer the guest gets when our own last message asked them something.
 *
 * "Defer once, then skip", from the ruling. The deferral is this multiplier on
 * the floor; the skip is WARM_CLOSE_MAX_AGE_MS above. Together they need NO
 * stored state, which is what lets the due set stay derived from `messages`
 * rather than needing a scheduling table: a tick that never ran cannot
 * double-defer, because the floor is recomputed from the same two timestamps
 * every time.
 */
export const WARM_CLOSE_QUESTION_FLOOR_MULTIPLIER = 2

/**
 * The floor this guest's close has to clear, in ms.
 *
 * Doubles when our own last message asked them something: closing warmly on top
 * of a question we just asked reads as abandoning it.
 */
export function warmCloseFloorMs(
  pauseMs: number,
  weAskedAQuestion: boolean,
): number {
  return weAskedAQuestion
    ? pauseMs * WARM_CLOSE_QUESTION_FLOOR_MULTIPLIER
    : pauseMs
}

/**
 * Has the floor elapsed since our last message reached the guest?
 *
 * `>=` rather than `>`, for the reason isScanGreetingDue gives: the pause is a
 * floor the guest has had, not a deadline to beat, and a tick landing on the
 * exact millisecond should fire rather than wait another minute.
 */
export function isWarmCloseDue(
  lastOutboundAt: Date,
  now: Date,
  floorMs: number,
): boolean {
  return now.getTime() - lastOutboundAt.getTime() >= floorMs
}

/**
 * Is the close too late to send?
 *
 * `>` rather than `>=`: exactly at the bound is still inside it, so this and
 * isWarmCloseDue cannot both refuse the same instant.
 */
export function isWarmCloseTooLate(
  lastOutboundAt: Date,
  now: Date,
  maxAgeMs: number = WARM_CLOSE_MAX_AGE_MS,
): boolean {
  return now.getTime() - lastOutboundAt.getTime() > maxAgeMs
}

/**
 * Did our own last message ask the guest something?
 *
 * TWO SIGNALS, ORed, and the OR is the point. Either alone leaves a real gap:
 *
 *   looksLikeQuestion  catches the ordinary case. Our outbound copy always
 *                      carries a question mark (Le Mil's rule 25: "Never drop a
 *                      question mark"), so on this population its recall is
 *                      near-total.
 *   renderedIntentions catches TAC-554's getting-to-know-you question, which is
 *                      GUARANTEED to be the last message of the response when
 *                      anything rendered. A column, not a judgement about text.
 *
 * THE RISK DIRECTION IS THE OPPOSITE OF TAC-484'S, and that is worth saying
 * plainly because it is the same function being reused. There, on a guest's
 * inbound, a false positive invented an outstanding question, so
 * looksLikeQuestion is deliberately precision-biased. Here a MISS is the
 * expensive direction: it closes over our own unanswered question. So this
 * wrapper widens rather than narrows, and the cost of a false positive is ten
 * extra minutes of silence.
 */
export function weAskedAQuestion(
  lastOutboundBody: string,
  renderedIntentionCount: number,
): boolean {
  if (renderedIntentionCount > 0) return true
  return looksLikeQuestion(lastOutboundBody)
}

/**
 * Is the guest still inside their FIRST conversation with the venue?
 *
 * Measured from `guests.first_contacted_at` against TAC-380 ruling 1's one
 * definition of "the same conversation" (`followup_rules.recent_conversation_hours`,
 * 48h by default), the same number the intention brake and TAC-547's contextual
 * retrieval read.
 *
 * DELIBERATELY CONSERVATIVE, and the direction is chosen. A guest whose genuine
 * first conversation spans more than the window does not get the close, where
 * the alternative (walking their whole inbound history looking for a gap) would
 * risk sending it on a SECOND conversation, which rule 15 forbids outright
 * ("never on later conversations"). Under-firing is a missed nicety;
 * over-firing contradicts the venue's own voice rule.
 *
 * Note this is not the only thing keeping the close to one conversation: the
 * once-per-guest-ever marker does that on its own for any guest who has already
 * had one. This predicate covers the guest whose first conversation produced no
 * close at all (quiet hours, say) and who comes back a week later.
 */
export function isFirstConversation(
  firstContactedAt: Date,
  now: Date,
  conversationWindowMs: number,
): boolean {
  const elapsed = now.getTime() - firstContactedAt.getTime()
  if (!Number.isFinite(elapsed)) return false
  return elapsed >= 0 && elapsed <= conversationWindowMs
}

/**
 * The rng handed to dispatch so the close is always ONE message.
 *
 * resolveDispatchBubbles splits a 2-to-3-sentence body when `rng() < 0.5`, so a
 * close naming three topics would arrive as two bubbles about half the time.
 * "One short message" is in rule 15 and in this ticket's acceptance criteria, so
 * the coin is removed rather than tuned: 1 is never less than 0.5.
 *
 * Uses the rng parameter TAC-319 already built for exactly this kind of caller
 * rather than adding a flag to the pure splitter.
 */
export const NEVER_SPLIT_RNG = (): number => 1
