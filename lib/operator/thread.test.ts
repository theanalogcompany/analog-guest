// Offline tests for loadGuestThread's lookup + projection layer (TAC-277).
// Mirrors the queue.test.ts shape: mock the admin client at the boundary,
// drive the supabase-js fluent builder via vi.fn returning the expected
// data/error shapes.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { loadGuestThread } from './thread'
import { grantedVenues } from '@/lib/auth/venue-scope'

const VALID_UUID = '550e8400-e29b-41d4-a716-446655440000'
const VENUE_A = '00000000-0000-0000-0000-00000000000a'
const VENUE_B = '00000000-0000-0000-0000-00000000000b'
const GUEST_X = '00000000-0000-0000-0000-000000000001'

// TAC-395: transcribed from TAC-395's Contract ("Which messages count",
// condition 2) into PostgREST syntax. A literal, never built from
// DELIVERED_OUTBOUND_STATUSES: an expectation built from the constant would
// pass whatever the constant says (CLAUDE.md, Cross-repo contracts).
const CONTRACT_REACHED_GUEST_FILTER =
  'direction.eq.inbound,and(status.in.(sending,sent,delivered),or(review_state.is.null,review_state.neq.pending))'

// The helper makes two sequential .from('messages') calls. We dispatch the
// second-call mock from a queue, so each test can stage exactly the responses
// it needs without coupling test order to mock-call order.
let nextSelectResponses: Array<{ data: unknown; error: { message: string } | null }> = []
let nextMaybeSingleResponse: { data: unknown; error: { message: string } | null } = {
  data: null,
  error: null,
}

const limitMock = vi.fn(() => Promise.resolve(nextSelectResponses.shift()))
const orderMock = vi.fn(() => ({ limit: limitMock }))
const orMock = vi.fn(() => ({ order: orderMock }))
const neqMock = vi.fn(() => ({ or: orMock }))
const eqGuestMock = vi.fn(() => ({ neq: neqMock }))
const eqVenueMock = vi.fn(() => ({ eq: eqGuestMock }))
const maybeSingleMock = vi.fn(() => Promise.resolve(nextMaybeSingleResponse))
// The lookup chain has no `.or`: a filter added to the lookup throws here.
const eqIdMock = vi.fn(() => ({ maybeSingle: maybeSingleMock }))

// `select()` is called twice with different downstream chains. Distinguish by
// the column list — the lookup uses `'venue_id, guest_id'`; the thread fetch
// uses `'id, body, direction, created_at'`.
const selectMock = vi.fn((cols: string) => {
  if (cols === 'venue_id, guest_id') return { eq: eqIdMock }
  return { eq: eqVenueMock }
})
const fromMock = vi.fn(() => ({ select: selectMock }))

vi.mock('@/lib/db/admin', () => ({
  createAdminClient: () => ({ from: fromMock }),
}))

beforeEach(() => {
  nextSelectResponses = []
  nextMaybeSingleResponse = { data: null, error: null }
  fromMock.mockClear()
  selectMock.mockClear()
  eqIdMock.mockClear()
  maybeSingleMock.mockClear()
  eqVenueMock.mockClear()
  eqGuestMock.mockClear()
  neqMock.mockClear()
  orMock.mockClear()
  orderMock.mockClear()
  limitMock.mockClear()
})

afterEach(() => {
  vi.clearAllMocks()
})

describe('loadGuestThread', () => {
  it('short-circuits to out_of_allowlist when the operator has no venue grants', async () => {
    const result = await loadGuestThread({ messageId: VALID_UUID, venueScope: grantedVenues([]) })
    expect(result).toEqual({ ok: false, errorCode: 'out_of_allowlist' })
    expect(fromMock).not.toHaveBeenCalled()
  })

  it('returns message_not_found when the initial lookup returns no row', async () => {
    nextMaybeSingleResponse = { data: null, error: null }
    const result = await loadGuestThread({
      messageId: VALID_UUID,
      venueScope: grantedVenues([VENUE_A]),
    })
    expect(result).toEqual({ ok: false, errorCode: 'message_not_found' })
    expect(eqIdMock).toHaveBeenCalledWith('id', VALID_UUID)
  })

  it('returns out_of_allowlist when the message exists at a venue not in the allowlist', async () => {
    nextMaybeSingleResponse = {
      data: { venue_id: VENUE_B, guest_id: GUEST_X },
      error: null,
    }
    const result = await loadGuestThread({
      messageId: VALID_UUID,
      venueScope: grantedVenues([VENUE_A]),
    })
    expect(result).toEqual({ ok: false, errorCode: 'out_of_allowlist' })
    // Critically: the second SELECT must NOT have fired. Verify by checking
    // the thread-fetch mock chain was never touched.
    expect(eqVenueMock).not.toHaveBeenCalled()
  })

  it('returns the thread in oldest→newest order from a DESC SQL slice', async () => {
    nextMaybeSingleResponse = {
      data: { venue_id: VENUE_A, guest_id: GUEST_X },
      error: null,
    }
    // 5 rows, DESC by created_at (simulating ORDER BY created_at DESC LIMIT 200).
    nextSelectResponses = [
      {
        data: [
          { id: 'm5', direction: 'outbound', body: 'fifth', created_at: '2026-05-26T18:14:55Z' },
          { id: 'm4', direction: 'inbound', body: 'fourth', created_at: '2026-05-26T18:14:54Z' },
          { id: 'm3', direction: 'outbound', body: 'third', created_at: '2026-05-26T18:14:53Z' },
          { id: 'm2', direction: 'inbound', body: 'second', created_at: '2026-05-26T18:14:52Z' },
          { id: 'm1', direction: 'inbound', body: 'first', created_at: '2026-05-26T18:14:51Z' },
        ],
        error: null,
      },
    ]
    const result = await loadGuestThread({
      messageId: VALID_UUID,
      venueScope: grantedVenues([VENUE_A]),
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.messages.map((m) => m.id)).toEqual(['m1', 'm2', 'm3', 'm4', 'm5'])
    }
    // Verify the SQL shape: equal-eq on (venue_id, guest_id), neq body '',
    // the reached-guest filter, order DESC, limit 200.
    expect(eqVenueMock).toHaveBeenCalledWith('venue_id', VENUE_A)
    expect(eqGuestMock).toHaveBeenCalledWith('guest_id', GUEST_X)
    expect(neqMock).toHaveBeenCalledWith('body', '')
    expect(orMock).toHaveBeenCalledWith(CONTRACT_REACHED_GUEST_FILTER)
    expect(orderMock).toHaveBeenCalledWith('created_at', { ascending: false })
    expect(limitMock).toHaveBeenCalledWith(200)
  })

  it('honors the 200-row cap (returns 200 ASC when SQL returns 200 DESC)', async () => {
    nextMaybeSingleResponse = {
      data: { venue_id: VENUE_A, guest_id: GUEST_X },
      error: null,
    }
    // Fabricate 200 rows DESC by index (200 → 1).
    const desc = Array.from({ length: 200 }, (_, idx) => {
      const seq = 200 - idx
      return {
        id: `m${seq}`,
        direction: seq % 2 === 0 ? 'outbound' : 'inbound',
        body: `msg ${seq}`,
        // Ascending seq → ascending date. The DESC slice has high seqs first.
        created_at: new Date(2026, 4, 1, 0, 0, seq).toISOString(),
      }
    })
    nextSelectResponses = [{ data: desc, error: null }]
    const result = await loadGuestThread({
      messageId: VALID_UUID,
      venueScope: grantedVenues([VENUE_A]),
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.messages).toHaveLength(200)
      // First out should be the oldest of the most-recent slice (seq=1),
      // last should be the newest (seq=200).
      expect(result.messages[0]!.id).toBe('m1')
      expect(result.messages[199]!.id).toBe('m200')
    }
  })

  it('drops rows whose direction is not in the closed enum (defensive)', async () => {
    nextMaybeSingleResponse = {
      data: { venue_id: VENUE_A, guest_id: GUEST_X },
      error: null,
    }
    nextSelectResponses = [
      {
        data: [
          { id: 'm3', direction: 'outbound', body: 'good', created_at: '2026-05-26T18:14:53Z' },
          { id: 'm2', direction: 'sideways', body: 'bad', created_at: '2026-05-26T18:14:52Z' },
          { id: 'm1', direction: 'inbound', body: 'good', created_at: '2026-05-26T18:14:51Z' },
        ],
        error: null,
      },
    ]
    const result = await loadGuestThread({
      messageId: VALID_UUID,
      venueScope: grantedVenues([VENUE_A]),
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.messages.map((m) => m.id)).toEqual(['m1', 'm3'])
    }
  })

  it('returns db_error on first-lookup failure', async () => {
    nextMaybeSingleResponse = { data: null, error: { message: 'connection lost' } }
    const result = await loadGuestThread({
      messageId: VALID_UUID,
      venueScope: grantedVenues([VENUE_A]),
    })
    expect(result).toEqual({
      ok: false,
      errorCode: 'db_error',
      error: 'connection lost',
    })
    expect(eqVenueMock).not.toHaveBeenCalled()
  })

  it('returns db_error on thread-fetch failure', async () => {
    nextMaybeSingleResponse = {
      data: { venue_id: VENUE_A, guest_id: GUEST_X },
      error: null,
    }
    nextSelectResponses = [{ data: null, error: { message: 'rpc timed out' } }]
    const result = await loadGuestThread({
      messageId: VALID_UUID,
      venueScope: grantedVenues([VENUE_A]),
    })
    expect(result).toEqual({
      ok: false,
      errorCode: 'db_error',
      error: 'rpc timed out',
    })
  })

  it('returns an empty messages array when the guest has only empty-body rows besides the seed', async () => {
    nextMaybeSingleResponse = {
      data: { venue_id: VENUE_A, guest_id: GUEST_X },
      error: null,
    }
    // Second SELECT returns [] because the body!=∅ filter removed everything.
    nextSelectResponses = [{ data: [], error: null }]
    const result = await loadGuestThread({
      messageId: VALID_UUID,
      venueScope: grantedVenues([VENUE_A]),
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.messages).toEqual([])
    }
  })
})

describe('loadGuestThread: only messages that reached the guest (TAC-395)', () => {
  it('filters the thread query with the Contract condition, exactly once', async () => {
    nextMaybeSingleResponse = {
      data: { venue_id: VENUE_A, guest_id: GUEST_X },
      error: null,
    }
    nextSelectResponses = [{ data: [], error: null }]
    await loadGuestThread({ messageId: VALID_UUID, venueScope: grantedVenues([VENUE_A]) })
    expect(orMock).toHaveBeenCalledTimes(1)
    expect(orMock).toHaveBeenCalledWith(CONTRACT_REACHED_GUEST_FILTER)
  })

  // The edit screen opens the thread with the pending draft's own id. Its
  // lookup must resolve even though the thread query then leaves that row out.
  it("resolves a pending draft's own id: the lookup carries no filter", async () => {
    nextMaybeSingleResponse = {
      data: { venue_id: VENUE_A, guest_id: GUEST_X },
      error: null,
    }
    nextSelectResponses = [
      {
        data: [
          { id: 'm1', direction: 'inbound', body: 'what time do you open on sundaus', created_at: '2026-09-14T16:31:23Z' },
        ],
        error: null,
      },
    ]
    const result = await loadGuestThread({ messageId: VALID_UUID, venueScope: grantedVenues([VENUE_A]) })
    expect(result).toEqual({
      ok: true,
      messages: [
        { id: 'm1', direction: 'inbound', body: 'what time do you open on sundaus', createdAt: '2026-09-14T16:31:23Z' },
      ],
    })
    expect(selectMock).toHaveBeenCalledWith('venue_id, guest_id')
    expect(eqIdMock).toHaveBeenCalledWith('id', VALID_UUID)
    // One filter call in total, and it belongs to the thread query.
    expect(orMock).toHaveBeenCalledTimes(1)
  })

  // The filter runs in SQL, before LIMIT 200. A JS post-filter would return
  // fewer than 200 rows when more qualify, so JS must keep every row the query
  // returns, and must not fetch the columns such a filter would need.
  it('filters in the query only: every returned row is kept and no delivery columns are fetched', async () => {
    nextMaybeSingleResponse = {
      data: { venue_id: VENUE_A, guest_id: GUEST_X },
      error: null,
    }
    nextSelectResponses = [
      {
        data: [
          { id: 'm3', direction: 'outbound', body: 'draft', created_at: '2026-09-14T16:31:50Z', status: 'pending_review', review_state: 'pending' },
          { id: 'm2', direction: 'outbound', body: 'skipped', created_at: '2026-09-14T16:26:34Z', status: 'pending_review', review_state: 'skipped' },
          { id: 'm1', direction: 'inbound', body: 'hi', created_at: '2026-09-14T16:26:03Z', status: 'received', review_state: null },
        ],
        error: null,
      },
    ]
    const result = await loadGuestThread({ messageId: VALID_UUID, venueScope: grantedVenues([VENUE_A]) })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.messages.map((m) => m.id)).toEqual(['m1', 'm2', 'm3'])
    }
    expect(selectMock).toHaveBeenCalledWith('id, body, direction, created_at')
  })
})
