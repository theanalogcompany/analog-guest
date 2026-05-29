// TAC-297 arrival-capture dispatch. Called from handle-inbound and
// handle-followup between generateStage success and applyApprovalPolicyStage
// (mirrors the TAC-296 contextUpdate dispatch site) so the arrival capture
// fires regardless of whether the draft ships, queues, or refuses. What the
// agent UNDERSTOOD from the inbound is independent of what we SAID back.
//
// Signal handling:
//   imminent  → transitionToPendingAck (CAS-gated on status='open');
//               caller fires sendCommitmentArrivalPush via waitUntil iff
//               transitioned=true (TAC-297 design call #4 — the CAS rowcount
//               anchors push idempotency; concurrent imminent inbound + cron
//               firing on the same row produces exactly one push).
//   scheduled → scheduleArrival (writes expected_arrival + arrival_signal,
//               status stays 'open'); the hourly cron transitions + pushes
//               that morning.
//
// Never throws. Returns a discriminated union the caller pattern-matches on
// to decide whether to fire the push and what to log.

import type { ArrivalCaptureEmission, GuestCommitmentRow } from '@/lib/schemas'
import { isEmptyArrivalCapture } from '@/lib/schemas'
import {
  scheduleArrival,
  transitionToPendingAck,
} from '@/lib/guests/commitments'
import type { ArrivalSignal } from '@/lib/schemas/guest-commitment'

export type ArrivalCaptureDispatchResult =
  | { kind: 'noop' }
  | { kind: 'invalid_signal'; reason: string }
  | { kind: 'imminent_won'; commitmentRow: GuestCommitmentRow }
  | { kind: 'imminent_lost' }
  | { kind: 'scheduled_recorded'; commitmentRow: GuestCommitmentRow }
  | { kind: 'scheduled_lost' }
  | { kind: 'failed'; error: string; errorCode?: string }

/**
 * Dispatch an arrival capture emission. Pure-ish: only side effect is the
 * CAS-gated UPDATE on guest_commitments. Push fire is the caller's
 * responsibility (matches TAC-207 handle-inbound pattern).
 *
 * For imminent signal, expectedArrival defaults to `now` if the agent didn't
 * provide one (consistent with the prompt instruction — "expectedArrival is
 * optional for imminent signals — the system stamps now").
 */
export async function dispatchArrivalCapture(opts: {
  arrivalCapture: ArrivalCaptureEmission
  now: Date
}): Promise<ArrivalCaptureDispatchResult> {
  const { arrivalCapture, now } = opts

  if (isEmptyArrivalCapture(arrivalCapture)) {
    return { kind: 'noop' }
  }

  // Type-narrow: isEmptyArrivalCapture guarantees signal + referencesCommitmentId.
  const signal = arrivalCapture.signal as ArrivalSignal
  const commitmentId = arrivalCapture.referencesCommitmentId!.trim()

  if (signal === 'imminent') {
    const expectedArrival = arrivalCapture.expectedArrival
      ? new Date(arrivalCapture.expectedArrival)
      : now
    // Guard against an unparseable expectedArrival — fall back to now rather
    // than failing the dispatch on a malformed timestamp from the model.
    const validExpected = Number.isNaN(expectedArrival.getTime()) ? now : expectedArrival
    const r = await transitionToPendingAck({
      commitmentId,
      expectedArrival: validExpected,
      arrivalSignal: 'imminent',
      now,
    })
    if (!r.ok) {
      return { kind: 'failed', error: r.error, errorCode: r.errorCode }
    }
    if (!r.data.transitioned || r.data.row === null) {
      return { kind: 'imminent_lost' }
    }
    return { kind: 'imminent_won', commitmentRow: r.data.row }
  }

  if (signal === 'scheduled') {
    if (!arrivalCapture.expectedArrival) {
      return {
        kind: 'invalid_signal',
        reason: 'scheduled signal requires expectedArrival',
      }
    }
    const expectedArrival = new Date(arrivalCapture.expectedArrival)
    if (Number.isNaN(expectedArrival.getTime())) {
      return {
        kind: 'invalid_signal',
        reason: `unparseable expectedArrival: ${arrivalCapture.expectedArrival}`,
      }
    }
    const r = await scheduleArrival({
      commitmentId,
      expectedArrival,
      arrivalSignal: 'scheduled',
      now,
    })
    if (!r.ok) {
      return { kind: 'failed', error: r.error, errorCode: r.errorCode }
    }
    if (!r.data.transitioned || r.data.row === null) {
      return { kind: 'scheduled_lost' }
    }
    return { kind: 'scheduled_recorded', commitmentRow: r.data.row }
  }

  // Schema enum should make this unreachable, but be defensive.
  return { kind: 'invalid_signal', reason: `unknown signal: ${String(signal)}` }
}
