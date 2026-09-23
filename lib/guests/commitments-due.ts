// TAC-297 scheduled-commitments processor. Called from the hourly GitHub
// Actions cron (.github/workflows/commitments-due-cron.yml) that hits the
// /api/cron/commitments-due route. Per-venue morning-of model:
//
//   * `imminent` arrivals fire off the inbound (lib/agent/handle-inbound.ts),
//     never from the cron. They never enter this processor.
//
//   * `scheduled` arrivals fire on the EXPECTED DAY (in the venue's local
//     timezone), from the venue's OPENING TIME onward. They do NOT fire at the
//     agent's stamped expected_arrival time — the operator gets a day-prep
//     heads-up when the doors open, not a just-in-time ping per stated ETA.
//
// TAC-428 rewrote the eligibility gate. Two things were wrong with it.
//
// It required the tick to land IN the firing hour (`venueHour !== MORNING_HOUR
// _LOCAL`), and GitHub Actions stopped delivering that: measured 2026-09-22, a
// scheduled run landed inside Le Mil's 07:00 hour on 6 of the 26 days since the
// 2026-08-27 onset, and 2 of the last 7. On the other 20 the push did not
// happen at all. cron-job.org is the primary trigger now (see the route), and
// the gate accepts any tick from opening onward so a missed hour is recovered
// the same day rather than not at all.
//
// And the hour was a hardcoded 07:00 rather than the venue's own opening time,
// which is wrong in both directions: too late for a venue opening at 06:00, too
// early for one opening at 08:00 — and Le Mil's itself moves to 08:00 on
// 3 October (TAC-508). Opening time now comes from the hours the venue already
// publishes, through the same parser the prompt's open/closed line and the
// TAC-363 closed-venue gate read.
//
// The gate is three clauses, and the two limits the 2026-09-17 ruling set are
// the second and third:
//
//   0. the venue does not state it is closed today — a stated closure is a read
//      fact and nothing is announced on that day (ruled 2026-09-23);
//   1. at or after today's opening time, venue-local;
//   2. expected_arrival's venue-local DATE is today — catch-up is bounded to
//      the same venue-local day, so a missed day is never announced late;
//   3. the arrival has not already happened — EXCEPT for an arrival earlier
//      than opening, which nobody could have been ready for and which is
//      therefore announced at opening.
//
// Clause 1 cannot cross midnight on its own: at 00:00 local the clock drops
// below opening again. So "the same venue-local day" needs no date bookkeeping
// of its own; it falls out of the comparison.
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
import {
  resolveOpeningToday,
  venueLocalMinutes,
  VenueHoursSchema,
  type VenueInfo,
} from '@/lib/schemas'

/**
 * FALLBACK local hour (0-23) for the morning-of push, used only when the venue
 * publishes no readable opening time for today.
 *
 * TAC-428 renamed this from MORNING_HOUR_LOCAL. It stopped being "the hour the
 * push fires" and became "the hour we guess when the venue's own hours cannot
 * be read", and a name that outlives its meaning is how the next reader is
 * misled — this file's own history has two such cases.
 *
 * Falling back rather than skipping is the 2026-09-22 ruling: a push nobody
 * needed costs less than a guest arriving unannounced. It is the same
 * direction TAC-363 took for unknown hours, reached the same way — by never
 * testing for a closure.
 */
export const FALLBACK_MORNING_HOUR_LOCAL = 7

/**
 * How long after opening an arrival stamped AT OR BEFORE opening may still be
 * announced, in venue-local minutes.
 *
 * Equal to the external cron's tick interval (hourly), because that is the
 * resolution at which "announced at opening" can be observed at all: with
 * ticks on the hour, a venue opening at 07:30 is first seen at 08:00. Change
 * this if that interval changes.
 *
 * It exists because the carve-out for a pre-opening arrival must not become a
 * licence to announce it all day. Unbounded, a 06:00 arrival at a venue
 * opening 07:00 would be pushed as "arriving this morning" by a 14:00
 * catch-up tick — which is the same defect the same-day bound closes, arriving
 * by another route.
 */
export const ARRIVAL_AT_OPENING_GRACE_MINUTES = 60

export interface ProcessDueCommitmentsResult {
  /** Number of `status='open' AND arrival_signal='scheduled'` rows scanned. */
  scanned: number
  /** Number of rows where the CAS won (this run flipped status to pending_ack). */
  transitioned: number
  /** Number of rows where the CAS lost (concurrent caller won). */
  skipped: number
  /** Number of rows whose venue has not reached today's opening time yet. Held for a later tick today. */
  beforeOpening: number
  /** Number of rows whose expected_arrival date is still in the future (venue tz). Held until that day's opening. */
  future: number
  /**
   * Number of rows whose expected_arrival day has fully passed (venue tz).
   * Never pushed: announcing yesterday's arrival as "this morning" is the
   * confirmed defect this replaces, not a catch-up.
   */
  arrivalDayPassed: number
  /**
   * Number of rows whose arrival was today, at or after opening, and has
   * already gone by. Never pushed. An arrival EARLIER than opening is not
   * counted here and is still announced — nobody could have been ready for it.
   */
  arrivalPassed: number
  /**
   * Number of rows whose venue published no readable opening time for today —
   * absent, blank or unparseable — so the fallback hour was used. A stated
   * closure is NOT counted here; it has its own outcome below.
   */
  openingTimeUnreadable: number
  /**
   * Number of rows at a venue that positively states it is CLOSED today.
   * Never pushed (ruled 2026-09-23). Distinct from `openingTimeUnreadable`
   * because the two are opposites: one is a fact we read, the other is the
   * absence of one.
   */
  venueClosedToday: number
  /** Number of rows that failed defensive checks (null signal, malformed timestamp, missing venue timezone). */
  invalid: number
  /** Number of rows that errored during the transition CAS round trip. */
  errored: number
  /** Number of rows that triggered a push fanout via waitUntil. */
  pushed: number
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
    beforeOpening: 0,
    future: 0,
    arrivalDayPassed: 0,
    arrivalPassed: 0,
    openingTimeUnreadable: 0,
    venueClosedToday: 0,
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
  const venueClocks = await loadVenueClocks(venueIds)
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

    const venueClock = venueClocks.get(row.venue_id) ?? null
    const venueTimezone = venueClock?.timezone ?? null
    const venueHours: VenueInfo['hours'] = venueClock?.hours ?? {}
    if (venueTimezone === null) {
      console.warn(
        `[cron commitments-due] venue timezone missing for venue=${row.venue_id}, skipping commitment=${row.id}`,
      )
      summary.invalid += 1
      continue
    }

    // Clause 2 FIRST: same venue-local day, in both directions.
    //
    // Deliberately ahead of the opening check. Clause 1 costs a warn and a
    // counter increment on every tick, and a row whose arrival is a week away
    // would otherwise take them hourly until then, making
    // `openingTimeUnreadable` a count of rows-per-tick rather than of rows.
    const todayDate = dateInVenueTz(now, venueTimezone)
    const expectedDate = dateInVenueTz(expectedArrival, venueTimezone)
    if (todayDate === null || expectedDate === null) {
      summary.invalid += 1
      continue
    }
    if (expectedDate > todayDate) {
      // Future-dated. Fires from the opening time on expectedDate itself.
      summary.future += 1
      continue
    }
    if (expectedDate < todayDate) {
      // The arrival day has fully passed. Deliberately NOT a catch-up: until
      // TAC-428 the date filter was `<=`, so a missed day fired on a later
      // morning and buildArrivalContext, which buckets only the hour-of-day,
      // announced it as "this morning". That was the confirmed downstream
      // defect of this ticket's investigation 2. The row stays open; for comp,
      // hold and discount the TAC-341 lifecycle processor still expires and
      // escalates it, so nothing is lost from the obligation ledger.
      summary.arrivalDayPassed += 1
      continue
    }

    // Clause 1: at or after today's opening time, on the venue's own clock.
    //
    // THREE STATES, AND A STATED CLOSURE IS NOT THE SAME AS AN UNREADABLE ONE
    // (ruled 2026-09-23, correcting how this shipped). Unknown hours fall back
    // to a fixed hour because we could not read them and a push nobody needed
    // costs less than a guest arriving unannounced. A stated closure is a read
    // fact, and guessing 07:00 past it discards the only thing it told us. On
    // a day the venue says it is shut, nothing is announced: if that leaves a
    // scheduled arrival unannounced, the ARRIVAL is the defect, and a "this
    // morning" push makes it worse rather than better.
    const opening = resolveOpeningToday(venueHours, venueTimezone, now)
    if (opening.state === 'closed') {
      summary.venueClosedToday += 1
      console.warn(
        `[cron commitments-due] venue=${row.venue_id} states it is closed today; not announcing commitment=${row.id}`,
      )
      continue
    }
    let openMin: number
    let nowMin: number
    if (opening.state === 'open') {
      openMin = opening.openMin
      nowMin = opening.nowMin
    } else {
      const fallbackNow = venueLocalMinutes(venueTimezone, now)
      if (fallbackNow === null) {
        // No usable clock at all. Distinct from unreadable HOURS: without a
        // timezone there is no venue-local day either.
        console.warn(
          `[cron commitments-due] invalid venue timezone "${venueTimezone}" for venue=${row.venue_id}, skipping commitment=${row.id}`,
        )
        summary.invalid += 1
        continue
      }
      openMin = FALLBACK_MORNING_HOUR_LOCAL * 60
      nowMin = fallbackNow
      summary.openingTimeUnreadable += 1
      console.warn(
        `[cron commitments-due] venue=${row.venue_id} publishes no readable opening time for today (absent or unparseable, NOT a stated closure); falling back to ${FALLBACK_MORNING_HOUR_LOCAL}:00 local for commitment=${row.id}`,
      )
    }

    if (nowMin < openMin) {
      // Doors are not open yet. A later tick today picks this up — that is the
      // catch-up, and it is why this is `<` and not `!==`.
      summary.beforeOpening += 1
      continue
    }

    // Clause 3: the arrival has not already happened.
    //
    // An arrival at or BEFORE opening is one nobody could have been ready for,
    // so it is announced at opening rather than treated as past — the ruling's
    // own carve-out. Without it, "I'll come at 6" to a venue opening at 7
    // produces no push at all, and that is the arrival an operator most needs.
    //
    // `<=`, not `<`: "I'll come by when you open at 7" stamps expected_arrival
    // at exactly the opening minute, which is among the commonest phrasings. A
    // strict `<` refuses it, because the first eligible tick is at or after
    // opening and so is never strictly before the arrival.
    //
    // The null guard is NOT dead weight, and must not be tidied away: this
    // branch is reachable only when the timezone is usable, so it never fires
    // today, but `null < openMin` coerces to `0 < openMin` and would carve out
    // EVERY past arrival — the exact defect clause 2 and this clause exist to
    // close.
    const expectedMin = venueLocalMinutes(venueTimezone, expectedArrival)
    const arrivalIsAtOrBeforeOpening = expectedMin !== null && expectedMin <= openMin

    // THE CARVE-OUT IS BOUNDED TO OPENING, NOT TO THE WHOLE DAY. Left
    // unbounded it re-creates the very defect clause 2 closes: a 06:00 arrival
    // at a venue opening 07:00, caught up on a 14:00 tick, pushes "arriving
    // this morning" at 2pm. The bound is one tick interval, because an hourly
    // cron is the resolution at which "at opening" can be observed at all. If
    // the external cron's interval changes, this changes with it.
    const arrivalHasPassed = arrivalIsAtOrBeforeOpening
      ? nowMin >= openMin + ARRIVAL_AT_OPENING_GRACE_MINUTES
      : now.getTime() >= expectedArrival.getTime()
    if (arrivalHasPassed) {
      summary.arrivalPassed += 1
      continue
    }

    // Eligible — the venue is open, the arrival is today, and it is still
    // ahead of us (or was before opening). CAS-transition + push.
    const transition = await transitionToPendingAck({
      commitmentId: row.id,
      // TAC-363: the CAS is venue- and guest-scoped now. This caller reads
      // both off the row it already loaded, so the predicate can only ever
      // match the row this iteration is about.
      venueId: row.venue_id,
      guestId: row.guest_id,
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
        description: transitionedRow.description,
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

async function loadVenueClocks(
  venueIds: readonly string[],
): Promise<Map<string, { timezone: string; hours: VenueInfo['hours'] }>> {
  const out = new Map<string, { timezone: string; hours: VenueInfo['hours'] }>()
  if (venueIds.length === 0) return out
  const supabase = createAdminClient()
  const [venues, configs] = await Promise.all([
    supabase.from('venues').select('id, timezone').in('id', venueIds),
    supabase.from('venue_configs').select('venue_id, venue_info').in('venue_id', venueIds),
  ])
  if (venues.error || !venues.data) {
    console.warn('[cron commitments-due] loadVenueClocks: venues load failed', {
      error: venues.error?.message,
    })
    return out
  }

  // Parse the HOURS SUB-OBJECT, never the whole VenueInfoSchema, which
  // requires `address`: a venue missing an unrelated field would otherwise
  // lose its opening time and silently take the fallback hour. Same call
  // TAC-341's loadVenueClock makes, for the same reason its comment gives.
  const hoursByVenue = new Map<string, VenueInfo['hours']>()
  if (configs.error || !configs.data) {
    // Not fatal: every row falls back to the fixed hour, which is the
    // documented behaviour for hours nobody can read.
    console.warn('[cron commitments-due] loadVenueClocks: venue_configs load failed', {
      error: configs.error?.message,
    })
  } else {
    for (const row of configs.data) {
      const raw = row.venue_info
      if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) continue
      const parsed = VenueHoursSchema.safeParse((raw as Record<string, unknown>).hours ?? {})
      if (parsed.success) hoursByVenue.set(row.venue_id, parsed.data)
    }
  }

  for (const row of venues.data) {
    // Same guard as commitments.ts's loadVenueClock: an empty string is not a
    // timezone, and treating it as one defers the failure into Intl. The two
    // loaders are near-duplicates (batched here, single-venue there) and move
    // together.
    if (typeof row.timezone !== 'string' || row.timezone.length === 0) continue
    out.set(row.id, { timezone: row.timezone, hours: hoursByVenue.get(row.id) ?? {} })
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
