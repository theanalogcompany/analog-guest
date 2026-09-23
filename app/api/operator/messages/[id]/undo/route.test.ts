// TAC-530: POST /api/operator/messages/[id]/undo.
//
// This route had NO test file. Its initial read carried the cookie path's
// `if (allowedVenueIds.length > 0)` idiom on bearer-path data, so an operator
// with a valid JWT and zero venue grants read — and could undo — any card in
// the fleet.
//
// Scope note: these tests cover the venue-scoping fix and the one revert path
// it guards. Full state-machine coverage (window boundary, operator mismatch,
// the approve/edit log-only branch) is pre-existing missing coverage and is
// reported as a finding rather than folded into a security fix.
//
// Mocking shape mirrors ../resolve-external/route.test.ts: the builders RECORD
// their filters so "the allowlist was applied" is assertable.

import { beforeEach, describe, expect, it, vi } from 'vitest'

const verifyMock = vi.fn()
vi.mock('@/lib/auth/verify-jwt', () => ({
  verifyOperatorRequest: (...args: unknown[]) => verifyMock(...args),
}))

const captureMock = vi.fn()
vi.mock('@/lib/analytics/posthog', () => ({
  captureOperatorMessageActionUndone: (...args: unknown[]) => captureMock(...args),
}))

interface DbScript {
  /** The row the initial read found. */
  row?: Record<string, unknown> | null
  readError?: string
  /** Rows the revert UPDATE matched. */
  reverted?: Array<Record<string, unknown>>
}

const readFilters: Array<Record<string, unknown>> = []
const revertFilters: Array<Record<string, unknown>> = []
let revertPatch: Record<string, unknown> = {}
let script: DbScript = {}
let fromCalls = 0

vi.mock('@/lib/db/admin', () => ({
  createAdminClient: () => ({
    from() {
      fromCalls += 1
      return {
        select() {
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
            async maybeSingle() {
              readFilters.push({ ...filters })
              if (script.readError) {
                return { data: null, error: { message: script.readError } }
              }
              return { data: script.row ?? null, error: null }
            },
          }
          return b
        },
        update(patch: Record<string, unknown>) {
          revertPatch = patch
          const filters: Record<string, unknown> = {}
          const b = {
            eq(c: string, v: unknown) {
              filters[c] = v
              return b
            },
            async select() {
              revertFilters.push({ ...filters })
              return { data: script.reverted ?? [], error: null }
            },
          }
          return b
        },
      }
    },
  }),
}))

import { POST } from './route'
import { grantedVenues } from '@/lib/auth/venue-scope'

const VALID_UUID = '550e8400-e29b-41d4-a716-446655440000'
const VENUE_A = '00000000-0000-0000-0000-00000000000a'
const VENUE_B = '00000000-0000-0000-0000-00000000000b'

/** A just-skipped card, inside the 3s undo window, owned by op-1. */
function skippedCard(overrides: Record<string, unknown> = {}) {
  return {
    id: VALID_UUID,
    venue_id: VENUE_A,
    guest_id: 'guest-1',
    review_state: 'skipped',
    previous_review_state: 'pending',
    last_operator_action_at: new Date().toISOString(),
    last_operator_id: 'op-1',
    direction: 'outbound',
    ...overrides,
  }
}

async function undo(
  id: string = VALID_UUID,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await POST(
    new Request(`https://example.test/api/operator/messages/${id}/undo`, {
      method: 'POST',
      headers: { authorization: 'Bearer fake-jwt' },
    }),
    { params: Promise.resolve({ id }) },
  )
  return { status: res.status, body: (await res.json()) as Record<string, unknown> }
}

beforeEach(() => {
  vi.clearAllMocks()
  readFilters.length = 0
  revertFilters.length = 0
  revertPatch = {}
  script = {}
  fromCalls = 0
  verifyMock.mockResolvedValue({ operatorId: 'op-1', venueScope: grantedVenues([VENUE_A]) })
})

describe('POST /api/operator/messages/[id]/undo', () => {
  // The fixture is a card that WOULD be undoable if the filter were skipped:
  // right state, right operator, inside the window. A fixture with no matching
  // row passes whether or not the guard exists.
  it('answers 404 and touches nothing when the operator is allowlisted for no venue', async () => {
    verifyMock.mockResolvedValue({ operatorId: 'op-1', venueScope: grantedVenues([]) })
    script = { row: skippedCard(), reverted: [{ id: VALID_UUID }] }
    expect(await undo()).toEqual({ status: 404, body: { error: 'not found' } })
    expect(fromCalls).toBe(0)
    expect(readFilters).toHaveLength(0)
    expect(revertFilters).toHaveLength(0)
    expect(captureMock).not.toHaveBeenCalled()
  })

  it('scopes the initial read to the venue allowlist', async () => {
    script = { row: skippedCard(), reverted: [{ id: VALID_UUID }] }
    await undo()
    expect(readFilters[0]).toEqual({ id: VALID_UUID, venue_id: [VENUE_A] })
  })

  it('answers the same 404 for an out-of-allowlist card as for one that does not exist', async () => {
    verifyMock.mockResolvedValue({ operatorId: 'op-1', venueScope: grantedVenues([VENUE_B]) })
    script = { row: null }
    const outOfScope = await undo()
    script = { row: null }
    const absent = await undo()
    expect(outOfScope).toEqual(absent)
    expect(outOfScope).toEqual({ status: 404, body: { error: 'not found' } })
  })

  it('reverts a skip it is granted, back to pending', async () => {
    script = { row: skippedCard(), reverted: [{ id: VALID_UUID }] }
    expect(await undo()).toEqual({
      status: 200,
      body: { status: 'undone', messageId: VALID_UUID, reviewState: 'pending' },
    })
    expect(revertPatch).toEqual({
      review_state: 'pending',
      previous_review_state: null,
      last_operator_action_at: null,
      last_operator_id: null,
    })
    expect(captureMock).toHaveBeenCalledTimes(1)
  })

  it('answers 404 for an inbound row', async () => {
    script = { row: skippedCard({ direction: 'inbound' }) }
    expect(await undo()).toEqual({ status: 404, body: { error: 'not found' } })
    expect(revertFilters).toHaveLength(0)
  })

  it('answers 400 for a malformed messageId without touching the database', async () => {
    expect(await undo('not-a-uuid')).toEqual({
      status: 400,
      body: { error: 'invalid messageId' },
    })
    expect(fromCalls).toBe(0)
  })
})
