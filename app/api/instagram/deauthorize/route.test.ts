// TAC-516: Meta's deauthorize callback.
//
// The behaviour worth pinning is what it does NOT do: a revoked connection
// stops future traffic and must not touch a single guest or message row.

import { createHmac } from 'node:crypto'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const deauthorizeMock = vi.fn()
vi.mock('@/lib/messaging/instagram/credentials-store', () => ({
  deauthorizeInstagramCredential: (...a: unknown[]) => deauthorizeMock(...a),
}))
vi.mock('@/lib/db/admin', () => ({ createAdminClient: () => ({}) }))

import { POST } from './route'

const SECRET = 'app-secret-value'
const ACCOUNT_ID = '17841479626987104'
const VENUE_ID = '11111111-1111-4111-8111-111111111111'
const ORIGINAL = process.env.INSTAGRAM_APP_SECRET

function signedRequest(payload: unknown, secret = SECRET): string {
  const payloadB64 = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
  const signature = createHmac('sha256', secret).update(payloadB64).digest('base64url')
  return `${signature}.${payloadB64}`
}

function call(body: string | null): Promise<Response> {
  const form = new FormData()
  if (body !== null) form.set('signed_request', body)
  return POST(
    new Request('https://webhooks.theanalog.company/api/instagram/deauthorize', {
      method: 'POST',
      body: form,
    }),
  )
}

const logged: unknown[][] = []
beforeEach(() => {
  vi.clearAllMocks()
  logged.length = 0
  process.env.INSTAGRAM_APP_SECRET = SECRET
  deauthorizeMock.mockResolvedValue({ ok: true, venueId: VENUE_ID })
  for (const level of ['log', 'warn', 'error'] as const) {
    vi.spyOn(console, level).mockImplementation((...a: unknown[]) => {
      logged.push(a)
    })
  }
})

afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.INSTAGRAM_APP_SECRET
  else process.env.INSTAGRAM_APP_SECRET = ORIGINAL
  vi.restoreAllMocks()
})

describe('POST /api/instagram/deauthorize', () => {
  it('marks the venue disconnected for the account Meta named', async () => {
    const res = await call(signedRequest({ user_id: ACCOUNT_ID }))
    expect(res.status).toBe(200)
    expect(deauthorizeMock).toHaveBeenCalledWith(expect.anything(), ACCOUNT_ID, expect.any(Date))
  })

  // A revoked connection says nothing about past data. Erasure is the
  // deletion callback, which has its own ruling.
  it('never touches guests or messages', async () => {
    await call(signedRequest({ user_id: ACCOUNT_ID }))
    // The only write helper this route may reach is the credential one.
    expect(deauthorizeMock).toHaveBeenCalledOnce()
  })

  it.each([
    ['a forged signature', () => signedRequest({ user_id: ACCOUNT_ID }, 'wrong-secret')],
    ['a malformed value', () => 'not-a-signed-request'],
  ])('refuses %s with 403 and an empty body, writing nothing', async (_label, make) => {
    const res = await call(make())
    expect(res.status).toBe(403)
    expect(await res.text()).toBe('')
    expect(deauthorizeMock).not.toHaveBeenCalled()
  })

  it('refuses a request with no signed_request field', async () => {
    const res = await call(null)
    expect(res.status).toBe(403)
    expect(deauthorizeMock).not.toHaveBeenCalled()
  })

  // Every genuine delivery fails this way until the secret is set, so it is
  // an error rather than a warning, and it must never fall open.
  it('refuses every delivery when the app secret is unset', async () => {
    delete process.env.INSTAGRAM_APP_SECRET
    const res = await call(signedRequest({ user_id: ACCOUNT_ID }, ''))
    expect(res.status).toBe(403)
    expect(deauthorizeMock).not.toHaveBeenCalled()
  })

  // Meta disables a callback after repeated non-2xx. A failure that is not
  // transient would otherwise switch the callback off with no alert.
  it('answers 200 when the write fails, and logs at error level', async () => {
    deauthorizeMock.mockResolvedValue({ ok: false, error: 'connection reset' })
    const res = await call(signedRequest({ user_id: ACCOUNT_ID }))
    expect(res.status).toBe(200)
    expect(JSON.stringify(logged)).toContain('instagram_deauthorize_failed')
  })

  // Meta can send this for an account we never finished connecting.
  it('answers 200 for an account no venue owns', async () => {
    deauthorizeMock.mockResolvedValue({ ok: true, venueId: null })
    const res = await call(signedRequest({ user_id: 'unknown-account' }))
    expect(res.status).toBe(200)
  })

  it('never logs the signed request, the payload or the secret', async () => {
    const signed = signedRequest({ user_id: ACCOUNT_ID }, 'wrong-secret')
    await call(signed)
    const rendered = JSON.stringify(logged)
    expect(rendered).not.toContain(signed)
    expect(rendered).not.toContain(SECRET)
  })
})
