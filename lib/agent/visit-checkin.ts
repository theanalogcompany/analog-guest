// TAC-575: the rules behind the same-visit "how is it so far?" check-in.
//
// Pure, split from visit-checkin-store.ts the way warm-close.ts and
// scan-arrival.ts are split from their stores: every constant here decides
// something a guest reads, and the boundary should be drivable without a
// database.
//
// THE SHAPE OF THE FLOW (ruled 2026-10-06):
//
//   A guest scans at the counter and is asked what they got.
//   They name it. The reply receives the order and asks how it is so far.
//   (If their own message already says how it is, that is recorded and the
//   question is not asked.)
//   What they say back is read as good, bad or not yet, and a row in
//   `visit_checkins` (migration 073) carries that for the rest of the visit:
//   the sign-off, the check-back and the next-visit follow-up all read it.
//
//   If they have not said it is good or bad (they had not tried it, or did
//   not reply), we check back ONCE: about ten minutes after the order if they
//   have gone quiet, or worked into a reply once about five minutes have
//   passed if they are still chatting. If they do not answer the check-back,
//   nothing more is sent.
//
// WHAT THIS MODULE DOES NOT DECIDE: what the sign-off says. That belongs to a
// later part of the ticket and reads the row this one writes.

/** What a guest said when asked how their order is. */
export type VisitCheckinAnswer = 'good' | 'bad' | 'not_yet'

/** One guest's check-in for one venue-local day, as stored. */
export interface VisitCheckin {
  id: string
  venueLocalDate: string
  orderedAt: Date
  askedAt: Date
  answer: VisitCheckinAnswer | null
  answeredAt: Date | null
  /** The check-back's claim, taken before it is sent. Null until then. */
  checkbackClaimedAt: Date | null
  /** Set once the check-back has reached the guest. */
  checkbackSentAt: Date | null
}

/**
 * How long after a counter scan a guest created by that scan is still treated
 * as standing at the counter, on a channel with no scan row to read.
 *
 * Instagram needs no constant of its own here: `scanCarryForwardAt`
 * (scan-arrival.ts) already answers "is this message part of a scan visit"
 * from the scan and the greeting. A text-message guest's scan is recorded only
 * as `created_via = 'qr_scan'` on the guest, so the nearest equivalent is how
 * recently that guest was created. Thirty minutes, to match
 * SCAN_GREETING_CARRY_FORWARD_MS: one idea of how long a counter visit lasts.
 */
export const COUNTER_ARRIVAL_WINDOW_MS = 30 * 60 * 1000

/**
 * How long after we asked a reply is still read as an answer to it.
 *
 * Two hours, the bound the warm close uses for "the moment has gone"
 * (WARM_CLOSE_MAX_AGE_MS). A message the next morning is about something else,
 * and reading it as "not yet" would be recording an answer nobody gave.
 */
export const CHECKIN_ANSWER_WINDOW_MS = 2 * 60 * 60 * 1000

/**
 * When did this guest name the order they got on THIS visit, as far as this
 * turn can tell? Null when the turn is not that moment.
 *
 * ALL OF:
 *   the guest is answering us. Our last message to reach them asked something,
 *     which on a counter visit is "what did you get?" from the greeting or the
 *     opener. This is the same trigger R21's compliment exception names ("the
 *     guest is answering your own question about what they just got"), and it
 *     is what separates an order from a menu word. A live scan alone does not:
 *     the scan carries forward for up to half an hour, and "do you still have
 *     the iced sofi?" inside it names a menu item and reports nothing;
 *   a counter visit is live for this turn. On Instagram that is a scan on this
 *     message or one carried forward (`scanAt`); on a text thread it is a
 *     guest the counter sign created inside COUNTER_ARRIVAL_WINDOW_MS;
 *   this message names something on the menu. Arming is decided while the
 *     context is built, before the order extractor has run, so the menu-name
 *     prefilter stands in for it here and over-matches on purpose; the armed
 *     turn then waits for the extractor itself (orderTurnVerdict);
 *   we have not already asked on this visit.
 *
 * `alreadyAskedThisVisit` MUST BE TRUE WHEN THE CHECK-IN COULD NOT BE READ.
 * The intention this arms re-arms on a newer event, so without that a guest
 * who names a second item five minutes later would be asked how it is twice.
 * An unreadable table has not shown that we have not asked.
 *
 * The anchor is the message's own arrival time, not `now`, for the reason
 * build-runtime-context gives for the scan anchor: it belongs to the turn.
 */
export function resolveSameVisitOrderAt(input: {
  scanAt: Date | null
  guestCreatedVia: string
  guestCreatedAt: Date
  inboundAt: Date
  mentionsMenuItem: boolean
  /** Our last message to reach the guest asked them something. */
  answeringOurQuestion: boolean
  alreadyAskedThisVisit: boolean
}): Date | null {
  if (!input.mentionsMenuItem) return null
  if (!input.answeringOurQuestion) return null
  if (input.alreadyAskedThisVisit) return null
  if (input.scanAt !== null) return input.inboundAt
  const sinceCreated =
    input.inboundAt.getTime() - input.guestCreatedAt.getTime()
  const atTheCounter =
    input.guestCreatedVia === 'qr_scan' &&
    Number.isFinite(sinceCreated) &&
    sinceCreated >= 0 &&
    sinceCreated <= COUNTER_ARRIVAL_WINDOW_MS
  return atTheCounter ? input.inboundAt : null
}

/** What to do with a message that named the order, once it is classified. */
export type OrderTurnVerdict =
  /** Ask how it is. */
  | 'ask'
  /** They already said it is good. Record that; asking would be asking twice. */
  | 'good'
  /** They are already complaining about it. Record that; the complaint path runs. */
  | 'bad'
  /** Not an order report after all. Ask nothing, record nothing. */
  | 'skip'

/**
 * How long an armed turn waits for the order extractor before giving up on
 * asking this turn.
 *
 * NOT IN THE RULING, and stated as a choice. The ruling makes the armed turn
 * wait for the extractor; it does not say for how long, and the reply is what
 * is waiting. Six seconds is several times the read's measured p95 (the PR
 * body has the figures), so it only ever cuts off a call that has hung. On a
 * timeout nothing is asked and the extractor carries on in the background, so
 * the order is still recorded: one unasked question, never a held reply.
 */
export const ORDER_READ_WAIT_MS = 6000

/**
 * The turn that armed the question has now been read: should it ask?
 *
 * WHAT DECIDES IT IS THE ORDER EXTRACTOR, NOT THE CLASSIFIER (ruled
 * 2026-10-07). `orderRecorded` is "the extractor recorded an order for the
 * visit this message arrived on" (recordedOrderForThisVisit,
 * extract-reported-order.ts), and the armed turn waits for it.
 *
 * It used to be the classifier's category, against an allow-list of
 * `casual_chatter` and `acknowledgment`. The 2026-10-07 phone test: we asked
 * "what did you get just now?", the guest answered "pink panther", the
 * classifier said `reply`, and nothing was asked. Adding `reply` was measured
 * and still missed: Jev read 3 of 22 bare item names as `new_question`, and
 * which three moved between runs. A category cannot tell an order from a
 * question about the menu; the extractor is built to.
 *
 * The classifier still says two things the extractor does not:
 *
 *   it is a complaint            the order is already going badly. `bad`,
 *                                whatever the extractor made of it.
 *   it already praises the item  "iced sofi, so good" answers the question
 *                                before it is asked. `good`, and no ask.
 *
 * Complaint first, for classifyCheckinAnswer's reason: a burst that praises
 * and complains classifies as a complaint.
 */
export function orderTurnVerdict(input: {
  category: string
  praisedExperience: boolean
  /** recordedOrderForThisVisit for this turn. False when the wait timed out. */
  orderRecorded: boolean
}): OrderTurnVerdict {
  if (input.category === 'comp_complaint') return 'bad'
  if (!input.orderRecorded) return 'skip'
  return input.praisedExperience ? 'good' : 'ask'
}

/**
 * Is a reply arriving now still an answer to this check-in?
 *
 * `>` on the far bound, so exactly at two hours is still inside it.
 */
export function isAwaitingCheckinAnswer(
  checkin: VisitCheckin,
  inboundAt: Date,
): boolean {
  const sinceAsked = inboundAt.getTime() - checkin.askedAt.getTime()
  if (!Number.isFinite(sinceAsked) || sinceAsked < 0) return false
  return sinceAsked <= CHECKIN_ANSWER_WINDOW_MS
}

/**
 * Is this check-in still about the visit that is happening?
 *
 * The check-in row is keyed on the venue-local DAY, but a visit is not a day.
 * A guest who said "so good" at nine and asks what time the shop closes at
 * four is on a different errand, and a sign-off telling them we are glad they
 * are enjoying it, with a review link, would be about a drink from seven hours
 * ago. Ruled 2026-10-06: the link is offered at the sign-off of the SAME visit.
 *
 * So "the same visit" is the answer window again: within
 * CHECKIN_ANSWER_WINDOW_MS of the latest thing that happened on the row, the
 * question or the answer. One number for "this visit is still going".
 */
export function isCheckinFresh(checkin: VisitCheckin, at: Date): boolean {
  const latest = Math.max(
    checkin.askedAt.getTime(),
    checkin.answeredAt?.getTime() ?? 0,
  )
  const since = at.getTime() - latest
  return (
    Number.isFinite(since) && since >= 0 && since <= CHECKIN_ANSWER_WINDOW_MS
  )
}

/**
 * Read one reply as an answer.
 *
 * NO NEW MODEL CALL AND NO CLASSIFIER CHANGE. Both signals already exist on
 * every turn, from both classifier arms:
 *
 *   bad      the turn classified `comp_complaint`. Checked FIRST: a burst that
 *            praises one thing and complains about another classifies as a
 *            complaint, and that is the reading this must agree with.
 *   good     the classifier's `praisedExperience`, the flag the review ask
 *            already rides on.
 *   not yet  everything else.
 *
 * "NOT YET" IS THE DEFAULT, NOT A DETECTION, and that is the honest name for
 * it. "haven't tried it" lands here, and so does "it's fine" when the
 * classifier does not read that as praise, and so does a question about wifi.
 * The cost is one check-back to a guest who had half-answered, which is why it
 * is the default rather than `good`: reading a lukewarm reply as happy would
 * send a review ask to someone who never said they liked it.
 */
export function classifyCheckinAnswer(input: {
  category: string
  praisedExperience: boolean
}): VisitCheckinAnswer {
  if (input.category === 'comp_complaint') return 'bad'
  if (input.praisedExperience) return 'good'
  return 'not_yet'
}

/**
 * Given what is on the row and what this reply read as, what should be
 * written? Null means leave the row alone.
 *
 *   nothing yet -> anything
 *   not yet     -> good or bad
 *   good        -> bad
 *   bad         -> nothing, ever
 *
 * BAD IS FINAL AND GOOD IS NOT. A guest who said it was great and then says it
 * arrived cold must not get a review ask at the sign-off, so a complaint
 * overrides praise. The reverse is refused: "all sorted, thanks" after a
 * complaint is the fix landing, and the ruling routes that guest to the
 * follow-up on their next visit, not back onto the happy path.
 */
export function nextCheckinAnswer(
  current: VisitCheckinAnswer | null,
  incoming: VisitCheckinAnswer,
): VisitCheckinAnswer | null {
  if (current === incoming) return null
  if (current === 'bad') return null
  if (current === 'good') return incoming === 'bad' ? 'bad' : null
  return incoming
}

// ---------------------------------------------------------------------------
// The check-back
// ---------------------------------------------------------------------------

/**
 * How long after the ORDER a quiet guest is checked back on.
 *
 * Ten minutes, from the ruling ("check back once about ten minutes after the
 * order"). Measured from the order, not from our question, because the thing
 * being waited on is the guest getting to their drink.
 */
export const CHECKBACK_DELAY_MS = 10 * 60 * 1000

/**
 * How long after the order the check-back may be worked into a reply to a
 * guest who is still chatting. Five minutes, from the ruling.
 */
export const CHECKBACK_IN_CONVERSATION_DELAY_MS = 5 * 60 * 1000

/**
 * How long our own last message has to have sat unanswered before the TIMED
 * check-back goes out.
 *
 * NOT IN THE RULING, and stated as a choice. "Ten minutes after the order" on
 * its own would send the check-back thirty seconds after a reply of ours to a
 * guest who was chatting until minute nine and a half, which reads as two
 * messages in a row about different things. Two minutes is long enough that
 * the guest has had the chance to answer what we last said, and short enough
 * that the check-back still lands near the ten-minute mark.
 */
export const CHECKBACK_QUIET_FLOOR_MS = 2 * 60 * 1000

/**
 * How late the timed check-back may still fire, measured from the order.
 *
 * Thirty minutes, ALSO A CHOICE the ruling does not make. Past it the drink is
 * finished and "how's it treating you?" asserts a present tense that has gone,
 * which is the reasoning behind SCAN_GREETING_MAX_AGE_MS and
 * WARM_CLOSE_MAX_AGE_MS: a catch-up that asserts the present is worse than no
 * catch-up. It bounds how long a blocked check-back (quiet hours, a card
 * waiting on an operator) keeps being retried.
 */
export const CHECKBACK_MAX_AGE_MS = 30 * 60 * 1000

/**
 * Is this visit still owed its one check-back?
 *
 * Owed while the guest has not said it is good or bad, and nobody has claimed
 * the check-back. The claim is what makes it "once": the timer takes it before
 * sending, and a reply that works the check-back in takes it after.
 */
export function owesCheckback(checkin: VisitCheckin): boolean {
  return (
    checkin.checkbackClaimedAt === null &&
    (checkin.answer === null || checkin.answer === 'not_yet')
  )
}

/** Is the timed check-back too late to send? `>`, so the bound itself is inside. */
export function isCheckbackTooLate(orderedAt: Date, now: Date): boolean {
  return now.getTime() - orderedAt.getTime() > CHECKBACK_MAX_AGE_MS
}

/** Has our last message sat long enough for the timed check-back to follow it? */
export function hasBeenQuietLongEnough(
  lastOutboundAt: Date,
  now: Date,
): boolean {
  return now.getTime() - lastOutboundAt.getTime() >= CHECKBACK_QUIET_FLOOR_MS
}

/**
 * On an inbound turn: should this reply work the check-back in, and from when
 * was it askable? Null when not.
 *
 * The guest is still chatting, so the timer will not fire for them (it needs
 * our message to be the newest). Once five minutes have passed the reply
 * carries the question instead. Bounded by the answer window, so a guest who
 * writes again the next morning is not asked how yesterday's drink is treating
 * them.
 *
 * FIVE MINUTES FROM THE LATER OF TWO THINGS: the order, and the guest telling
 * us they had not got to it yet. Measured from the order alone, "haven't tried
 * it yet, too hot" six minutes in would be answered with "and how is it?" in
 * the same breath, which is asking the question they have just declined. Their
 * "not yet" restarts the wait. (The turn that GIVES that answer is handled by
 * the caller, which knows what this message read as; this function only sees
 * the row as it stood before the turn.)
 *
 * The returned instant is the intention's anchor, and it is STABLE across the
 * visit: `answeredAt` is written once, when the answer first becomes "not
 * yet", and a later "still not yet" does not move it (nextCheckinAnswer
 * returns null for a repeat). An anchor that moved would look like a newer
 * event on every turn.
 */
export function resolveCheckbackDueAt(
  checkin: VisitCheckin | null,
  inboundAt: Date,
): Date | null {
  if (checkin === null || !owesCheckback(checkin)) return null
  const waitFrom = Math.max(
    checkin.orderedAt.getTime(),
    checkin.answer === 'not_yet' && checkin.answeredAt !== null
      ? checkin.answeredAt.getTime()
      : 0,
  )
  const dueAt = new Date(waitFrom + CHECKBACK_IN_CONVERSATION_DELAY_MS)
  if (inboundAt.getTime() < dueAt.getTime()) return null
  if (!isAwaitingCheckinAnswer(checkin, inboundAt)) return null
  return dueAt
}

/**
 * Was the last unprompted message to this guest part of THIS visit?
 *
 * Ruled 2026-10-06: the greeting, the check-back and the sign-off within one
 * visit are not spaced against each other; the one-hour rule still applies
 * against everything else. A visit starts no earlier than the scan, and a scan
 * precedes the order it leads to by at most the counter window, so an
 * unprompted send at or after `orderedAt - COUNTER_ARRIVAL_WINDOW_MS` is this
 * visit's own greeting (or its check-back). Anything older is some other
 * mechanism's message and the hour rule stands.
 *
 * False when there was no such send, which leaves the caller's ordinary
 * spacing check to say "not too soon" on its own.
 */
export function lastProactiveWasThisVisit(
  lastProactiveSendAt: Date | null,
  orderedAt: Date,
): boolean {
  if (lastProactiveSendAt === null) return false
  return (
    lastProactiveSendAt.getTime() >=
    orderedAt.getTime() - COUNTER_ARRIVAL_WINDOW_MS
  )
}

/**
 * Did the check-back go out and get no answer?
 *
 * Ruled 2026-10-06: "no reply to the check-back: send nothing more". The warm
 * close reads this and stands down, for the rest of the visit.
 *
 * READ FROM THE GUEST'S SIDE: nothing of theirs has arrived since it went out.
 * An earlier version compared our own newest message's time against the sent
 * stamp, and could never be true, because the stamp was the tick's clock from
 * BEFORE generation and the message row is written after the send. A
 * comparison between two of our own timestamps depends on which was written
 * first; "has the guest written since" does not.
 *
 * Falls back to the CLAIM when there is no sent stamp. A check-back that was
 * held for an operator keeps its claim and never gets the stamp, and if it was
 * approved it reached the guest all the same. If it was skipped instead, this
 * reads a check-back that never went as unanswered and the visit gets no close
 * either, which is the cheap direction: a missing close, not a message nobody
 * should have had.
 */
export function checkbackWentUnanswered(
  checkin: VisitCheckin,
  lastInboundAt: Date | null,
): boolean {
  const wentOutAt = checkin.checkbackSentAt ?? checkin.checkbackClaimedAt
  if (wentOutAt === null) return false
  return (
    lastInboundAt === null || lastInboundAt.getTime() <= wentOutAt.getTime()
  )
}

// ---------------------------------------------------------------------------
// The follow-up on the next visit after a complaint
// ---------------------------------------------------------------------------
//
// Ruled 2026-10-06: a guest who said their order was bad goes down the
// complaint path that day, and "on the guest's next detected visit, the agent
// follows up, then offers the review link". A detected visit is a counter scan.
//
// THE ONE COLUMN THIS USES is `followup_claimed_at` on the `bad` row (migration
// 073). Null means the follow-up is still owed. It is claimed when the visit
// that follows it up begins, and from then on it is what says "this guest's
// complaint has been followed up", which is the fact the review link waits on.

/** A `bad` check-in, reduced to what the follow-up reads. */
export interface ComplaintCheckin {
  venueLocalDate: string
  orderedAt: Date
  followupClaimedAt: Date | null
}

/**
 * How old a complaint can be and still be referred to when the guest comes
 * back. Thirty days (ruled 2026-10-06). Past it the guest is greeted as any
 * returning guest; the follow-up is still claimed and the link is still
 * offered at that visit's sign-off, because the review ruling is about every
 * guest who answered, not about recent ones.
 */
export const COMPLAINT_FOLLOWUP_MENTION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000

export interface OwedComplaintFollowup {
  /** False when the complaint is too old to bring up. */
  mention: boolean
}

/**
 * Is this guest owed a follow-up on the visit happening now?
 *
 * Owed when a `bad` check-in from an EARLIER venue-local day has no follow-up
 * claimed. Today's own `bad` row is never owed today: that is the complaint
 * itself, still on the complaint path.
 *
 * `mention` is read off the NEWEST owed complaint. An older one behind it is
 * claimed in the same statement (claimComplaintFollowup), so it cannot come
 * back as a second follow-up on a later visit.
 */
export function owedComplaintFollowup(
  complaints: readonly ComplaintCheckin[],
  todayLocalDate: string,
  now: Date,
): OwedComplaintFollowup | null {
  let newest: ComplaintCheckin | null = null
  for (const complaint of complaints) {
    if (complaint.followupClaimedAt !== null) continue
    if (complaint.venueLocalDate >= todayLocalDate) continue
    if (newest === null || complaint.orderedAt > newest.orderedAt) {
      newest = complaint
    }
  }
  if (newest === null) return null
  return {
    mention:
      now.getTime() - newest.orderedAt.getTime() <=
      COMPLAINT_FOLLOWUP_MENTION_MAX_AGE_MS,
  }
}

/**
 * Where "this visit" starts for a follow-up claimed at `followedUpAt`. The
 * claim is taken as the greeting goes out, or just after the reply to the
 * guest's own first message, so a message of theirs shortly BEFORE the claim
 * is part of the visit. The counter-arrival window is the existing number for
 * "shortly before" (COUNTER_ARRIVAL_WINDOW_MS).
 */
export function visitStartFor(followedUpAt: Date): Date {
  return new Date(followedUpAt.getTime() - COUNTER_ARRIVAL_WINDOW_MS)
}

/**
 * The part of a thread that belongs to the visit starting now.
 *
 * Used for ONE KIND of generation: a scan greeting (lib/agent/stages.ts,
 * buildAiRuntime). A greeting is written without the earlier conversation,
 * because with it the model answers an old complaint again; guest-arrived.ts
 * has the measurements. What the guest wrote in the
 * minutes before scanning stays: it is this visit.
 *
 * Generic over the message type so it reads nothing but the time.
 */
export function messagesFromThisVisit<T extends { createdAt: Date }>(
  messages: readonly T[],
  visitBeganAt: Date,
): T[] {
  const since = visitStartFor(visitBeganAt).getTime()
  return messages.filter((m) => m.createdAt.getTime() >= since)
}

// ---------------------------------------------------------------------------
// The sign-off (TAC-578, rule 3 as re-ruled 2026-10-07)
// ---------------------------------------------------------------------------
//
// "When the guest answers 'how is it?' (good, or not yet and then good), the
// reply to that answer IS the sign-off: one light line tied to the visit. The
// timed sign-off only remains for a visit where the check-in went unanswered
// and the guest has chatted since (otherwise nothing)."

/**
 * The one getting-to-know-you question a sign-off reply may carry, and only
 * on a first visit (ruled 2026-10-07: "may ask the name and nothing else").
 */
export const SIGN_OFF_REPLY_QUESTION = 'learn_name'

/**
 * Which of this turn's open questions may ride the reply that signs a visit
 * off. On a first visit, the name ask if it is open; on any later visit,
 * nothing. It only ever NARROWS what pacing and the first-conversation rules
 * already allowed, so a name ask those hold back stays held back.
 */
export function signOffReplyQuestions<T extends { key: string }>(
  open: readonly T[],
  firstVisit: boolean,
): T[] {
  return firstVisit ? open.filter((o) => o.key === SIGN_OFF_REPLY_QUESTION) : []
}

/**
 * The categories a sign-off reply may be. AN ALLOW-LIST, and the direction is
 * chosen: the block tells the model to answer the praise in one line and ask
 * nothing, which is wrong for a message that also asks for something ("so
 * good! what's the wifi?" classifies as a question) and must never sit over
 * an opt-out confirmation ("loved it, please stop messaging me"). A category
 * missing from this list costs one ordinary reply where a sign-off would have
 * done; the other direction costs an unanswered question or a compliance
 * turn told to be light. Found in review.
 */
const SIGN_OFF_REPLY_CATEGORIES: ReadonlySet<string> = new Set([
  'reply',
  'casual_chatter',
  'acknowledgment',
])

/**
 * Is the reply to THIS message the visit's sign-off?
 *
 * Two ways in, and the second is not redundant:
 *
 *   this message changed the row to `good`   the ordinary case.
 *   the row already says `good`, and         a burst. "so good" arrives, the
 *   nothing of ours has reached the guest    answer is written, and a second
 *   since they said it                       message lands while the reply is
 *                                            being written. The turn is run
 *                                            again from a fresh context, finds
 *                                            the row already `good`, and
 *                                            without this would send an
 *                                            ordinary reply while the timer
 *                                            stood down for a sign-off that
 *                                            never went (found in review).
 *                                            The same holds for a retried
 *                                            turn, and for a reply that was
 *                                            held on a card.
 *
 * "Nothing of ours since" is read off delivered outbound rows, so a sign-off
 * that DID go out ends it: the next "thanks!" is an ordinary turn.
 */
export function replySignsOffVisit(input: {
  category: string
  /** What this message changed the row to, or null when it changed nothing. */
  answerThisTurn: VisitCheckinAnswer | null
  /** The row as loaded for this turn. */
  rowAnswer: VisitCheckinAnswer | null
  rowAnsweredAt: Date | null
  /** Our newest message that reached the guest, or null. */
  lastDeliveredOutboundAt: Date | null
}): boolean {
  if (!SIGN_OFF_REPLY_CATEGORIES.has(input.category)) return false
  if (input.answerThisTurn === 'good') return true
  if (input.answerThisTurn !== null) return false
  if (input.rowAnswer !== 'good' || input.rowAnsweredAt === null) return false
  return (
    input.lastDeliveredOutboundAt === null ||
    input.lastDeliveredOutboundAt.getTime() < input.rowAnsweredAt.getTime()
  )
}

/** What the pause timer should do about a visit's sign-off. */
export type TimedSignOff =
  /** Send the light line. */
  | 'send'
  /** They said it is good. No timed sign-off follows a check-in that was answered. */
  | 'answered_good'
  /** Asked, and nothing from them since. Nothing more is sent. */
  | 'nothing_since_checkin'
  /** No check-in from this visit (or it reads bad): not a visit sign-off. */
  | 'not_a_visit_sign_off'

/**
 * Does this visit still get a TIMED sign-off?
 *
 * Only when the guest was asked how it is, has not said good or bad, and has
 * written something since we asked.
 *
 * A CHECK-IN THAT READS `good` NEVER GETS ONE, whatever the reply to it was.
 * That is the ruling as written (2026-10-07: "no separate timed sign-off after
 * a check-in is answered"), and it is also the only version of this with no
 * way to send a second sign-off. THE KNOWN COST: the reply to "it's good" is
 * the sign-off only on a turn that asks for nothing (replySignsOffVisit), so a
 * guest who writes "so good! what's the wifi?" gets their answer and no
 * sign-off line at all, from the reply or from here. One light line fewer for
 * that guest was judged better than the machinery it took to send it.
 *
 * `not_yet` is where every reply that is neither praise nor a complaint lands
 * (classifyCheckinAnswer), so "has written since" and "the answer is not_yet"
 * usually arrive together; the inbound time is read anyway, because the answer
 * write is fire-and-forget and a row can still say null after the guest has
 * replied.
 */
export function timedSignOffFor(
  checkin: VisitCheckin | null,
  lastInboundAt: Date | null,
  now: Date,
): TimedSignOff {
  if (checkin === null || !isCheckinFresh(checkin, now)) {
    return 'not_a_visit_sign_off'
  }
  if (checkin.answer === 'bad') return 'not_a_visit_sign_off'
  if (checkin.answer === 'good') return 'answered_good'
  const chattedSince =
    lastInboundAt !== null &&
    lastInboundAt.getTime() > checkin.askedAt.getTime()
  return chattedSince ? 'send' : 'nothing_since_checkin'
}
