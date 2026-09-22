// TAC-297 arrival-capture dispatch. Called from handle-inbound and
// handle-followup between generateStage success and applyApprovalPolicyStage
// (mirrors the TAC-296 contextUpdate dispatch site) so the arrival capture
// fires regardless of whether the draft ships, queues, or refuses. What the
// agent UNDERSTOOD from the inbound is independent of what we SAID back.
//
// Signal handling:
//   imminent  → transitionToPendingAck (CAS-gated on status='open');
//               caller fires sendCommitmentArrivalPush via waitUntil for each
//               row that transitioned (TAC-297 design call #4 — the CAS
//               rowcount anchors push idempotency; concurrent imminent inbound
//               + cron firing on the same row produces exactly one push).
//   scheduled → scheduleArrival (writes expected_arrival + arrival_signal,
//               status stays 'open'); the hourly cron transitions + pushes
//               that morning.
//
// ===== TAC-363 reworked two things here. Both are about which rows move. =====
//
// 1. THE VENUE'S HOURS ARE CONSULTED. An `imminent` signal that lands while the
//    venue is CLOSED records nothing at all: the commitments stay `open`, no
//    arrival time is stamped, no push fires (ruling 1(a), 2026-09-21).
//
//    This is the defect observed twice in production. On 2026-09-14 a guest
//    texted "heading over in a bit" at 01:02 Pacific, six hours after close;
//    the comp moved to pending_ack with an arrival stamped for 1am and an
//    operator was pushed at 1am for an arrival that could not happen. On
//    2026-09-21 it reproduced on Instagram WITH A CORRECT REPLY — the agent
//    said "we're closed for the day, back at 7 tomorrow" and capture moved the
//    comp anyway. That second one is the precise shape of the bug: the prose
//    layer had already been fixed by TAC-301 and this path never asked.
//
//    `scheduled` is deliberately NOT gated on hours. A guest texting at 11pm to
//    arrange 8am tomorrow is recording a real future arrival, and the venue
//    being shut at the moment they type is not a reason to drop it. Ruling 1(a)
//    is about an arrival that cannot happen, not about the clock on the wall.
//
//    `unknown` hours behave as open (ruling 2(a)) — see isVenueClosed, which is
//    the only comparison made and is true only for a positive closed verdict.
//
// 2. THE MODEL NO LONGER CHOOSES THE ROW. Every open obligation is swept.
//
//    `referencesCommitmentId` is a single string, and system-template.ts tells
//    the model to "pick the most recent open one" when several apply. It obeys.
//    On 2026-09-21 a guest held two open comps, 5Q22 and ADH8, said "heading
//    over now", and only 5Q22 moved — so staff saw one of the two things the
//    venue owed that guest walking through the door.
//
//    So the emission no longer selects. It still GATES: `isEmptyArrivalCapture`
//    requires the id, which is the evidence the model actually read the
//    `## Active commitments` block rather than inventing an arrival. What it
//    stops doing is deciding which rows are written. Targets come from
//    `activeCommitments`, which build-runtime-context already loaded and
//    already scoped to this guest at this venue.
//
//    Two consequences worth stating because neither was the goal. Ruling 4(a)
//    ("arrival capture stops referencing recommendations") is satisfied without
//    a prompt change: recommendations are not in OBLIGATION_TYPES, so a capture
//    naming only a recommendation now writes nothing. And a model-supplied id
//    never reaches the database at all, which is the first of the two locks on
//    the cross-guest write the CAS scoping in lib/guests/commitments.ts is the
//    second of.
//
// Never throws. Returns a discriminated union the caller pattern-matches on
// to decide whether to fire the push and what to log.

import type { ArrivalCaptureEmission, GuestCommitmentRow } from '@/lib/schemas'
import { isEmptyArrivalCapture } from '@/lib/schemas'
import {
  scheduleArrival,
  transitionToPendingAck,
} from '@/lib/guests/commitments'
import { isObligationType } from '@/lib/guests/commitment-expiry'
import type { ActiveCommitment, ArrivalSignal } from '@/lib/schemas/guest-commitment'
import type { VenueContext } from './types'
import { isVenueClosed } from './venue-open-state'

export type ArrivalCaptureDispatchResult =
  | { kind: 'noop' }
  | { kind: 'invalid_signal'; reason: string }
  // TAC-363 ruling 1(a): imminent arrival, venue closed. Nothing written.
  | { kind: 'closed_venue_skipped' }
  // TAC-363: the emission was actionable but this guest owes nothing that an
  // arrival can be recorded against — including the ruling 4(a) case, where the
  // only thing open is a recommendation.
  | { kind: 'no_open_obligations' }
  | { kind: 'imminent_won'; commitmentRows: GuestCommitmentRow[]; failedCount: number }
  | { kind: 'imminent_lost' }
  | { kind: 'scheduled_recorded'; commitmentRows: GuestCommitmentRow[]; failedCount: number }
  | { kind: 'scheduled_lost' }
  | { kind: 'failed'; error: string; errorCode?: string }

/** The venue fields this dispatch needs: the CAS scope plus the clock. */
type ArrivalVenue = Pick<VenueContext, 'id' | 'venueInfo' | 'timezone'>

interface SweepOutcome {
  rows: GuestCommitmentRow[]
  failedCount: number
  firstError: { error: string; errorCode?: string } | null
}

/**
 * Dispatch an arrival capture emission. Pure-ish: the only side effect is the
 * CAS-gated UPDATE on guest_commitments, once per open obligation. Push fire is
 * the caller's responsibility (matches the TAC-207 handle-inbound pattern).
 *
 * For an imminent signal, expectedArrival defaults to `now` when the agent
 * didn't provide one, consistent with the prompt instruction.
 */
export async function dispatchArrivalCapture(opts: {
  arrivalCapture: ArrivalCaptureEmission
  venue: ArrivalVenue
  guestId: string
  activeCommitments: readonly ActiveCommitment[]
  now: Date
}): Promise<ArrivalCaptureDispatchResult> {
  const { arrivalCapture, venue, guestId, activeCommitments, now } = opts

  if (isEmptyArrivalCapture(arrivalCapture)) {
    return { kind: 'noop' }
  }

  // Type-narrow: isEmptyArrivalCapture guarantees signal + referencesCommitmentId.
  // The id is no longer read — see note 2 in the header — but its presence is
  // still what makes this emission actionable.
  const signal = arrivalCapture.signal as ArrivalSignal

  if (signal !== 'imminent' && signal !== 'scheduled') {
    // Schema enum should make this unreachable, but be defensive.
    return { kind: 'invalid_signal', reason: `unknown signal: ${String(signal)}` }
  }

  if (signal === 'scheduled') {
    if (!arrivalCapture.expectedArrival) {
      return {
        kind: 'invalid_signal',
        reason: 'scheduled signal requires expectedArrival',
      }
    }
    if (Number.isNaN(new Date(arrivalCapture.expectedArrival).getTime())) {
      return {
        kind: 'invalid_signal',
        reason: `unparseable expectedArrival: ${arrivalCapture.expectedArrival}`,
      }
    }
  }

  // Ruling 1(a). Ordered after the shape checks so a malformed scheduled
  // emission still reports as malformed rather than being masked by the clock,
  // and applied to `imminent` only — see note 1 in the header.
  if (signal === 'imminent' && isVenueClosed(venue, now)) {
    return { kind: 'closed_venue_skipped' }
  }

  // Note 2. `status === 'open'` excludes a row the guest has already signalled
  // against, matching the CAS gate the helpers apply anyway; isObligationType
  // excludes recommendations per ruling 4(a).
  const targets = activeCommitments.filter(
    (c) => c.status === 'open' && isObligationType(c.type),
  )
  if (targets.length === 0) {
    return { kind: 'no_open_obligations' }
  }

  // One guest, one arrival event: every target gets the SAME resolved arrival
  // time rather than each recomputing it.
  const expectedArrival = resolveExpectedArrival(signal, arrivalCapture.expectedArrival, now)

  const outcome = await sweep({
    targets,
    signal,
    venueId: venue.id,
    guestId,
    expectedArrival,
    now,
  })

  if (outcome.rows.length > 0) {
    return signal === 'imminent'
      ? { kind: 'imminent_won', commitmentRows: outcome.rows, failedCount: outcome.failedCount }
      : {
          kind: 'scheduled_recorded',
          commitmentRows: outcome.rows,
          failedCount: outcome.failedCount,
        }
  }

  // Nothing moved. An error is the more actionable report, so it wins over a
  // clean CAS loss when both happened.
  if (outcome.firstError) {
    return {
      kind: 'failed',
      error: outcome.firstError.error,
      errorCode: outcome.firstError.errorCode,
    }
  }
  return signal === 'imminent' ? { kind: 'imminent_lost' } : { kind: 'scheduled_lost' }
}

function resolveExpectedArrival(
  signal: ArrivalSignal,
  emitted: string | undefined,
  now: Date,
): Date {
  if (signal === 'scheduled') {
    // Validated above; a scheduled emission always carries a parseable value.
    return new Date(emitted as string)
  }
  if (!emitted) return now
  const parsed = new Date(emitted)
  // Guard against an unparseable expectedArrival — fall back to now rather
  // than failing the dispatch on a malformed timestamp from the model.
  return Number.isNaN(parsed.getTime()) ? now : parsed
}

/**
 * Write the arrival to every target, one CAS at a time.
 *
 * Sequential rather than concurrent: at pilot volume a guest holds one or two
 * open obligations, and the rows are independent, so there is nothing to win
 * from parallelism and a serial loop keeps the failure accounting readable.
 */
async function sweep(opts: {
  targets: ActiveCommitment[]
  signal: ArrivalSignal
  venueId: string
  guestId: string
  expectedArrival: Date
  now: Date
}): Promise<SweepOutcome> {
  const { targets, signal, venueId, guestId, expectedArrival, now } = opts
  const rows: GuestCommitmentRow[] = []
  let failedCount = 0
  let firstError: SweepOutcome['firstError'] = null

  for (const target of targets) {
    const write = signal === 'imminent' ? transitionToPendingAck : scheduleArrival
    const r = await write({
      commitmentId: target.id,
      venueId,
      guestId,
      expectedArrival,
      arrivalSignal: signal,
      now,
    })
    if (!r.ok) {
      // One row's failure never stops the sweep: the whole point is that a
      // guest owed two things has both surfaced, and dropping the second
      // because the first errored would reinstate the defect under a new cause.
      failedCount += 1
      firstError ??= { error: r.error, errorCode: r.errorCode }
      continue
    }
    if (r.data.transitioned && r.data.row !== null) {
      rows.push(r.data.row)
    }
  }

  return { rows, failedCount, firstError }
}
