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
//   What they say back is read as good, bad or not yet, and a row in
//   `visit_checkins` (migration 073) carries that for the rest of the visit:
//   the sign-off, the check-back and the next-visit follow-up all read it.
//
// WHAT THIS MODULE DOES NOT DECIDE: when the check-back goes out and what the
// sign-off says. Those belong to later parts of the ticket and read the row
// this one writes.

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
 *   a counter visit is live for this turn. On Instagram that is a scan on this
 *     message or one carried forward (`scanAt`); on a text thread it is a
 *     guest the counter sign created inside COUNTER_ARRIVAL_WINDOW_MS;
 *   this message names something on the menu. The order extractor runs after
 *     the reply is sent, so no transaction exists yet on the turn that names
 *     the order; the menu-name prefilter is the same signal
 *     applyCurrentTurnSuppression already reads for the same reason;
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
  alreadyAskedThisVisit: boolean
}): Date | null {
  if (!input.mentionsMenuItem) return null
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
