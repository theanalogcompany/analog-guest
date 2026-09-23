// TAC-530: GET /api/operator/queue.
//
// This route had no test file. Its two helpers (listPendingQueue,
// listHeadsUpQueue) each deny on an empty allowlist and are tested for it in
// lib/operator/queue.test.ts and heads-up-queue.test.ts. What was never
// asserted is that the route forwards the operator's scope to both of them
// verbatim — a route that dropped or substituted it would make both denies
// unreachable while every existing test stayed green.
//
// Unlike the other operator endpoints, a grantless operator here is NOT an
// error: the route answers 200 with two empty lists, because "you have no
// venues" and "your venues have nothing waiting" are the same screen. That is
// deliberate (see the route header) and is asserted below so a future change
// to a 403 is a decision rather than a drift.

import { beforeEach, describe, expect, it, vi } from 'vitest'

const verifyMock = vi.fn()
vi.mock('@/lib/auth/verify-jwt', () => ({
  verifyOperatorRequest: (...args: unknown[]) => verifyMock(...args),
}))

const pendingMock = vi.fn()
const headsUpMock = vi.fn()
vi.mock('@/lib/operator', async () => {
  const actual = await vi.importActual<typeof import('@/lib/operator')>('@/lib/operator')
  return {
    ...actual,
    listPendingQueue: (...args: unknown[]) => pendingMock(...args),
    listHeadsUpQueue: (...args: unknown[]) => headsUpMock(...args),
  }
})

import { GET } from './route'

const VENUE_A = '00000000-0000-0000-0000-00000000000a'

async function queue(): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await GET(
    new Request('https://example.test/api/operator/queue', {
      method: 'GET',
      headers: { authorization: 'Bearer fake-jwt' },
    }),
    { params: Promise.resolve({}) },
  )
  return { status: res.status, body: (await res.json()) as Record<string, unknown> }
}

beforeEach(() => {
  vi.clearAllMocks()
  verifyMock.mockResolvedValue({ operatorId: 'op-1', allowedVenueIds: [VENUE_A] })
  pendingMock.mockResolvedValue({ ok: true, drafts: [] })
  headsUpMock.mockResolvedValue({ ok: true, commitments: [] })
})

describe('GET /api/operator/queue — venue scope (TAC-530)', () => {
  it('passes the operator’s allowlist to BOTH lookups unchanged, including when empty', async () => {
    verifyMock.mockResolvedValue({ operatorId: 'op-1', allowedVenueIds: [] })
    await queue()
    expect(pendingMock).toHaveBeenCalledWith([])
    expect(headsUpMock).toHaveBeenCalledWith([])
  })

  it('passes a non-empty allowlist to BOTH lookups unchanged', async () => {
    await queue()
    expect(pendingMock).toHaveBeenCalledWith([VENUE_A])
    expect(headsUpMock).toHaveBeenCalledWith([VENUE_A])
  })

  it('answers a grantless operator with two empty lists, not an error', async () => {
    verifyMock.mockResolvedValue({ operatorId: 'op-1', allowedVenueIds: [] })
    expect(await queue()).toEqual({ status: 200, body: { drafts: [], commitments: [] } })
  })

  it('answers 500 when the draft lookup fails', async () => {
    pendingMock.mockResolvedValue({ ok: false, error: 'boom' })
    const { status, body } = await queue()
    expect(status).toBe(500)
    expect(body).toEqual({ error: 'queue lookup failed', detail: 'boom' })
  })

  it('answers 500 when the heads-up lookup fails', async () => {
    headsUpMock.mockResolvedValue({ ok: false, error: 'boom' })
    const { status, body } = await queue()
    expect(status).toBe(500)
    expect(body).toEqual({ error: 'queue lookup failed', detail: 'boom' })
  })
})
