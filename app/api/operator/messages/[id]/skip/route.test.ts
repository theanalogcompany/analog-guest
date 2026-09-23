// TAC-530: POST /api/operator/messages/[id]/skip.
//
// This route had NO test file. It carried the cookie path's
// `if (allowedVenueIds.length > 0)` idiom on bearer-path data at two queries
// (the claim UPDATE and the disambiguation lookup), so an operator with a
// valid JWT and zero venue grants skipped the filter entirely and could skip
// any pending card in the fleet.
//
// Mocking shape mirrors ../resolve-external/route.test.ts: the query builders
// RECORD their filters rather than swallowing them, because a builder that
// discards them cannot tell "the allowlist was applied" from "the script said
// no row" — which is exactly how this went unasserted.

import { beforeEach, describe, expect, it, vi } from 'vitest'

const verifyMock = vi.fn()
vi.mock('@/lib/auth/verify-jwt', () => ({
  verifyOperatorRequest: (...args: unknown[]) => verifyMock(...args),
}))

const captureMock = vi.fn()
vi.mock('@/lib/analytics/posthog', () => ({
  captureOperatorMessageSkipped: (...args: unknown[]) => captureMock(...args),
}))

interface DbScript {
  /** Rows the claim UPDATE matched. */
  claimed?: Array<Record<string, unknown>>
  claimError?: string
  /** The row the disambiguation lookup found. */
  current?: Record<string, unknown> | null
}

const claimFilters: Array<Record<string, unknown>> = []
const lookupFilters: Array<Record<string, unknown>> = []
let claimPatch: Record<string, unknown> = {}
let script: DbScript = {}
/** Counts every `from()` — the strongest form of "never touched the database". */
let fromCalls = 0

vi.mock('@/lib/db/admin', () => ({
  createAdminClient: () => ({
    from() {
      fromCalls += 1
      return {
        update(patch: Record<string, unknown>) {
          claimPatch = patch
          const filters: Record<string, unknown> = {}
          const b = {
            eq(c: string, v: unknown) {
              filters[c] = v
              return b
            },
            in(c: string, v: unknown) {
              filters[c] = v
              return b
            },
            async select() {
              claimFilters.push({ ...filters })
              if (script.claimError) {
                return { data: null, error: { message: script.claimError } }
              }
              return { data: script.claimed ?? [], error: null }
            },
          }
          return b
        },
        select() {
          const filters: Record<string, unknown> = {}
          const b = {
            eq(c: string, v: unknown) {
              filters[c] = v
              return b
            },
            in(c: string, v: unknown) {
              filters[c] = v
              return b
            },
            async maybeSingle() {
              lookupFilters.push({ ...filters })
              return { data: script.current ?? null, error: null }
            },
          }
          return b
        },
      }
    },
  }),
}))

import { POST } from './route'
import { grantedVenues } from '@/lib/auth/venue-scope'

const VALID_UUID = '550e8400-e29b-41d4-a716-446655440000'
const VENUE_A = '00000000-0000-0000-0000-00000000000a'
const VENUE_B = '00000000-0000-0000-0000-00000000000b'

const PENDING_CARD = {
  id: VALID_UUID,
  venue_id: VENUE_A,
  guest_id: 'guest-1',
  category: 'reply',
  voice_fidelity: 0.82,
  created_at: '2026-09-23T10:00:00.000Z',
}

async function skip(
  id: string = VALID_UUID,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await POST(
    new Request(`https://example.test/api/operator/messages/${id}/skip`, {
      method: 'POST',
      headers: { authorization: 'Bearer fake-jwt' },
    }),
    { params: Promise.resolve({ id }) },
  )
  return { status: res.status, body: (await res.json()) as Record<string, unknown> }
}

beforeEach(() => {
  vi.clearAllMocks()
  claimFilters.length = 0
  lookupFilters.length = 0
  claimPatch = {}
  script = {}
  fromCalls = 0
  verifyMock.mockResolvedValue({ operatorId: 'op-1', venueScope: grantedVenues([VENUE_A]) })
})

describe('POST /api/operator/messages/[id]/skip', () => {
  // The fixture is a card that WOULD match if the filter were skipped. A
  // fixture with no matching row passes whether or not the guard exists.
  it('answers 404 and touches nothing when the operator is allowlisted for no venue', async () => {
    verifyMock.mockResolvedValue({ operatorId: 'op-1', venueScope: grantedVenues([]) })
    script = { claimed: [PENDING_CARD] }
    expect(await skip()).toEqual({ status: 404, body: { error: 'not found' } })
    expect(fromCalls).toBe(0)
    expect(claimFilters).toHaveLength(0)
    expect(lookupFilters).toHaveLength(0)
    expect(captureMock).not.toHaveBeenCalled()
  })

  it('scopes the claim UPDATE to the venue allowlist', async () => {
    script = { claimed: [PENDING_CARD] }
    await skip()
    expect(claimFilters[0]).toEqual({
      id: VALID_UUID,
      review_state: 'pending',
      direction: 'outbound',
      venue_id: [VENUE_A],
    })
  })

  it('scopes the disambiguation LOOKUP to the venue allowlist, not just the claim', async () => {
    // Without this the lookup reports review_state for any message in the
    // fleet by id, which is the existence leak the uniform 404 exists to stop.
    script = { claimed: [], current: null }
    await skip()
    expect(lookupFilters[0]).toEqual({ id: VALID_UUID, venue_id: [VENUE_A] })
  })

  it('answers the same 404 for an out-of-allowlist card as for one that does not exist', async () => {
    verifyMock.mockResolvedValue({ operatorId: 'op-1', venueScope: grantedVenues([VENUE_B]) })
    script = { claimed: [], current: null }
    const outOfScope = await skip()
    script = { claimed: [], current: null }
    const absent = await skip()
    expect(outOfScope).toEqual(absent)
    expect(outOfScope).toEqual({ status: 404, body: { error: 'not found' } })
  })

  it('skips a pending card it is granted', async () => {
    script = { claimed: [PENDING_CARD] }
    expect(await skip()).toEqual({
      status: 200,
      body: { status: 'skipped', messageId: VALID_UUID, reviewState: 'skipped' },
    })
    expect(claimPatch.review_state).toBe('skipped')
    expect(claimPatch.previous_review_state).toBe('pending')
    expect(claimPatch.last_operator_id).toBe('op-1')
    expect(captureMock).toHaveBeenCalledTimes(1)
  })

  it('reports already_acted when the claim matched nothing but the row is visible', async () => {
    script = {
      claimed: [],
      current: { id: VALID_UUID, venue_id: VENUE_A, review_state: 'approved', direction: 'outbound' },
    }
    expect(await skip()).toEqual({
      status: 200,
      body: { status: 'already_acted', messageId: VALID_UUID, reviewState: 'approved' },
    })
    expect(captureMock).not.toHaveBeenCalled()
  })

  it('answers 404 for an inbound row', async () => {
    script = {
      claimed: [],
      current: { id: VALID_UUID, venue_id: VENUE_A, review_state: null, direction: 'inbound' },
    }
    expect(await skip()).toEqual({ status: 404, body: { error: 'not found' } })
  })

  it('answers 400 for a malformed messageId without touching the database', async () => {
    expect(await skip('not-a-uuid')).toEqual({
      status: 400,
      body: { error: 'invalid messageId' },
    })
    expect(fromCalls).toBe(0)
  })
})
