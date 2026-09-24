// TAC-516: the connect endpoint.
//
// Every assertion about a response body is transcribed from the ticket's
// `## Contract`, never read back out of the handler. A test written by
// reading the implementation can only confirm the code does what the code
// does, which is how TAC-310 certified a live cross-repo defect on every
// green run.
//
// The auth tests are the point of this file. TAC-530 landed the same day this
// ticket was planned, and it exists because the cookie path's
// `if (ids.length > 0)` idiom was pasted onto bearer data and granted the
// fleet. This route is exactly that shape: a venue id in the path, an
// operator token in the header.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const verifyOperatorRequestMock = vi.fn()
vi.mock('@/lib/auth', async () => {
  const actual = await vi.importActual<typeof import('@/lib/auth')>('@/lib/auth')
  return { ...actual, verifyOperatorRequest: (req: Request) => verifyOperatorRequestMock(req) }
})

const issueMock = vi.fn()
vi.mock('@/lib/messaging/instagram/oauth-state-store', async () => {
  const actual = await vi.importActual<typeof import('@/lib/messaging/instagram/oauth-state-store')>(
    '@/lib/messaging/instagram/oauth-state-store',
  )
  return { ...actual, issueInstagramOAuthState: (...args: unknown[]) => issueMock(...args) }
})

vi.mock('@/lib/db/admin', () => ({ createAdminClient: () => ({}) }))

import { AuthError } from '@/lib/auth'
import { grantedVenues, ALL_VENUES } from '@/lib/auth/venue-scope'
import {
  deriveInstagramStateSigningKey,
  verifyInstagramOAuthState,
} from '@/lib/messaging/instagram/oauth-state'

import { POST } from './route'

const VENUE_ID = '11111111-1111-4111-8111-111111111111'
const OTHER_VENUE_ID = '22222222-2222-4222-8222-222222222222'
const OPERATOR_ID = '33333333-3333-4333-8333-333333333333'
const ENC_KEY = Buffer.alloc(32, 8).toString('base64')

const ORIGINAL = {
  appId: process.env.INSTAGRAM_APP_ID,
  redirect: process.env.INSTAGRAM_OAUTH_REDIRECT_URL,
  key: process.env.INSTAGRAM_TOKEN_ENC_KEY,
}

function req(): Request {
  return new Request('http://localhost/api/operator/venues/x/instagram/connect', {
    method: 'POST',
    headers: { authorization: 'Bearer token' },
  })
}

function call(venueId = VENUE_ID) {
  return POST(req(), { params: Promise.resolve({ venueId }) })
}

beforeEach(() => {
  vi.clearAllMocks()
  process.env.INSTAGRAM_APP_ID = 'app-1227804829539686'
  process.env.INSTAGRAM_OAUTH_REDIRECT_URL = 'https://webhooks.theanalog.company/api/instagram/callback'
  process.env.INSTAGRAM_TOKEN_ENC_KEY = ENC_KEY
  verifyOperatorRequestMock.mockResolvedValue({
    operatorId: OPERATOR_ID,
    venueScope: grantedVenues([VENUE_ID]),
  })
  issueMock.mockResolvedValue({ ok: true })
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  for (const [k, v] of [
    ['INSTAGRAM_APP_ID', ORIGINAL.appId],
    ['INSTAGRAM_OAUTH_REDIRECT_URL', ORIGINAL.redirect],
    ['INSTAGRAM_TOKEN_ENC_KEY', ORIGINAL.key],
  ] as const) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  vi.restoreAllMocks()
})

describe('POST /api/operator/venues/[venueId]/instagram/connect', () => {
  it('returns the Contract shape on success', async () => {
    const res = await call()
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>
    expect(Object.keys(body).sort()).toEqual(['authorizationUrl', 'expiresAt'])
    expect(String(body.authorizationUrl)).toContain('https://www.instagram.com/oauth/authorize?')
    expect(typeof body.expiresAt).toBe('string')
    expect(new Date(String(body.expiresAt)).getTime()).toBeGreaterThan(Date.now())
  })

  it('asks for exactly the scopes the use case needs', async () => {
    const body = (await (await call()).json()) as { authorizationUrl: string }
    const url = new URL(body.authorizationUrl)
    expect(url.searchParams.get('scope')).toBe(
      'instagram_business_basic,instagram_business_manage_messages',
    )
    expect(url.searchParams.get('response_type')).toBe('code')
    expect(url.searchParams.get('client_id')).toBe('app-1227804829539686')
    expect(url.searchParams.get('redirect_uri')).toBe(
      'https://webhooks.theanalog.company/api/instagram/callback',
    )
  })

  // The state has to tie the flow to THIS venue and THIS operator, or the
  // callback cannot tell which venue is connecting.
  it('signs a state carrying the venue, the operator and the issued nonce', async () => {
    const body = (await (await call()).json()) as { authorizationUrl: string }
    const state = new URL(body.authorizationUrl).searchParams.get('state') ?? ''
    const verified = verifyInstagramOAuthState(
      state,
      deriveInstagramStateSigningKey(ENC_KEY),
      new Date(),
    )
    expect(verified.ok).toBe(true)
    if (!verified.ok) return
    expect(verified.payload.venueId).toBe(VENUE_ID)
    expect(verified.payload.operatorId).toBe(OPERATOR_ID)

    // The nonce in the signed state is the one written to the database. If
    // these diverged, every callback would fail to claim.
    const [, issued] = issueMock.mock.calls[0] as [unknown, { nonce: string; venueId: string }]
    expect(issued.nonce).toBe(verified.payload.nonce)
    expect(issued.venueId).toBe(VENUE_ID)
  })

  it('issues a fresh nonce each time, so one state can never be reused', async () => {
    await call()
    await call()
    const [, first] = issueMock.mock.calls[0] as [unknown, { nonce: string }]
    const [, second] = issueMock.mock.calls[1] as [unknown, { nonce: string }]
    expect(first.nonce).not.toBe(second.nonce)
  })

  it('returns 401 with the Contract body when the bearer is bad', async () => {
    verifyOperatorRequestMock.mockRejectedValue(new AuthError(401, 'JWT expired'))
    const res = await call()
    expect(res.status).toBe(401)
    // The Contract's literal, not AuthError.message: "JWT expired" must not
    // reach the wire.
    expect(await res.json()).toEqual({ error: 'unauthorized' })
  })

  it('returns 404 for a venue outside the operator\'s allowlist', async () => {
    const res = await call(OTHER_VENUE_ID)
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: 'not_found' })
    expect(issueMock).not.toHaveBeenCalled()
  })

  // THE TAC-530 CASE. A valid token with zero grants must be a deny. Under
  // the `ids.length > 0` idiom this returns 200 and mints a state for any
  // venue in the fleet.
  it('returns 404 for an operator with NO venue grants, and issues nothing', async () => {
    verifyOperatorRequestMock.mockResolvedValue({
      operatorId: OPERATOR_ID,
      venueScope: grantedVenues([]),
    })
    const res = await call()
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: 'not_found' })
    expect(issueMock).not.toHaveBeenCalled()
  })

  // bearerAllowsVenue refuses a fleet-wide scope outright. The bearer path
  // never produces one, but a future admin surface passing a cookie scope
  // into this route would, and it must not be a grant.
  it('returns 404 for a fleet-wide scope, which this path must never honour', async () => {
    verifyOperatorRequestMock.mockResolvedValue({ operatorId: OPERATOR_ID, venueScope: ALL_VENUES })
    const res = await call()
    expect(res.status).toBe(404)
    expect(issueMock).not.toHaveBeenCalled()
  })

  it('returns 404 for a non-UUID venue without touching the database', async () => {
    const res = await call('not-a-uuid')
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: 'not_found' })
    expect(issueMock).not.toHaveBeenCalled()
  })

  it.each(['INSTAGRAM_APP_ID', 'INSTAGRAM_OAUTH_REDIRECT_URL', 'INSTAGRAM_TOKEN_ENC_KEY'] as const)(
    'returns 500 with the Contract body when %s is unset',
    async (name) => {
      delete process.env[name]
      const res = await call()
      expect(res.status).toBe(500)
      expect(await res.json()).toEqual({ error: 'internal_error' })
    },
  )

  it('returns 500 when the state cannot be issued, rather than a URL that cannot be claimed', async () => {
    issueMock.mockResolvedValue({ ok: false, error: 'duplicate key' })
    const res = await call()
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ error: 'internal_error' })
  })

  it('never puts the encryption key or the app secret in a response', async () => {
    const res = await call()
    const text = await res.text()
    expect(text).not.toContain(ENC_KEY)
    expect(text).not.toContain(process.env.INSTAGRAM_APP_SECRET ?? 'app-secret-never-set')
  })
})
