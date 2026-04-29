import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getCurrentOperator } from './get-current-operator'
import { AuthError } from './types'
import { verifyOperatorRequest } from './verify-jwt'

vi.mock('./verify-jwt', () => ({
  verifyOperatorRequest: vi.fn(),
}))

function emptyRequest(): Request {
  return new Request('https://example.test/api/x')
}

describe('getCurrentOperator', () => {
  beforeEach(() => {
    vi.mocked(verifyOperatorRequest).mockReset()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('returns the AuthenticatedOperator when verifyOperatorRequest resolves', async () => {
    vi.mocked(verifyOperatorRequest).mockResolvedValue({
      operatorId: 'operator-1',
      allowedVenueIds: ['venue-a'],
    })
    const out = await getCurrentOperator(emptyRequest())
    expect(out).toEqual({ operatorId: 'operator-1', allowedVenueIds: ['venue-a'] })
  })

  it('returns a 401 Response when verifyOperatorRequest throws AuthError(401)', async () => {
    vi.mocked(verifyOperatorRequest).mockRejectedValue(
      new AuthError(401, 'invalid or expired token'),
    )
    const out = await getCurrentOperator(emptyRequest())
    expect(out).toBeInstanceOf(Response)
    const res = out as Response
    expect(res.status).toBe(401)
    expect(res.headers.get('content-type')).toBe('application/json')
    await expect(res.json()).resolves.toEqual({ error: 'invalid or expired token' })
  })

  it('returns a 403 Response when AuthError(403) is thrown (forwards forwarded statuses)', async () => {
    // The wrapper passes through any AuthError status. The verify helper
    // itself never throws 403 — but route handlers downstream can throw one
    // and rely on this wrapper to format it consistently if they choose to
    // re-use the conversion.
    vi.mocked(verifyOperatorRequest).mockRejectedValue(
      new AuthError(403, 'venue not in allowlist'),
    )
    const out = await getCurrentOperator(emptyRequest())
    expect(out).toBeInstanceOf(Response)
    expect((out as Response).status).toBe(403)
  })

  it('re-throws non-AuthError errors (infra failures, missing env vars, etc.)', async () => {
    vi.mocked(verifyOperatorRequest).mockRejectedValue(
      new Error('Missing env var: SUPABASE_SECRET_KEY'),
    )
    await expect(getCurrentOperator(emptyRequest())).rejects.toThrow(
      'Missing env var: SUPABASE_SECRET_KEY',
    )
  })
})
