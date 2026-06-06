/* eslint-disable @typescript-eslint/no-unused-vars */

import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/db/admin', () => ({
  createAdminClient: vi.fn(),
}))

import { createAdminClient } from '@/lib/db/admin'
import {
  claimFollowupLogRows,
  emptyFollowupGuestSignals,
  finalizeFollowupLogClaim,
  loadFollowupSnapshotsForVenue,
  releaseFollowupLogClaim,
} from './log'

const VENUE_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const GUEST_ID_1 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const GUEST_ID_2 = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const MSG_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'

interface InsertCall {
  rows: Array<Record<string, unknown>>
}

interface MockState {
  insertedReturn: Array<{ id: string; reason: string; dedup_key: string }> | null
  insertError: { code?: string; message: string } | null
  insertCalls: InsertCall[]
  updatedReturn: Array<{ id: string }> | null
  updateError: { code?: string; message: string } | null
  updateCalls: Array<{ patch: Record<string, unknown>; ids: string[] }>
  deletedReturn: Array<{ id: string }> | null
  deleteError: { code?: string; message: string } | null
  deleteCalls: string[][]
  weeklySelectReturn: Array<{ guest_id: string; created_at: string }> | null
  weeklySelectError: { message: string } | null
  historySelectReturn: Array<{ guest_id: string; reason: string; dedup_key: string; created_at: string }> | null
  historySelectError: { message: string } | null
  selectCallTrace: Array<{ table: string; phase: string }>
}

function newState(overrides: Partial<MockState> = {}): MockState {
  return {
    insertedReturn: [],
    insertError: null,
    insertCalls: [],
    updatedReturn: [],
    updateError: null,
    updateCalls: [],
    deletedReturn: [],
    deleteError: null,
    deleteCalls: [],
    weeklySelectReturn: [],
    weeklySelectError: null,
    historySelectReturn: [],
    historySelectError: null,
    selectCallTrace: [],
    ...overrides,
  }
}

function makeSupabaseMock(state: MockState) {
  return {
    from: (table: string) => ({
      insert: (rows: Array<Record<string, unknown>>) => ({
        select: (_cols: string) => {
          state.insertCalls.push({ rows })
          if (state.insertError) {
            return Promise.resolve({ data: null, error: state.insertError })
          }
          return Promise.resolve({ data: state.insertedReturn, error: null })
        },
      }),
      update: (patch: Record<string, unknown>) => ({
        in: (_col: string, ids: string[]) => ({
          select: (_cols: string) => {
            state.updateCalls.push({ patch, ids })
            if (state.updateError) {
              return Promise.resolve({ data: null, error: state.updateError })
            }
            return Promise.resolve({ data: state.updatedReturn, error: null })
          },
        }),
      }),
      delete: () => ({
        in: (_col: string, ids: string[]) => ({
          select: (_cols: string) => {
            state.deleteCalls.push(ids)
            if (state.deleteError) {
              return Promise.resolve({ data: null, error: state.deleteError })
            }
            return Promise.resolve({ data: state.deletedReturn, error: null })
          },
        }),
      }),
      // The loadFollowupSnapshotsForVenue path uses .select().eq().in() and
      // .select().eq().in().gte() then .order(). Two distinct call chains;
      // we identify them by whether `.gte` was called.
      select: (_cols: string) =>
        new SelectChain(state, table, _cols),
    }),
  }
}

class SelectChain {
  private hasGte = false
  private hasOrder = false
  constructor(
    private readonly state: MockState,
    private readonly table: string,
    private readonly cols: string,
  ) {}
  eq(_col: string, _val: unknown): this {
    return this
  }
  in(_col: string, _vals: readonly unknown[]): this {
    return this
  }
  gte(_col: string, _val: string): this {
    this.hasGte = true
    return this
  }
  order(_col: string, _opts: { ascending: boolean }): Promise<unknown> {
    this.hasOrder = true
    this.state.selectCallTrace.push({ table: this.table, phase: 'history' })
    if (this.state.historySelectError) {
      return Promise.resolve({ data: null, error: this.state.historySelectError })
    }
    return Promise.resolve({ data: this.state.historySelectReturn, error: null })
  }
  then(
    onFulfilled?: (value: unknown) => unknown,
    onRejected?: (reason: unknown) => unknown,
  ): Promise<unknown> {
    // Awaited without .order() → weekly query (no order chain).
    const phase = this.hasGte ? 'weekly' : 'plain'
    this.state.selectCallTrace.push({ table: this.table, phase })
    if (phase === 'weekly') {
      const value = this.state.weeklySelectError
        ? { data: null, error: this.state.weeklySelectError }
        : { data: this.state.weeklySelectReturn, error: null }
      return Promise.resolve(value).then(onFulfilled, onRejected)
    }
    return Promise.resolve({ data: null, error: null }).then(onFulfilled, onRejected)
  }
}

beforeEach(() => {
  vi.mocked(createAdminClient).mockReset()
})

describe('claimFollowupLogRows', () => {
  it('returns ok+empty on empty rows (no-op, no DB call)', async () => {
    const state = newState()
    vi.mocked(createAdminClient).mockReturnValue(
      makeSupabaseMock(state) as unknown as ReturnType<typeof createAdminClient>,
    )
    const result = await claimFollowupLogRows([])
    expect(result).toEqual({ ok: true, claimed: [] })
    expect(state.insertCalls).toHaveLength(0)
  })

  it('returns claimed ids on a clean insert', async () => {
    const state = newState({
      insertedReturn: [{ id: 'log-1', reason: 'post_visit_day_7', dedup_key: 'day_7:2026-05-25' }],
    })
    vi.mocked(createAdminClient).mockReturnValue(
      makeSupabaseMock(state) as unknown as ReturnType<typeof createAdminClient>,
    )
    const result = await claimFollowupLogRows([
      {
        venueId: VENUE_ID,
        guestId: GUEST_ID_1,
        reason: 'post_visit_day_7',
        dedupKey: 'day_7:2026-05-25',
      },
    ])
    expect(result).toEqual({
      ok: true,
      claimed: [{ id: 'log-1', reason: 'post_visit_day_7', dedupKey: 'day_7:2026-05-25' }],
    })
    expect(state.insertCalls).toHaveLength(1)
    expect(state.insertCalls[0].rows).toEqual([
      {
        venue_id: VENUE_ID,
        guest_id: GUEST_ID_1,
        reason: 'post_visit_day_7',
        dedup_key: 'day_7:2026-05-25',
      },
    ])
  })

  it('returns {conflict: true} on 23505 (atomic rollback, nothing to clean up)', async () => {
    const state = newState({
      insertError: { code: '23505', message: 'duplicate key value' },
    })
    vi.mocked(createAdminClient).mockReturnValue(
      makeSupabaseMock(state) as unknown as ReturnType<typeof createAdminClient>,
    )
    const result = await claimFollowupLogRows([
      {
        venueId: VENUE_ID,
        guestId: GUEST_ID_1,
        reason: 'cold_lapsed',
        dedupKey: 'cold:2026-05-25',
      },
    ])
    expect(result).toEqual({ ok: true, conflict: true })
  })

  it('returns error on non-23505 DB error', async () => {
    const state = newState({
      insertError: { code: '08006', message: 'connection failure' },
    })
    vi.mocked(createAdminClient).mockReturnValue(
      makeSupabaseMock(state) as unknown as ReturnType<typeof createAdminClient>,
    )
    const result = await claimFollowupLogRows([
      {
        venueId: VENUE_ID,
        guestId: GUEST_ID_1,
        reason: 'cold_lapsed',
        dedupKey: 'cold:2026-05-25',
      },
    ])
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.errorCode).toBe('08006')
      expect(result.error).toContain('connection failure')
    }
  })
})

describe('finalizeFollowupLogClaim', () => {
  it('no-op on empty ids', async () => {
    const state = newState()
    vi.mocked(createAdminClient).mockReturnValue(
      makeSupabaseMock(state) as unknown as ReturnType<typeof createAdminClient>,
    )
    const result = await finalizeFollowupLogClaim([], MSG_ID)
    expect(result).toEqual({ ok: true, data: { updatedCount: 0 } })
    expect(state.updateCalls).toHaveLength(0)
  })

  it('updates message_id and reports count', async () => {
    const state = newState({ updatedReturn: [{ id: 'log-1' }, { id: 'log-2' }] })
    vi.mocked(createAdminClient).mockReturnValue(
      makeSupabaseMock(state) as unknown as ReturnType<typeof createAdminClient>,
    )
    const result = await finalizeFollowupLogClaim(['log-1', 'log-2'], MSG_ID)
    expect(result).toEqual({ ok: true, data: { updatedCount: 2 } })
    expect(state.updateCalls[0].patch).toEqual({ message_id: MSG_ID })
    expect(state.updateCalls[0].ids).toEqual(['log-1', 'log-2'])
  })

  it('returns error on DB failure', async () => {
    const state = newState({ updateError: { message: 'boom' } })
    vi.mocked(createAdminClient).mockReturnValue(
      makeSupabaseMock(state) as unknown as ReturnType<typeof createAdminClient>,
    )
    const result = await finalizeFollowupLogClaim(['log-1'], MSG_ID)
    expect(result.ok).toBe(false)
  })
})

describe('releaseFollowupLogClaim', () => {
  it('no-op on empty ids', async () => {
    const state = newState()
    vi.mocked(createAdminClient).mockReturnValue(
      makeSupabaseMock(state) as unknown as ReturnType<typeof createAdminClient>,
    )
    const result = await releaseFollowupLogClaim([])
    expect(result).toEqual({ ok: true, data: { deletedCount: 0 } })
    expect(state.deleteCalls).toHaveLength(0)
  })

  it('deletes claim rows and reports count', async () => {
    const state = newState({ deletedReturn: [{ id: 'log-1' }] })
    vi.mocked(createAdminClient).mockReturnValue(
      makeSupabaseMock(state) as unknown as ReturnType<typeof createAdminClient>,
    )
    const result = await releaseFollowupLogClaim(['log-1'])
    expect(result).toEqual({ ok: true, data: { deletedCount: 1 } })
    expect(state.deleteCalls[0]).toEqual(['log-1'])
  })
})

describe('loadFollowupSnapshotsForVenue', () => {
  const NOW = new Date('2026-06-04T17:00:00Z')

  it('returns empty map on empty guestIds (no DB calls)', async () => {
    const state = newState()
    vi.mocked(createAdminClient).mockReturnValue(
      makeSupabaseMock(state) as unknown as ReturnType<typeof createAdminClient>,
    )
    const result = await loadFollowupSnapshotsForVenue(VENUE_ID, [], NOW)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.data.size).toBe(0)
    expect(state.selectCallTrace).toHaveLength(0)
  })

  it('aggregates weekly count + per-reason history + announced mechanics', async () => {
    const state = newState({
      weeklySelectReturn: [
        { guest_id: GUEST_ID_1, created_at: '2026-06-03T00:00:00Z' },
        { guest_id: GUEST_ID_1, created_at: '2026-06-02T00:00:00Z' },
        { guest_id: GUEST_ID_2, created_at: '2026-06-01T00:00:00Z' },
      ],
      historySelectReturn: [
        {
          guest_id: GUEST_ID_1,
          reason: 'post_visit_day_7',
          dedup_key: 'day_7:2026-05-25T00:00:00Z',
          created_at: '2026-06-03T00:00:00Z',
        },
        {
          guest_id: GUEST_ID_1,
          reason: 'perk_unlock',
          dedup_key: 'perk:mech-abc',
          created_at: '2026-06-02T00:00:00Z',
        },
        {
          guest_id: GUEST_ID_2,
          reason: 'cold_lapsed',
          dedup_key: 'cold:2026-04-01T00:00:00Z',
          created_at: '2026-06-01T00:00:00Z',
        },
      ],
    })
    vi.mocked(createAdminClient).mockReturnValue(
      makeSupabaseMock(state) as unknown as ReturnType<typeof createAdminClient>,
    )
    const result = await loadFollowupSnapshotsForVenue(VENUE_ID, [GUEST_ID_1, GUEST_ID_2], NOW)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const g1 = result.data.get(GUEST_ID_1)
    expect(g1?.weeklyCount).toBe(2)
    expect(g1?.lastByReason.post_visit_day_7).toEqual(new Date('2026-06-03T00:00:00Z'))
    expect(g1?.lastByReason.perk_unlock).toEqual(new Date('2026-06-02T00:00:00Z'))
    expect(Array.from(g1?.announcedMechanicIds ?? [])).toEqual(['mech-abc'])
    const g2 = result.data.get(GUEST_ID_2)
    expect(g2?.weeklyCount).toBe(1)
    expect(g2?.lastByReason.cold_lapsed).toEqual(new Date('2026-06-01T00:00:00Z'))
    expect(g2?.announcedMechanicIds.size).toBe(0)
  })

  it('skips non-perk dedup_keys when building announcedMechanicIds', async () => {
    const state = newState({
      historySelectReturn: [
        {
          guest_id: GUEST_ID_1,
          reason: 'cold_lapsed',
          dedup_key: 'cold:2026-05-01T00:00:00Z',
          created_at: '2026-06-01T00:00:00Z',
        },
      ],
    })
    vi.mocked(createAdminClient).mockReturnValue(
      makeSupabaseMock(state) as unknown as ReturnType<typeof createAdminClient>,
    )
    const result = await loadFollowupSnapshotsForVenue(VENUE_ID, [GUEST_ID_1], NOW)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.data.get(GUEST_ID_1)?.announcedMechanicIds.size).toBe(0)
    }
  })

  it('returns error on weekly query failure', async () => {
    const state = newState({ weeklySelectError: { message: 'weekly fail' } })
    vi.mocked(createAdminClient).mockReturnValue(
      makeSupabaseMock(state) as unknown as ReturnType<typeof createAdminClient>,
    )
    const result = await loadFollowupSnapshotsForVenue(VENUE_ID, [GUEST_ID_1], NOW)
    expect(result.ok).toBe(false)
  })

  it('returns error on history query failure', async () => {
    const state = newState({ historySelectError: { message: 'history fail' } })
    vi.mocked(createAdminClient).mockReturnValue(
      makeSupabaseMock(state) as unknown as ReturnType<typeof createAdminClient>,
    )
    const result = await loadFollowupSnapshotsForVenue(VENUE_ID, [GUEST_ID_1], NOW)
    expect(result.ok).toBe(false)
  })
})

describe('emptyFollowupGuestSignals', () => {
  it('returns a fresh empty snapshot each call', () => {
    const a = emptyFollowupGuestSignals()
    const b = emptyFollowupGuestSignals()
    a.weeklyCount = 99
    expect(b.weeklyCount).toBe(0) // a + b are independent
    a.lastByReason.cold_lapsed = new Date()
    expect(b.lastByReason.cold_lapsed).toBeUndefined()
  })
})
