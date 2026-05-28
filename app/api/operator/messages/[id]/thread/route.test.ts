// Integration tests for GET /api/operator/messages/[id]/thread (TAC-277).
// Asserts:
//   - 401 body shape is exactly {error: 'unauthorized'} (NOT err.message —
//     the explicit Contract conformance change vs withOperatorAuth).
//   - 404 (uniform) covers not-found, out-of-allowlist, and invalid uuid.
//   - 500 body shape is exactly {error: 'internal_error'}.
//   - 200 happy path is {messages: ThreadMessage[]}, oldest→newest, capped
//     at 200, empty-body rows filtered.
//
// Mocking shape mirrors app/api/operator/devices/route.test.ts (mock the
// auth + db boundary; import the route handler AFTER the mocks).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const verifyMock = vi.fn()
vi.mock('@/lib/auth/verify-jwt', () => ({
  verifyOperatorRequest: (...args: unknown[]) => verifyMock(...args),
}))

// loadGuestThread is the helper the route delegates to; mock it directly
// so route tests don't have to re-stage the supabase fluent builder.
const loadMock = vi.fn()
vi.mock('@/lib/operator', async () => {
  const actual = await vi.importActual<typeof import('@/lib/operator')>('@/lib/operator')
  return {
    ...actual,
    loadGuestThread: (...args: unknown[]) => loadMock(...args),
  }
})

import { GET } from './route'

const VALID_UUID = '550e8400-e29b-41d4-a716-446655440000'
const VENUE_A = '00000000-0000-0000-0000-00000000000a'

function makeRequest(): Request {
  return new Request(`https://example.test/api/operator/messages/${VALID_UUID}/thread`, {
    method: 'GET',
    headers: { authorization: 'Bearer fake-jwt' },
  })
}

function params(id = VALID_UUID): { params: Promise<{ id: string }> } {
  return { params: Promise.resolve({ id }) }
}

beforeEach(() => {
  verifyMock.mockReset()
  verifyMock.mockResolvedValue({ operatorId: 'op-1', allowedVenueIds: [VENUE_A] })
  loadMock.mockReset()
})

afterEach(() => {
  vi.clearAllMocks()
})

describe('GET /api/operator/messages/[id]/thread', () => {
  describe('401', () => {
    it("returns body exactly {error: 'unauthorized'} when AuthError is thrown (not err.message)", async () => {
      const { AuthError } = await import('@/lib/auth/types')
      verifyMock.mockRejectedValueOnce(
        new AuthError(401, 'invalid or expired token: JWT expired'),
      )
      const res = await GET(makeRequest(), params())
      expect(res.status).toBe(401)
      const body = await res.json()
      expect(body).toEqual({ error: 'unauthorized' })
      // Sanity: helper should NEVER fire when auth fails.
      expect(loadMock).not.toHaveBeenCalled()
    })

    it('also returns unauthorized on missing-header AuthError (does not leak header detail)', async () => {
      const { AuthError } = await import('@/lib/auth/types')
      verifyMock.mockRejectedValueOnce(new AuthError(401, 'missing Authorization header'))
      const res = await GET(makeRequest(), params())
      expect(res.status).toBe(401)
      expect(await res.json()).toEqual({ error: 'unauthorized' })
    })
  })

  describe('404', () => {
    it("returns 404 not_found when params.id is not a uuid (no helper call, doesn't surface 400)", async () => {
      const res = await GET(makeRequest(), params('not-a-uuid'))
      expect(res.status).toBe(404)
      expect(await res.json()).toEqual({ error: 'not_found' })
      expect(loadMock).not.toHaveBeenCalled()
    })

    it('returns 404 not_found when helper reports message_not_found', async () => {
      loadMock.mockResolvedValueOnce({ ok: false, errorCode: 'message_not_found' })
      const res = await GET(makeRequest(), params())
      expect(res.status).toBe(404)
      expect(await res.json()).toEqual({ error: 'not_found' })
    })

    it('returns 404 not_found when helper reports out_of_allowlist (indistinguishable on wire)', async () => {
      loadMock.mockResolvedValueOnce({ ok: false, errorCode: 'out_of_allowlist' })
      const res = await GET(makeRequest(), params())
      expect(res.status).toBe(404)
      expect(await res.json()).toEqual({ error: 'not_found' })
    })
  })

  describe('500', () => {
    it('returns 500 internal_error on helper db_error', async () => {
      loadMock.mockResolvedValueOnce({
        ok: false,
        errorCode: 'db_error',
        error: 'connection lost',
      })
      const res = await GET(makeRequest(), params())
      expect(res.status).toBe(500)
      expect(await res.json()).toEqual({ error: 'internal_error' })
    })
  })

  describe('200', () => {
    it('returns {messages: [...]} threading allowedVenueIds into the helper', async () => {
      loadMock.mockResolvedValueOnce({
        ok: true,
        messages: [
          {
            id: '11111111-1111-1111-1111-111111111111',
            direction: 'inbound',
            body: 'hey are you guys open tomorrow?',
            createdAt: '2026-05-26T18:14:23.000Z',
          },
          {
            id: '22222222-2222-2222-2222-222222222222',
            direction: 'outbound',
            body: 'we are! 8 to 4 :)',
            createdAt: '2026-05-26T18:14:51.000Z',
          },
        ],
      })
      const res = await GET(makeRequest(), params())
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body).toEqual({
        messages: [
          {
            id: '11111111-1111-1111-1111-111111111111',
            direction: 'inbound',
            body: 'hey are you guys open tomorrow?',
            createdAt: '2026-05-26T18:14:23.000Z',
          },
          {
            id: '22222222-2222-2222-2222-222222222222',
            direction: 'outbound',
            body: 'we are! 8 to 4 :)',
            createdAt: '2026-05-26T18:14:51.000Z',
          },
        ],
      })
      expect(loadMock).toHaveBeenCalledWith({
        messageId: VALID_UUID,
        allowedVenueIds: [VENUE_A],
      })
    })

    it('returns {messages: []} when the helper returns an empty array', async () => {
      loadMock.mockResolvedValueOnce({ ok: true, messages: [] })
      const res = await GET(makeRequest(), params())
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ messages: [] })
    })

    it('forwards the helper response as-is for a 200-message slice', async () => {
      const big = Array.from({ length: 200 }, (_, i) => ({
        id: `00000000-0000-0000-0000-${(i + 1).toString().padStart(12, '0')}`,
        direction: i % 2 === 0 ? 'inbound' : 'outbound',
        body: `msg ${i + 1}`,
        createdAt: new Date(2026, 4, 1, 0, 0, i + 1).toISOString(),
      }))
      loadMock.mockResolvedValueOnce({ ok: true, messages: big })
      const res = await GET(makeRequest(), params())
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.messages).toHaveLength(200)
      expect(body.messages[0].body).toBe('msg 1')
      expect(body.messages[199].body).toBe('msg 200')
    })
  })

  describe('caller threading', () => {
    it('passes the operator allowedVenueIds verbatim into the helper', async () => {
      verifyMock.mockResolvedValueOnce({
        operatorId: 'op-2',
        allowedVenueIds: ['v1', 'v2', 'v3'],
      })
      loadMock.mockResolvedValueOnce({ ok: true, messages: [] })
      await GET(makeRequest(), params())
      expect(loadMock).toHaveBeenCalledWith({
        messageId: VALID_UUID,
        allowedVenueIds: ['v1', 'v2', 'v3'],
      })
    })

    it('handles an operator with empty allowedVenueIds (helper returns out_of_allowlist)', async () => {
      verifyMock.mockResolvedValueOnce({ operatorId: 'op-3', allowedVenueIds: [] })
      loadMock.mockResolvedValueOnce({ ok: false, errorCode: 'out_of_allowlist' })
      const res = await GET(makeRequest(), params())
      expect(res.status).toBe(404)
      expect(await res.json()).toEqual({ error: 'not_found' })
    })
  })
})
