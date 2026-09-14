import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/analytics/posthog', () => ({
  captureCommitmentEscalated: vi.fn(),
  captureCommitmentExpired: vi.fn(),
}))

vi.mock('./commitments', () => ({
  findOpenObligations: vi.fn(),
  markEscalated: vi.fn(),
  markExpired: vi.fn(),
}))

import {
  captureCommitmentEscalated,
  captureCommitmentExpired,
} from '@/lib/analytics/posthog'
import type { GuestCommitmentRow } from '@/lib/schemas/guest-commitment'
import { processCommitmentLifecycle } from './commitment-lifecycle-due'
import { findOpenObligations, markEscalated, markExpired } from './commitments'

const NOW = new Date('2026-09-20T18:00:00Z')

function makeRow(overrides: Partial<GuestCommitmentRow> = {}): GuestCommitmentRow {
  return {
    id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    guest_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    venue_id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    type: 'comp',
    description: 'oat latte',
    code: '7K2P',
    status: 'open',
    expected_arrival: null,
    arrival_signal: null,
    created_by: 'agent',
    // Created 12 days before NOW, so the 7-day escalation window has passed
    // but the 2-year horizon has not.
    expires_at: '2028-09-08T18:00:00Z',
    escalated_at: null,
    acknowledged_at: null,
    acknowledged_by: null,
    redeemed_at: null,
    source_message_id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
    created_at: '2026-09-08T18:00:00Z',
    updated_at: '2026-09-08T18:00:00Z',
    ...overrides,
  }
}

function scanReturns(rows: GuestCommitmentRow[]) {
  vi.mocked(findOpenObligations).mockResolvedValue({ ok: true, data: rows })
}

function transitionOk(transitioned: boolean, row: GuestCommitmentRow | null = null) {
  return { ok: true as const, data: { transitioned, row } }
}

beforeEach(() => {
  vi.mocked(findOpenObligations).mockReset()
  vi.mocked(markEscalated).mockReset().mockResolvedValue(transitionOk(true, makeRow()))
  vi.mocked(markExpired).mockReset().mockResolvedValue(transitionOk(true, makeRow()))
  vi.mocked(captureCommitmentEscalated).mockReset()
  vi.mocked(captureCommitmentExpired).mockReset()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('processCommitmentLifecycle — escalation', () => {
  it('escalates a comp past its window without expiring it', async () => {
    scanReturns([makeRow()])
    const r = await processCommitmentLifecycle(NOW)
    expect(r).toEqual(
      expect.objectContaining({ scanned: 1, escalated: 1, expired: 0, casLost: 0 }),
    )
    expect(markExpired).not.toHaveBeenCalled()
    expect(captureCommitmentEscalated).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'aging_obligation', ageDays: 12 }),
    )
  })

  it('does not re-escalate a row that already carries escalated_at', async () => {
    scanReturns([makeRow({ escalated_at: '2026-09-15T18:00:00Z' })])
    const r = await processCommitmentLifecycle(NOW)
    expect(markEscalated).not.toHaveBeenCalled()
    expect(captureCommitmentEscalated).not.toHaveBeenCalled()
    expect(r.escalated).toBe(0)
    expect(r.untouched).toBe(1)
  })

  it('leaves a comp inside its escalation window alone', async () => {
    // Created 2 days before NOW — inside the 7-day window.
    scanReturns([makeRow({ created_at: '2026-09-18T18:00:00Z' })])
    const r = await processCommitmentLifecycle(NOW)
    expect(markEscalated).not.toHaveBeenCalled()
    expect(markExpired).not.toHaveBeenCalled()
    expect(r.untouched).toBe(1)
  })

  it('escalates a hold on proximity to close, not on age', async () => {
    // Created an hour ago, closes an hour from now — inside the 2h lead.
    scanReturns([
      makeRow({
        type: 'hold',
        code: null,
        created_at: '2026-09-20T17:00:00Z',
        expires_at: '2026-09-20T19:00:00Z',
      }),
    ])
    const r = await processCommitmentLifecycle(NOW)
    expect(r.escalated).toBe(1)
    expect(captureCommitmentEscalated).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'hold_nearing_close' }),
    )
  })

  it('counts a lost escalation CAS without emitting', async () => {
    scanReturns([makeRow()])
    vi.mocked(markEscalated).mockResolvedValue(transitionOk(false))
    const r = await processCommitmentLifecycle(NOW)
    expect(r.casLost).toBe(1)
    expect(r.escalated).toBe(0)
    // The emit rides on the CAS win precisely so two overlapping ticks
    // produce one alert, not two.
    expect(captureCommitmentEscalated).not.toHaveBeenCalled()
  })
})

describe('processCommitmentLifecycle — expiry', () => {
  it('expires an elapsed row that had already surfaced', async () => {
    scanReturns([
      makeRow({
        expires_at: '2026-09-19T18:00:00Z',
        escalated_at: '2026-09-15T18:00:00Z',
      }),
    ])
    const r = await processCommitmentLifecycle(NOW)
    expect(r.expired).toBe(1)
    expect(markEscalated).not.toHaveBeenCalled()
    expect(captureCommitmentExpired).toHaveBeenCalledWith(
      expect.objectContaining({ hadEscalated: true }),
    )
  })

  // Ordering check only. NOTE this row's escalation window has ALSO passed
  // (created 12 days before NOW), so it does not on its own exercise the
  // `|| isElapsed` clause — the test below does. Stated because a first
  // version of this comment claimed mutation-verification it did not have,
  // and the mutant survived all twelve tests.
  it('escalates before expiring, in that order', async () => {
    const order: string[] = []
    vi.mocked(markEscalated).mockImplementation(async () => {
      order.push('escalate')
      return transitionOk(true, makeRow())
    })
    vi.mocked(markExpired).mockImplementation(async () => {
      order.push('expire')
      return transitionOk(true, makeRow())
    })
    scanReturns([makeRow({ expires_at: '2026-09-19T18:00:00Z', escalated_at: null })])

    const r = await processCommitmentLifecycle(NOW)

    expect(order).toEqual(['escalate', 'expire'])
    expect(r.escalated).toBe(1)
    expect(r.expired).toBe(1)
    expect(captureCommitmentEscalated).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'expiring_unsurfaced' }),
    )
    expect(captureCommitmentExpired).toHaveBeenCalledWith(
      expect.objectContaining({ hadEscalated: true }),
    )
  })

  // THE GUARANTEE, and the only test that reaches it. `isElapsed &&
  // !windowPassed` is unreachable through today's own derivation (a comp's
  // 7-day window always precedes its 2-year horizon; a hold's lead is
  // defined relative to its own expiry), so it takes a horizon this code did
  // not derive — which is exactly what the hand-applied Studio backfill is,
  // and what any future change to the horizon table would be.
  //
  // Mutation-verified for real this time: narrowing needsEscalation to
  // `windowPassed` alone fails this test and only this one.
  it('escalates a row that elapsed before its escalation window ever arrived', async () => {
    const order: string[] = []
    vi.mocked(markEscalated).mockImplementation(async () => {
      order.push('escalate')
      return transitionOk(true, makeRow())
    })
    vi.mocked(markExpired).mockImplementation(async () => {
      order.push('expire')
      return transitionOk(true, makeRow())
    })
    // Created yesterday, hand-set to expire today: elapsed, but the 7-day
    // comp window does not arrive until the 26th.
    scanReturns([
      makeRow({
        created_at: '2026-09-19T18:00:00Z',
        expires_at: '2026-09-20T06:00:00Z',
        escalated_at: null,
      }),
    ])

    const r = await processCommitmentLifecycle(NOW)

    expect(order).toEqual(['escalate', 'expire'])
    expect(r.escalated).toBe(1)
    expect(r.expired).toBe(1)
    expect(captureCommitmentEscalated).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'expiring_unsurfaced' }),
    )
    expect(captureCommitmentExpired).toHaveBeenCalledWith(
      expect.objectContaining({ hadEscalated: true }),
    )
  })

  it('leaves a row alone when the expiry CAS loses to an arrival transition', async () => {
    scanReturns([
      makeRow({
        expires_at: '2026-09-19T18:00:00Z',
        escalated_at: '2026-09-15T18:00:00Z',
      }),
    ])
    vi.mocked(markExpired).mockResolvedValue(transitionOk(false))
    const r = await processCommitmentLifecycle(NOW)
    expect(r.casLost).toBe(1)
    expect(r.expired).toBe(0)
    expect(captureCommitmentExpired).not.toHaveBeenCalled()
  })
})

describe('processCommitmentLifecycle — the escalation guarantee under failure', () => {
  // THE BLOCKER FOUND IN CODE REVIEW. The original code logged the failed
  // escalation write and fell through to markExpired, which moves the row out
  // of 'open' — the scan's own filter — so it would never be examined again.
  // A comp closed with escalated_at still null, no human ever told, and
  // captureCommitmentExpired reporting hadEscalated: true because that field
  // was computed from INTENT rather than outcome. The guarantee's only
  // telemetry actively asserted it had held.
  it('does not expire a row whose escalation write failed', async () => {
    scanReturns([makeRow({ expires_at: '2026-09-19T18:00:00Z', escalated_at: null })])
    vi.mocked(markEscalated).mockResolvedValue({
      ok: false,
      error: 'db down',
      errorCode: 'db_write_failed',
    })

    const r = await processCommitmentLifecycle(NOW)

    // Left open so the next hourly tick retries. An hour of delay is the
    // whole cost; the alternative is a permanently silent closure.
    expect(markExpired).not.toHaveBeenCalled()
    expect(r.expired).toBe(0)
    expect(r.errored).toBe(1)
    expect(captureCommitmentExpired).not.toHaveBeenCalled()
  })

  // hadEscalated must describe what happened, not what was attempted.
  it('reports hadEscalated from the outcome, not from the intent', async () => {
    scanReturns([makeRow({ expires_at: '2026-09-19T18:00:00Z', escalated_at: null })])
    vi.mocked(markEscalated).mockResolvedValue(transitionOk(true, makeRow()))

    await processCommitmentLifecycle(NOW)

    expect(captureCommitmentExpired).toHaveBeenCalledWith(
      expect.objectContaining({ hadEscalated: true }),
    )
  })

  // One row, one race. Counting the same row's single CAS loss in both the
  // escalation and expiry branches let casLost exceed scanned.
  it('counts one lost race once, not twice', async () => {
    scanReturns([makeRow({ expires_at: '2026-09-19T18:00:00Z', escalated_at: null })])
    vi.mocked(markEscalated).mockResolvedValue(transitionOk(false))

    const r = await processCommitmentLifecycle(NOW)

    expect(r.casLost).toBe(1)
    expect(r.casLost).toBeLessThanOrEqual(r.scanned)
    expect(markExpired).not.toHaveBeenCalled()
  })

  it('labels an aging comp and a closing hold differently', async () => {
    scanReturns([makeRow()])
    await processCommitmentLifecycle(NOW)
    expect(captureCommitmentEscalated).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'aging_obligation' }),
    )
  })
})

describe('processCommitmentLifecycle — failure handling', () => {
  it('reports a scan failure without throwing', async () => {
    vi.mocked(findOpenObligations).mockResolvedValue({
      ok: false,
      error: 'boom',
      errorCode: 'db_read_failed',
    })
    const r = await processCommitmentLifecycle(NOW)
    expect(r).toEqual(
      expect.objectContaining({ scanned: 0, errored: 1, escalated: 0, expired: 0 }),
    )
  })

  // A NaN horizon must not read as "elapsed at the dawn of time" and sweep a
  // live obligation into expired.
  it('leaves a row with an unparseable expires_at open', async () => {
    scanReturns([makeRow({ expires_at: 'not-a-date' })])
    const r = await processCommitmentLifecycle(NOW)
    expect(r.errored).toBe(1)
    expect(markExpired).not.toHaveBeenCalled()
    expect(markEscalated).not.toHaveBeenCalled()
  })

  it('keeps processing after one row throws', async () => {
    scanReturns([makeRow({ id: 'row-1' }), makeRow({ id: 'row-2' })])
    vi.mocked(markEscalated)
      .mockRejectedValueOnce(new Error('transient'))
      .mockResolvedValue(transitionOk(true, makeRow()))
    const r = await processCommitmentLifecycle(NOW)
    expect(r.scanned).toBe(2)
    expect(r.errored).toBe(1)
    expect(r.escalated).toBe(1)
  })

  it('records a write failure without halting the run', async () => {
    scanReturns([makeRow()])
    vi.mocked(markEscalated).mockResolvedValue({
      ok: false,
      error: 'db down',
      errorCode: 'db_write_failed',
    })
    const r = await processCommitmentLifecycle(NOW)
    expect(r.errored).toBe(1)
    expect(r.escalated).toBe(0)
  })
})
