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
import { MORNING_HOUR_LOCAL, processDueCommitments } from './commitments-due'

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
    redeemed_at: null,
    source_message_id: null,
    created_at: '2026-05-29T00:00:00Z',
    updated_at: '2026-05-29T00:00:00Z',
    ...overrides,
  }
}

// State for the supabase mock — handles guest_commitments (select+update),
// venues (select), guests (select).
interface DBState {
  dueRows: unknown[]
  selectError: { message: string } | null
  updateReturnByRowId: Map<string, unknown[]>
  updateErrorByRowId: Map<string, { message: string }>
  venues: Array<{ id: string; timezone: string }>
  guests: Array<{ id: string; first_name: string | null }>
}

function newState(overrides: Partial<DBState> = {}): DBState {
  return {
    dueRows: [],
    selectError: null,
    updateReturnByRowId: new Map(),
    updateErrorByRowId: new Map(),
    venues: [
      { id: VENUE_LA, timezone: 'America/Los_Angeles' },
      { id: VENUE_NYC, timezone: 'America/New_York' },
      { id: VENUE_TOKYO, timezone: 'Asia/Tokyo' },
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
          select: (_cols: string) => ({
            in: async (_field: string, values: unknown[]) => ({
              data: state.venues.filter((v) =>
                (values as string[]).includes(v.id),
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
  waitUntilMock.mockReset()
  sendCommitmentArrivalPushMock.mockReset()
  sendCommitmentArrivalPushMock.mockResolvedValue(undefined)
  vi.mocked(createAdminClient).mockReset()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('MORNING_HOUR_LOCAL', () => {
  it('is 7 (pilot default; venue_configs override is a follow-up)', () => {
    expect(MORNING_HOUR_LOCAL).toBe(7)
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
    expect(r.notMorningHour).toBe(0)
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
    expect(r.notMorningHour).toBe(0)
    expect(sendCommitmentArrivalPushMock).toHaveBeenCalledOnce()
  })

  it('skips a NYC-tz venue at 14:00 UTC (10:00 EDT, not 07:00) — counts as notMorningHour', async () => {
    const row = makeDueRow('cmt-nyc', { venue_id: VENUE_NYC })
    const state = newState({ dueRows: [row] })
    vi.mocked(createAdminClient).mockReturnValue(
      makeMockClient(state) as unknown as ReturnType<typeof createAdminClient>,
    )
    const r = await processDueCommitments(NOW)
    expect(r.scanned).toBe(1)
    expect(r.notMorningHour).toBe(1)
    expect(r.transitioned).toBe(0)
    expect(r.pushed).toBe(0)
    expect(sendCommitmentArrivalPushMock).not.toHaveBeenCalled()
  })

  it('skips a Tokyo-tz venue at 14:00 UTC (23:00 JST, not 07:00)', async () => {
    const row = makeDueRow('cmt-tokyo', { venue_id: VENUE_TOKYO })
    const state = newState({ dueRows: [row] })
    vi.mocked(createAdminClient).mockReturnValue(
      makeMockClient(state) as unknown as ReturnType<typeof createAdminClient>,
    )
    const r = await processDueCommitments(NOW)
    expect(r.scanned).toBe(1)
    expect(r.notMorningHour).toBe(1)
    expect(r.transitioned).toBe(0)
  })

  it('fires the LA row + skips NYC + Tokyo on the same tick', async () => {
    const laRow = makeDueRow('cmt-la')
    const nycRow = makeDueRow('cmt-nyc', { venue_id: VENUE_NYC })
    const tokyoRow = makeDueRow('cmt-tokyo', { venue_id: VENUE_TOKYO })
    const transitionedLA = { ...laRow, status: 'pending_ack' }
    const state = newState({
      dueRows: [laRow, nycRow, tokyoRow],
      updateReturnByRowId: new Map([['cmt-la', [transitionedLA]]]),
    })
    vi.mocked(createAdminClient).mockReturnValue(
      makeMockClient(state) as unknown as ReturnType<typeof createAdminClient>,
    )
    const r = await processDueCommitments(NOW)
    expect(r.scanned).toBe(3)
    expect(r.transitioned).toBe(1)
    expect(r.pushed).toBe(1)
    expect(r.notMorningHour).toBe(2)
    expect(sendCommitmentArrivalPushMock).toHaveBeenCalledOnce()
    const call = sendCommitmentArrivalPushMock.mock.calls[0][0] as {
      commitmentId: string
    }
    expect(call.commitmentId).toBe('cmt-la')
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

  it('fires CATCH-UP — expected_arrival date in venue tz is in the past', async () => {
    // expected_arrival 16:00 UTC on 2026-05-27 = 09:00 PDT 2026-05-27 (2 days ago).
    // Lean catch-up: fires on the next morning tick.
    const row = makeDueRow('cmt-pastdue', {
      expected_arrival: '2026-05-27T16:00:00Z',
    })
    const transitionedRow = { ...row, status: 'pending_ack' }
    const state = newState({
      dueRows: [row],
      updateReturnByRowId: new Map([['cmt-pastdue', [transitionedRow]]]),
    })
    vi.mocked(createAdminClient).mockReturnValue(
      makeMockClient(state) as unknown as ReturnType<typeof createAdminClient>,
    )
    const r = await processDueCommitments(NOW)
    expect(r.transitioned).toBe(1)
    expect(r.future).toBe(0)
    expect(r.pushed).toBe(1)
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
