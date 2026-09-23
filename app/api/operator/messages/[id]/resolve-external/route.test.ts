// TAC-473: POST /api/operator/messages/[id]/resolve-external.
//
// Every status and body below is transcribed from the `## Contract` section of
// the TAC-473 description, never read back out of route.ts. A test written by
// reading the handler can only confirm the handler equals itself, which is how
// TAC-310 certified a live cross-repo defect on every green run.
//
// Mocking shape mirrors ../thread/route.test.ts.

import { beforeEach, describe, expect, it, vi } from 'vitest'

const verifyMock = vi.fn()
vi.mock('@/lib/auth/verify-jwt', () => ({
  verifyOperatorRequest: (...args: unknown[]) => verifyMock(...args),
}))

const captureMock = vi.fn()
vi.mock('@/lib/analytics/posthog', () => ({
  captureOperatorMessageResolvedExternally: (...args: unknown[]) => captureMock(...args),
}))

interface DbScript {
  /** Rows the CAS update matched. */
  claimed?: Array<Record<string, unknown>>
  claimError?: string
  /** The row the fallback lookup found. */
  current?: Record<string, unknown> | null
  lookupError?: string
}

const updateFilters: Array<Record<string, unknown>> = []
let updatePatch: Record<string, unknown> = {}
let script: DbScript = {}

vi.mock('@/lib/db/admin', () => ({
  createAdminClient: () => ({
    from() {
      return {
        update(patch: Record<string, unknown>) {
          updatePatch = patch
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
              updateFilters.push(filters)
              if (script.claimError) return { data: null, error: { message: script.claimError } }
              return { data: script.claimed ?? [], error: null }
            },
          }
          return b
        },
        select() {
          const b = {
            eq() {
              return b
            },
            in() {
              return b
            },
            async maybeSingle() {
              if (script.lookupError) return { data: null, error: { message: script.lookupError } }
              return { data: script.current ?? null, error: null }
            },
          }
          return b
        },
      }
    },
  }),
}))

import { AuthError } from '@/lib/auth'

import { POST } from './route'

const VALID_UUID = '550e8400-e29b-41d4-a716-446655440000'
const VENUE_A = '00000000-0000-0000-0000-00000000000a'

const PENDING_CARD = {
  id: VALID_UUID,
  venue_id: VENUE_A,
  guest_id: 'guest-1',
  channel: 'instagram',
  created_at: '2026-09-23T10:00:00.000Z',
}

async function resolveExternal(
  id: string = VALID_UUID,
  headers: Record<string, string> = { authorization: 'Bearer fake-jwt' },
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await POST(
    new Request(`https://example.test/api/operator/messages/${id}/resolve-external`, {
      method: 'POST',
      headers,
    }),
    { params: Promise.resolve({ id }) },
  )
  return { status: res.status, body: (await res.json()) as Record<string, unknown> }
}

beforeEach(() => {
  vi.clearAllMocks()
  updateFilters.length = 0
  updatePatch = {}
  script = {}
  verifyMock.mockResolvedValue({ operatorId: 'op-1', allowedVenueIds: [VENUE_A] })
})

describe('POST /api/operator/messages/[id]/resolve-external', () => {
  it('resolves a pending card and answers the Contract 200', async () => {
    script = { claimed: [PENDING_CARD] }
    expect(await resolveExternal()).toEqual({
      status: 200,
      body: { ok: true, reviewState: 'resolved_externally' },
    })
  })

  it('writes the review state, the operator and the time, and nothing else', async () => {
    script = { claimed: [PENDING_CARD] }
    await resolveExternal()
    // toEqual on the KEY SET, not toMatchObject. resolved_by_message_id must
    // stay NULL here — an operator asserting a send is a weaker record than an
    // echo proving it, and a partial match would pass while it crept in.
    expect(Object.keys(updatePatch).sort()).toEqual([
      'last_operator_action_at',
      'last_operator_id',
      'review_state',
    ])
    expect(updatePatch.review_state).toBe('resolved_externally')
    expect(updatePatch.last_operator_id).toBe('op-1')
  })

  it('does not set previous_review_state, so /undo cannot reach it', async () => {
    script = { claimed: [PENDING_CARD] }
    await resolveExternal()
    expect(updatePatch).not.toHaveProperty('previous_review_state')
  })

  it('CAS-guards on pending, outbound, this id and the venue allowlist', async () => {
    script = { claimed: [PENDING_CARD] }
    await resolveExternal()
    expect(updateFilters[0]).toEqual({
      id: VALID_UUID,
      review_state: 'pending',
      direction: 'outbound',
      venue_id: [VENUE_A],
    })
  })

  it('is idempotent: a second call answers 200 with alreadyResolved', async () => {
    // The operator may double-tap, and the echo may land between their tap and
    // this request. Either way the card is resolved; an error would be wrong.
    script = { claimed: [], current: { id: VALID_UUID, review_state: 'resolved_externally', direction: 'outbound' } }
    expect(await resolveExternal()).toEqual({
      status: 200,
      body: { ok: true, reviewState: 'resolved_externally', alreadyResolved: true },
    })
  })

  it('reports a card an operator already approved as alreadyResolved, without touching it', async () => {
    script = { claimed: [], current: { id: VALID_UUID, review_state: 'approved', direction: 'outbound' } }
    const res = await resolveExternal()
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ ok: true, reviewState: 'approved', alreadyResolved: true })
  })

  it('answers 401 with the Contract body when the bearer is missing or invalid', async () => {
    verifyMock.mockRejectedValueOnce(new AuthError(401, 'missing Authorization header'))
    const res = await resolveExternal(VALID_UUID, {})
    expect(res).toEqual({ status: 401, body: { error: 'unauthorized' } })
    // The HOF would have forwarded err.message here; the Contract says it must not.
    expect(JSON.stringify(res.body)).not.toContain('Authorization')
  })

  it('answers 404 for a message that does not exist', async () => {
    script = { claimed: [], current: null }
    expect(await resolveExternal()).toEqual({ status: 404, body: { error: 'not_found' } })
  })

  it('answers 404, not 400, for an id that is not a UUID', async () => {
    expect(await resolveExternal('not-a-uuid')).toEqual({ status: 404, body: { error: 'not_found' } })
  })

  it('answers 404 for a card outside the venue allowlist, leaking no existence', async () => {
    // The allowlist is applied to the lookup too, so an out-of-allowlist card
    // comes back as absent and is indistinguishable from one that never existed.
    verifyMock.mockResolvedValue({ operatorId: 'op-1', allowedVenueIds: ['other-venue'] })
    script = { claimed: [], current: null }
    const outOfScope = await resolveExternal()
    verifyMock.mockResolvedValue({ operatorId: 'op-1', allowedVenueIds: [VENUE_A] })
    script = { claimed: [], current: null }
    const absent = await resolveExternal()
    expect(outOfScope).toEqual(absent)
    expect(outOfScope).toEqual({ status: 404, body: { error: 'not_found' } })
  })

  it('answers 404 for an inbound row', async () => {
    script = { claimed: [], current: { id: VALID_UUID, review_state: null, direction: 'inbound' } }
    expect(await resolveExternal()).toEqual({ status: 404, body: { error: 'not_found' } })
  })

  it.each([
    ['the update', { claimError: 'boom' }],
    ['the lookup', { claimed: [], lookupError: 'boom' }],
  ] as const)('answers 500 with the Contract body when %s fails, leaking no detail', async (_n, s) => {
    script = s as DbScript
    const res = await resolveExternal()
    expect(res).toEqual({ status: 500, body: { error: 'internal_error' } })
    expect(JSON.stringify(res.body)).not.toContain('boom')
  })

  it('records the action, with the channel, only when it actually resolved one', async () => {
    script = { claimed: [PENDING_CARD] }
    await resolveExternal()
    expect(captureMock).toHaveBeenCalledTimes(1)
    expect(captureMock).toHaveBeenCalledWith(
      expect.objectContaining({ messageId: VALID_UUID, operatorId: 'op-1', channel: 'instagram' }),
    )

    captureMock.mockClear()
    script = { claimed: [], current: { id: VALID_UUID, review_state: 'approved', direction: 'outbound' } }
    await resolveExternal()
    expect(captureMock).not.toHaveBeenCalled()
  })
})
