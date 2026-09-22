// TAC-363: first tests for the arrival-capture dispatch.
//
// This module had none, which is the reason both of the defects it fixes could
// reach production and stay there. The single-id limit was invisible because
// nothing exercised a guest with two open obligations, and the missing hours
// check was invisible because nothing exercised a closed venue.
//
// The load-bearing assertions are NEGATIVE: that a closed venue writes nothing
// at all, and that a recommendation is never touched. A test that only checks
// the happy path passes with either defect restored.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ActiveCommitment, GuestCommitmentRow } from '@/lib/schemas/guest-commitment'
import type { VenueInfo } from '@/lib/schemas'

vi.mock('@/lib/guests/commitments', () => ({
  transitionToPendingAck: vi.fn(),
  scheduleArrival: vi.fn(),
}))

import { scheduleArrival, transitionToPendingAck } from '@/lib/guests/commitments'
import { dispatchArrivalCapture } from './dispatch-arrival-capture'

const VENUE_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const GUEST_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'

const COMP_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const COMP_B = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
const RECOMMENDATION = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'

const HOURS: VenueInfo['hours'] = {
  monday: '7:00 AM – 3:00 PM',
  tuesday: '7:00 AM – 3:00 PM',
  wednesday: '7:00 AM – 3:00 PM',
  thursday: '7:00 AM – 3:00 PM',
  friday: '7:00 AM – 3:00 PM',
  saturday: '7:00 AM – 3:00 PM',
  sunday: '7:00 AM – 3:00 PM',
}

// 2026-09-22 is a Tuesday. 17:00Z is 10:00 Pacific; 08:00Z is 01:00 Pacific,
// the hour the 2026-09-14 incident landed in.
const DURING_SERVICE = new Date('2026-09-22T17:00:00Z')
const AFTER_CLOSE = new Date('2026-09-22T08:00:00Z')

function venue(overrides: Partial<{ hours: VenueInfo['hours']; timezone: string }> = {}) {
  return {
    id: VENUE_ID,
    venueInfo: { hours: overrides.hours ?? HOURS } as VenueInfo,
    timezone: overrides.timezone ?? 'America/Los_Angeles',
  }
}

function commitment(overrides: Partial<ActiveCommitment> = {}): ActiveCommitment {
  return {
    id: COMP_A,
    type: 'comp',
    description: 'oat latte',
    code: '5Q22',
    status: 'open',
    expected_arrival: null,
    arrival_signal: null,
    created_at: '2026-09-20T12:00:00Z',
    ...overrides,
  }
}

function row(id: string, overrides: Partial<GuestCommitmentRow> = {}): GuestCommitmentRow {
  return {
    id,
    venue_id: VENUE_ID,
    guest_id: GUEST_ID,
    type: 'comp',
    description: 'oat latte',
    code: '5Q22',
    status: 'pending_ack',
    expected_arrival: DURING_SERVICE.toISOString(),
    arrival_signal: 'imminent',
    created_by: 'agent',
    expires_at: null,
    acknowledged_at: null,
    acknowledged_by: null,
    escalated_at: null,
    redeemed_at: null,
    source_message_id: null,
    created_at: '2026-09-20T12:00:00Z',
    updated_at: '2026-09-22T17:00:00Z',
    ...overrides,
  } as GuestCommitmentRow
}

function won(id: string) {
  return { ok: true as const, data: { transitioned: true, row: row(id) } }
}
const LOST = { ok: true as const, data: { transitioned: false, row: null } }

function call(overrides: Parameters<typeof dispatchArrivalCapture>[0] extends infer T
  ? Partial<T>
  : never = {}) {
  return dispatchArrivalCapture({
    arrivalCapture: { signal: 'imminent', referencesCommitmentId: COMP_A },
    venue: venue(),
    guestId: GUEST_ID,
    activeCommitments: [commitment()],
    now: DURING_SERVICE,
    ...overrides,
  })
}

beforeEach(() => {
  vi.mocked(transitionToPendingAck).mockReset()
  vi.mocked(scheduleArrival).mockReset()
})

describe('emissions that record nothing', () => {
  it('is a noop on the empty emission shape', async () => {
    const r = await call({ arrivalCapture: {} })
    expect(r).toEqual({ kind: 'noop' })
    expect(transitionToPendingAck).not.toHaveBeenCalled()
  })

  it('is a noop when the model named no commitment', async () => {
    // referencesCommitmentId no longer selects the row, but its presence is
    // still the evidence the model read the ## Active commitments block rather
    // than inventing an arrival from nothing.
    const r = await call({ arrivalCapture: { signal: 'imminent' } })
    expect(r).toEqual({ kind: 'noop' })
    expect(transitionToPendingAck).not.toHaveBeenCalled()
  })

  it('reports a scheduled signal with no expectedArrival as invalid', async () => {
    const r = await call({
      arrivalCapture: { signal: 'scheduled', referencesCommitmentId: COMP_A },
    })
    expect(r.kind).toBe('invalid_signal')
    expect(scheduleArrival).not.toHaveBeenCalled()
  })

  it('reports an unparseable scheduled expectedArrival as invalid', async () => {
    const r = await call({
      arrivalCapture: {
        signal: 'scheduled',
        expectedArrival: 'next tuesday-ish',
        referencesCommitmentId: COMP_A,
      },
    })
    expect(r.kind).toBe('invalid_signal')
    expect(scheduleArrival).not.toHaveBeenCalled()
  })
})

describe('ruling 1(a): an imminent arrival at a closed venue records nothing', () => {
  it('writes nothing and makes no DB call at all', async () => {
    // The 2026-09-14 incident and its 2026-09-21 reproduction. The assertion
    // that matters is not the returned kind but that NOTHING was called: the
    // commitment stays open, no arrival time is stamped, no push can fire
    // because no row comes back to fire one for.
    const r = await call({ now: AFTER_CLOSE })
    expect(r).toEqual({ kind: 'closed_venue_skipped' })
    expect(transitionToPendingAck).not.toHaveBeenCalled()
    expect(scheduleArrival).not.toHaveBeenCalled()
  })

  it('still records an imminent arrival during service', async () => {
    vi.mocked(transitionToPendingAck).mockResolvedValue(won(COMP_A))
    const r = await call({ now: DURING_SERVICE })
    expect(r.kind).toBe('imminent_won')
    expect(transitionToPendingAck).toHaveBeenCalledTimes(1)
  })

  it('does NOT gate a scheduled arrival on the venue being open', async () => {
    // A guest texting at 1am to arrange 8am tomorrow is recording a real
    // future arrival. Gating this on the clock would drop it.
    vi.mocked(scheduleArrival).mockResolvedValue(won(COMP_A))
    const r = await call({
      arrivalCapture: {
        signal: 'scheduled',
        expectedArrival: '2026-09-22T15:00:00Z',
        referencesCommitmentId: COMP_A,
      },
      now: AFTER_CLOSE,
    })
    expect(r.kind).toBe('scheduled_recorded')
    expect(scheduleArrival).toHaveBeenCalledTimes(1)
  })

  it('ruling 2(a): unknown hours behave as OPEN, so the arrival is recorded', async () => {
    // The failure direction that matters. If unknown were treated as closed,
    // every venue whose hours nobody has filled in would silently stop
    // recording arrivals, and nothing would say so.
    vi.mocked(transitionToPendingAck).mockResolvedValue(won(COMP_A))
    const r = await call({ venue: venue({ hours: {} }), now: AFTER_CLOSE })
    expect(r.kind).toBe('imminent_won')
    expect(transitionToPendingAck).toHaveBeenCalledTimes(1)
  })

  it('ruling 2(a): an unusable timezone behaves as OPEN too', async () => {
    vi.mocked(transitionToPendingAck).mockResolvedValue(won(COMP_A))
    const r = await call({
      venue: venue({ timezone: 'America/Los_Angles' }),
      now: AFTER_CLOSE,
    })
    expect(r.kind).toBe('imminent_won')
  })
})

describe('every open obligation is swept, not just the one the model named', () => {
  it('transitions BOTH open comps and returns both rows', async () => {
    // The 2026-09-21 live finding: the guest held 5Q22 and ADH8, said "heading
    // over now", and only 5Q22 moved because the model can name one id.
    vi.mocked(transitionToPendingAck)
      .mockResolvedValueOnce(won(COMP_A))
      .mockResolvedValueOnce(won(COMP_B))

    const r = await call({
      // The model named only the first. It must not decide the outcome.
      arrivalCapture: { signal: 'imminent', referencesCommitmentId: COMP_A },
      activeCommitments: [
        commitment({ id: COMP_A, code: '5Q22' }),
        commitment({ id: COMP_B, code: 'ADH8', description: 'gulab jamun cake' }),
      ],
    })

    expect(r.kind).toBe('imminent_won')
    if (r.kind !== 'imminent_won') return
    expect(r.commitmentRows.map((x) => x.id)).toEqual([COMP_A, COMP_B])
    expect(transitionToPendingAck).toHaveBeenCalledTimes(2)
    expect(vi.mocked(transitionToPendingAck).mock.calls.map((c) => c[0].commitmentId)).toEqual([
      COMP_A,
      COMP_B,
    ])
  })

  it('sweeps an obligation the model did NOT name, even when it named another', async () => {
    // Directly pins that the emission's id is not consulted for targeting: the
    // only row open is one the model never mentioned, and it still moves.
    vi.mocked(transitionToPendingAck).mockResolvedValue(won(COMP_B))
    const r = await call({
      arrivalCapture: { signal: 'imminent', referencesCommitmentId: COMP_A },
      activeCommitments: [commitment({ id: COMP_B })],
    })
    expect(r.kind).toBe('imminent_won')
    expect(vi.mocked(transitionToPendingAck).mock.calls[0][0].commitmentId).toBe(COMP_B)
  })

  it('gives every swept row the SAME arrival time, and it is `now`', async () => {
    // One guest walking in is one arrival event. Two rows stamped a few
    // milliseconds apart would read as two visits to anything that later
    // groups on the timestamp.
    //
    // The VALUE is asserted, not just the equality between the two. Comparing
    // the calls to each other alone is satisfied by any constant — a mutant
    // stamping every row with the epoch passed it — and `expected_arrival` is
    // what the morning-of cron fires on and what the push body renders. "An
    // arrival stamped for 1am" is half the incident this ticket is about.
    vi.mocked(transitionToPendingAck).mockResolvedValueOnce(won(COMP_A)).mockResolvedValueOnce(won(COMP_B))
    await call({
      activeCommitments: [commitment({ id: COMP_A }), commitment({ id: COMP_B })],
    })
    const calls = vi.mocked(transitionToPendingAck).mock.calls
    expect(calls[0][0].expectedArrival.toISOString()).toBe(DURING_SERVICE.toISOString())
    expect(calls[1][0].expectedArrival.toISOString()).toBe(DURING_SERVICE.toISOString())
  })

  it('scopes EVERY write to this venue and guest, not just the first', async () => {
    vi.mocked(transitionToPendingAck).mockResolvedValueOnce(won(COMP_A)).mockResolvedValueOnce(won(COMP_B))
    await call({
      activeCommitments: [commitment({ id: COMP_A }), commitment({ id: COMP_B })],
    })
    for (const c of vi.mocked(transitionToPendingAck).mock.calls) {
      expect(c[0]).toMatchObject({ venueId: VENUE_ID, guestId: GUEST_ID })
    }
  })

  it('sweeps every open obligation on a SCHEDULED signal too', async () => {
    // Ruling 5 is not scoped to `imminent`. A mutant slicing the scheduled
    // target list to one passed every other test in this file.
    vi.mocked(scheduleArrival).mockResolvedValueOnce(won(COMP_A)).mockResolvedValueOnce(won(COMP_B))
    const r = await call({
      arrivalCapture: {
        signal: 'scheduled',
        expectedArrival: '2026-09-23T15:00:00Z',
        referencesCommitmentId: COMP_A,
      },
      activeCommitments: [commitment({ id: COMP_A }), commitment({ id: COMP_B })],
    })
    expect(scheduleArrival).toHaveBeenCalledTimes(2)
    expect(r.kind).toBe('scheduled_recorded')
    if (r.kind !== 'scheduled_recorded') return
    expect(r.commitmentRows.map((x) => x.id)).toEqual([COMP_A, COMP_B])
    expect(r.failedCount).toBe(0)
  })
})

describe('the arrival time written to each row', () => {
  it('uses the emitted time on a scheduled signal', async () => {
    vi.mocked(scheduleArrival).mockResolvedValue(won(COMP_A))
    await call({
      arrivalCapture: {
        signal: 'scheduled',
        expectedArrival: '2026-09-23T15:00:00Z',
        referencesCommitmentId: COMP_A,
      },
    })
    expect(vi.mocked(scheduleArrival).mock.calls[0][0].expectedArrival.toISOString()).toBe(
      new Date('2026-09-23T15:00:00Z').toISOString(),
    )
  })

  it('uses `now` on an imminent signal that carried no time', async () => {
    vi.mocked(transitionToPendingAck).mockResolvedValue(won(COMP_A))
    await call()
    expect(
      vi.mocked(transitionToPendingAck).mock.calls[0][0].expectedArrival.toISOString(),
    ).toBe(DURING_SERVICE.toISOString())
  })

  it('uses the emitted time on an imminent signal that carried one', async () => {
    vi.mocked(transitionToPendingAck).mockResolvedValue(won(COMP_A))
    await call({
      arrivalCapture: {
        signal: 'imminent',
        expectedArrival: '2026-09-22T17:20:00Z',
        referencesCommitmentId: COMP_A,
      },
    })
    expect(
      vi.mocked(transitionToPendingAck).mock.calls[0][0].expectedArrival.toISOString(),
    ).toBe(new Date('2026-09-22T17:20:00Z').toISOString())
  })

  it('falls back to `now` when an imminent time is unparseable', async () => {
    // A malformed timestamp from the model must not fail the dispatch, and
    // must not land an Invalid Date in expected_arrival.
    vi.mocked(transitionToPendingAck).mockResolvedValue(won(COMP_A))
    await call({
      arrivalCapture: {
        signal: 'imminent',
        expectedArrival: 'sometime-ish',
        referencesCommitmentId: COMP_A,
      },
    })
    expect(
      vi.mocked(transitionToPendingAck).mock.calls[0][0].expectedArrival.toISOString(),
    ).toBe(DURING_SERVICE.toISOString())
  })
})

describe('ruling 4(a): recommendations are not obligations', () => {
  it('never touches a recommendation, even when the model named it', async () => {
    const r = await call({
      arrivalCapture: { signal: 'imminent', referencesCommitmentId: RECOMMENDATION },
      activeCommitments: [commitment({ id: RECOMMENDATION, type: 'recommendation', code: null })],
    })
    expect(r).toEqual({ kind: 'no_open_obligations' })
    expect(transitionToPendingAck).not.toHaveBeenCalled()
  })

  it('sweeps the comp and leaves the recommendation alone when both are open', async () => {
    vi.mocked(transitionToPendingAck).mockResolvedValue(won(COMP_A))
    const r = await call({
      activeCommitments: [
        commitment({ id: RECOMMENDATION, type: 'recommendation', code: null }),
        commitment({ id: COMP_A }),
      ],
    })
    expect(r.kind).toBe('imminent_won')
    expect(transitionToPendingAck).toHaveBeenCalledTimes(1)
    expect(vi.mocked(transitionToPendingAck).mock.calls[0][0].commitmentId).toBe(COMP_A)
  })

  it('holds and discounts ARE obligations and are swept', async () => {
    vi.mocked(transitionToPendingAck).mockResolvedValueOnce(won(COMP_A)).mockResolvedValueOnce(won(COMP_B))
    await call({
      activeCommitments: [
        commitment({ id: COMP_A, type: 'hold' }),
        commitment({ id: COMP_B, type: 'discount' }),
      ],
    })
    expect(transitionToPendingAck).toHaveBeenCalledTimes(2)
  })

  it('skips a row that is already pending_ack', async () => {
    const r = await call({
      activeCommitments: [commitment({ status: 'pending_ack' })],
    })
    expect(r).toEqual({ kind: 'no_open_obligations' })
    expect(transitionToPendingAck).not.toHaveBeenCalled()
  })
})

describe('partial and total failure accounting', () => {
  it('reports the rows that moved and counts the ones that did not', async () => {
    // One row erroring must not drop the other: a guest owed two things still
    // has one surfaced, and the failure is counted rather than swallowed.
    vi.mocked(transitionToPendingAck)
      .mockResolvedValueOnce({ ok: false as const, error: 'connection lost', errorCode: 'db_write_failed' })
      .mockResolvedValueOnce(won(COMP_B))

    const r = await call({
      activeCommitments: [commitment({ id: COMP_A }), commitment({ id: COMP_B })],
    })

    expect(r.kind).toBe('imminent_won')
    if (r.kind !== 'imminent_won') return
    expect(r.commitmentRows.map((x) => x.id)).toEqual([COMP_B])
    expect(r.failedCount).toBe(1)
  })

  it('reports failed when every row errored', async () => {
    vi.mocked(transitionToPendingAck).mockResolvedValue({
      ok: false as const,
      error: 'connection lost',
      errorCode: 'db_write_failed',
    })
    const r = await call()
    expect(r.kind).toBe('failed')
    if (r.kind === 'failed') expect(r.errorCode).toBe('db_write_failed')
  })

  it('reports imminent_lost when every CAS lost cleanly', async () => {
    vi.mocked(transitionToPendingAck).mockResolvedValue(LOST)
    const r = await call()
    expect(r).toEqual({ kind: 'imminent_lost' })
  })

  it('prefers the error over a clean loss when both happened', async () => {
    vi.mocked(transitionToPendingAck)
      .mockResolvedValueOnce(LOST)
      .mockResolvedValueOnce({ ok: false as const, error: 'boom', errorCode: 'db_write_threw' })
    const r = await call({
      activeCommitments: [commitment({ id: COMP_A }), commitment({ id: COMP_B })],
    })
    expect(r.kind).toBe('failed')
  })
})
