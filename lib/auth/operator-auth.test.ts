import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { type OperatorRouteHandler, withOperatorAuth } from './operator-auth'
import { AuthError } from './types'
import { verifyOperatorRequest } from './verify-jwt'

vi.mock('./verify-jwt', () => ({
  verifyOperatorRequest: vi.fn(),
}))

function emptyRequest(): Request {
  return new Request('https://example.test/api/operator/messages/m1/approve')
}

describe('withOperatorAuth', () => {
  beforeEach(() => {
    vi.mocked(verifyOperatorRequest).mockReset()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('threads { operator, params } into the inner handler on success', async () => {
    vi.mocked(verifyOperatorRequest).mockResolvedValue({
      operatorId: 'op-1',
      allowedVenueIds: ['venue-a', 'venue-b'],
    })
    const handler: OperatorRouteHandler<{ id: string }> = vi.fn(async (_req, ctx) => {
      return new Response(JSON.stringify({ ok: true, ...ctx }), { status: 200 })
    })
    const wrapped = withOperatorAuth<{ id: string }>(handler)
    const res = await wrapped(emptyRequest(), {
      params: Promise.resolve({ id: 'msg-1' }),
    })
    expect(res.status).toBe(200)
    expect(handler).toHaveBeenCalledOnce()
    const handlerMock = vi.mocked(handler)
    const ctx = handlerMock.mock.calls[0]![1]
    expect(ctx.operator).toEqual({
      operatorId: 'op-1',
      allowedVenueIds: ['venue-a', 'venue-b'],
    })
    expect(ctx.params).toEqual({ id: 'msg-1' })
  })

  it('returns 401 NextResponse when verifyOperatorRequest throws AuthError(401)', async () => {
    vi.mocked(verifyOperatorRequest).mockRejectedValue(
      new AuthError(401, 'missing Authorization header'),
    )
    const handler = vi.fn()
    const wrapped = withOperatorAuth(handler)
    const res = await wrapped(emptyRequest(), {
      params: Promise.resolve({}),
    })
    expect(res.status).toBe(401)
    await expect(res.json()).resolves.toEqual({ error: 'missing Authorization header' })
    expect(handler).not.toHaveBeenCalled()
  })

  it('returns 403 NextResponse when AuthError(403) is thrown', async () => {
    vi.mocked(verifyOperatorRequest).mockRejectedValue(
      new AuthError(403, 'venue not in allowlist'),
    )
    const handler = vi.fn()
    const wrapped = withOperatorAuth(handler)
    const res = await wrapped(emptyRequest(), {
      params: Promise.resolve({}),
    })
    expect(res.status).toBe(403)
    expect(handler).not.toHaveBeenCalled()
  })

  it('re-throws non-AuthError throws so Next 500 boundary catches them', async () => {
    vi.mocked(verifyOperatorRequest).mockRejectedValue(
      new Error('Missing env var: SUPABASE_SECRET_KEY'),
    )
    const handler = vi.fn()
    const wrapped = withOperatorAuth(handler)
    await expect(
      wrapped(emptyRequest(), { params: Promise.resolve({}) }),
    ).rejects.toThrow('Missing env var: SUPABASE_SECRET_KEY')
    expect(handler).not.toHaveBeenCalled()
  })

  it('awaits the Next.js params Promise before invoking the handler', async () => {
    vi.mocked(verifyOperatorRequest).mockResolvedValue({
      operatorId: 'op-1',
      allowedVenueIds: [],
    })
    const handler: OperatorRouteHandler<{ id: string }> = vi.fn(
      async () => new Response(null, { status: 204 }),
    )
    const wrapped = withOperatorAuth<{ id: string }>(handler)
    let resolveParams!: (v: { id: string }) => void
    const paramsPromise = new Promise<{ id: string }>((res) => {
      resolveParams = res
    })
    const responsePromise = wrapped(emptyRequest(), { params: paramsPromise })
    // params not yet resolved — handler shouldn't have been called
    expect(handler).not.toHaveBeenCalled()
    resolveParams({ id: 'late-id' })
    await responsePromise
    expect(handler).toHaveBeenCalledOnce()
    const handlerMock = vi.mocked(handler)
    expect(handlerMock.mock.calls[0]![1].params).toEqual({ id: 'late-id' })
  })
})
