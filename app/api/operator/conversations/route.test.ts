import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const verifyMock = vi.fn()
vi.mock('@/lib/auth/verify-jwt', () => ({
  verifyOperatorRequest: (...args: unknown[]) => verifyMock(...args),
}))

const listMock = vi.fn()
vi.mock('@/lib/operator', async () => {
  const actual = await vi.importActual<typeof import('@/lib/operator')>('@/lib/operator')
  return {
    ...actual,
    listOperatorConversations: (...args: unknown[]) => listMock(...args),
  }
})

import { GET } from './route'

const VENUE_A = '00000000-0000-0000-0000-00000000000a'

function makeRequest(): Request {
  return new Request('https://example.test/api/operator/conversations', {
    method: 'GET',
    headers: { authorization: 'Bearer fake-jwt' },
  })
}

beforeEach(() => {
  verifyMock.mockReset()
  verifyMock.mockResolvedValue({ operatorId: 'op-1', allowedVenueIds: [VENUE_A] })
  listMock.mockReset()
})

afterEach(() => {
  vi.clearAllMocks()
})

describe('GET /api/operator/conversations', () => {
  it("returns 401 {error:'unauthorized'} when AuthError is thrown", async () => {
    const { AuthError } = await import('@/lib/auth/types')
    verifyMock.mockRejectedValueOnce(new AuthError(401, 'invalid or expired token'))
    const res = await GET(makeRequest())
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ error: 'unauthorized' })
    expect(listMock).not.toHaveBeenCalled()
  })

  it("returns 500 {error:'internal_error'} when the helper fails", async () => {
    listMock.mockResolvedValueOnce({ ok: false, error: 'connection lost' })
    const res = await GET(makeRequest())
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ error: 'internal_error' })
  })

  it('returns {conversations: [...]} threading allowedVenueIds into the helper', async () => {
    listMock.mockResolvedValueOnce({
      ok: true,
      conversations: [
        {
          guestId: 'g1',
          venueId: VENUE_A,
          venueSlug: 'mock-sextant',
          venueTimezone: 'America/Los_Angeles',
          agentName: 'Sana',
          name: 'Maya R.',
          phoneFallback: '+15551110001',
          recognitionState: 'returning',
          lastMessageAt: '2026-09-05T21:39:00.000Z',
          lastMessageDirection: 'outbound',
          lastMessagePreview: 'Done — got you down for two at 7:30.',
          conversationCount: 4,
          firstConversationAt: '2026-06-10T18:00:00.000Z',
        },
      ],
    })
    const res = await GET(makeRequest())
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.conversations).toHaveLength(1)
    expect(body.conversations[0].guestId).toBe('g1')
    expect(listMock).toHaveBeenCalledWith([VENUE_A])
  })

  it('returns {conversations: []} for an operator with no venue grants', async () => {
    verifyMock.mockResolvedValueOnce({ operatorId: 'op-2', allowedVenueIds: [] })
    listMock.mockResolvedValueOnce({ ok: true, conversations: [] })
    const res = await GET(makeRequest())
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ conversations: [] })
    expect(listMock).toHaveBeenCalledWith([])
  })
})
