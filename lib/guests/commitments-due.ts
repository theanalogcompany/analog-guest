// TAC-297 scheduled-commitments processor. Called from the hourly Vercel
// cron route at /api/cron/commitments-due. Finds open commitments whose
// expected_arrival is due, CAS-transitions each to pending_ack, and fires
// the operator push fire-and-forget when the CAS won.
//
// Design call #3 (TAC-297 plan-review): "build concrete, generalize later."
// No plugin framework, no consumer registry. The follow-up engine will land
// a sibling processDueFollowups(now) function; the shared "find-due →
// CAS-transition → side-effect" seam gets extracted then.
//
// Idempotency anchor (design call #4): every transition is CAS-gated on
// status='open' (transitionToPendingAck). A push fires only when CAS won
// (transitioned=true). Concurrent runs (the same scheduled commitment fired
// by an imminent inbound right before the cron tick) end up with exactly
// one transition + one push, because the loser sees rowcount=0 and skips.
//
// The cron is fire-and-forget at the row level: a single bad commitment
// (push failure, malformed expected_arrival) doesn't block the rest of the
// batch. Errors log + continue.

import { waitUntil } from '@vercel/functions'
import { findDueCommitments, transitionToPendingAck } from './commitments'
import { sendCommitmentArrivalPush } from '@/lib/notifications/send-commitment-push'
import { createAdminClient } from '@/lib/db/admin'

export interface ProcessDueCommitmentsResult {
  /** Number of due rows the SELECT returned. */
  scanned: number
  /** Number of rows where the CAS won (this run flipped status to pending_ack). */
  transitioned: number
  /** Number of rows where the CAS lost (concurrent caller won). */
  skipped: number
  /** Number of rows whose arrival_signal was null (data integrity drop, shouldn't
   * happen since findDueCommitments filters for non-null). */
  invalid: number
  /** Number of rows that errored during the transition CAS round trip. */
  errored: number
  /** Number of rows that triggered a push fanout via waitUntil. */
  pushed: number
}

/**
 * Process all commitments due as of `now`. Fire-and-forget per-row at the
 * push layer (waitUntil); the function itself awaits the CAS transitions so
 * the count summary in the return value is accurate.
 *
 * The push fanout uses waitUntil so the cron route can return quickly with
 * the summary. Vercel keeps the function alive for the waitUntil promises
 * to settle (same pattern as TAC-207 draft-flagged push in handle-inbound).
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
    invalid: 0,
    errored: 0,
    pushed: 0,
  }

  const dueResult = await findDueCommitments(now)
  if (!dueResult.ok) {
    console.error('[cron commitments-due] findDueCommitments failed', {
      error: dueResult.error,
      errorCode: dueResult.errorCode,
    })
    return summary
  }
  summary.scanned = dueResult.data.length

  // Pre-fetch venue timezones for the push body's morning/afternoon/evening
  // bucketing. Done in one round trip to avoid N venue lookups in the loop.
  const venueIds = Array.from(new Set(dueResult.data.map((r) => r.venue_id)))
  const venueTimezones = await loadVenueTimezones(venueIds)

  // Pre-fetch guest first names for the push body. Same N+1 concern as
  // venues — one round trip rather than per-row.
  const guestIds = Array.from(new Set(dueResult.data.map((r) => r.guest_id)))
  const guestFirstNames = await loadGuestFirstNames(guestIds)

  for (const row of dueResult.data) {
    if (row.arrival_signal === null || row.expected_arrival === null) {
      // Belt + suspenders — findDueCommitments already filters these out.
      summary.invalid += 1
      continue
    }
    const expectedArrival = new Date(row.expected_arrival)
    if (Number.isNaN(expectedArrival.getTime())) {
      console.warn(`[cron commitments-due] malformed expected_arrival on row=${row.id}, skipping`)
      summary.invalid += 1
      continue
    }
    const transition = await transitionToPendingAck({
      commitmentId: row.id,
      expectedArrival,
      arrivalSignal: row.arrival_signal,
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
      // CAS lost — concurrent caller won this row. Skip the push.
      summary.skipped += 1
      continue
    }
    summary.transitioned += 1
    const transitionedRow = transition.data.row

    const venueTimezone =
      venueTimezones.get(transitionedRow.venue_id) ?? 'America/Los_Angeles'
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
        arrivalSignal: transitionedRow.arrival_signal ?? 'scheduled',
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
