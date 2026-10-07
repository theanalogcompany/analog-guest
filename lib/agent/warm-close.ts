// TAC-560: the timing rules behind the warm "line is open" close.
//
// Pure, split from the DB layer the way scan-arrival.ts and looks-like-question.ts
// are: every constant here decides something guest-facing, and the boundary
// should be drivable without a database.
//
// THE SHAPE OF THE FLOW, so the constants read as one rule rather than three
// numbers (ruled 2026-09-29):
//
//   A guest has their first conversation with the shop, whether they scanned
//   the counter code or simply messaged (TAC-575), and then stops replying.
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
 * How many messages a guest has to send after the warm close before the venue
 * asks them anything again.
 *
 * TWO, from the TAC-575 ruling (2026-10-06): "after a warm close, answer
 * anything they ask; our questions resume only if they send two or more further
 * messages, never in the very next reply." The Oct 6 device test is the case it
 * was written against: the close went out and the very next reply asked whether
 * the guest was new here.
 */
export const QUESTIONS_RESUME_AFTER_CLOSE_INBOUNDS = 2

/**
 * Is the guest still inside the quiet that follows a warm close?
 *
 * False for a guest who has never been closed. Otherwise true until they have
 * sent QUESTIONS_RESUME_AFTER_CLOSE_INBOUNDS messages after the marker, the
 * current one included, so the first message after a close is answered with no
 * question and the second is the earliest that may carry one.
 *
 * STRICTLY AFTER the marker. The in-conversation close claims the marker during
 * the turn that sends it, which is after that turn's own inbound arrived, so the
 * guest's goodbye is never counted as a message past the close.
 *
 * `inboundTimes` is the loaded history, which has a horizon. A message beyond it
 * is not counted, which can only keep the quiet on for longer, and never past
 * the guest's next two messages: those are always inside the horizon.
 */
export function isQuietAfterWarmClose(
  warmCloseSentAt: Date | null,
  inboundTimes: readonly Date[],
): boolean {
  if (warmCloseSentAt === null) return false
  const closedAt = warmCloseSentAt.getTime()
  if (!Number.isFinite(closedAt)) return false
  const since = inboundTimes.filter((t) => t.getTime() > closedAt).length
  return since < QUESTIONS_RESUME_AFTER_CLOSE_INBOUNDS
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
 * TAC-568. The in-conversation path's whole decision, pure, so every boundary
 * is drivable without a database or a model.
 *
 * ONE WAY TO CLOSE: THE GOODBYE. Two signals, ANDed, and the AND is the point.
 * They answer the two halves of the ruling's own sentence ("the guest signed
 * off AND the agent answered with a goodbye"), and both already existed for
 * TAC-560:
 *
 *   guestSignedOff   the inbound classified `acknowledgment`. Venue-neutral and
 *                    structural.
 *   agentSaidGoodbye the model's closedTheConversation self-report, reworded in
 *                    v1.78.0 from "this reply IS the warm close" to "this reply
 *                    says goodbye".
 *
 * Self-report is not trusted alone, on this repo's record (TAC-350: 8 of 8
 * fabrications self-reported clean), which is why it is ANDed with something
 * structural rather than read on its own.
 *
 * THERE WAS A SECOND WAY, AND TAC-575 REMOVED IT (ruled 2026-10-06: "the warm
 * close is triggered by a natural lull, not by a stored name"). TAC-568's
 * follow-on closed on the turn that stored the guest's name, because the name
 * was then the last thing a first visit gathered. With the name ask now the
 * FIRST of several questions, closing on it would end the conversation at the
 * point the ruling says it starts. It also spent the guest's one close on a
 * column write the model proposed and nothing verified (TAC-569).
 *
 * WHAT A MISS COSTS NOW. A guest who never says goodbye is closed by the pause
 * timer, which since TAC-575 covers any first Instagram conversation, scanned
 * or not. A text-message guest still has no timer, so for them a miss here is
 * permanent. The narrowing is still right: a FALSE POSITIVE is the expensive
 * direction, because it spends the guest's one close, for ever, on a turn that
 * was not closing anything.
 *
 * NO qr_scan CHECK AND NO CHANNEL CHECK. The close happens on SMS too, and the
 * marker has always meant "this guest has been closed", not "the timer ran".
 *
 * `warmCloseText` empty means the venue has no close configured, and no path
 * sends one. Checked here rather than at dispatch so the claim is never taken
 * for a message that was never going to exist.
 */
export function closesFirstConversation(input: {
  guestSignedOff: boolean
  agentSaidGoodbye: boolean
  isFirstConversation: boolean
  warmCloseText: string
}): boolean {
  if (input.warmCloseText.trim() === '') return false
  if (!input.isFirstConversation) return false
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
