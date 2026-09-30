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
 * ONE SIGNAL, the sent body. TAC-568 removed a second arm that counted the
 * intentions RENDERED into the draft's prompt, and the removal is a bug fix
 * rather than a simplification — that arm could not fire correctly in either
 * direction, for two structural reasons that only bite together:
 *
 *   `messages.rendered_intentions` is written on BUBBLE INDEX 0 ONLY
 *   (schedule-and-send.ts), deliberately, so that counting non-null rows counts
 *   RESPONSES rather than bubbles.
 *
 *   The candidate scan folds to the NEWEST row per guest, which is the LAST
 *   bubble.
 *
 * So on any multi-bubble response — the only shape that ever carries a raised
 * getting-to-know-you question, since TAC-554 guarantees the question its own
 * final bubble — the count read here was always 0 and the arm never fired on
 * the case it was written for. The only shape where it COULD fire was a
 * single-bubble response, where index 0 is also the last row, and there a
 * non-zero count means intentions RENDERED INTO THE PROMPT while the model
 * raised nothing. That is the doubled-pause bug: twenty minutes of silence
 * deferring to a question that was never asked.
 *
 * WHAT COVERS THE REAL CASE IS THE BODY, and it does so by construction. A
 * raised question IS the last bubble (docs/decisions/0007), and the candidate's
 * body IS the last bubble, so "the sent body asks one" and "intentionQuestion
 * was non-empty" are the same test at this call site. Our outbound copy always
 * carries a question mark (Le Mil's rule 25: "Never drop a question mark"), so
 * looksLikeQuestion's recall on this population is near-total.
 *
 * THE RISK DIRECTION IS THE OPPOSITE OF TAC-484'S, and that is worth saying
 * plainly because it is the same predicate being reused. There, on a guest's
 * inbound, a false positive invented an outstanding question, so
 * looksLikeQuestion is deliberately precision-biased. Here a MISS is the
 * expensive direction: it closes over our own unanswered question. The cost of
 * a false positive is ten extra minutes of silence, which is why the surviving
 * arm is the permissive one.
 *
 * KNOWN LIMIT, stated rather than discovered: a question asked in a NON-FINAL
 * bubble is not seen, because this reads the last bubble alone. That is not a
 * regression — the removed arm read 0 on exactly those responses too — and
 * folding the whole response by `generation_id` is the fix if it ever matters.
 * Ruled out of scope 2026-09-30; the body arm covers the real case.
 */
export function weAskedAQuestion(lastOutboundBody: string): boolean {
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

/**
 * Is THIS reply the one that closes the guest's first conversation?
 *
 * TAC-568. Both in-conversation paths' whole decision, pure, so every boundary
 * is drivable without a database or a model.
 *
 * TWO WAYS TO CLOSE, ORed at the top level, each gated by the same two
 * preconditions. A first conversation ends either because the guest said
 * goodbye, or because we just learned their name — and after the TAC-568
 * follow-on the second is the ordinary case, not the exception.
 *
 * WAY ONE: THE GOODBYE. TWO SIGNALS, ANDed, and the AND is the point. They
 * answer the two halves of the ruling's own sentence ("the guest signed off AND
 * the agent answered with a goodbye"), and both already existed for TAC-560:
 *
 *   guestSignedOff   the inbound classified `acknowledgment`. This is the timer's
 *                    own belt (loadLastInboundCategory), read off the current
 *                    turn instead of a query. Venue-neutral and structural.
 *   agentSaidGoodbye the model's closedTheConversation self-report, reworded in
 *                    v1.78.0 from "this reply IS the warm close" to "this reply
 *                    says goodbye" — the old meaning dies with Le Mil's rule 15.
 *
 * WAY TWO: THE NAME (TAC-568 follow-on, ruled 2026-09-30). Learning the guest's
 * name IS the closing moment of a first conversation. The device test that
 * prompted this ruling never reached a goodbye at all: the visit stalled on "jp,
 * nice to meet you" because the one remaining question was optional and the
 * model declined to raise it. So the close now rides on something that either
 * happened or did not.
 *
 * `nameJustStored` IS A DATABASE WRITE, NOT A MODEL SELF-REPORT, and that is the
 * whole reason this arm needs no partner signal where the goodbye arm needs two.
 * The caller builds it from updateGuestContext's own `identityColumnsChanged`
 * — the `first_name` column actually written on this turn — ANDed with the guest
 * having had no name before it. "Way one" trusts the model twice and so is
 * ANDed with something structural (TAC-350: 8 of 8 fabrications self-reported
 * clean); this one never asks the model anything.
 *
 * Requiring "no name before" is what makes it LEARNING a name rather than
 * re-asserting one, and it matches learn_name's own isSatisfied (`hasFirstName`)
 * so the close fires on the turn the intention actually closes.
 *
 * THE RISK DIRECTION IS THE OPPOSITE OF weAskedAQuestion'S, which is why this
 * narrows where that one widens. A FALSE POSITIVE is the expensive direction
 * here: it spends the guest's one close, for ever, on a turn that was not
 * closing anything. A false negative costs nothing at all, because the pause
 * timer is still running and sends the same text ten minutes later. So the
 * cheap mistake is missing, and every condition above buys that.
 *
 * Self-report is not trusted alone, on this repo's record (TAC-350: 8 of 8
 * fabrications self-reported clean) — which is the second reason it is ANDed
 * with something structural rather than read on its own.
 *
 * NO qr_scan CHECK AND NO CHANNEL CHECK, unlike the timer. Ruling 5: the pause
 * path stays scan-only, the in-conversation paths are any first conversation.
 * The close happens on SMS too, and the marker has always meant "this guest has
 * been closed", not "the timer ran".
 *
 * `warmCloseText` empty means the venue has no close configured, and no path
 * sends one. Checked here rather than at dispatch so the claim is never taken
 * for a message that was never going to exist.
 */
export function closesFirstConversation(input: {
  guestSignedOff: boolean
  agentSaidGoodbye: boolean
  /**
   * This turn wrote `guests.first_name` for a guest who had none. Built from
   * updateGuestContext's identityColumnsChanged, never from the model's
   * proposed contextUpdate — see the note above.
   */
  nameJustStored: boolean
  isFirstConversation: boolean
  warmCloseText: string
}): boolean {
  if (input.warmCloseText.trim() === '') return false
  if (!input.isFirstConversation) return false
  if (input.nameJustStored) return true
  return input.guestSignedOff && input.agentSaidGoodbye
}

/**
 * The inbound category that means the guest signed off.
 *
 * Named rather than spelled at both call sites: the timer compares
 * loadLastInboundCategory against it and the goodbye path compares
 * ctx.classification.category against it, and two string literals is how those
 * two drift into two different ideas of "signed off".
 */
export const SIGN_OFF_CATEGORY = 'acknowledgment'
