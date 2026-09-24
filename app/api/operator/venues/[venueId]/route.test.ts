// TAC-516: the venue-state endpoint. Bodies transcribed from the Contract.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const verifyOperatorRequestMock = vi.fn()
vi.mock('@/lib/auth', async () => {
  const actual = await vi.importActual<typeof import('@/lib/auth')>('@/lib/auth')
  return { ...actual, verifyOperatorRequest: (req: Request) => verifyOperatorRequestMock(req) }
})

const loadMock = vi.fn()
vi.mock('@/lib/operator/venue-connection', () => ({
  loadVenueConnectionState: (...a: unknown[]) => loadMock(...a),
}))

vi.mock('@/lib/db/admin', () => ({ createAdminClient: () => ({}) }))

import { AuthError } from '@/lib/auth'
import { ALL_VENUES, grantedVenues } from '@/lib/auth/venue-scope'

import { GET } from './route'

const VENUE_ID = '11111111-1111-4111-8111-111111111111'
const OTHER_VENUE_ID = '22222222-2222-4222-8222-222222222222'
const OPERATOR_ID = '33333333-3333-4333-8333-333333333333'

const CONNECTED = {
  instagram: { status: 'connected', username: 'lemilscoffee', expiresAt: '2026-11-21T00:00:00.000Z' },
}

function call(venueId = VENUE_ID) {
  return GET(
    new Request('http://localhost/api/operator/venues/x', {
      headers: { authorization: 'Bearer token' },
    }),
    { params: Promise.resolve({ venueId }) },
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  verifyOperatorRequestMock.mockResolvedValue({
    operatorId: OPERATOR_ID,
    venueScope: grantedVenues([VENUE_ID]),
  })
  loadMock.mockResolvedValue({ ok: true, state: CONNECTED })
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('GET /api/operator/venues/[venueId]', () => {
  it('returns the Contract shape', async () => {
    const res = await call()
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual(CONNECTED)
  })

  it('returns 401 with the Contract body, never AuthError.message', async () => {
    verifyOperatorRequestMock.mockRejectedValue(new AuthError(401, 'JWT expired'))
    const res = await call()
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ error: 'unauthorized' })
  })

  // 404, not 403, matching every other /api/operator/* route.
  it('returns 404 for a venue outside the allowlist', async () => {
    const res = await call(OTHER_VENUE_ID)
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: 'not_found' })
    expect(loadMock).not.toHaveBeenCalled()
  })

  // THE TAC-530 CASE, on a read this time: a grantless bearer must not read
  // any venue's state.
  it('returns 404 for an operator with NO venue grants, without querying', async () => {
    verifyOperatorRequestMock.mockResolvedValue({
      operatorId: OPERATOR_ID,
      venueScope: grantedVenues([]),
    })
    const res = await call()
    expect(res.status).toBe(404)
    expect(loadMock).not.toHaveBeenCalled()
  })

  it('returns 404 for a fleet-wide scope, which this bearer path must never honour', async () => {
    verifyOperatorRequestMock.mockResolvedValue({ operatorId: OPERATOR_ID, venueScope: ALL_VENUES })
    expect((await call()).status).toBe(404)
    expect(loadMock).not.toHaveBeenCalled()
  })

  it('returns 404 for a non-UUID venue', async () => {
    const res = await call('not-a-uuid')
    expect(res.status).toBe(404)
    expect(loadMock).not.toHaveBeenCalled()
  })

  // A read failure must not render as "disconnected": that would tell an
  // operator their Instagram is down when it is working.
  it('returns 500 rather than reporting a failed read as disconnected', async () => {
    loadMock.mockResolvedValue({ ok: false, error: 'timeout' })
    const res = await call()
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ error: 'internal_error' })
  })
})
