// Integration tests for GET /api/operator/guests/[guestId]/thread (TAC-297
// plan, Task 7). Sibling to app/api/operator/messages/[id]/thread/route.ts
// (TAC-277) — same Contract-shaped error bodies, same uniform 404 for
// not-found/out-of-allowlist/invalid-uuid, same 500 body shape. The only
// difference is the lookup key: guestId directly instead of resolving
// (venue_id, guest_id) from a messageId first.
//
// Mocking shape mirrors the [id]/thread route test: mock the auth + helper
// boundary; import the route handler AFTER the mocks.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const verifyMock = vi.fn()
vi.mock('@/lib/auth/verify-jwt', () => ({
  verifyOperatorRequest: (...args: unknown[]) => verifyMock(...args),
}))

const loadMock = vi.fn()
vi.mock('@/lib/operator', async () => {
  const actual = await vi.importActual<typeof import('@/lib/operator')>('@/lib/operator')
  return {
    ...actual,
    loadGuestThreadByGuestId: (...args: unknown[]) => loadMock(...args),
  }
})

import { GET } from './route'

const VALID_GUEST_ID = '550e8400-e29b-41d4-a716-446655440000'
const VENUE_A = '00000000-0000-0000-0000-00000000000a'

function makeRequest(): Request {
  return new Request(
    `https://example.test/api/operator/guests/${VALID_GUEST_ID}/thread`,
    { method: 'GET', headers: { authorization: 'Bearer fake-jwt' } },
  )
}

function params(guestId = VALID_GUEST_ID): { params: Promise<{ guestId: string }> } {
  return { params: Promise.resolve({ guestId }) }
}

beforeEach(() => {
  verifyMock.mockReset()
  verifyMock.mockResolvedValue({ operatorId: 'op-1', allowedVenueIds: [VENUE_A] })
  loadMock.mockReset()
})

afterEach(() => {
  vi.clearAllMocks()
})

describe('GET /api/operator/guests/[guestId]/thread', () => {
  it("returns 401 {error:'unauthorized'} when AuthError is thrown", async () => {
    const { AuthError } = await import('@/lib/auth/types')
    verifyMock.mockRejectedValueOnce(new AuthError(401, 'invalid or expired token'))
    const res = await GET(makeRequest(), params())
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ error: 'unauthorized' })
    expect(loadMock).not.toHaveBeenCalled()
  })

  it("returns 404 not_found when guestId is not a uuid (no helper call)", async () => {
    const res = await GET(makeRequest(), params('not-a-uuid'))
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: 'not_found' })
    expect(loadMock).not.toHaveBeenCalled()
  })

  it('returns 404 not_found when helper reports guest_not_found', async () => {
    loadMock.mockResolvedValueOnce({ ok: false, errorCode: 'guest_not_found' })
    const res = await GET(makeRequest(), params())
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: 'not_found' })
  })

  it('returns 404 not_found when helper reports out_of_allowlist', async () => {
    loadMock.mockResolvedValueOnce({ ok: false, errorCode: 'out_of_allowlist' })
    const res = await GET(makeRequest(), params())
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: 'not_found' })
  })

  it("returns 500 {error:'internal_error'} on db_error", async () => {
    loadMock.mockResolvedValueOnce({ ok: false, errorCode: 'db_error', error: 'timeout' })
    const res = await GET(makeRequest(), params())
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ error: 'internal_error' })
  })

  it('returns {messages: [...]} threading allowedVenueIds into the helper', async () => {
    loadMock.mockResolvedValueOnce({
      ok: true,
      messages: [
        {
          id: '11111111-1111-1111-1111-111111111111',
          direction: 'inbound',
          body: 'hey!',
          createdAt: '2026-09-05T18:00:00.000Z',
        },
      ],
    })
    const res = await GET(makeRequest(), params())
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      messages: [
        {
          id: '11111111-1111-1111-1111-111111111111',
          direction: 'inbound',
          body: 'hey!',
          createdAt: '2026-09-05T18:00:00.000Z',
        },
      ],
    })
    expect(loadMock).toHaveBeenCalledWith({
      guestId: VALID_GUEST_ID,
      allowedVenueIds: [VENUE_A],
    })
  })
})
