// TAC-297 scheduled-commitments processor. Called from the hourly GitHub
// Actions cron (.github/workflows/commitments-due-cron.yml) that hits the
// /api/cron/commitments-due route. Per-venue morning-of model:
//
//   * `imminent` arrivals fire off the inbound (lib/agent/handle-inbound.ts),
//     never from the cron. They never enter this processor.
//
//   * `scheduled` arrivals fire on the EXPECTED DAY (in the venue's local
//     timezone) at the venue's local MORNING_HOUR_LOCAL (currently 7am).
//     They do NOT fire at the agent's stamped expected_arrival time — the
//     operator gets a day-prep heads-up at opening time, not a just-in-time
//     ping per stated ETA.
//
//     Lean catch-up: a scheduled commitment whose expected_arrival date in
//     venue tz is in the past (missed morning run because the row was created
//     after that day's tick, or the cron failed) fires on the next morning
//     tick. The date filter is `expected_date <= today` (venue tz), not `==`.
//
// Design call #3 (TAC-297 plan-review): "build concrete, generalize later."
// No plugin framework. The follow-up engine will land a sibling
// processDueFollowups(now); the shared seam gets extracted then.
//
// Idempotency anchor (design call #4): every transition is CAS-gated on
// status='open' (transitionToPendingAck). A push fires only when CAS won
// (transitioned=true). A scheduled commitment that ALSO gets an imminent
// inbound between creation and the next morning tick (already transitioned
// to pending_ack off the inbound) sees CAS rowcount=0 here and skips —
// exactly one push, regardless of which path won.
//
// The cron is fire-and-forget at the row level: a single bad row (push
// failure, malformed expected_arrival) doesn't block the rest of the batch.
// Errors log + continue.

import { waitUntil } from '@vercel/functions'
import {
  findScheduledOpenCommitments,
  transitionToPendingAck,
} from './commitments'
import { sendCommitmentArrivalPush } from '@/lib/notifications/send-commitment-push'
import { createAdminClient } from '@/lib/db/admin'

/**
 * Local hour (0-23) at which the morning-of push fires in each venue's
 * timezone. 7am pilot default — early enough for staff prep before open,
 * late enough that 8am crews aren't pinged at home. Per-venue override via
 * venue_configs is a follow-up; module constant for v1.
 */
export const MORNING_HOUR_LOCAL = 7

export interface ProcessDueCommitmentsResult {
  /** Number of `status='open' AND arrival_signal='scheduled'` rows scanned. */
  scanned: number
  /** Number of rows where the CAS won (this run flipped status to pending_ack). */
  transitioned: number
  /** Number of rows where the CAS lost (concurrent caller won). */
  skipped: number
  /** Number of rows whose venue is NOT currently in MORNING_HOUR_LOCAL — held for the next morning tick. */
  notMorningHour: number
  /** Number of rows whose expected_arrival date is still in the future (venue tz). Held until that date's morning. */
  future: number
  /** Number of rows that failed defensive checks (null signal, malformed timestamp, missing venue timezone). */
  invalid: number
  /** Number of rows that errored during the transition CAS round trip. */
  errored: number
  /** Number of rows that triggered a push fanout via waitUntil. */
  pushed: number
}

/**
 * Compute the hour-of-day (0-23) of `instant` in `venueTimezone`. Returns
 * null on invalid timezone — caller treats as ineligible.
 */
function hourInVenueTz(instant: Date, venueTimezone: string): number | null {
  try {
    const formatted = new Intl.DateTimeFormat('en-GB', {
      timeZone: venueTimezone,
      hour: '2-digit',
      hour12: false,
    }).format(instant)
    const h = Number(formatted)
    return Number.isNaN(h) ? null : h
  } catch {
    return null
  }
}

/**
 * Compute the YYYY-MM-DD date string of `instant` in `venueTimezone`.
 * Returns null on invalid timezone. en-CA renders YYYY-MM-DD which is
 * lexicographically comparable as a date.
 */
function dateInVenueTz(instant: Date, venueTimezone: string): string | null {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: venueTimezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(instant)
  } catch {
    return null
  }
}

/**
 * Process all open scheduled commitments. Fire-and-forget per-row at the
 * push layer (waitUntil); the function itself awaits the CAS transitions so
 * the summary counts are accurate.
 *
 * The morning-of filter runs per-row in JS rather than in SQL because the
 * date comparison is timezone-bound and a single venue's timezone is
 * trivially cheap to look up. At pilot scale (single-digit venues) the
 * commitments-first scan is fine; if multi-tenant scale changes this, flip
 * to a venues-first approach (look up which venues are in morning hour
 * NOW, then pull only those venues' commitments).
 *
 * Failure posture: every error is caught and logged; the function never
 * throws. The caller (cron route) maps the summary into a 200 response.
 */
export async function processDueCommitments(
  now: Date,
): Promise<ProcessDueCommitmentsResult> {
  const summary: ProcessDueCommitmentsResult = {
    scanned: 0,
    transitioned: 0,
    skipped: 0,
    notMorningHour: 0,
    future: 0,
    invalid: 0,
    errored: 0,
    pushed: 0,
  }

  const dueResult = await findScheduledOpenCommitments()
  if (!dueResult.ok) {
    console.error('[cron commitments-due] findScheduledOpenCommitments failed', {
      error: dueResult.error,
      errorCode: dueResult.errorCode,
    })
    return summary
  }
  summary.scanned = dueResult.data.length

  // Pre-fetch venue timezones + guest first names. Done in one round trip
  // each to avoid N+1 in the loop.
  const venueIds = Array.from(new Set(dueResult.data.map((r) => r.venue_id)))
  const venueTimezones = await loadVenueTimezones(venueIds)
  const guestIds = Array.from(new Set(dueResult.data.map((r) => r.guest_id)))
  const guestFirstNames = await loadGuestFirstNames(guestIds)

  for (const row of dueResult.data) {
    // Belt + suspenders: findScheduledOpenCommitments already enforces both.
    if (row.arrival_signal !== 'scheduled' || row.expected_arrival === null) {
      summary.invalid += 1
      continue
    }
    const expectedArrival = new Date(row.expected_arrival)
    if (Number.isNaN(expectedArrival.getTime())) {
      console.warn(
        `[cron commitments-due] malformed expected_arrival on row=${row.id}, skipping`,
      )
      summary.invalid += 1
      continue
    }

    const venueTimezone = venueTimezones.get(row.venue_id) ?? null
    if (venueTimezone === null) {
      console.warn(
        `[cron commitments-due] venue timezone missing for venue=${row.venue_id}, skipping commitment=${row.id}`,
      )
      summary.invalid += 1
      continue
    }

    const venueHour = hourInVenueTz(now, venueTimezone)
    if (venueHour === null) {
      console.warn(
        `[cron commitments-due] invalid venue timezone "${venueTimezone}" for venue=${row.venue_id}, skipping commitment=${row.id}`,
      )
      summary.invalid += 1
      continue
    }
    if (venueHour !== MORNING_HOUR_LOCAL) {
      // Not this venue's morning yet (or already past it for this UTC tick).
      // Will be picked up on a future hourly tick when the venue's local
      // hour rolls around to MORNING_HOUR_LOCAL.
      summary.notMorningHour += 1
      continue
    }

    const todayDate = dateInVenueTz(now, venueTimezone)
    const expectedDate = dateInVenueTz(expectedArrival, venueTimezone)
    if (todayDate === null || expectedDate === null) {
      summary.invalid += 1
      continue
    }
    if (expectedDate > todayDate) {
      // Future-dated; not yet eligible. Will fire on the morning of
      // expectedDate (or — if the cron is down that day — the next morning,
      // via the lean-catch-up `<=` semantics above).
      summary.future += 1
      continue
    }

    // Eligible — venue is in its morning hour AND expected date is today
    // or past (catch-up). CAS-transition + push.
    const transition = await transitionToPendingAck({
      commitmentId: row.id,
      expectedArrival,
      arrivalSignal: 'scheduled',
      now,
    })
    if (!transition.ok) {
      console.error('[cron commitments-due] transition errored', {
        commitmentId: row.id,
        error: transition.error,
        errorCode: transition.errorCode,
      })
      summary.errored += 1
      continue
    }
    if (!transition.data.transitioned || transition.data.row === null) {
      // CAS lost — another caller (most likely a racing imminent inbound
      // that beat us between the SELECT and the CAS) won this row.
      summary.skipped += 1
      continue
    }
    summary.transitioned += 1
    const transitionedRow = transition.data.row
    const guestFirstName = guestFirstNames.get(transitionedRow.guest_id) ?? null

    summary.pushed += 1
    waitUntil(
      sendCommitmentArrivalPush({
        commitmentId: transitionedRow.id,
        venueId: transitionedRow.venue_id,
        guestId: transitionedRow.guest_id,
        guestFirstName,
        type: transitionedRow.type,
        code: transitionedRow.code,
        expectedArrival: transitionedRow.expected_arrival,
        arrivalSignal: 'scheduled',
        venueTimezone,
        agentRunId: null,
      }).catch((e) => {
        console.error('[cron commitments-due] sendCommitmentArrivalPush threw', {
          commitmentId: transitionedRow.id,
          error: e instanceof Error ? e.message : String(e),
        })
      }),
    )
  }

  return summary
}

async function loadVenueTimezones(
  venueIds: readonly string[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  if (venueIds.length === 0) return out
  const supabase = createAdminClient()
  const { data, error } = await supabase
    .from('venues')
    .select('id, timezone')
    .in('id', venueIds)
  if (error || !data) {
    console.warn('[cron commitments-due] loadVenueTimezones failed', {
      error: error?.message,
    })
    return out
  }
  for (const row of data) {
    out.set(row.id, row.timezone)
  }
  return out
}

async function loadGuestFirstNames(
  guestIds: readonly string[],
): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>()
  if (guestIds.length === 0) return out
  const supabase = createAdminClient()
  const { data, error } = await supabase
    .from('guests')
    .select('id, first_name')
    .in('id', guestIds)
  if (error || !data) {
    console.warn('[cron commitments-due] loadGuestFirstNames failed', {
      error: error?.message,
    })
    return out
  }
  for (const row of data) {
    out.set(row.id, row.first_name)
  }
  return out
}
