// TAC-516: the four Meta calls the connect callback makes, against a stubbed
// Meta. Nothing here reaches the network.
//
// The assertions that matter are about what is NOT in a URL, and about
// user_id vs id. The second one has a specific failure mode: taking `id`
// stores an app-scoped value in venues.instagram_account_id, and then every
// inbound message routes to no venue at all, silently.

import { describe, expect, it, vi } from 'vitest'

import {
  INSTAGRAM_WEBHOOK_SUBSCRIBED_FIELDS,
  exchangeForLongLivedToken,
  exchangeInstagramCode,
  fetchConnectedAccount,
  subscribeInstagramWebhooks,
} from './oauth-exchange'

const NOW = new Date('2026-10-01T12:00:00.000Z')
const DAY = 24 * 60 * 60 * 1000
const CODE = 'AQBx-authorization-code-value'
const APP_SECRET = 'app-secret-value'
const SHORT_TOKEN = 'IGAAshort0000000000000000000000000000000000000'
const LONG_TOKEN = 'IGAAlong00000000000000000000000000000000000000'
const ACCOUNT_ID = '17841479626987104'

function respond(body: unknown, status = 200) {
  return vi.fn(async () => new Response(JSON.stringify(body), { status }))
}

describe('exchangeInstagramCode', () => {
  const input = {
    code: CODE,
    redirectUri: 'https://webhooks.theanalog.company/api/instagram/callback',
    appId: 'app-id',
    appSecret: APP_SECRET,
  }

  // The code and the app secret go in the BODY. A URL reaches request logs
  // and error messages; a form body does not.
  it('sends the code and the secret in the body, never the URL', async () => {
    const fetchImpl = respond({ access_token: SHORT_TOKEN, user_id: 17841479626987104 })
    await exchangeInstagramCode(input, fetchImpl)

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://api.instagram.com/oauth/access_token')
    expect(url).not.toContain(CODE)
    expect(url).not.toContain(APP_SECRET)
    expect(init.method).toBe('POST')
    const body = String(init.body)
    expect(body).toContain(`code=${CODE}`)
    expect(body).toContain('grant_type=authorization_code')
  })

  // Meta returns user_id as a NUMBER here. JavaScript cannot hold a 17-digit
  // account id exactly as a number in every case, so it is stringified at the
  // boundary rather than carried as one.
  it('reads a numeric user_id as a string', async () => {
    const fetchImpl = respond({ access_token: SHORT_TOKEN, user_id: 17841479626987104 })
    const result = await exchangeInstagramCode(input, fetchImpl)
    expect(result).toEqual({ ok: true, value: { token: SHORT_TOKEN, userId: '17841479626987104' } })
  })

  it('accepts a string user_id too', async () => {
    const fetchImpl = respond({ access_token: SHORT_TOKEN, user_id: ACCOUNT_ID })
    const result = await exchangeInstagramCode(input, fetchImpl)
    expect(result).toMatchObject({ ok: true, value: { userId: ACCOUNT_ID } })
  })

  it("refuses a response missing the token or the account, rather than storing half of it", async () => {
    expect((await exchangeInstagramCode(input, respond({ user_id: ACCOUNT_ID }))).ok).toBe(false)
    expect((await exchangeInstagramCode(input, respond({ access_token: SHORT_TOKEN }))).ok).toBe(false)
  })

  // Meta's message on this endpoint quotes the code, and on a redirect-uri
  // mismatch it quotes the URI. graph.ts's rule applies here too.
  it("carries Meta's code and subcode but never its message", async () => {
    const fetchImpl = respond(
      {
        error: {
          message: `Invalid authorization code: ${CODE}`,
          type: 'OAuthException',
          code: 100,
          error_subcode: 36007,
          fbtrace_id: 'AbC',
        },
      },
      400,
    )
    const result = await exchangeInstagramCode(input, fetchImpl)
    expect(result).toEqual({
      ok: false,
      failure: { reason: 'graph_error', httpStatus: 400, code: 100, subcode: 36007, type: 'OAuthException', fbtraceId: 'AbC' },
    })
    expect(JSON.stringify(result)).not.toContain(CODE)
  })

  it('reports an unparseable body as malformed rather than throwing', async () => {
    const fetchImpl = vi.fn(async () => new Response('<html>502</html>', { status: 502 }))
    expect(await exchangeInstagramCode(input, fetchImpl)).toEqual({
      ok: false,
      failure: { reason: 'malformed_response', httpStatus: 502 },
    })
  })

  it('reports a network failure as a value, never a throw', async () => {
    const fetchImpl = vi.fn(async () => {
      throw Object.assign(new Error('nope'), { name: 'TypeError' })
    })
    expect(await exchangeInstagramCode(input, fetchImpl)).toMatchObject({
      ok: false,
      failure: { reason: 'network' },
    })
  })
})

describe('exchangeForLongLivedToken', () => {
  const input = { shortLivedToken: SHORT_TOKEN, appSecret: APP_SECRET, now: NOW }

  // The DEVIATION this module documents: Meta shows access_token in the query
  // string; we send it in the header. client_secret stays in the query
  // because Meta requires it there and it is not an auth token.
  it('sends the token in the header, never the URL', async () => {
    const fetchImpl = respond({ access_token: LONG_TOKEN, expires_in: 60 * 24 * 60 * 60 })
    await exchangeForLongLivedToken(input, fetchImpl)

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toContain('grant_type=ig_exchange_token')
    expect(url).not.toContain(SHORT_TOKEN)
    expect((init.headers as Record<string, string>).authorization).toBe(`Bearer ${SHORT_TOKEN}`)
  })

  it('turns expires_in into an absolute expiry', async () => {
    const fetchImpl = respond({ access_token: LONG_TOKEN, expires_in: 60 * 24 * 60 * 60 })
    const result = await exchangeForLongLivedToken(input, fetchImpl)
    expect(result).toEqual({
      ok: true,
      value: { token: LONG_TOKEN, expiresAt: new Date(NOW.getTime() + 60 * DAY) },
    })
  })

  // An expiry in the past would make a brand new credential look
  // unrecoverable on the refresh job's first pass.
  it.each([
    ['omitted', {}],
    ['zero', { expires_in: 0 }],
    ['negative', { expires_in: -100 }],
    ['not a number', { expires_in: 'soon' }],
  ])('falls back to 60 days when expires_in is %s', async (_label, extra) => {
    const fetchImpl = respond({ access_token: LONG_TOKEN, ...extra })
    const result = await exchangeForLongLivedToken(input, fetchImpl)
    expect(result).toMatchObject({ ok: true, value: { expiresAt: new Date(NOW.getTime() + 60 * DAY) } })
  })

  it('refuses a response with no token', async () => {
    expect((await exchangeForLongLivedToken(input, respond({ expires_in: 100 }))).ok).toBe(false)
  })
})

describe('fetchConnectedAccount', () => {
  // THE ONE THAT MATTERS. `id` is app-scoped; `user_id` is the account id the
  // webhook's entry.id carries. Taking the wrong one routes every inbound
  // message to no venue, silently.
  it('reads user_id, not the app-scoped id', async () => {
    const fetchImpl = respond({ id: 'app-scoped-99999', user_id: ACCOUNT_ID, username: 'lemilscoffee' })
    const result = await fetchConnectedAccount(LONG_TOKEN, fetchImpl)
    expect(result).toEqual({ ok: true, value: { userId: ACCOUNT_ID, username: 'lemilscoffee' } })
    if (result.ok) expect(result.value.userId).not.toBe('app-scoped-99999')
  })

  it('asks for both fields', async () => {
    const fetchImpl = respond({ user_id: ACCOUNT_ID, username: 'lemilscoffee' })
    await fetchConnectedAccount(LONG_TOKEN, fetchImpl)
    const [url] = fetchImpl.mock.calls[0] as unknown as [string]
    expect(url).toContain('fields=user_id,username')
    expect(url).not.toContain(LONG_TOKEN)
  })

  // A missing handle costs the handle, not the connection: the operator app
  // shows it, nothing routes on it.
  it('accepts a missing username as null', async () => {
    const fetchImpl = respond({ user_id: ACCOUNT_ID })
    expect(await fetchConnectedAccount(LONG_TOKEN, fetchImpl)).toEqual({
      ok: true,
      value: { userId: ACCOUNT_ID, username: null },
    })
  })

  it('refuses a response with no user_id', async () => {
    expect((await fetchConnectedAccount(LONG_TOKEN, respond({ username: 'x' }))).ok).toBe(false)
  })
})

describe('subscribeInstagramWebhooks', () => {
  it('subscribes the exact field set the app is already subscribed to', async () => {
    const fetchImpl = respond({ success: true })
    const result = await subscribeInstagramWebhooks({ accountId: ACCOUNT_ID, token: LONG_TOKEN }, fetchImpl)
    expect(result).toEqual({ ok: true, value: true })

    const [url] = fetchImpl.mock.calls[0] as unknown as [string]
    expect(url).toContain(`/${ACCOUNT_ID}/subscribed_apps`)
    for (const field of INSTAGRAM_WEBHOOK_SUBSCRIBED_FIELDS) {
      expect(decodeURIComponent(url)).toContain(field)
    }
    expect(url).not.toContain(LONG_TOKEN)
  })

  // The subscribed field list must match what the app carries at the app
  // level (the ticket's Background section). Pinned so a change here is a
  // deliberate act rather than a silent divergence whose only symptom is
  // messages not arriving.
  it('pins the field list', () => {
    expect([...INSTAGRAM_WEBHOOK_SUBSCRIBED_FIELDS]).toEqual([
      'messages',
      'message_edit',
      'message_reactions',
      'messaging_handover',
      'messaging_optins',
      'messaging_postbacks',
      'comments',
      'live_comments',
    ])
  })

  // Meta answering 200 with anything other than success:true is not a
  // subscription, and treating it as one is how a venue ends up connected
  // with no messages ever arriving.
  it.each([
    ['success: false', { success: false }],
    ['an empty object', {}],
    ['a bare array', []],
  ])('refuses a 200 that is not a subscription (%s)', async (_label, body) => {
    const result = await subscribeInstagramWebhooks(
      { accountId: ACCOUNT_ID, token: LONG_TOKEN },
      respond(body),
    )
    expect(result.ok).toBe(false)
  })
})
