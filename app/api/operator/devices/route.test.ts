import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const verifyMock = vi.fn()
vi.mock('@/lib/auth/verify-jwt', () => ({
  verifyOperatorRequest: (...args: unknown[]) => verifyMock(...args),
}))

const updateThenMock = vi.fn()
const eqMock = vi.fn().mockReturnValue({ then: (r: (v: unknown) => unknown) => updateThenMock().then(r) })
const updateMock = vi.fn().mockReturnValue({ eq: eqMock })
const fromMock = vi.fn().mockReturnValue({ update: updateMock })
vi.mock('@/lib/db/admin', () => ({
  createAdminClient: () => ({ from: fromMock }),
}))

// Import AFTER mocks.
import { POST } from './route'

const VALID_TOKEN = 'a'.repeat(64)

function makeRequest(body: unknown): Request {
  return new Request('https://example.test/api/operator/devices', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })
}

beforeEach(() => {
  verifyMock.mockReset()
  verifyMock.mockResolvedValue({ operatorId: 'op-1', allowedVenueIds: ['v1'] })
  fromMock.mockClear()
  updateMock.mockClear()
  eqMock.mockClear()
  updateThenMock.mockReset()
  updateThenMock.mockResolvedValue({ error: null })
})

afterEach(() => {
  vi.clearAllMocks()
})

describe('POST /api/operator/devices', () => {
  it('returns 401 when bearer auth fails', async () => {
    const { AuthError } = await import('@/lib/auth/types')
    verifyMock.mockRejectedValueOnce(new AuthError(401, 'missing Authorization header'))
    const res = await POST(makeRequest({ token: VALID_TOKEN }), {
      params: Promise.resolve({}),
    })
    expect(res.status).toBe(401)
    expect(fromMock).not.toHaveBeenCalled()
  })

  it('returns 400 on missing token', async () => {
    const res = await POST(makeRequest({}), { params: Promise.resolve({}) })
    expect(res.status).toBe(400)
    expect(fromMock).not.toHaveBeenCalled()
  })

  it('returns 400 on non-hex token', async () => {
    const res = await POST(
      makeRequest({ token: 'not-hex-!!' + 'x'.repeat(30) }),
      { params: Promise.resolve({}) },
    )
    expect(res.status).toBe(400)
    expect(fromMock).not.toHaveBeenCalled()
  })

  it('returns 400 on too-short token', async () => {
    const res = await POST(
      makeRequest({ token: 'abcd' }),
      { params: Promise.resolve({}) },
    )
    expect(res.status).toBe(400)
  })

  it('returns 400 on too-long token (>256 chars)', async () => {
    const res = await POST(
      makeRequest({ token: 'a'.repeat(257) }),
      { params: Promise.resolve({}) },
    )
    expect(res.status).toBe(400)
  })

  it('returns 400 on non-JSON body', async () => {
    const res = await POST(makeRequest('not json'), { params: Promise.resolve({}) })
    expect(res.status).toBe(400)
  })

  it('upserts the token + timestamp on the authenticated operator and returns 200', async () => {
    const res = await POST(
      makeRequest({ token: VALID_TOKEN }),
      { params: Promise.resolve({}) },
    )
    expect(res.status).toBe(200)
    expect(fromMock).toHaveBeenCalledWith('operators')
    expect(updateMock).toHaveBeenCalledTimes(1)
    const [updatePayload] = updateMock.mock.calls[0]!
    expect(updatePayload.apns_device_token).toBe(VALID_TOKEN)
    expect(typeof updatePayload.apns_token_updated_at).toBe('string')
    expect(eqMock).toHaveBeenCalledWith('id', 'op-1')
  })

  it('returns 500 when the DB update fails', async () => {
    updateThenMock.mockResolvedValueOnce({ error: { message: 'db connection broke' } })
    const res = await POST(
      makeRequest({ token: VALID_TOKEN }),
      { params: Promise.resolve({}) },
    )
    expect(res.status).toBe(500)
  })

  it('accepts re-registration of the same token (idempotent)', async () => {
    const res1 = await POST(
      makeRequest({ token: VALID_TOKEN }),
      { params: Promise.resolve({}) },
    )
    expect(res1.status).toBe(200)
    const res2 = await POST(
      makeRequest({ token: VALID_TOKEN }),
      { params: Promise.resolve({}) },
    )
    expect(res2.status).toBe(200)
    expect(updateMock).toHaveBeenCalledTimes(2)
  })

  it('accepts the wire contract { token, platform } and silently ignores platform', async () => {
    const res = await POST(
      makeRequest({ token: VALID_TOKEN, platform: 'ios' }),
      { params: Promise.resolve({}) },
    )
    expect(res.status).toBe(200)
    const [updatePayload] = updateMock.mock.calls[0]!
    expect(updatePayload.apns_device_token).toBe(VALID_TOKEN)
    // platform is not persisted (iOS-only pilot, no column).
    expect('platform' in updatePayload).toBe(false)
  })
})
