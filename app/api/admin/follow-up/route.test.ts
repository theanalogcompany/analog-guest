import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { handleFollowup } from '@/lib/agent'
import { AuthError, verifyAnalogAdminAccess } from '@/lib/auth'
import { createAdminClient } from '@/lib/db/admin'
import { createServerClient } from '@/lib/db/server'
import { POST } from './route'

vi.mock('@/lib/agent', () => ({
  handleFollowup: vi.fn(),
}))

// Mock @/lib/auth without vi.importActual — vitest can't resolve the @/* alias
// inside a mock factory under our setup. We redefine AuthError here so the
// `instanceof AuthError` check in the route still hits the same constructor:
// both the route and this test import AuthError from '@/lib/auth', and that
// import resolves to this mocked module in both cases.
vi.mock('@/lib/auth', () => {
  class AuthError extends Error {
    readonly status: 401 | 403
    constructor(status: 401 | 403, message: string) {
      super(message)
      this.name = 'AuthError'
      this.status = status
    }
  }
  return {
    AuthError,
    verifyAnalogAdminAccess: vi.fn(),
  }
})

vi.mock('@/lib/db/admin', () => ({
  createAdminClient: vi.fn(),
}))

vi.mock('@/lib/db/server', () => ({
  createServerClient: vi.fn(),
}))

// Hand-crafted RFC-4122 UUIDs (version=4, variant=8) so they pass Zod's
// .uuid() format check.
const VENUE_ID = '11111111-1111-4111-8111-111111111111'
const GUEST_ID = '22222222-2222-4222-8222-222222222222'
const OTHER_VENUE_ID = '33333333-3333-4333-8333-333333333333'

type GuestRow = { id: string; opted_out_at: string | null }

interface AdminMockOpts {
  guestRow?: GuestRow | null
  guestError?: { message: string } | null
  recentManualCount?: number
  rateError?: { message: string } | null
}

// Builds the chained-builder shape used by both supabase reads in the route:
//   .from('guests').select(...).eq(...).eq(...).maybeSingle()
//   .from('messages').select(..., {count, head}).eq(...)... .gte(...)
// .gte() is the terminal call on the messages chain — it must be thenable so
// the route's `await ... gte(...)` resolves directly.
function makeAdminMock(opts: AdminMockOpts) {
  const guestResult = {
    data: opts.guestRow ?? null,
    error: opts.guestError ?? null,
  }
  const messagesResult = {
    count: opts.recentManualCount ?? 0,
    error: opts.rateError ?? null,
  }

  const guestBuilder = {
    select: () => guestBuilder,
    eq: () => guestBuilder,
    maybeSingle: () => Promise.resolve(guestResult),
  }

  const messagesBuilder = {
    select: () => messagesBuilder,
    eq: () => messagesBuilder,
    gte: () => Promise.resolve(messagesResult),
  }

  return {
    from: vi.fn((table: string) => {
      if (table === 'guests') return guestBuilder
      if (table === 'messages') return messagesBuilder
      throw new Error(`unexpected table in test: ${table}`)
    }),
  }
}

function makeSessionMock(session: { user: { id: string } } | null) {
  return {
    auth: {
      getSession: vi.fn().mockResolvedValue({ data: { session } }),
    },
  }
}

function makeRequest(body: unknown, opts: { rawBody?: string } = {}): Request {
  const init: RequestInit = {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: opts.rawBody ?? JSON.stringify(body),
  }
  return new Request('https://admin.example.test/api/admin/follow-up', init)
}

describe('POST /api/admin/follow-up', () => {
  beforeEach(() => {
    vi.mocked(handleFollowup).mockReset()
    vi.mocked(verifyAnalogAdminAccess).mockReset()
    vi.mocked(createAdminClient).mockReset()
    vi.mocked(createServerClient).mockReset()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('returns 401 when there is no session', async () => {
    vi.mocked(createServerClient).mockResolvedValue(makeSessionMock(null) as never)

    const res = await POST(makeRequest({ venueId: VENUE_ID, guestId: GUEST_ID, hint: null }))
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ error: 'unauthorized' })
    expect(handleFollowup).not.toHaveBeenCalled()
  })

  it('returns the AuthError status when verifyAnalogAdminAccess throws', async () => {
    vi.mocked(createServerClient).mockResolvedValue(
      makeSessionMock({ user: { id: 'auth-user-1' } }) as never,
    )
    vi.mocked(verifyAnalogAdminAccess).mockRejectedValue(
      new AuthError(403, 'not an analog admin'),
    )

    const res = await POST(makeRequest({ venueId: VENUE_ID, guestId: GUEST_ID, hint: null }))
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: 'not an analog admin' })
    expect(handleFollowup).not.toHaveBeenCalled()
  })

  it('returns 500 when the auth check fails for an unexpected reason', async () => {
    vi.mocked(createServerClient).mockResolvedValue(
      makeSessionMock({ user: { id: 'auth-user-1' } }) as never,
    )
    vi.mocked(verifyAnalogAdminAccess).mockRejectedValue(new Error('db down'))

    const res = await POST(makeRequest({ venueId: VENUE_ID, guestId: GUEST_ID, hint: null }))
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ error: 'auth check failed' })
  })

  it('returns 400 when the JSON body cannot be parsed', async () => {
    vi.mocked(createServerClient).mockResolvedValue(
      makeSessionMock({ user: { id: 'auth-user-1' } }) as never,
    )
    vi.mocked(verifyAnalogAdminAccess).mockResolvedValue({
      operatorId: 'op-1',
      allowedVenueIds: [],
      isAnalogAdmin: true,
    })

    const res = await POST(makeRequest(undefined, { rawBody: '{not json' }))
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'invalid json' })
  })

  it('returns 400 when the body fails Zod validation', async () => {
    vi.mocked(createServerClient).mockResolvedValue(
      makeSessionMock({ user: { id: 'auth-user-1' } }) as never,
    )
    vi.mocked(verifyAnalogAdminAccess).mockResolvedValue({
      operatorId: 'op-1',
      allowedVenueIds: [],
      isAnalogAdmin: true,
    })

    // venueId is not a uuid
    const res = await POST(
      makeRequest({ venueId: 'not-a-uuid', guestId: GUEST_ID, hint: null }),
    )
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toBe('invalid body')
    expect(typeof body.detail).toBe('string')
  })

  it('returns 400 when hint exceeds the max length', async () => {
    vi.mocked(createServerClient).mockResolvedValue(
      makeSessionMock({ user: { id: 'auth-user-1' } }) as never,
    )
    vi.mocked(verifyAnalogAdminAccess).mockResolvedValue({
      operatorId: 'op-1',
      allowedVenueIds: [],
      isAnalogAdmin: true,
    })

    const res = await POST(
      makeRequest({ venueId: VENUE_ID, guestId: GUEST_ID, hint: 'x'.repeat(501) }),
    )
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('invalid body')
  })

  it('returns 403 when the venue is not in the operator allowlist', async () => {
    vi.mocked(createServerClient).mockResolvedValue(
      makeSessionMock({ user: { id: 'auth-user-1' } }) as never,
    )
    vi.mocked(verifyAnalogAdminAccess).mockResolvedValue({
      operatorId: 'op-1',
      allowedVenueIds: [OTHER_VENUE_ID],
      isAnalogAdmin: true,
    })

    const res = await POST(
      makeRequest({ venueId: VENUE_ID, guestId: GUEST_ID, hint: null }),
    )
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: 'venue not allowed' })
    expect(handleFollowup).not.toHaveBeenCalled()
  })

  it('returns 404 when the guest is not at the venue', async () => {
    vi.mocked(createServerClient).mockResolvedValue(
      makeSessionMock({ user: { id: 'auth-user-1' } }) as never,
    )
    vi.mocked(verifyAnalogAdminAccess).mockResolvedValue({
      operatorId: 'op-1',
      allowedVenueIds: [VENUE_ID],
      isAnalogAdmin: true,
    })
    vi.mocked(createAdminClient).mockReturnValue(makeAdminMock({ guestRow: null }) as never)

    const res = await POST(
      makeRequest({ venueId: VENUE_ID, guestId: GUEST_ID, hint: null }),
    )
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: 'guest not found at venue' })
    expect(handleFollowup).not.toHaveBeenCalled()
  })

  it('returns 500 when the guest lookup errors', async () => {
    vi.mocked(createServerClient).mockResolvedValue(
      makeSessionMock({ user: { id: 'auth-user-1' } }) as never,
    )
    vi.mocked(verifyAnalogAdminAccess).mockResolvedValue({
      operatorId: 'op-1',
      allowedVenueIds: [VENUE_ID],
      isAnalogAdmin: true,
    })
    vi.mocked(createAdminClient).mockReturnValue(
      makeAdminMock({ guestError: { message: 'connection refused' } }) as never,
    )

    const res = await POST(
      makeRequest({ venueId: VENUE_ID, guestId: GUEST_ID, hint: null }),
    )
    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body.error).toBe('guest lookup failed')
    expect(body.detail).toBe('connection refused')
  })

  it('returns 403 when the guest is opted out', async () => {
    vi.mocked(createServerClient).mockResolvedValue(
      makeSessionMock({ user: { id: 'auth-user-1' } }) as never,
    )
    vi.mocked(verifyAnalogAdminAccess).mockResolvedValue({
      operatorId: 'op-1',
      allowedVenueIds: [VENUE_ID],
      isAnalogAdmin: true,
    })
    vi.mocked(createAdminClient).mockReturnValue(
      makeAdminMock({
        guestRow: { id: GUEST_ID, opted_out_at: '2026-04-29T00:00:00.000Z' },
      }) as never,
    )

    const res = await POST(
      makeRequest({ venueId: VENUE_ID, guestId: GUEST_ID, hint: null }),
    )
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: 'guest opted out' })
    expect(handleFollowup).not.toHaveBeenCalled()
  })

  it('returns 429 when a manual outbound exists in the rate-limit window', async () => {
    vi.mocked(createServerClient).mockResolvedValue(
      makeSessionMock({ user: { id: 'auth-user-1' } }) as never,
    )
    vi.mocked(verifyAnalogAdminAccess).mockResolvedValue({
      operatorId: 'op-1',
      allowedVenueIds: [VENUE_ID],
      isAnalogAdmin: true,
    })
    vi.mocked(createAdminClient).mockReturnValue(
      makeAdminMock({
        guestRow: { id: GUEST_ID, opted_out_at: null },
        recentManualCount: 1,
      }) as never,
    )

    const res = await POST(
      makeRequest({ venueId: VENUE_ID, guestId: GUEST_ID, hint: null }),
    )
    expect(res.status).toBe(429)
    const body = await res.json()
    expect(body.error).toBe('rate limited')
    expect(body.detail).toContain('5 minutes')
    expect(handleFollowup).not.toHaveBeenCalled()
  })

  it('returns 500 when the rate limit query errors', async () => {
    vi.mocked(createServerClient).mockResolvedValue(
      makeSessionMock({ user: { id: 'auth-user-1' } }) as never,
    )
    vi.mocked(verifyAnalogAdminAccess).mockResolvedValue({
      operatorId: 'op-1',
      allowedVenueIds: [VENUE_ID],
      isAnalogAdmin: true,
    })
    vi.mocked(createAdminClient).mockReturnValue(
      makeAdminMock({
        guestRow: { id: GUEST_ID, opted_out_at: null },
        rateError: { message: 'timeout' },
      }) as never,
    )

    const res = await POST(
      makeRequest({ venueId: VENUE_ID, guestId: GUEST_ID, hint: null }),
    )
    expect(res.status).toBe(500)
    expect((await res.json()).error).toBe('rate limit check failed')
  })

  it('returns 200 with messageId on the happy path with no hint', async () => {
    vi.mocked(createServerClient).mockResolvedValue(
      makeSessionMock({ user: { id: 'auth-user-1' } }) as never,
    )
    vi.mocked(verifyAnalogAdminAccess).mockResolvedValue({
      operatorId: 'op-1',
      allowedVenueIds: [VENUE_ID],
      isAnalogAdmin: true,
    })
    vi.mocked(createAdminClient).mockReturnValue(
      makeAdminMock({
        guestRow: { id: GUEST_ID, opted_out_at: null },
        recentManualCount: 0,
      }) as never,
    )
    vi.mocked(handleFollowup).mockResolvedValue({
      status: 'sent',
      outboundMessageId: 'msg-1',
    })

    const res = await POST(
      makeRequest({ venueId: VENUE_ID, guestId: GUEST_ID, hint: null }),
    )
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ success: true, messageId: 'msg-1' })

    expect(handleFollowup).toHaveBeenCalledTimes(1)
    const arg = vi.mocked(handleFollowup).mock.calls[0][0]
    expect(arg.venueId).toBe(VENUE_ID)
    expect(arg.guestId).toBe(GUEST_ID)
    expect(arg.skipHumanFeelDelay).toBe(true)
    expect(arg.trigger.reason).toBe('manual')
    expect(arg.trigger.metadata).toBeUndefined()
    expect(arg.trigger.triggeredAt).toBeInstanceOf(Date)
  })

  it('passes hint as trigger.metadata when provided', async () => {
    vi.mocked(createServerClient).mockResolvedValue(
      makeSessionMock({ user: { id: 'auth-user-1' } }) as never,
    )
    vi.mocked(verifyAnalogAdminAccess).mockResolvedValue({
      operatorId: 'op-1',
      allowedVenueIds: [VENUE_ID],
      isAnalogAdmin: true,
    })
    vi.mocked(createAdminClient).mockReturnValue(
      makeAdminMock({
        guestRow: { id: GUEST_ID, opted_out_at: null },
        recentManualCount: 0,
      }) as never,
    )
    vi.mocked(handleFollowup).mockResolvedValue({
      status: 'sent',
      outboundMessageId: 'msg-2',
    })

    const res = await POST(
      makeRequest({
        venueId: VENUE_ID,
        guestId: GUEST_ID,
        hint: 'check on their last visit',
      }),
    )
    expect(res.status).toBe(200)

    const arg = vi.mocked(handleFollowup).mock.calls[0][0]
    expect(arg.trigger.metadata).toEqual({ hint: 'check on their last visit' })
  })

  it('permits any venue when allowedVenueIds is empty (super-admin)', async () => {
    vi.mocked(createServerClient).mockResolvedValue(
      makeSessionMock({ user: { id: 'auth-user-1' } }) as never,
    )
    vi.mocked(verifyAnalogAdminAccess).mockResolvedValue({
      operatorId: 'op-1',
      allowedVenueIds: [],
      isAnalogAdmin: true,
    })
    vi.mocked(createAdminClient).mockReturnValue(
      makeAdminMock({
        guestRow: { id: GUEST_ID, opted_out_at: null },
        recentManualCount: 0,
      }) as never,
    )
    vi.mocked(handleFollowup).mockResolvedValue({
      status: 'sent',
      outboundMessageId: 'msg-3',
    })

    const res = await POST(
      makeRequest({ venueId: VENUE_ID, guestId: GUEST_ID, hint: null }),
    )
    expect(res.status).toBe(200)
  })

  it('returns 422 when handleFollowup refuses on low fidelity', async () => {
    vi.mocked(createServerClient).mockResolvedValue(
      makeSessionMock({ user: { id: 'auth-user-1' } }) as never,
    )
    vi.mocked(verifyAnalogAdminAccess).mockResolvedValue({
      operatorId: 'op-1',
      allowedVenueIds: [VENUE_ID],
      isAnalogAdmin: true,
    })
    vi.mocked(createAdminClient).mockReturnValue(
      makeAdminMock({
        guestRow: { id: GUEST_ID, opted_out_at: null },
        recentManualCount: 0,
      }) as never,
    )
    vi.mocked(handleFollowup).mockResolvedValue({
      status: 'refused',
      reason: 'low_fidelity',
      attemptScores: [0.32, 0.31, 0.3],
    })

    const res = await POST(
      makeRequest({ venueId: VENUE_ID, guestId: GUEST_ID, hint: null }),
    )
    expect(res.status).toBe(422)
    const body = await res.json()
    expect(body.error).toBe('refused')
    expect(body.attemptScores).toEqual([0.32, 0.31, 0.3])
  })

  it('returns 502 when handleFollowup fails at a stage', async () => {
    vi.mocked(createServerClient).mockResolvedValue(
      makeSessionMock({ user: { id: 'auth-user-1' } }) as never,
    )
    vi.mocked(verifyAnalogAdminAccess).mockResolvedValue({
      operatorId: 'op-1',
      allowedVenueIds: [VENUE_ID],
      isAnalogAdmin: true,
    })
    vi.mocked(createAdminClient).mockReturnValue(
      makeAdminMock({
        guestRow: { id: GUEST_ID, opted_out_at: null },
        recentManualCount: 0,
      }) as never,
    )
    vi.mocked(handleFollowup).mockResolvedValue({
      status: 'failed',
      stage: 'send',
      error: 'sendblue down',
    })

    const res = await POST(
      makeRequest({ venueId: VENUE_ID, guestId: GUEST_ID, hint: null }),
    )
    expect(res.status).toBe(502)
    const body = await res.json()
    expect(body.error).toBe('pipeline failed')
    expect(body.stage).toBe('send')
    expect(body.detail).toBe('sendblue down')
  })
})
