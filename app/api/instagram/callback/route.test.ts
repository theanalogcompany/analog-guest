// TAC-516: the public callback. Every branch renders HTML, and none of them
// may carry a token, an account id, Meta's error message, or the state.
//
// The leak assertions render the whole response AND everything logged, the
// way TAC-458 established: JSON.stringify turns a Headers or an Error into
// {} and would report a leak as clean.

import { formatWithOptions } from 'node:util'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const claimMock = vi.fn()
vi.mock('@/lib/messaging/instagram/oauth-state-store', async () => {
  const actual = await vi.importActual<typeof import('@/lib/messaging/instagram/oauth-state-store')>(
    '@/lib/messaging/instagram/oauth-state-store',
  )
  return { ...actual, claimInstagramOAuthState: (...a: unknown[]) => claimMock(...a) }
})

const exchangeCodeMock = vi.fn()
const exchangeLongMock = vi.fn()
const fetchAccountMock = vi.fn()
const subscribeMock = vi.fn()
vi.mock('@/lib/messaging/instagram/oauth-exchange', async () => {
  const actual = await vi.importActual<typeof import('@/lib/messaging/instagram/oauth-exchange')>(
    '@/lib/messaging/instagram/oauth-exchange',
  )
  return {
    ...actual,
    exchangeInstagramCode: (...a: unknown[]) => exchangeCodeMock(...a),
    exchangeForLongLivedToken: (...a: unknown[]) => exchangeLongMock(...a),
    fetchConnectedAccount: (...a: unknown[]) => fetchAccountMock(...a),
    subscribeInstagramWebhooks: (...a: unknown[]) => subscribeMock(...a),
  }
})

const upsertMock = vi.fn()
vi.mock('@/lib/messaging/instagram/credentials-store', () => ({
  upsertInstagramCredential: (...a: unknown[]) => upsertMock(...a),
}))

const subscribeFailedMock = vi.fn()
vi.mock('@/lib/analytics/posthog', () => ({
  captureInstagramConnectSubscribeFailed: (...a: unknown[]) => subscribeFailedMock(...a),
}))

const venueSelectMock = vi.fn()
const venueUpdateMock = vi.fn()
const credentialDeleteMock = vi.fn()
vi.mock('@/lib/db/admin', () => ({
  createAdminClient: () => ({
    from: (table: string) => ({
      select: () => ({ eq: () => ({ maybeSingle: () => venueSelectMock() }) }),
      update: (patch: unknown) => ({ eq: (_c: string, v: string) => venueUpdateMock(patch, v) }),
      delete: () => ({ eq: (_c: string, v: string) => credentialDeleteMock(table, v) }),
    }),
  }),
}))

import {
  deriveInstagramStateSigningKey,
  signInstagramOAuthState,
} from '@/lib/messaging/instagram/oauth-state'

import { GET } from './route'

const VENUE_ID = '11111111-1111-4111-8111-111111111111'
const OTHER_VENUE_ID = '22222222-2222-4222-8222-222222222222'
const OPERATOR_ID = '33333333-3333-4333-8333-333333333333'
const ENC_KEY = Buffer.alloc(32, 6).toString('base64')
const KEY = deriveInstagramStateSigningKey(ENC_KEY)
const ACCOUNT_ID = '17841479626987104'
const CODE = 'AQB-the-authorization-code'
const SHORT_TOKEN = 'IGAAshort-secret-token-value'
const LONG_TOKEN = 'IGAAlong-secret-token-value'
const NONCE = 'nonce-abc'

const ORIGINAL = { ...process.env }

function validState(overrides: Record<string, unknown> = {}): string {
  return signInstagramOAuthState(
    {
      venueId: VENUE_ID,
      operatorId: OPERATOR_ID,
      nonce: NONCE,
      expiresAtMs: Date.now() + 5 * 60 * 1000,
      ...overrides,
    } as Parameters<typeof signInstagramOAuthState>[0],
    KEY,
  )
}

function call(params: Record<string, string>): Promise<Response> {
  const url = new URL('https://webhooks.theanalog.company/api/instagram/callback')
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v)
  return GET(new Request(url.toString()))
}

const logged: unknown[][] = []
function loggedText(): string {
  return logged
    .map((args) =>
      formatWithOptions(
        { depth: Infinity, maxArrayLength: Infinity, maxStringLength: Infinity, breakLength: Infinity },
        ...args,
      ),
    )
    .join('\n')
}

beforeEach(() => {
  vi.clearAllMocks()
  logged.length = 0
  process.env.INSTAGRAM_APP_ID = 'app-id'
  process.env.INSTAGRAM_APP_SECRET = 'app-secret'
  process.env.INSTAGRAM_OAUTH_REDIRECT_URL = 'https://webhooks.theanalog.company/api/instagram/callback'
  process.env.INSTAGRAM_TOKEN_ENC_KEY = ENC_KEY

  claimMock.mockResolvedValue({ ok: true, venueId: VENUE_ID, operatorId: OPERATOR_ID })
  exchangeCodeMock.mockResolvedValue({ ok: true, value: { token: SHORT_TOKEN, userId: ACCOUNT_ID } })
  exchangeLongMock.mockResolvedValue({
    ok: true,
    value: { token: LONG_TOKEN, expiresAt: new Date('2026-11-30T00:00:00.000Z') },
  })
  fetchAccountMock.mockResolvedValue({ ok: true, value: { userId: ACCOUNT_ID, username: 'lemilscoffee' } })
  subscribeMock.mockResolvedValue({ ok: true, value: true })
  upsertMock.mockResolvedValue({ ok: true })
  venueSelectMock.mockResolvedValue({ data: null, error: null })
  venueUpdateMock.mockResolvedValue({ error: null })
  credentialDeleteMock.mockResolvedValue({ error: null })

  for (const level of ['log', 'warn', 'error'] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
      logged.push(args)
    })
  }
})

afterEach(() => {
  process.env = { ...ORIGINAL }
  vi.restoreAllMocks()
})

describe('GET /api/instagram/callback: the happy path', () => {
  it('renders HTML, not JSON, and confirms the handle', async () => {
    const res = await call({ code: CODE, state: validState() })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/html')
    const body = await res.text()
    expect(body).toContain('Instagram connected')
    expect(body).toContain('@lemilscoffee')
  })

  it('stores the credential against the venue the state named', async () => {
    await call({ code: CODE, state: validState() })
    const [, input] = upsertMock.mock.calls[0] as [unknown, Record<string, unknown>]
    expect(input).toMatchObject({
      venueId: VENUE_ID,
      accessToken: LONG_TOKEN,
      instagramUsername: 'lemilscoffee',
      connectedByOperatorId: OPERATOR_ID,
    })
  })

  it("points the venue at the account Meta reported, not at anything the caller sent", async () => {
    await call({ code: CODE, state: validState() })
    expect(venueUpdateMock).toHaveBeenCalledWith({ instagram_account_id: ACCOUNT_ID }, VENUE_ID)
  })

  it('subscribes the account to our webhooks', async () => {
    await call({ code: CODE, state: validState() })
    expect(subscribeMock).toHaveBeenCalledWith(
      { accountId: ACCOUNT_ID, token: LONG_TOKEN },
      expect.anything(),
    )
  })
})

describe('GET /api/instagram/callback: the three state refusals', () => {
  it('refuses a request with no code or no state', async () => {
    expect((await call({ state: validState() })).status).toBe(400)
    expect((await call({ code: CODE })).status).toBe(400)
    expect(claimMock).not.toHaveBeenCalled()
  })

  // TAMPERED. Caught by the signature, before any database read.
  it('refuses a tampered state without touching the database', async () => {
    const forged = signInstagramOAuthState(
      { venueId: OTHER_VENUE_ID, operatorId: OPERATOR_ID, nonce: NONCE, expiresAtMs: Date.now() + 60_000 },
      deriveInstagramStateSigningKey(Buffer.alloc(32, 1).toString('base64')),
    )
    const res = await call({ code: CODE, state: forged })
    expect(res.status).toBe(401)
    expect(await res.text()).toContain('could not verify')
    expect(claimMock).not.toHaveBeenCalled()
  })

  // EXPIRED. Its own page, because "try again" is the right advice and
  // "that did not come from us" is not.
  it('refuses an expired state and says so, distinctly from a forged one', async () => {
    const res = await call({ code: CODE, state: validState({ expiresAtMs: Date.now() - 1 }) })
    expect(res.status).toBe(401)
    expect(await res.text()).toContain('expired')
    expect(claimMock).not.toHaveBeenCalled()
  })

  // REPLAYED. The signature verifies a second presentation happily; the claim
  // is what refuses it.
  it('refuses a replayed state, which the signature alone cannot catch', async () => {
    claimMock.mockResolvedValue({ ok: false, reason: 'unclaimable' })
    const res = await call({ code: CODE, state: validState() })
    expect(res.status).toBe(401)
    expect(await res.text()).toContain('already used')
    expect(exchangeCodeMock).not.toHaveBeenCalled()
  })

  it('refuses when the signed state disagrees with the row it was issued as', async () => {
    claimMock.mockResolvedValue({ ok: true, venueId: OTHER_VENUE_ID, operatorId: OPERATOR_ID })
    const res = await call({ code: CODE, state: validState() })
    expect(res.status).toBe(401)
    expect(upsertMock).not.toHaveBeenCalled()
  })

  it('reports a claim failure as storage, not as a replay', async () => {
    claimMock.mockResolvedValue({ ok: false, reason: 'error', error: 'connection reset' })
    const res = await call({ code: CODE, state: validState() })
    expect(res.status).toBe(500)
  })
})

describe('GET /api/instagram/callback: the cross-venue refusal', () => {
  // Ruling 1, 2026-09-23. Refuse, and leave the original venue connected.
  // "Nothing written" is the load-bearing half: a refusal that had already
  // stored a credential would have half-transferred the account.
  it('refuses an account already connected to a different venue, and writes NOTHING', async () => {
    venueSelectMock.mockResolvedValue({ data: { id: OTHER_VENUE_ID }, error: null })
    const res = await call({ code: CODE, state: validState() })
    expect(res.status).toBe(409)
    expect(await res.text()).toContain('already connected')
    expect(upsertMock).not.toHaveBeenCalled()
    expect(venueUpdateMock).not.toHaveBeenCalled()
  })

  // The same venue reconnecting is an ordinary reconnect, not the conflict
  // the ruling refused. The Contract's "What this doesn't settle" says so.
  it('allows the SAME venue to reconnect', async () => {
    venueSelectMock.mockResolvedValue({ data: { id: VENUE_ID }, error: null })
    const res = await call({ code: CODE, state: validState() })
    expect(res.status).toBe(200)
    expect(upsertMock).toHaveBeenCalled()
  })

  // The unique constraint is the authority when the check loses a race. Both
  // this and the storage path reach it AFTER the credential is written, so
  // both must undo it — the page says "Nothing here was changed", and until
  // code review that was false on exactly these two branches.
  it('treats a unique violation on the venue write as the same refusal, and undoes the credential', async () => {
    venueUpdateMock.mockResolvedValue({ error: { code: '23505', message: 'duplicate key' } })
    const res = await call({ code: CODE, state: validState() })
    expect(res.status).toBe(409)
    expect(await res.text()).toContain('already connected')
    // The write DID happen on this path, which is why the undo has to.
    expect(upsertMock).toHaveBeenCalled()
    expect(credentialDeleteMock).toHaveBeenCalled()
  })

  it('treats any other venue-write failure as storage, not as a conflict, and undoes the credential', async () => {
    venueUpdateMock.mockResolvedValue({ error: { code: '08006', message: 'connection failure' } })
    const res = await call({ code: CODE, state: validState() })
    expect(res.status).toBe(500)
    expect(credentialDeleteMock).toHaveBeenCalled()
  })

  it('leaves the credential alone when the venue write succeeds', async () => {
    await call({ code: CODE, state: validState() })
    expect(credentialDeleteMock).not.toHaveBeenCalled()
  })

  it('refuses when the conflict check itself fails, rather than guessing', async () => {
    venueSelectMock.mockResolvedValue({ data: null, error: { message: 'timeout' } })
    const res = await call({ code: CODE, state: validState() })
    expect(res.status).toBe(500)
    expect(upsertMock).not.toHaveBeenCalled()
  })
})

describe('GET /api/instagram/callback: exchange and storage failures', () => {
  it.each([
    ['the code exchange', () => exchangeCodeMock.mockResolvedValue({ ok: false, failure: { reason: 'timeout' } })],
    ['the long-lived exchange', () => exchangeLongMock.mockResolvedValue({ ok: false, failure: { reason: 'timeout' } })],
    ['the account read', () => fetchAccountMock.mockResolvedValue({ ok: false, failure: { reason: 'timeout' } })],
  ])('renders a failure page when %s fails, and stores nothing', async (_label, arrange) => {
    arrange()
    const res = await call({ code: CODE, state: validState() })
    expect(res.status).toBe(502)
    expect(upsertMock).not.toHaveBeenCalled()
    expect(venueUpdateMock).not.toHaveBeenCalled()
  })

  it('does not point the venue at an account whose credential failed to store', async () => {
    upsertMock.mockResolvedValue({ ok: false, error: 'write failed' })
    const res = await call({ code: CODE, state: validState() })
    expect(res.status).toBe(500)
    expect(venueUpdateMock).not.toHaveBeenCalled()
  })

  it.each([
    'INSTAGRAM_APP_ID',
    'INSTAGRAM_APP_SECRET',
    'INSTAGRAM_OAUTH_REDIRECT_URL',
    'INSTAGRAM_TOKEN_ENC_KEY',
  ])('renders the not-configured page when %s is unset', async (name) => {
    delete process.env[name]
    const res = await call({ code: CODE, state: validState() })
    expect(res.status).toBe(500)
    expect(await res.text()).toContain('not set up')
  })
})

describe('GET /api/instagram/callback: the webhook subscription', () => {
  // NOT fatal: the credential and the pointer are stored, so the connection
  // is real. But an unsubscribed account looks connected and delivers
  // nothing, so it gets its own alert.
  it('still succeeds when the subscription fails, and alerts separately', async () => {
    subscribeMock.mockResolvedValue({ ok: false, failure: { reason: 'graph_error', code: 100 } })
    const res = await call({ code: CODE, state: validState() })
    expect(res.status).toBe(200)
    expect(subscribeFailedMock).toHaveBeenCalledWith(
      expect.objectContaining({ venueId: VENUE_ID, graphCode: 100 }),
    )
  })

  it('does not alert when the subscription succeeds', async () => {
    await call({ code: CODE, state: validState() })
    expect(subscribeFailedMock).not.toHaveBeenCalled()
  })
})

describe('GET /api/instagram/callback: nothing secret reaches a page or a log', () => {
  const secrets = [SHORT_TOKEN, LONG_TOKEN, CODE, ENC_KEY, 'app-secret']

  it('keeps tokens, the code, the app secret and the key out of every successful response and log', async () => {
    const res = await call({ code: CODE, state: validState() })
    const body = await res.text()
    for (const secret of secrets) {
      expect(body).not.toContain(secret)
      expect(loggedText()).not.toContain(secret)
    }
  })

  it.each([
    ['a replay', () => claimMock.mockResolvedValue({ ok: false, reason: 'unclaimable' })],
    ['an exchange failure', () => exchangeCodeMock.mockResolvedValue({ ok: false, failure: { reason: 'timeout' } })],
    ['a conflict', () => venueSelectMock.mockResolvedValue({ data: { id: OTHER_VENUE_ID }, error: null })],
    ['a storage failure', () => upsertMock.mockResolvedValue({ ok: false, error: 'boom' })],
  ])('keeps them out of the page and the log on %s too', async (_label, arrange) => {
    arrange()
    const res = await call({ code: CODE, state: validState() })
    const body = await res.text()
    for (const secret of secrets) {
      expect(body).not.toContain(secret)
      expect(loggedText()).not.toContain(secret)
    }
  })

  // The state is a bearer-ish value in its own right: it is signed, and a
  // logged one is replayable until it expires or is claimed.
  it('never renders or logs the state value itself', async () => {
    const state = validState()
    claimMock.mockResolvedValue({ ok: false, reason: 'unclaimable' })
    const res = await call({ code: CODE, state })
    expect(await res.text()).not.toContain(state)
    expect(loggedText()).not.toContain(state)
  })

  // The account id is not secret, but it is an identifier we do not put in
  // front of a person who may not own it.
  it('never renders the account id on any page', async () => {
    const ok = await (await call({ code: CODE, state: validState() })).text()
    expect(ok).not.toContain(ACCOUNT_ID)
    venueSelectMock.mockResolvedValue({ data: { id: OTHER_VENUE_ID }, error: null })
    const conflict = await (await call({ code: CODE, state: validState() })).text()
    expect(conflict).not.toContain(ACCOUNT_ID)
  })
})
