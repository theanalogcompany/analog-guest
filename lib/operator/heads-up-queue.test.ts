/* eslint-disable @typescript-eslint/no-unused-vars */

// TAC-297 + TAC-299. Tests the heads-up queue projection, with special
// attention to the TAC-299 additions:
//   - sourceMessageId — projected from the row's source_message_id column
//   - recognitionState — fetched via a second batched query on guest_states

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/db/admin', () => ({
  createAdminClient: vi.fn(),
}))

import { createAdminClient } from '@/lib/db/admin'
import { listHeadsUpQueue } from './heads-up-queue'

const VENUE_A = '00000000-0000-0000-0000-00000000000a'
const VENUE_B = '00000000-0000-0000-0000-00000000000b'
const GUEST_1 = '11111111-1111-4111-8111-111111111111'
const GUEST_2 = '22222222-2222-4222-8222-222222222222'
const COMMITMENT_1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const COMMITMENT_2 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const MESSAGE_1 = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'

interface MockState {
  commitmentRows: Array<Record<string, unknown>>
  commitmentError: { message: string } | null
  stateRows: Array<Record<string, unknown>>
  stateError: { message: string } | null
  // Capture every .in() call on guest_states (guest_id + venue_id) so tests
  // can assert both the scoping shape and the deduped guest_id set.
  stateSelectInCalls: Array<{ field: string; values: unknown[] }>
}

function newState(overrides: Partial<MockState> = {}): MockState {
  return {
    commitmentRows: [],
    commitmentError: null,
    stateRows: [],
    stateError: null,
    stateSelectInCalls: [],
    ...overrides,
  }
}

function makeSupabase(state: MockState) {
  return {
    from: (table: string) => {
      if (table === 'guest_commitments') {
        const chain = {
          select: (_cols: string) => chain,
          eq: (_field: string, _value: unknown) => chain,
          in: (_field: string, _values: unknown[]) => chain,
          order: (_field: string, _opts: unknown) => chain,
          limit: (_n: number) =>
            Promise.resolve({
              data: state.commitmentRows,
              error: state.commitmentError,
            }),
        }
        return chain
      }
      if (table === 'guest_states') {
        const chain = {
          select: (_cols: string) => chain,
          in: (field: string, values: unknown[]) => {
            state.stateSelectInCalls.push({ field, values })
            return chain
          },
          is: (_field: string, _value: unknown) => chain,
          order: (_field: string, _opts: unknown) =>
            Promise.resolve({
              data: state.stateRows,
              error: state.stateError,
            }),
        }
        return chain
      }
      throw new Error(`unexpected table: ${table}`)
    },
  }
}

function makeCommitmentRow(overrides: Record<string, unknown> = {}) {
  return {
    id: COMMITMENT_1,
    type: 'comp',
    description: 'oat latte',
    code: '7K2P',
    expected_arrival: null,
    created_at: '2026-05-29T09:55:00Z',
    source_message_id: MESSAGE_1,
    guest_id: GUEST_1,
    guest: { first_name: 'Sam' },
    ...overrides,
  }
}

beforeEach(() => {
  vi.mocked(createAdminClient).mockReset()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('listHeadsUpQueue', () => {
  it('returns empty + no DB round trip when allowedVenueIds is empty', async () => {
    const r = await listHeadsUpQueue([])
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.commitments).toEqual([])
    expect(vi.mocked(createAdminClient)).not.toHaveBeenCalled()
  })

  it('returns empty + skips second query when no commitments match', async () => {
    const state = newState({ commitmentRows: [] })
    vi.mocked(createAdminClient).mockReturnValue(
      makeSupabase(state) as unknown as ReturnType<typeof createAdminClient>,
    )
    const r = await listHeadsUpQueue([VENUE_A])
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.commitments).toEqual([])
    // No commitments → no guest_states query
    expect(state.stateSelectInCalls).toHaveLength(0)
  })

  it('projects sourceMessageId from the row column (TAC-299)', async () => {
    const state = newState({
      commitmentRows: [makeCommitmentRow({ source_message_id: MESSAGE_1 })],
      stateRows: [],
    })
    vi.mocked(createAdminClient).mockReturnValue(
      makeSupabase(state) as unknown as ReturnType<typeof createAdminClient>,
    )
    const r = await listHeadsUpQueue([VENUE_A])
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.commitments).toHaveLength(1)
      expect(r.commitments[0].sourceMessageId).toBe(MESSAGE_1)
    }
  })

  it('projects sourceMessageId=null when row source_message_id is null', async () => {
    const state = newState({
      commitmentRows: [makeCommitmentRow({ source_message_id: null })],
    })
    vi.mocked(createAdminClient).mockReturnValue(
      makeSupabase(state) as unknown as ReturnType<typeof createAdminClient>,
    )
    const r = await listHeadsUpQueue([VENUE_A])
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.commitments[0].sourceMessageId).toBeNull()
  })

  it('projects recognitionState from the latest guest_states row (TAC-299)', async () => {
    const state = newState({
      commitmentRows: [makeCommitmentRow()],
      stateRows: [
        // Ordered DESC by entered_at — first row per guest_id is the latest.
        { guest_id: GUEST_1, state: 'regular', entered_at: '2026-05-28T10:00:00Z' },
        { guest_id: GUEST_1, state: 'returning', entered_at: '2026-05-15T10:00:00Z' },
      ],
    })
    vi.mocked(createAdminClient).mockReturnValue(
      makeSupabase(state) as unknown as ReturnType<typeof createAdminClient>,
    )
    const r = await listHeadsUpQueue([VENUE_A])
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.commitments[0].recognitionState).toBe('regular')
  })

  it('projects recognitionState=null when guest has no states row', async () => {
    const state = newState({
      commitmentRows: [makeCommitmentRow({ guest_id: GUEST_1 })],
      stateRows: [],
    })
    vi.mocked(createAdminClient).mockReturnValue(
      makeSupabase(state) as unknown as ReturnType<typeof createAdminClient>,
    )
    const r = await listHeadsUpQueue([VENUE_A])
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.commitments[0].recognitionState).toBeNull()
  })

  it('projects recognitionState=null when state value is not in canonical set', async () => {
    const state = newState({
      commitmentRows: [makeCommitmentRow()],
      stateRows: [
        { guest_id: GUEST_1, state: 'mystery_state', entered_at: '2026-05-28T10:00:00Z' },
      ],
    })
    vi.mocked(createAdminClient).mockReturnValue(
      makeSupabase(state) as unknown as ReturnType<typeof createAdminClient>,
    )
    const r = await listHeadsUpQueue([VENUE_A])
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.commitments[0].recognitionState).toBeNull()
  })

  it('batches the guest_states lookup across multiple commitments (deduped guest_ids)', async () => {
    const state = newState({
      commitmentRows: [
        makeCommitmentRow({ id: COMMITMENT_1, guest_id: GUEST_1 }),
        makeCommitmentRow({ id: COMMITMENT_2, guest_id: GUEST_2 }),
        // Two commitments for GUEST_1 — should yield ONE entry in the IN clause.
        makeCommitmentRow({ id: 'eee', guest_id: GUEST_1 }),
      ],
      stateRows: [
        { guest_id: GUEST_1, state: 'regular', entered_at: '2026-05-28T10:00:00Z' },
        { guest_id: GUEST_2, state: 'new', entered_at: '2026-05-28T10:00:00Z' },
      ],
    })
    vi.mocked(createAdminClient).mockReturnValue(
      makeSupabase(state) as unknown as ReturnType<typeof createAdminClient>,
    )
    const r = await listHeadsUpQueue([VENUE_A])
    expect(r.ok).toBe(true)
    if (r.ok) {
      const byId = new Map(r.commitments.map((c) => [c.id, c.recognitionState]))
      expect(byId.get(COMMITMENT_1)).toBe('regular')
      expect(byId.get(COMMITMENT_2)).toBe('new')
      expect(byId.get('eee')).toBe('regular')
    }
    // Deduped: GUEST_1 + GUEST_2, not three entries.
    const guestIdCall = state.stateSelectInCalls.find((c) => c.field === 'guest_id')
    expect(guestIdCall).toBeDefined()
    expect(new Set(guestIdCall?.values as string[])).toEqual(
      new Set([GUEST_1, GUEST_2]),
    )
    // venue_id filter encoded on the query surface (composite index hit).
    const venueIdCall = state.stateSelectInCalls.find((c) => c.field === 'venue_id')
    expect(venueIdCall).toBeDefined()
    expect(venueIdCall?.values).toEqual([VENUE_A])
  })

  it('degrades gracefully when guest_states lookup errors (recognitionState=null, commitments still returned)', async () => {
    const state = newState({
      commitmentRows: [makeCommitmentRow()],
      stateError: { message: 'connection lost' },
      stateRows: [],
    })
    vi.mocked(createAdminClient).mockReturnValue(
      makeSupabase(state) as unknown as ReturnType<typeof createAdminClient>,
    )
    const r = await listHeadsUpQueue([VENUE_A])
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.commitments).toHaveLength(1)
      expect(r.commitments[0].recognitionState).toBeNull()
      // Other fields still project correctly
      expect(r.commitments[0].sourceMessageId).toBe(MESSAGE_1)
      expect(r.commitments[0].description).toBe('oat latte')
    }
  })

  it('returns ok:false when the commitments query itself errors', async () => {
    const state = newState({
      commitmentError: { message: 'connection lost' },
    })
    vi.mocked(createAdminClient).mockReturnValue(
      makeSupabase(state) as unknown as ReturnType<typeof createAdminClient>,
    )
    const r = await listHeadsUpQueue([VENUE_A, VENUE_B])
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain('connection lost')
  })
})
