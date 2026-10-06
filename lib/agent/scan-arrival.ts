// TAC-536: the timing rules behind a bare Instagram scan.
//
// Pure, no imports beyond the shared venue-local date helper, split from the
// DB layer the way isVenueClosed and looksLikeQuestion are: every constant
// here decides something guest-facing, and the boundary should be drivable
// without a database.
//
// THE SHAPE OF THE FLOW, so the four constants below read as one rule rather
// than four numbers (ruled 2026-09-25, retimed 2026-10-06):
//
//   A guest follows the venue's ig.me link into a thread Instagram already
//   has. No icebreaker is shown, so no message comes with it.
//
//   The scan does NOT get an immediate reply. It starts a twenty-second
//   timer.
//
//   Anything the guest sends inside those twenty seconds replaces the
//   greeting: their own message is the turn.
//
//   Twenty seconds of silence sends the greeting.
//
//   Separately, anything the guest sends within FIVE MINUTES of the scan is
//   treated as at-counter, greeted or not: order capture arms off the scan.
//
// WHY A DELAY AT ALL. Scanning is a deliberate act at the counter, so silence
// is a worse answer than a greeting; but a guest who scans and then types is
// mid-sentence, and greeting over them would talk across the thing they were
// about to say. The timer is what lets both be true.
//
// WHY TWENTY SECONDS AND NOT FIVE MINUTES (ruled 2026-10-06). At five minutes
// plus the cron's lag the greeting landed about six minutes after the scan,
// by which time a to-go guest had left. The cost, accepted in the same
// ruling: a guest still typing at twenty seconds is greeted anyway, and a
// message that lands while the greeting is generating crosses it.

import { venueLocalDate } from '@/lib/schemas'

/**
 * How long a scan waits for the guest to say something before the venue
 * greets them.
 *
 * TWENTY SECONDS, ruled 2026-10-06. It was five minutes, and the same number
 * as SCAN_CARRY_FORWARD_MS below on purpose; the two are now separate
 * questions with separate answers. This one is only "did they write instead
 * of being greeted".
 */
export const SCAN_GREETING_DELAY_MS = 20 * 1000

/**
 * How late a greeting may still fire.
 *
 * FIFTEEN MINUTES, from the ruling. The greeting says the guest is in the shop
 * right now and the code is at the pickup counter, so a to-go guest is gone
 * well before it. The bound only matters when the cron misses ticks, and a
 * missed greeting is cheaper than a wrong one.
 *
 * Same reasoning as TAC-428's rule that an arrival push never fires after the
 * arrival it announces: a catch-up that asserts the present tense is worse
 * than no catch-up.
 */
export const SCAN_GREETING_MAX_AGE_MS = 15 * 60 * 1000

/**
 * How long after a scan an inbound is still at the counter.
 *
 * FIVE MINUTES, and the first of the two carry-forward anchors. Its own
 * literal, deliberately NOT derived from SCAN_GREETING_DELAY_MS (ruled
 * 2026-10-06): how long we wait before speaking and how long the guest's own
 * first message still counts as part of the scan are different facts, and
 * shortening the first to twenty seconds must not shorten this.
 */
export const SCAN_CARRY_FORWARD_MS = 5 * 60 * 1000

/**
 * How long after a SCAN GREETING an inbound is still at the counter.
 *
 * THIRTY MINUTES, from the ruling, and the second anchor. Without it the
 * flow's payoff depends on the guest answering quickly: the greeting asks
 * what they got, and an answer more than SCAN_CARRY_FORWARD_MS after the scan
 * would leave `understand_order` unarmed on exactly the turn the whole
 * mechanism exists to capture.
 *
 * It matters only for a guest the scan did NOT create. One the scan created
 * carries `created_via: 'qr_scan'`, which is a permanent confirmed-visit
 * source, so their reply arms whenever it arrives.
 *
 * Longer than the at-counter window because it is anchored to something later:
 * the guest was in the shop when we greeted them, and a reply within half an
 * hour is still that visit.
 */
export const SCAN_GREETING_CARRY_FORWARD_MS = 30 * 60 * 1000

/** A pending scan, as the greeting processor and the carry-forward see it. */
export interface ScanArrivalTiming {
  scannedAt: Date
}

/**
 * Has the greeting delay elapsed?
 *
 * `>=` rather than `>`: the delay is a floor the guest has had, not a deadline
 * to beat, and a check landing on the exact millisecond should fire rather
 * than leave the row for the next cron tick.
 */
export function isScanGreetingDue(
  scannedAt: Date,
  now: Date,
  delayMs: number = SCAN_GREETING_DELAY_MS,
): boolean {
  return now.getTime() - scannedAt.getTime() >= delayMs
}

/**
 * How long the fast path should sleep before the greeting is due.
 *
 * Measured from `scannedAt`, the same clock `isScanGreetingDue` reads, so a
 * sleep of this length ends on a row that predicate calls due.
 *
 * Floored at zero: a delivery Meta held for longer than the delay is already
 * due. CAPPED at twice the delay: `scannedAt` is Meta's clock, and a
 * timestamp ahead of ours (or simply wrong) must not hold a webhook
 * invocation open for however long it says. Past the cap the row is not due
 * when the sleep ends, the fast path leaves it, and the cron takes it.
 */
export function msUntilScanGreetingDue(
  scannedAt: Date,
  now: Date,
  delayMs: number = SCAN_GREETING_DELAY_MS,
): number {
  const remaining = scannedAt.getTime() + delayMs - now.getTime()
  if (!Number.isFinite(remaining)) return 0
  return Math.min(Math.max(remaining, 0), 2 * delayMs)
}

/**
 * Is the scan too old to greet?
 *
 * `>` rather than `>=`: exactly at the bound is still inside it, so the two
 * predicates above and here cannot both refuse the same instant.
 */
export function isScanTooStale(
  scannedAt: Date,
  now: Date,
  maxAgeMs: number = SCAN_GREETING_MAX_AGE_MS,
): boolean {
  return now.getTime() - scannedAt.getTime() > maxAgeMs
}

/** What the carry-forward has to work with for one guest. */
export interface ScanCarryForwardInput {
  /** Meta's clock for the most recent scan by this guest, or null. */
  lastScanAt: Date | null
  /** When the most recent scan greeting was sent to this guest, or null. */
  lastGreetingAt: Date | null
  /** The inbound being handled. */
  inboundAt: Date
}

/**
 * Is this inbound an at-counter message, carried forward from a scan?
 *
 * TWO ANCHORS, either of which is enough (ruled 2026-09-25):
 *
 *   a scan within SCAN_CARRY_FORWARD_MS before it, or
 *   a scan greeting within SCAN_GREETING_CARRY_FORWARD_MS before it.
 *
 * Returns the SCAN's time, never the greeting's, whichever anchor matched.
 * `visitConfirmedAt` means "when the visit was confirmed", and the scan is
 * when it was; the greeting is only our own evidence that it had been.
 *
 * Returns null when neither holds, and when the anchor is in the FUTURE
 * relative to the inbound: a scan that has not happened yet cannot make an
 * earlier message at-counter, and on a replay path (the Voices regen pins
 * history to an old inbound) it otherwise would.
 */
export function scanCarryForwardAt(input: ScanCarryForwardInput): Date | null {
  const { lastScanAt, lastGreetingAt, inboundAt } = input
  if (lastScanAt === null) return null

  const sinceScan = inboundAt.getTime() - lastScanAt.getTime()
  if (sinceScan < 0) return null
  if (sinceScan <= SCAN_CARRY_FORWARD_MS) return lastScanAt

  if (lastGreetingAt === null) return null
  const sinceGreeting = inboundAt.getTime() - lastGreetingAt.getTime()
  if (sinceGreeting < 0 || sinceGreeting > SCAN_GREETING_CARRY_FORWARD_MS)
    return null
  // The greeting has to belong to this scan, not to an older one: a greeting
  // sent BEFORE the scan is evidence about a different arrival.
  if (lastGreetingAt.getTime() < lastScanAt.getTime()) return null
  return lastScanAt
}

/**
 * The venue-local calendar day a claim is keyed on.
 *
 * Re-exported rather than reimplemented. It is the value written into
 * `instagram_scan_arrivals.venue_local_date` in the same UPDATE as the claim,
 * and the partial unique index on it is the once-per-day guard, so a second
 * definition of "which day is it" would be a second definition of that guard.
 */
export { venueLocalDate }
