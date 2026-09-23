// TAC-467. dispatchOperatorOutbound refuses a guest with no phone number
// (an Instagram guest) as `no_phone_number`, before the review_state flip.
// This route must answer it with exactly the response it already gives
// `sendblue_failed`, so the operator app, which already handles that 502,
// sees no new shape and the operator API Contract does not change. The test
// compares the two responses rather than restating one, so a future edit to
// either case that makes them diverge fails here.
//
// Mocking shape mirrors ../thread/route.test.ts. The failure path returns
// before any corpus write, but the route imports the voice-training module,
// which loads Voyage, so both are stubbed.

import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('voyageai', () => ({ VoyageAIClient: class {} }))
vi.mock('@/lib/voice-training', () => ({ upsertCorpusEdit: vi.fn() }))

const verifyMock = vi.fn()
vi.mock('@/lib/auth/verify-jwt', () => ({
  verifyOperatorRequest: (...args: unknown[]) => verifyMock(...args),
}))

const dispatchMock = vi.fn()
vi.mock('@/lib/operator', async () => {
  const actual = await vi.importActual<typeof import('@/lib/operator')>('@/lib/operator')
  return {
    ...actual,
    dispatchOperatorOutbound: (...args: unknown[]) => dispatchMock(...args),
  }
})

import { POST } from './route'
import { grantedVenues } from '@/lib/auth/venue-scope'

const VALID_UUID = '550e8400-e29b-41d4-a716-446655440000'
const VENUE_A = '00000000-0000-0000-0000-00000000000a'

async function edit(): Promise<{ status: number; body: unknown }> {
  const res = await POST(
    new Request(`https://example.test/api/operator/messages/${VALID_UUID}/edit`, {
      method: 'POST',
      headers: { authorization: 'Bearer fake-jwt', 'content-type': 'application/json' },
      body: JSON.stringify({ editedBody: 'we open at 7' }),
    }),
    { params: Promise.resolve({ id: VALID_UUID }) },
  )
  return { status: res.status, body: await res.json() }
}

beforeEach(() => {
  vi.clearAllMocks()
  verifyMock.mockResolvedValue({ operatorId: 'op-1', venueScope: grantedVenues([VENUE_A]) })
})

describe('POST /api/operator/messages/[id]/edit — guest with no phone (TAC-467)', () => {
  it('answers no_phone_number with the same 502 as sendblue_failed', async () => {
    dispatchMock.mockResolvedValueOnce({ ok: false, errorCode: 'no_phone_number', error: 'X' })
    const noPhone = await edit()
    dispatchMock.mockResolvedValueOnce({ ok: false, errorCode: 'sendblue_failed', error: 'X' })
    const sendFailed = await edit()

    expect(noPhone).toEqual(sendFailed)
    expect(noPhone).toEqual({ status: 502, body: { error: 'dispatch failed', detail: 'X' } })
  })
})


// TAC-530. See the twin block in ../approve/route.test.ts. Both routes reach
// the same helper, so both need the pass-through asserted separately \u2014 the
// helper's own deny test cannot see a route that fails to forward the scope.
describe('POST /api/operator/messages/[id]/edit \u2014 venue scope pass-through (TAC-530)', () => {
  it('passes the operator\u2019s allowlist to the dispatcher unchanged, including when empty', async () => {
    verifyMock.mockResolvedValue({ operatorId: 'op-1', venueScope: grantedVenues([]) })
    dispatchMock.mockResolvedValueOnce({ ok: false, errorCode: 'message_not_found', error: 'X' })
    await edit()
    expect(dispatchMock).toHaveBeenCalledTimes(1)
    expect(dispatchMock.mock.calls[0]![0]).toMatchObject({ venueScope: grantedVenues([]) })
  })

  it('passes a non-empty allowlist through unchanged', async () => {
    dispatchMock.mockResolvedValueOnce({ ok: false, errorCode: 'message_not_found', error: 'X' })
    await edit()
    expect(dispatchMock.mock.calls[0]![0]).toMatchObject({ venueScope: grantedVenues([VENUE_A]) })
  })
})
