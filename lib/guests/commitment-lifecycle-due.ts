import {
  captureCommitmentEscalated,
  captureCommitmentExpired,
  type CommitmentEscalationReason,
} from '@/lib/analytics/posthog'
import type { GuestCommitmentRow } from '@/lib/schemas/guest-commitment'
import { escalationDueAt } from './commitment-expiry'
import { findOpenObligations, markEscalated, markExpired } from './commitments'

/**
 * TAC-341 lifecycle processor: surface obligations that have gone stale, and
 * close the ones that have elapsed.
 *
 * Third concrete sibling to lib/guests/commitments-due.ts (arrival) and
 * lib/followups/engine.ts (follow-ups). Deliberately NOT generic: per the
 * TAC-297 design call the shared "find-eligible → side-effect" seam stays
 * unextracted until the shapes have stabilized, and a third instance is not
 * yet evidence that they have.
 *
 * Scope is obligations only — comp, hold, discount. Recommendations are
 * excluded at the SCAN, not by a guard in this loop, so they cannot be
 * reached by anything here. See TAC-380.
 */

export interface ProcessCommitmentLifecycleResult {
  /** Open obligations carrying a horizon that the scan returned. */
  scanned: number
  /** Rows newly marked escalated_at on this tick. */
  escalated: number
  /** Rows moved open → expired on this tick. */
  expired: number
  /** Rows whose escalation window has not arrived and whose horizon is future. */
  untouched: number
  /**
   * Rows where a CAS lost — another tick, or a concurrent arrival transition,
   * got there first. Expected under overlapping cron runs, not an error.
   */
  casLost: number
  /** Rows where a read or write returned an error. Logged, loop continues. */
  errored: number
}

export async function processCommitmentLifecycle(
  now: Date,
): Promise<ProcessCommitmentLifecycleResult> {
  const summary: ProcessCommitmentLifecycleResult = {
    scanned: 0,
    escalated: 0,
    expired: 0,
    untouched: 0,
    casLost: 0,
    errored: 0,
  }

  const scan = await findOpenObligations()
  if (!scan.ok) {
    console.error(`[cron commitment-lifecycle] scan failed: ${scan.error}`)
    summary.errored += 1
    return summary
  }
  summary.scanned = scan.data.length

  for (const row of scan.data) {
    try {
      await processRow(row, now, summary)
    } catch (e) {
      summary.errored += 1
      console.error(
        `[cron commitment-lifecycle] unexpected failure on commitment=${row.id}: ${e instanceof Error ? e.message : String(e)}`,
      )
    }
  }

  return summary
}

async function processRow(
  row: GuestCommitmentRow,
  now: Date,
  summary: ProcessCommitmentLifecycleResult,
): Promise<void> {
  // findOpenObligations filters `expires_at IS NOT NULL`, so this is a type
  // narrowing rather than a real branch — but a malformed timestamp is real,
  // and a NaN horizon must not read as "elapsed at the dawn of time".
  if (row.expires_at === null) return
  const expiresAt = new Date(row.expires_at)
  if (Number.isNaN(expiresAt.getTime())) {
    summary.errored += 1
    console.error(
      `[cron commitment-lifecycle] unparseable expires_at "${row.expires_at}" on commitment=${row.id}; leaving it open`,
    )
    return
  }

  const createdAt = new Date(row.created_at)
  const isElapsed = expiresAt.getTime() <= now.getTime()
  const escalationDue = escalationDueAt({
    type: row.type,
    createdAt,
    expiresAt,
  })
  const windowPassed =
    escalationDue !== null && escalationDue.getTime() <= now.getTime()

  // ESCALATE BEFORE EXPIRING, always, and note the `|| isElapsed`.
  //
  // That clause is what makes "a comp is never silently expired without
  // having surfaced first" true rather than merely likely. The window
  // normally passes long before the horizon, so the ordinary path escalates
  // on an earlier tick — but if this cron were down for the whole window
  // (a GH Actions outage, a deploy gap), the row would arrive here already
  // elapsed and never-surfaced. Without the clause it would expire in
  // silence, which is the exact failure the ticket is named after.
  const needsEscalation = row.escalated_at === null && (windowPassed || isElapsed)

  let escalatedThisTick = false

  if (needsEscalation) {
    const result = await markEscalated({ commitmentId: row.id, now })
    if (!result.ok) {
      summary.errored += 1
      console.error(
        `[cron commitment-lifecycle] escalate failed for commitment=${row.id}: ${result.error}`,
      )
      // RETURN, do not fall through to expiry. Expiring a row whose
      // escalation write just failed would move it out of 'open', which is
      // the scan's filter — so it would never be looked at again, and the
      // obligation would have been closed without a human ever hearing about
      // it. That is precisely the guarantee this job exists to keep. Leaving
      // it open costs an hour; the next tick retries.
      return
    }
    if (result.data.transitioned) {
      summary.escalated += 1
      escalatedThisTick = true
      // Emit only on the CAS win. Two overlapping ticks race here; the loser
      // gets transitioned=false and stays quiet, which is what keeps one
      // commitment to one alert.
      //
      // AWAITED, not fire-and-forget: this call posts to Slack, and on Vercel
      // work that is neither awaited nor wrapped in waitUntil is not
      // guaranteed to run once the route returns. For escalation the Slack
      // post IS the surfacing, so dropping it silently would be the defect
      // rather than a missing metric. Matches lib/followups/engine.ts, which
      // awaits its captures for the same reason. Cannot throw — both
      // capturePostHogEvent and postToSlack swallow their own errors.
      await captureCommitmentEscalated({
        venueId: row.venue_id,
        guestId: row.guest_id,
        commitmentId: row.id,
        type: row.type,
        reason: escalationReason(row.type, isElapsed),
        expiresAt: row.expires_at,
        createdAt: row.created_at,
        ageDays: wholeDaysBetween(createdAt, now),
      })
    } else {
      // CAS lost: the row either left 'open' or another tick escalated it.
      // Return rather than also attempting expiry — the tick that won owns
      // this row for this pass, and counting one row's single race twice
      // would make casLost exceed scanned.
      summary.casLost += 1
      return
    }
  }

  if (!isElapsed) {
    if (!needsEscalation) summary.untouched += 1
    return
  }

  const expiry = await markExpired({ commitmentId: row.id, now })
  if (!expiry.ok) {
    summary.errored += 1
    console.error(
      `[cron commitment-lifecycle] expire failed for commitment=${row.id}: ${expiry.error}`,
    )
    return
  }
  if (!expiry.data.transitioned) {
    // The row left 'open' between the scan and this write — most likely an
    // arrival transition to pending_ack. The guest signalled against it, and
    // that outranks the clock.
    summary.casLost += 1
    return
  }
  summary.expired += 1
  // Awaited for the same reason as the escalation capture above: unawaited
  // work is not guaranteed to run after the cron route returns.
  await captureCommitmentExpired({
    venueId: row.venue_id,
    guestId: row.guest_id,
    commitmentId: row.id,
    type: row.type,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    // Derived from what actually happened, never from needsEscalation —
    // that is intent, and a field asserting the guarantee held must not be
    // computed from the wish that it would.
    hadEscalated: row.escalated_at !== null || escalatedThisTick,
  })
}

function escalationReason(
  type: GuestCommitmentRow['type'],
  isElapsed: boolean,
): CommitmentEscalationReason {
  // Only ever called when needsEscalation is true, which already requires
  // escalated_at === null — so the first distinction to make is whether the
  // row reached its horizon before anyone heard about it. An earlier version
  // also branched on escalated_at here; that condition was always true and
  // those two arms collapsed into this one.
  if (isElapsed) return 'expiring_unsurfaced'
  // A hold escalates on proximity to close, a comp or discount on age. The
  // two reasons read differently in Slack because the actions differ: one is
  // "deal with the item before close", the other is "this has been owed for
  // a week".
  return type === 'hold' ? 'hold_nearing_close' : 'aging_obligation'
}

function wholeDaysBetween(from: Date, to: Date): number {
  const ms = to.getTime() - from.getTime()
  return ms <= 0 ? 0 : Math.floor(ms / (24 * 60 * 60 * 1000))
}
