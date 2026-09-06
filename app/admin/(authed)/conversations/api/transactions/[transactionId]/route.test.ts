// Mock signatures mirror the supabase-js fluent builder, which passes
// column names + filter args we don't inspect inside the test.
/* eslint-disable @typescript-eslint/no-unused-vars */

import { beforeEach, describe, expect, it, vi } from 'vitest'

// Mocks must be hoisted before importing the route handler.
vi.mock('@/lib/db/server', () => ({
  createServerClient: vi.fn(),
}))
vi.mock('@/lib/auth', async () => {
  const actual = await vi.importActual<typeof import('@/lib/auth')>('@/lib/auth')
  return {
    ...actual,
    verifyAnalogAdminAccess: vi.fn(),
  }
})
vi.mock('@/lib/db/admin', () => ({
  createAdminClient: vi.fn(),
}))

import { AuthError, verifyAnalogAdminAccess } from '@/lib/auth'
import { createAdminClient } from '@/lib/db/admin'
import { createServerClient } from '@/lib/db/server'
import { DELETE } from './route'

const TRANSACTION_ID = '11111111-1111-4111-8111-111111111111'
const VENUE_ID = '22222222-2222-4222-8222-222222222222'
const OPERATOR_ID = '33333333-3333-4333-8333-333333333333'
const AUTH_USER_ID = '44444444-4444-4444-8444-444444444444'

interface AdminMockState {
  transaction: { id: string; venue_id: string; source: string } | null
  lookupError: { message: string } | null
  deleteCalls: string[]
  deleteError: { message: string } | null
}

function newAdminState(overrides: Partial<AdminMockState> = {}): AdminMockState {
  return {
    transaction: { id: TRANSACTION_ID, venue_id: VENUE_ID, source: 'guest_reported' },
    lookupError: null,
    deleteCalls: [],
    deleteError: null,
    ...overrides,
  }
}

function makeAdminMock(state: AdminMockState) {
  return {
    from: (_table: string) => ({
      select: (_cols: string) => ({
        eq: (_f: string, _v: unknown) => ({
          maybeSingle: async () => ({ data: state.transaction, error: state.lookupError }),
        }),
      }),
      delete: () => ({
        eq: async (_f: string, v: unknown) => {
          state.deleteCalls.push(String(v))
          return { error: state.deleteError }
        },
      }),
    }),
  }
}

function makeSessionMock(session: { user: { id: string } } | null) {
  return {
    auth: {
      getSession: async () => ({ data: { session }, error: null }),
    },
  }
}

function buildParams(transactionId: string) {
  return { params: Promise.resolve({ transactionId }) }
}

beforeEach(() => {
  vi.mocked(createServerClient).mockReset()
  vi.mocked(createAdminClient).mockReset()
  vi.mocked(verifyAnalogAdminAccess).mockReset()
})

describe('DELETE /admin/conversations/api/transactions/[transactionId] — auth', () => {
  it('returns 401 when no session', async () => {
    vi.mocked(createServerClient).mockResolvedValue(
      makeSessionMock(null) as unknown as Awaited<ReturnType<typeof createServerClient>>,
    )

    const res = await DELETE(new Request('http://test'), buildParams(TRANSACTION_ID))
    expect(res.status).toBe(401)
  })

  it('returns 403 when operator is not an analog admin', async () => {
    vi.mocked(createServerClient).mockResolvedValue(
      makeSessionMock({ user: { id: AUTH_USER_ID } }) as unknown as Awaited<
        ReturnType<typeof createServerClient>
      >,
    )
    vi.mocked(verifyAnalogAdminAccess).mockRejectedValue(new AuthError(403, 'not an analog admin'))

    const res = await DELETE(new Request('http://test'), buildParams(TRANSACTION_ID))
    expect(res.status).toBe(403)
  })
})

describe('DELETE /admin/conversations/api/transactions/[transactionId] — validation + guards', () => {
  beforeEach(() => {
    vi.mocked(createServerClient).mockResolvedValue(
      makeSessionMock({ user: { id: AUTH_USER_ID } }) as unknown as Awaited<
        ReturnType<typeof createServerClient>
      >,
    )
    vi.mocked(verifyAnalogAdminAccess).mockResolvedValue({
      operatorId: OPERATOR_ID,
      allowedVenueIds: [],
      isAnalogAdmin: true,
    })
  })

  it('returns 400 for an invalid transactionId', async () => {
    const res = await DELETE(new Request('http://test'), buildParams('not-a-uuid'))
    expect(res.status).toBe(400)
  })

  it('returns 404 when the transaction does not exist', async () => {
    const state = newAdminState({ transaction: null })
    vi.mocked(createAdminClient).mockReturnValue(
      makeAdminMock(state) as unknown as ReturnType<typeof createAdminClient>,
    )

    const res = await DELETE(new Request('http://test'), buildParams(TRANSACTION_ID))
    expect(res.status).toBe(404)
  })

  it('returns 403 when the transaction is outside the operator allowlist', async () => {
    vi.mocked(verifyAnalogAdminAccess).mockResolvedValue({
      operatorId: OPERATOR_ID,
      allowedVenueIds: ['some-other-venue-id'],
      isAnalogAdmin: true,
    })
    const state = newAdminState()
    vi.mocked(createAdminClient).mockReturnValue(
      makeAdminMock(state) as unknown as ReturnType<typeof createAdminClient>,
    )

    const res = await DELETE(new Request('http://test'), buildParams(TRANSACTION_ID))
    expect(res.status).toBe(403)
    expect(state.deleteCalls).toHaveLength(0)
  })

  it('returns 400 and does not delete a non-guest_reported transaction', async () => {
    const state = newAdminState({ transaction: { id: TRANSACTION_ID, venue_id: VENUE_ID, source: 'square' } })
    vi.mocked(createAdminClient).mockReturnValue(
      makeAdminMock(state) as unknown as ReturnType<typeof createAdminClient>,
    )

    const res = await DELETE(new Request('http://test'), buildParams(TRANSACTION_ID))
    expect(res.status).toBe(400)
    expect(state.deleteCalls).toHaveLength(0)
  })

  it('deletes a guest_reported transaction within the allowlist', async () => {
    const state = newAdminState()
    vi.mocked(createAdminClient).mockReturnValue(
      makeAdminMock(state) as unknown as ReturnType<typeof createAdminClient>,
    )

    const res = await DELETE(new Request('http://test'), buildParams(TRANSACTION_ID))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toEqual({ success: true, deleted: true })
    expect(state.deleteCalls).toEqual([TRANSACTION_ID])
  })

  it('returns 500 when the delete fails', async () => {
    const state = newAdminState({ deleteError: { message: 'db exploded' } })
    vi.mocked(createAdminClient).mockReturnValue(
      makeAdminMock(state) as unknown as ReturnType<typeof createAdminClient>,
    )

    const res = await DELETE(new Request('http://test'), buildParams(TRANSACTION_ID))
    expect(res.status).toBe(500)
  })
})
