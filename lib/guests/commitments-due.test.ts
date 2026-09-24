/* eslint-disable @typescript-eslint/no-unused-vars */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// waitUntil is the @vercel/functions primitive we use to fire pushes
// without blocking the cron route's return. Mock to a no-op so tests don't
// pull in Vercel runtime.
const waitUntilMock = vi.fn<(p: Promise<unknown>) => void>()
vi.mock('@vercel/functions', () => ({
  waitUntil: (p: Promise<unknown>) => waitUntilMock(p),
}))

vi.mock('@/lib/db/admin', () => ({
  createAdminClient: vi.fn(),
}))


// Stub the push module — the processor tests assert which rows trigger the
// CAS + push fanout; the actual APNs call isn't under test here.
const sendCommitmentArrivalPushMock = vi.fn<
  (input: unknown) => Promise<void>
>()
vi.mock('@/lib/notifications/send-commitment-push', () => ({
  sendCommitmentArrivalPush: (input: unknown) =>
    sendCommitmentArrivalPushMock(input),
}))

import { createAdminClient } from '@/lib/db/admin'
import { FALLBACK_MORNING_HOUR_LOCAL, processDueCommitments } from './commitments-due'

// 14:00 UTC = 07:00 America/Los_Angeles (PDT, UTC-7 in late May) — morning
// hour for an LA venue. Same instant is 10:00 America/New_York and 23:00
// Asia/Tokyo, so a mixed-venue fleet exercises the per-venue filter.
const NOW = new Date('2026-05-29T14:00:00Z')

const VENUE_LA = 'venue-la'
const VENUE_NYC = 'venue-nyc'
const VENUE_TOKYO = 'venue-tokyo'
const GUEST_ID = 'guest-1'

function makeDueRow(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    guest_id: GUEST_ID,
    venue_id: VENUE_LA,
    type: 'comp',
    description: 'oat latte',
    code: '7K2P',
    status: 'open',
    // Today, in afternoon LA tz — the morning-of model fires this on today's
    // 7am LA tick because the date matches.
    expected_arrival: '2026-05-29T20:00:00Z',
    arrival_signal: 'scheduled',
    created_by: 'agent',
    expires_at: null,
    acknowledged_at: null,
    acknowledged_by: null,
    escalated_at: null,
    redeemed_at: null,
    source_message_id: null,
    created_at: '2026-05-29T00:00:00Z',
    updated_at: '2026-05-29T00:00:00Z',
    ...overrides,
  }
}

// TAC-529: the venues SELECT string, so a test can assert `status` is
// actually requested. See the note on DBState.venues.
let capturedVenueSelect: string | null = null

// State for the supabase mock — handles guest_commitments (select+update),
// venues (select), guests (select).
interface DBState {
  dueRows: unknown[]
  selectError: { message: string } | null
  updateReturnByRowId: Map<string, unknown[]>
  updateErrorByRowId: Map<string, { message: string }>
  /**
   * TAC-529: `status` is REQUIRED, not optional. The mock's select() ignores
   * its argument and returns these rows whatever the query asked for, so a
   * fixture omitting the field reads `undefined`, the halt gate never fires,
   * and every test stays green while the gate is unreachable. Required is
   * what forces each fixture to say which venue it is describing.
   */
  venues: Array<{ id: string; timezone: string; status: string | null }>
  /**
   * venue_configs.venue_info rows. TAC-428: the opening time comes from the
   * venue's own published hours, so a fixture that omits this is a venue with
   * no readable opening time and takes the fallback hour — which is a real
   * state, not a broken fixture, and several tests below rely on it.
   */
  venueConfigs: Array<{ venue_id: string; venue_info: unknown }>
  guests: Array<{ id: string; first_name: string | null }>
}

/** Every day the same range, the shape Le Mil's actually publishes. */
function hoursOpeningAt(range: string): { hours: Record<string, string> } {
  return {
    hours: {
      monday: range,
      tuesday: range,
      wednesday: range,
      thursday: range,
      friday: range,
      saturday: range,
      sunday: range,
    },
  }
}

function newState(overrides: Partial<DBState> = {}): DBState {
  return {
    dueRows: [],
    selectError: null,
    updateReturnByRowId: new Map(),
    updateErrorByRowId: new Map(),
    venues: [
      { id: VENUE_LA, timezone: 'America/Los_Angeles', status: 'active' },
      { id: VENUE_NYC, timezone: 'America/New_York', status: 'active' },
      { id: VENUE_TOKYO, timezone: 'Asia/Tokyo', status: 'active' },
    ],
    // Le Mil's real hours as of 2026-09-22. TAC-508 moves this venue to
    // 8:00 AM on 3 October; the test named for that change overrides it.
    venueConfigs: [
      { venue_id: VENUE_LA, venue_info: hoursOpeningAt('7:00 AM – 3:00 PM') },
      { venue_id: VENUE_NYC, venue_info: hoursOpeningAt('7:00 AM – 3:00 PM') },
      { venue_id: VENUE_TOKYO, venue_info: hoursOpeningAt('7:00 AM – 3:00 PM') },
    ],
    guests: [{ id: GUEST_ID, first_name: 'Jaipal' }],
    ...overrides,
  }
}

function makeMockClient(state: DBState) {
  return {
    from: (table: string) => {
      if (table === 'guest_commitments') {
        return {
          select: (_cols: string) => {
            // SELECT chain for findScheduledOpenCommitments. The new query
            // uses .eq on both status + arrival_signal and .not for the
            // null check, no .lte (the morning-of model's date filter lives
            // in the processor).
            const chain = {
              eq: (_f: string, _v: unknown) => chain,
              not: (_f: string, _op: string, _v: unknown) => chain,
              order: (_f: string, _opts: unknown) =>
                Promise.resolve({
                  data: state.dueRows,
                  error: state.selectError,
                }),
            }
            return chain
          },
          update: (_payload: Record<string, unknown>) => {
            let capturedId: string | null = null
            const chain = {
              eq: (field: string, value: unknown) => {
                if (field === 'id') capturedId = String(value)
                return chain
              },
              select: async () => {
                if (capturedId === null) {
                  return { data: [], error: null }
                }
                const err = state.updateErrorByRowId.get(capturedId)
                if (err) return { data: null, error: err }
                return {
                  data: state.updateReturnByRowId.get(capturedId) ?? [],
                  error: null,
                }
              },
            }
            return chain
          },
        }
      }
      if (table === 'venues') {
        return {
          select: (cols: string) => ({
            in: async (_field: string, values: unknown[]) => {
              // TAC-529: dropping `status` from the query makes the gate read
              // `undefined` and go inert, which no behavioural test can see
              // because this mock ignores `cols`.
              capturedVenueSelect = cols
              return {
                data: state.venues.filter((v) =>
                  (values as string[]).includes(v.id),
                ),
                error: null,
              }
            },
          }),
        }
      }
      if (table === 'venue_configs') {
        return {
          select: (_cols: string) => ({
            in: async (_field: string, values: unknown[]) => ({
              data: state.venueConfigs.filter((c) =>
                (values as string[]).includes(c.venue_id),
              ),
              error: null,
            }),
          }),
        }
      }
      if (table === 'guests') {
        return {
          select: (_cols: string) => ({
            in: async (_field: string, _values: unknown[]) => ({
              data: state.guests,
              error: null,
            }),
          }),
        }
      }
      throw new Error(`Unmocked table ${table}`)
    },
  }
}

beforeEach(() => {
  capturedVenueSelect = null
  waitUntilMock.mockReset()
  sendCommitmentArrivalPushMock.mockReset()
  sendCommitmentArrivalPushMock.mockResolvedValue(undefined)
  vi.mocked(createAdminClient).mockReset()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('FALLBACK_MORNING_HOUR_LOCAL', () => {
  it('is 7, and is now only the fallback for unreadable hours (TAC-428)', () => {
    expect(FALLBACK_MORNING_HOUR_LOCAL).toBe(7)
  })
})

describe('processDueCommitments — empty + zero-counts', () => {
  it('returns zero counts when no rows are due', async () => {
    const state = newState({ dueRows: [] })
    vi.mocked(createAdminClient).mockReturnValue(
      makeMockClient(state) as unknown as ReturnType<typeof createAdminClient>,
    )
    const r = await processDueCommitments(NOW)
    expect(r.scanned).toBe(0)
    expect(r.transitioned).toBe(0)
    expect(r.pushed).toBe(0)
    expect(r.beforeOpening).toBe(0)
    expect(r.future).toBe(0)
    expect(sendCommitmentArrivalPushMock).not.toHaveBeenCalled()
    expect(waitUntilMock).not.toHaveBeenCalled()
  })
})

describe('processDueCommitments — morning-hour-per-venue gate', () => {
  it('fires for the LA-tz venue at 07:00 PDT (14:00 UTC)', async () => {
    const row = makeDueRow('cmt-la')
    const transitionedRow = { ...row, status: 'pending_ack' }
    const state = newState({
      dueRows: [row],
      updateReturnByRowId: new Map([['cmt-la', [transitionedRow]]]),
    })
    vi.mocked(createAdminClient).mockReturnValue(
      makeMockClient(state) as unknown as ReturnType<typeof createAdminClient>,
    )
    const r = await processDueCommitments(NOW)
    expect(r.scanned).toBe(1)
    expect(r.transitioned).toBe(1)
    expect(r.pushed).toBe(1)
    expect(r.beforeOpening).toBe(0)
    expect(sendCommitmentArrivalPushMock).toHaveBeenCalledOnce()
  })

  // TAC-428 REVERSAL. This venue opens at 07:00 local and the tick lands at
  // 10:00 local, past opening. Before TAC-428 the gate demanded the tick land
  // IN the firing hour, so this counted as notMorningHour and the push never
  // went out; that exact-hour demand is what GitHub's scheduler stopped being
  // able to satisfy. Now it is the catch-up, and it fires.
  it('FIRES for a NYC-tz venue at 10:00 EDT — past opening, same day (TAC-428)', async () => {
    const row = makeDueRow('cmt-nyc', { venue_id: VENUE_NYC })
    const state = newState({
      dueRows: [row],
      updateReturnByRowId: new Map([['cmt-nyc', [{ ...row, status: 'pending_ack' }]]]),
    })
    vi.mocked(createAdminClient).mockReturnValue(
      makeMockClient(state) as unknown as ReturnType<typeof createAdminClient>,
    )
    const r = await processDueCommitments(NOW)
    expect(r.transitioned).toBe(1)
    expect(r.pushed).toBe(1)
    expect(r.beforeOpening).toBe(0)
  })

  // TAC-428 REVERSAL, and the same-day bound doing its job. 14:00Z is 23:00
  // JST, which is past this venue's opening, so clause 1 passes. It is held by
  // clause 2 instead: the arrival (20:00Z) is 05:00 JST on the FOLLOWING Tokyo
  // day, so it fires at that day's opening, not tonight. Before TAC-428 this
  // was held by the hour gate and the date was never reached.
  it('holds a Tokyo-tz venue at 23:00 JST as FUTURE, not before-opening (TAC-428)', async () => {
    const row = makeDueRow('cmt-tokyo', { venue_id: VENUE_TOKYO })
    const state = newState({ dueRows: [row] })
    vi.mocked(createAdminClient).mockReturnValue(
      makeMockClient(state) as unknown as ReturnType<typeof createAdminClient>,
    )
    const r = await processDueCommitments(NOW)
    expect(r.future).toBe(1)
    expect(r.beforeOpening).toBe(0)
    expect(r.transitioned).toBe(0)
    expect(sendCommitmentArrivalPushMock).not.toHaveBeenCalled()
  })

  // TAC-428 REVERSAL. LA (07:00 local, opening) and NYC (10:00 local, past
  // opening) both fire now; only Tokyo is held, and by the date rather than
  // the hour.
  it('fires LA and NYC on the same tick and holds Tokyo for its own day (TAC-428)', async () => {
    const la = makeDueRow('cmt-la')
    const nyc = makeDueRow('cmt-nyc', { venue_id: VENUE_NYC })
    const tokyo = makeDueRow('cmt-tokyo', { venue_id: VENUE_TOKYO })
    const state = newState({
      dueRows: [la, nyc, tokyo],
      updateReturnByRowId: new Map([
        ['cmt-la', [{ ...la, status: 'pending_ack' }]],
        ['cmt-nyc', [{ ...nyc, status: 'pending_ack' }]],
      ]),
    })
    vi.mocked(createAdminClient).mockReturnValue(
      makeMockClient(state) as unknown as ReturnType<typeof createAdminClient>,
    )
    const r = await processDueCommitments(NOW)
    expect(r.scanned).toBe(3)
    expect(r.transitioned).toBe(2)
    expect(r.pushed).toBe(2)
    expect(r.future).toBe(1)
  })
})

describe('processDueCommitments — date-of-expected-arrival gate', () => {
  it('fires when expected_arrival date in venue tz === today (venue tz)', async () => {
    // expected_arrival 20:00 UTC on 2026-05-29 = 13:00 PDT same day → today (LA)
    const row = makeDueRow('cmt-today', {
      expected_arrival: '2026-05-29T20:00:00Z',
    })
    const transitionedRow = { ...row, status: 'pending_ack' }
    const state = newState({
      dueRows: [row],
      updateReturnByRowId: new Map([['cmt-today', [transitionedRow]]]),
    })
    vi.mocked(createAdminClient).mockReturnValue(
      makeMockClient(state) as unknown as ReturnType<typeof createAdminClient>,
    )
    const r = await processDueCommitments(NOW)
    expect(r.transitioned).toBe(1)
    expect(r.future).toBe(0)
  })

  // TAC-428 REVERSAL, and the confirmed investigation-2 defect closed.
  // Before this, the date filter was `expected_date <= today`, so a missed day
  // fired on a later morning — and buildArrivalContext buckets only the
  // hour-of-day, so it announced a two-day-old arrival as "this morning".
  // Catch-up is bounded to the same venue-local day now, per the 2026-09-17
  // ruling, and this is refused rather than announced late.
  it('REFUSES a commitment whose arrival day has fully passed (TAC-428)', async () => {
    // expected_arrival 16:00 UTC on 2026-05-27 = 09:00 PDT, two days before NOW.
    const row = makeDueRow('cmt-pastdue', {
      expected_arrival: '2026-05-27T16:00:00Z',
    })
    const state = newState({ dueRows: [row] })
    vi.mocked(createAdminClient).mockReturnValue(
      makeMockClient(state) as unknown as ReturnType<typeof createAdminClient>,
    )
    const r = await processDueCommitments(NOW)
    expect(r.arrivalDayPassed).toBe(1)
    expect(r.transitioned).toBe(0)
    expect(r.pushed).toBe(0)
    expect(sendCommitmentArrivalPushMock).not.toHaveBeenCalled()
  })

  it('skips FUTURE — expected_arrival date in venue tz is tomorrow', async () => {
    // expected_arrival 10:00 UTC on 2026-05-30 = 03:00 PDT 2026-05-30 (tomorrow in LA)
    const row = makeDueRow('cmt-tomorrow', {
      expected_arrival: '2026-05-30T10:00:00Z',
    })
    const state = newState({ dueRows: [row] })
    vi.mocked(createAdminClient).mockReturnValue(
      makeMockClient(state) as unknown as ReturnType<typeof createAdminClient>,
    )
    const r = await processDueCommitments(NOW)
    expect(r.scanned).toBe(1)
    expect(r.future).toBe(1)
    expect(r.transitioned).toBe(0)
    expect(r.pushed).toBe(0)
    expect(sendCommitmentArrivalPushMock).not.toHaveBeenCalled()
  })

  it('fires for a same-UTC-day-but-late-PDT-day expected_arrival (boundary near midnight)', async () => {
    // expected_arrival 06:00 UTC 2026-05-30 = 23:00 PDT 2026-05-29 (still today, LA)
    const row = makeDueRow('cmt-late-night', {
      expected_arrival: '2026-05-30T06:00:00Z',
    })
    const transitionedRow = { ...row, status: 'pending_ack' }
    const state = newState({
      dueRows: [row],
      updateReturnByRowId: new Map([['cmt-late-night', [transitionedRow]]]),
    })
    vi.mocked(createAdminClient).mockReturnValue(
      makeMockClient(state) as unknown as ReturnType<typeof createAdminClient>,
    )
    const r = await processDueCommitments(NOW)
    expect(r.transitioned).toBe(1)
    expect(r.future).toBe(0)
  })
})

describe('processDueCommitments — CAS-rowcount-gates push', () => {
  it('transitioned=true fires push exactly once with sourced fields', async () => {
    const row = makeDueRow('cmt-cas-win')
    const transitionedRow = {
      ...row,
      status: 'pending_ack',
      arrival_signal: 'scheduled',
    }
    const state = newState({
      dueRows: [row],
      updateReturnByRowId: new Map([['cmt-cas-win', [transitionedRow]]]),
    })
    vi.mocked(createAdminClient).mockReturnValue(
      makeMockClient(state) as unknown as ReturnType<typeof createAdminClient>,
    )
    const r = await processDueCommitments(NOW)
    expect(r.pushed).toBe(1)
    expect(waitUntilMock).toHaveBeenCalledOnce()
    expect(sendCommitmentArrivalPushMock).toHaveBeenCalledOnce()
    const call = sendCommitmentArrivalPushMock.mock.calls[0][0] as {
      commitmentId: string
      type: string
      arrivalSignal: string
      venueTimezone: string
      agentRunId: string | null
    }
    expect(call.commitmentId).toBe('cmt-cas-win')
    expect(call.type).toBe('comp')
    expect(call.arrivalSignal).toBe('scheduled')
    expect(call.venueTimezone).toBe('America/Los_Angeles')
    expect(call.agentRunId).toBeNull()
  })

  it('transitioned=false (CAS lost, e.g. racing imminent inbound) skips push', async () => {
    const row = makeDueRow('cmt-cas-lose')
    const state = newState({
      dueRows: [row],
      updateReturnByRowId: new Map([['cmt-cas-lose', []]]),
    })
    vi.mocked(createAdminClient).mockReturnValue(
      makeMockClient(state) as unknown as ReturnType<typeof createAdminClient>,
    )
    const r = await processDueCommitments(NOW)
    expect(r.transitioned).toBe(0)
    expect(r.skipped).toBe(1)
    expect(r.pushed).toBe(0)
    expect(waitUntilMock).not.toHaveBeenCalled()
  })

  it('errored row logs + continues; summary counts the rest', async () => {
    const row1 = makeDueRow('cmt-err')
    const row2 = makeDueRow('cmt-ok')
    const transitionedRow2 = { ...row2, status: 'pending_ack' }
    const state = newState({
      dueRows: [row1, row2],
      updateErrorByRowId: new Map([['cmt-err', { message: 'connection lost' }]]),
      updateReturnByRowId: new Map([['cmt-ok', [transitionedRow2]]]),
    })
    vi.mocked(createAdminClient).mockReturnValue(
      makeMockClient(state) as unknown as ReturnType<typeof createAdminClient>,
    )
    const r = await processDueCommitments(NOW)
    expect(r.scanned).toBe(2)
    expect(r.errored).toBe(1)
    expect(r.transitioned).toBe(1)
    expect(r.pushed).toBe(1)
  })
})

describe('processDueCommitments — defensive belt-and-suspenders', () => {
  it('drops a row whose arrival_signal is null (data integrity)', async () => {
    const row = makeDueRow('cmt-invalid-signal', { arrival_signal: null })
    const state = newState({ dueRows: [row] })
    vi.mocked(createAdminClient).mockReturnValue(
      makeMockClient(state) as unknown as ReturnType<typeof createAdminClient>,
    )
    const r = await processDueCommitments(NOW)
    expect(r.invalid).toBe(1)
    expect(r.transitioned).toBe(0)
  })

  it('drops a row whose arrival_signal is imminent (must never reach the cron)', async () => {
    const row = makeDueRow('cmt-imminent-leak', {
      arrival_signal: 'imminent',
    })
    const state = newState({ dueRows: [row] })
    vi.mocked(createAdminClient).mockReturnValue(
      makeMockClient(state) as unknown as ReturnType<typeof createAdminClient>,
    )
    const r = await processDueCommitments(NOW)
    expect(r.invalid).toBe(1)
    expect(r.transitioned).toBe(0)
  })

  it('drops a row whose venue timezone is missing from the lookup', async () => {
    const row = makeDueRow('cmt-tz-miss', { venue_id: 'venue-unknown' })
    const state = newState({ dueRows: [row], venues: [] })
    vi.mocked(createAdminClient).mockReturnValue(
      makeMockClient(state) as unknown as ReturnType<typeof createAdminClient>,
    )
    const r = await processDueCommitments(NOW)
    expect(r.invalid).toBe(1)
    expect(r.transitioned).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// TAC-428: the push fires at the venue's OPENING time, not a fixed 07:00.
//
// NOW is 14:00 UTC = 07:00 PDT at VENUE_LA. That is deliberately the hour the
// old constant used, so every assertion here is about the venue's own hours
// deciding rather than the constant happening to agree with them.
// ---------------------------------------------------------------------------
describe('opening time decides when the arrival push fires (TAC-428)', () => {
  function laRow(id: string, overrides: Record<string, unknown> = {}) {
    return makeDueRow(id, overrides)
  }

  function stateWithHours(row: ReturnType<typeof makeDueRow>, range: string | null) {
    const base = newState({
      dueRows: [row],
      updateReturnByRowId: new Map([[row.id, [{ ...row, status: 'pending_ack' }]]]),
    })
    return {
      ...base,
      venueConfigs:
        range === null
          ? base.venueConfigs.filter((c) => c.venue_id !== VENUE_LA)
          : [
              { venue_id: VENUE_LA, venue_info: hoursOpeningAt(range) },
              ...base.venueConfigs.filter((c) => c.venue_id !== VENUE_LA),
            ],
    }
  }

  function run(state: ReturnType<typeof newState>) {
    vi.mocked(createAdminClient).mockReturnValue(
      makeMockClient(state) as unknown as ReturnType<typeof createAdminClient>,
    )
    return processDueCommitments(NOW)
  }

  it('fires at 07:00 local for a venue that opens at 07:00', async () => {
    const r = await run(stateWithHours(laRow('cmt-open7'), '7:00 AM – 3:00 PM'))
    expect(r.transitioned).toBe(1)
    expect(r.pushed).toBe(1)
  })

  // TAC-508 moves Le Mil's to 8:00 AM on 3 October. This is the behaviour
  // change that lands at the live venue within days of this ticket, and the
  // reason the opening-hour fix was folded in rather than deferred: at 07:00
  // local the doors are shut, and the old constant pushed anyway.
  it('does NOT fire at 07:00 local once the venue opens at 08:00 (TAC-508, 3 Oct)', async () => {
    const r = await run(stateWithHours(laRow('cmt-open8'), '8:00 AM – 3:00 PM'))
    expect(r.beforeOpening).toBe(1)
    expect(r.transitioned).toBe(0)
    expect(r.pushed).toBe(0)
    expect(sendCommitmentArrivalPushMock).not.toHaveBeenCalled()
  })

  it('fires at 08:00 local for that same 08:00-opening venue', async () => {
    const state = stateWithHours(laRow('cmt-open8'), '8:00 AM – 3:00 PM')
    vi.mocked(createAdminClient).mockReturnValue(
      makeMockClient(state) as unknown as ReturnType<typeof createAdminClient>,
    )
    // 15:00 UTC = 08:00 PDT.
    const r = await processDueCommitments(new Date('2026-05-29T15:00:00Z'))
    expect(r.transitioned).toBe(1)
    expect(r.pushed).toBe(1)
  })

  it('fires at 07:00 local for a venue that opens EARLIER, at 06:00', async () => {
    // The old constant was wrong in this direction too: it withheld the push
    // for an hour after the doors were already open.
    const r = await run(stateWithHours(laRow('cmt-open6'), '6:00 AM – 3:00 PM'))
    expect(r.transitioned).toBe(1)
    expect(r.pushed).toBe(1)
  })

  it('holds until the half-hour opening is reached, not the hour', async () => {
    const state = stateWithHours(laRow('cmt-half'), '7:30 AM – 3:00 PM')
    vi.mocked(createAdminClient).mockReturnValue(
      makeMockClient(state) as unknown as ReturnType<typeof createAdminClient>,
    )
    // 07:00 PDT is before 07:30.
    expect((await processDueCommitments(NOW)).beforeOpening).toBe(1)
  })

  // UNREADABLE HOURS FALL BACK AND PUSH. Per the 2026-09-22 ruling: we could
  // not read them, and a push nobody needed costs less than a guest arriving
  // unannounced.
  it.each([
    ['an unparseable value', 'ask at the counter'],
    ['a value that is only a placeholder dash', '-'],
  ])('falls back to the fixed hour and pushes on %s', async (_label, range) => {
    const r = await run(stateWithHours(laRow('cmt-fallback'), range))
    expect(r.openingTimeUnreadable).toBe(1)
    expect(r.venueClosedToday).toBe(0)
    expect(r.transitioned).toBe(1)
    expect(r.pushed).toBe(1)
  })

  // A STATED CLOSURE PUSHES NOTHING (ruled 2026-09-23, correcting how this
  // first shipped). It is the opposite case, not the same one: unknown hours
  // are guessed past because we could not read them, where a closure is a read
  // fact and guessing 07:00 past it discards the only thing it told us. If a
  // scheduled arrival is left unannounced on a day the venue says it is shut,
  // the ARRIVAL is the defect; a "this morning" push makes it worse.
  it.each([
    ['a bare Closed', 'Closed'],
    ["the venue-spec parser's own Closed – Closed row", 'Closed – Closed'],
  ])('pushes NOTHING when the venue states it is closed today: %s', async (_label, range) => {
    const r = await run(stateWithHours(laRow('cmt-closed'), range))
    expect(r.venueClosedToday).toBe(1)
    expect(r.openingTimeUnreadable).toBe(0)
    expect(r.transitioned).toBe(0)
    expect(r.pushed).toBe(0)
    expect(sendCommitmentArrivalPushMock).not.toHaveBeenCalled()
  })

  // The two outcomes must stay distinguishable in the summary. Collapsing them
  // is precisely the change that was ruled against, and a caller reading only
  // "did it push" cannot tell a venue that was shut from one whose hours
  // nobody filled in.
  it('counts a closed venue and an unreadable one under different outcomes', async () => {
    const closed = await run(stateWithHours(laRow('cmt-c'), 'Closed'))
    const unreadable = await run(stateWithHours(laRow('cmt-u'), 'ask at the counter'))
    expect(closed.venueClosedToday).toBe(1)
    expect(closed.openingTimeUnreadable).toBe(0)
    expect(unreadable.venueClosedToday).toBe(0)
    expect(unreadable.openingTimeUnreadable).toBe(1)
  })

  it('falls back to the fixed hour when the venue has no venue_configs row at all', async () => {
    const r = await run(stateWithHours(laRow('cmt-noconfig'), null))
    expect(r.openingTimeUnreadable).toBe(1)
    expect(r.transitioned).toBe(1)
    expect(r.pushed).toBe(1)
  })

  it('still refuses before the FALLBACK hour when hours are unreadable', async () => {
    const state = stateWithHours(laRow('cmt-fallback-early'), 'ask at the counter')
    vi.mocked(createAdminClient).mockReturnValue(
      makeMockClient(state) as unknown as ReturnType<typeof createAdminClient>,
    )
    // 13:00 UTC = 06:00 PDT, before the 07:00 fallback.
    const r = await processDueCommitments(new Date('2026-05-29T13:00:00Z'))
    expect(r.beforeOpening).toBe(1)
    expect(r.pushed).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// TAC-428: an arrival push never fires after the arrival it announces.
// ---------------------------------------------------------------------------
describe('an arrival push never fires after the arrival (TAC-428)', () => {
  function run(state: ReturnType<typeof newState>, now: Date) {
    vi.mocked(createAdminClient).mockReturnValue(
      makeMockClient(state) as unknown as ReturnType<typeof createAdminClient>,
    )
    return processDueCommitments(now)
  }

  it('refuses when the arrival was earlier today, at or after opening', async () => {
    // Arrival 16:00 UTC = 09:00 PDT; the tick is 18:00 UTC = 11:00 PDT.
    const row = makeDueRow('cmt-gone', { expected_arrival: '2026-05-29T16:00:00Z' })
    const r = await run(newState({ dueRows: [row] }), new Date('2026-05-29T18:00:00Z'))
    expect(r.arrivalPassed).toBe(1)
    expect(r.transitioned).toBe(0)
    expect(sendCommitmentArrivalPushMock).not.toHaveBeenCalled()
  })

  it('still fires while the arrival is ahead of the tick', async () => {
    const row = makeDueRow('cmt-ahead', { expected_arrival: '2026-05-29T20:00:00Z' })
    const state = newState({
      dueRows: [row],
      updateReturnByRowId: new Map([['cmt-ahead', [{ ...row, status: 'pending_ack' }]]]),
    })
    const r = await run(state, new Date('2026-05-29T18:00:00Z'))
    expect(r.transitioned).toBe(1)
    expect(r.arrivalPassed).toBe(0)
  })

  // The carve-out, and the reason folding the opening-hour fix in resolved the
  // gap rather than creating one. An arrival before the doors open is one
  // nobody could have been ready for, so it is announced AT opening and is
  // never treated as already past. Without this the guest who says "I'll come
  // at 6" to a venue opening at 7 produces no push at all.
  it('ANNOUNCES an arrival earlier than opening, at opening, rather than calling it past', async () => {
    // Arrival 13:00 UTC = 06:00 PDT, an hour before the 07:00 opening.
    // The tick is 07:00 PDT, which is already after the arrival instant.
    const row = makeDueRow('cmt-preopen', { expected_arrival: '2026-05-29T13:00:00Z' })
    const state = newState({
      dueRows: [row],
      updateReturnByRowId: new Map([['cmt-preopen', [{ ...row, status: 'pending_ack' }]]]),
    })
    const r = await run(state, NOW)
    expect(r.transitioned).toBe(1)
    expect(r.pushed).toBe(1)
    expect(r.arrivalPassed).toBe(0)
  })

  it('does not extend that carve-out to an arrival on a previous day', async () => {
    // 06:00 PDT the day BEFORE. Before-opening by the clock, but clause 2
    // holds it first: catch-up never crosses a venue-local day.
    const row = makeDueRow('cmt-preopen-yesterday', {
      expected_arrival: '2026-05-28T13:00:00Z',
    })
    const r = await run(newState({ dueRows: [row] }), NOW)
    expect(r.arrivalDayPassed).toBe(1)
    expect(r.transitioned).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// TAC-428 code-review follow-ups. Each of these was a hole a mutant walked
// through, or a case the reviewer reproduced against a Le Mil's-shaped venue.
// ---------------------------------------------------------------------------
describe('TAC-428 review: gaps the first pass left', () => {
  function laState(row: ReturnType<typeof makeDueRow>, range: string, transitions = true) {
    const base = newState({
      dueRows: [row],
      updateReturnByRowId: transitions
        ? new Map([[row.id, [{ ...row, status: 'pending_ack' }]]])
        : new Map(),
    })
    return {
      ...base,
      venueConfigs: [
        { venue_id: VENUE_LA, venue_info: hoursOpeningAt(range) },
        ...base.venueConfigs.filter((c) => c.venue_id !== VENUE_LA),
      ],
    }
  }
  function run(state: ReturnType<typeof newState>, now: Date) {
    vi.mocked(createAdminClient).mockReturnValue(
      makeMockClient(state) as unknown as ReturnType<typeof createAdminClient>,
    )
    return processDueCommitments(now)
  }

  // The earlier-opening half of the fix had NO test that could fail: the
  // existing one ticks at 07:00, where a 06:00 opening and the 07:00 fallback
  // agree. Mutation-proven — clamping the resolved opening up to the constant
  // with Math.max passed all 151 tests across the five changed files. This
  // ticks at 06:00, where only the venue's real hours can produce a push.
  it('fires at 06:00 local for a venue that opens at 06:00 (kills the clamp mutant)', async () => {
    const r = await run(
      laState(makeDueRow('cmt-open6-at6'), '6:00 AM – 3:00 PM'),
      new Date('2026-05-29T13:00:00Z'), // 06:00 PDT
    )
    expect(r.transitioned).toBe(1)
    expect(r.pushed).toBe(1)
    expect(r.beforeOpening).toBe(0)
  })

  // The reviewer's reproduction A. The pre-opening carve-out disabled the
  // past-arrival check for the WHOLE day, so a 06:00 arrival caught up on a
  // 14:00 tick pushed "arriving this morning" at 2pm — the investigation-2
  // defect arriving through clause 3 instead of clause 2.
  it('refuses a pre-opening arrival on a LATE tick, not just a passed-day one', async () => {
    const row = makeDueRow('cmt-preopen-late', {
      expected_arrival: '2026-05-29T13:00:00Z', // 06:00 PDT, before the 07:00 opening
    })
    const r = await run(
      laState(row, '7:00 AM – 3:00 PM', false),
      new Date('2026-05-29T21:00:00Z'), // 14:00 PDT
    )
    expect(r.arrivalPassed).toBe(1)
    expect(r.transitioned).toBe(0)
    expect(sendCommitmentArrivalPushMock).not.toHaveBeenCalled()
  })

  it('still announces that pre-opening arrival on the opening tick itself', async () => {
    const row = makeDueRow('cmt-preopen-ontime', {
      expected_arrival: '2026-05-29T13:00:00Z', // 06:00 PDT
    })
    const r = await run(laState(row, '7:00 AM – 3:00 PM'), NOW) // 07:00 PDT
    expect(r.transitioned).toBe(1)
    expect(r.arrivalPassed).toBe(0)
  })

  // An overnight range makes openMin large (17:00 = 1020), which is where an
  // unbounded carve-out did most damage: it stayed live until midnight, so a
  // 01:00 arrival could be announced 16 hours late. The grace bounds it to the
  // opening tick.
  //
  // KNOWN AND ACCEPTED, stated so it is not mistaken for an oversight: inside
  // the grace this still announces a 01:00 arrival, and buildArrivalContext
  // buckets on hour-of-day alone, so the push reads "this morning" at 17:30.
  // That is the push's WORDING, which this ticket is scoped out of changing,
  // and it is reachable only at an overnight venue — none exists today.
  it('refuses a pre-opening arrival at an overnight venue once the grace is past', async () => {
    const row = makeDueRow('cmt-overnight', {
      expected_arrival: '2026-05-29T08:00:00Z', // 01:00 PDT
    })
    const r = await run(
      laState(row, '5:00 PM – 2:00 AM', false),
      new Date('2026-05-30T02:00:00Z'), // 19:00 PDT, two hours past opening
    )
    expect(r.arrivalPassed).toBe(1)
    expect(sendCommitmentArrivalPushMock).not.toHaveBeenCalled()
  })

  it('announces that same overnight arrival on the opening tick', async () => {
    const row = makeDueRow('cmt-overnight-ontime', {
      expected_arrival: '2026-05-29T08:00:00Z', // 01:00 PDT
    })
    const r = await run(
      laState(row, '5:00 PM – 2:00 AM'),
      new Date('2026-05-30T00:00:00Z'), // 17:00 PDT, exactly opening
    )
    expect(r.transitioned).toBe(1)
    expect(r.arrivalPassed).toBe(0)
  })

  // "I'll come by when you open at 7" stamps expected_arrival at exactly the
  // opening minute. A strict `<` refused it, because the first eligible tick
  // is at or after opening and so is never strictly before the arrival — and
  // it is among the commonest phrasings a scheduled arrival takes.
  it('announces an arrival stamped at exactly the opening minute', async () => {
    const row = makeDueRow('cmt-at-opening', {
      expected_arrival: '2026-05-29T14:00:00Z', // exactly 07:00 PDT
    })
    const r = await run(laState(row, '7:00 AM – 3:00 PM'), NOW)
    expect(r.transitioned).toBe(1)
    expect(r.pushed).toBe(1)
    expect(r.arrivalPassed).toBe(0)
  })

  // Clause ordering: the date gate runs before the opening lookup, so a row
  // whose arrival is days away does not take a warn and an
  // openingTimeUnreadable increment on every tick until then.
  it('counts a future-dated row as future, without touching the opening lookup', async () => {
    const row = makeDueRow('cmt-future-noconfig', {
      expected_arrival: '2026-05-30T20:00:00Z',
    })
    const base = newState({ dueRows: [row] })
    const state = {
      ...base,
      venueConfigs: base.venueConfigs.filter((c) => c.venue_id !== VENUE_LA),
    }
    const r = await run(state, NOW)
    expect(r.future).toBe(1)
    expect(r.openingTimeUnreadable).toBe(0)
  })
})


// TAC-529. Pausing a venue has to stop the arrival heads-up too, or it is a
// switch that does not do what its name says.
//
// The load-bearing assertion in most of these is that the UPDATE never ran:
// transitionToPendingAck is a CAS, and flipping a commitment to `pending_ack`
// and then not pushing would leave the row marked "guest arriving" with
// nobody told. A `pushed === 0` assertion alone would pass for a gate placed
// after the CAS, which is the worst of the three possible placements.
describe('processDueCommitments — venue status gate (TAC-529)', () => {
  function stateWithStatus(status: string | null) {
    const row = makeDueRow('cmt-la')
    const transitionedRow = { ...row, status: 'pending_ack' }
    return newState({
      dueRows: [row],
      updateReturnByRowId: new Map([['cmt-la', [transitionedRow]]]),
      venues: [{ id: VENUE_LA, timezone: 'America/Los_Angeles', status }],
    })
  }

  function run(status: string | null) {
    const state = stateWithStatus(status)
    vi.mocked(createAdminClient).mockReturnValue(
      makeMockClient(state) as unknown as ReturnType<typeof createAdminClient>,
    )
    return processDueCommitments(NOW)
  }

  it.each(['paused', 'archived'])(
    'does not announce an arrival at a %s venue, and does not transition it',
    async (status) => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const r = await run(status)
      expect(r.venueHalted).toBe(1)
      expect(r.transitioned).toBe(0)
      expect(r.pushed).toBe(0)
      expect(sendCommitmentArrivalPushMock).not.toHaveBeenCalled()
      // The CAS never ran, so no row is left saying "guest arriving".
      expect(waitUntilMock).not.toHaveBeenCalled()
      warn.mockRestore()
    },
  )

  // The live-data test, same as the engine's. Le Mil's is 'pending' in
  // production and both mocks are 'active', so an allow-list on 'active'
  // would have stopped arrival pushes at the only real venue.
  it('DOES announce at a pending venue, because the live venue is pending', async () => {
    const r = await run('pending')
    expect(r.venueHalted).toBe(0)
    expect(r.transitioned).toBe(1)
    expect(r.pushed).toBe(1)
    expect(sendCommitmentArrivalPushMock).toHaveBeenCalledOnce()
  })

  it('announces at an active venue', async () => {
    const r = await run('active')
    expect(r.venueHalted).toBe(0)
    expect(r.pushed).toBe(1)
  })

  it('announces at a venue whose status it cannot read', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const r = await run('suspended')
    expect(r.venueHalted).toBe(0)
    expect(r.pushed).toBe(1)
    warn.mockRestore()
  })

  it('announces at a venue whose status is null', async () => {
    const r = await run(null)
    expect(r.venueHalted).toBe(0)
    expect(r.pushed).toBe(1)
  })

  it('asks for status in the venue read', async () => {
    await run('active')
    expect(capturedVenueSelect).toContain('status')
  })

  // A halted venue must not also spend the clock counters, which describe
  // rows we were never going to act on. This pins the gate ahead of them.
  it('counts a paused venue as halted rather than beforeOpening', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    // 04:00 LA: before the 7am opening, so without the status gate this row
    // would land in `beforeOpening`.
    const beforeOpening = new Date('2026-05-29T11:00:00Z')
    const state = stateWithStatus('paused')
    vi.mocked(createAdminClient).mockReturnValue(
      makeMockClient(state) as unknown as ReturnType<typeof createAdminClient>,
    )
    const r = await processDueCommitments(beforeOpening)
    expect(r.venueHalted).toBe(1)
    expect(r.beforeOpening).toBe(0)
    warn.mockRestore()
  })
})
