import { createHmac } from 'node:crypto'
import { formatWithOptions } from 'node:util'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { GET, POST } from './route'

const ROUTE_URL = 'https://webhooks.theanalog.company/api/webhooks/instagram'
const TOKEN = 'the-shared-verify-token'
const WRONG_TOKEN = 'the-wrong-verify-token'
const APP_SECRET = 'the-app-secret'

const ACCOUNT_ID = '17841400000000000'
const SENDER_IGSID = '9876543210987654'
const MESSAGE_TEXT = 'do you have oat milk?'

const PAYLOAD = {
  object: 'instagram',
  entry: [
    {
      id: ACCOUNT_ID,
      time: 1758153600000,
      messaging: [
        {
          sender: { id: SENDER_IGSID },
          recipient: { id: ACCOUNT_ID },
          timestamp: 1758153600000,
          message: { mid: 'aWdfZG06MRl', text: MESSAGE_TEXT },
        },
      ],
    },
  ],
}

const originalVerifyToken = process.env.META_VERIFY_TOKEN
const originalAppSecret = process.env.INSTAGRAM_APP_SECRET
const originalRawFlag = process.env.INSTAGRAM_LOG_RAW_INBOUND

let logged: unknown[][] = []

/**
 * Everything written to the console this test, rendered the way console
 * renders it, for substring checks.
 *
 * util.format, not JSON.stringify: JSON renders a Headers, an Error or a
 * URLSearchParams as `{}`, so a leak through any of them passed every "never
 * logs X" test in this file while console printed it in full. And unbounded,
 * where console stops at depth 2 and 100 array items: a leak test that sees
 * MORE than console prints can only fail safe.
 */
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

/** The structured second argument of the log line carrying `event`. */
function findEntry(event: string): Record<string, unknown> | undefined {
  for (const args of logged) {
    const payload = args[1]
    if (typeof payload !== 'object' || payload === null) continue
    const record = payload as Record<string, unknown>
    if (record.event === event) return record
  }
  return undefined
}

function getRequest(params: Record<string, string>): Request {
  const url = new URL(ROUTE_URL)
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value)
  return new Request(url)
}

function postRequest(body: string, headers: Record<string, string> = {}): Request {
  return new Request(ROUTE_URL, { method: 'POST', body, headers })
}

function signed(body: string, secret = APP_SECRET): Record<string, string> {
  return { 'x-hub-signature-256': `sha256=${createHmac('sha256', secret).update(body).digest('hex')}` }
}

function restore(name: string, original: string | undefined): void {
  if (original === undefined) delete process.env[name]
  else process.env[name] = original
}

beforeEach(() => {
  logged = []
  const capture = (...args: unknown[]): void => {
    logged.push(args)
  }
  vi.spyOn(console, 'log').mockImplementation(capture)
  vi.spyOn(console, 'warn').mockImplementation(capture)
  vi.spyOn(console, 'error').mockImplementation(capture)
  delete process.env.INSTAGRAM_LOG_RAW_INBOUND
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  restore('META_VERIFY_TOKEN', originalVerifyToken)
  restore('INSTAGRAM_APP_SECRET', originalAppSecret)
  restore('INSTAGRAM_LOG_RAW_INBOUND', originalRawFlag)
})

describe('GET /api/webhooks/instagram', () => {
  it('returns the challenge verbatim as plain text', async () => {
    process.env.META_VERIFY_TOKEN = TOKEN
    const res = await GET(
      getRequest({ 'hub.mode': 'subscribe', 'hub.verify_token': TOKEN, 'hub.challenge': '1158201444' }),
    )
    expect(res.status).toBe(200)
    // toBe, never toContain: a JSON wrapper, surrounding quotes or a trailing
    // newline all "contain" the challenge and all make Meta refuse the save.
    expect(await res.text()).toBe('1158201444')
    expect(res.headers.get('content-type')).toBe('text/plain; charset=utf-8')
  })

  it('refuses a wrong verify token with an empty body', async () => {
    process.env.META_VERIFY_TOKEN = TOKEN
    const res = await GET(
      getRequest({ 'hub.mode': 'subscribe', 'hub.verify_token': WRONG_TOKEN, 'hub.challenge': 'abc' }),
    )
    expect(res.status).toBe(403)
    expect(await res.text()).toBe('')
  })

  it('refuses a missing verify token', async () => {
    process.env.META_VERIFY_TOKEN = TOKEN
    const res = await GET(getRequest({ 'hub.mode': 'subscribe', 'hub.challenge': 'abc' }))
    expect(res.status).toBe(403)
  })

  it('refuses a missing hub.mode', async () => {
    process.env.META_VERIFY_TOKEN = TOKEN
    const res = await GET(getRequest({ 'hub.verify_token': TOKEN, 'hub.challenge': 'abc' }))
    expect(res.status).toBe(403)
  })

  it('refuses a hub.mode that is not subscribe', async () => {
    process.env.META_VERIFY_TOKEN = TOKEN
    const res = await GET(
      getRequest({ 'hub.mode': 'unsubscribe', 'hub.verify_token': TOKEN, 'hub.challenge': 'abc' }),
    )
    expect(res.status).toBe(403)
  })

  it('refuses an empty challenge', async () => {
    process.env.META_VERIFY_TOKEN = TOKEN
    const res = await GET(
      getRequest({ 'hub.mode': 'subscribe', 'hub.verify_token': TOKEN, 'hub.challenge': '' }),
    )
    expect(res.status).toBe(403)
  })

  // The trap: coalescing both sides of the comparison to '' makes '' === ''
  // true, and an unset token would verify a handshake nobody configured.
  it('refuses every handshake when META_VERIFY_TOKEN is unset', async () => {
    delete process.env.META_VERIFY_TOKEN
    const withEmpty = await GET(
      getRequest({ 'hub.mode': 'subscribe', 'hub.verify_token': '', 'hub.challenge': 'abc' }),
    )
    expect(withEmpty.status).toBe(403)

    const withGuess = await GET(
      getRequest({ 'hub.mode': 'subscribe', 'hub.verify_token': TOKEN, 'hub.challenge': 'abc' }),
    )
    expect(withGuess.status).toBe(403)
    expect(findEntry('instagram_verify_misconfigured')).toBeDefined()
  })

  // hub.verify_token rides in the QUERY STRING, so logging request.url the way
  // the Sendblue and Square routes do would write our own secret into Vercel
  // logs on every successful handshake.
  it('never writes a verify token into a log line', async () => {
    process.env.META_VERIFY_TOKEN = TOKEN

    await GET(
      getRequest({ 'hub.mode': 'subscribe', 'hub.verify_token': TOKEN, 'hub.challenge': 'abc' }),
    )
    expect(loggedText()).not.toContain(TOKEN)

    logged = []
    await GET(
      getRequest({ 'hub.mode': 'subscribe', 'hub.verify_token': WRONG_TOKEN, 'hub.challenge': 'abc' }),
    )
    expect(loggedText()).not.toContain(WRONG_TOKEN)
    expect(loggedText()).not.toContain(TOKEN)
  })
})

describe('POST /api/webhooks/instagram', () => {
  // AC 1 and AC 7 together: a verified delivery is handled exactly as before,
  // and the structured event line is pinned whole so a change to it has to
  // fail here rather than drift.
  it('acknowledges a correctly signed delivery and logs its shape unchanged', async () => {
    process.env.INSTAGRAM_APP_SECRET = APP_SECRET
    const body = JSON.stringify(PAYLOAD)
    const res = await POST(postRequest(body, signed(body)))
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('OK')
    expect(findEntry('instagram_event')).toEqual({
      event: 'instagram_event',
      object: 'instagram',
      entryCount: 1,
      events: [{ time: 1758153600000, types: ['message'] }],
    })
    expect(findEntry('instagram_signature_rejected')).toBeUndefined()
  })

  // Meta signs the bytes it sent. A verifier that re-serialized the parse would
  // pass the compact body above and refuse this one.
  it('verifies against the exact bytes received, not a re-serialization', async () => {
    process.env.INSTAGRAM_APP_SECRET = APP_SECRET
    const body = JSON.stringify(PAYLOAD, null, 2)
    const res = await POST(postRequest(body, signed(body)))
    expect(res.status).toBe(200)
    expect(findEntry('instagram_event')).toMatchObject({ object: 'instagram', entryCount: 1 })
  })

  // AC 2. "Not processed" means nothing derived from the body reaches a log
  // line: no event summary, no parse result, no content.
  it('refuses a bad signature with 403 and handles nothing', async () => {
    process.env.INSTAGRAM_APP_SECRET = APP_SECRET
    const body = JSON.stringify(PAYLOAD)
    // Signed correctly, then tampered with: the shape a real forgery takes.
    const res = await POST(postRequest(`${body} `, signed(body)))
    expect(res.status).toBe(403)
    expect(await res.text()).toBe('')
    expect(findEntry('instagram_signature_rejected')).toMatchObject({ reason: 'mismatch' })
    expect(findEntry('instagram_event')).toBeUndefined()
    expect(findEntry('instagram_invalid_json')).toBeUndefined()
    const text = loggedText()
    expect(text).not.toContain(MESSAGE_TEXT)
    expect(text).not.toContain(SENDER_IGSID)
    expect(text).not.toContain(ACCOUNT_ID)
  })

  // A forged body that would not even parse must be refused, not answered with
  // the parse-failure path's 200.
  it('refuses a bad signature on a body that would not parse', async () => {
    process.env.INSTAGRAM_APP_SECRET = APP_SECRET
    const res = await POST(postRequest('{not json', signed('{"object":"instagram"}')))
    expect(res.status).toBe(403)
    expect(findEntry('instagram_invalid_json')).toBeUndefined()
  })

  // AC 3.
  it('refuses a missing signature header with 403', async () => {
    process.env.INSTAGRAM_APP_SECRET = APP_SECRET
    const res = await POST(postRequest(JSON.stringify(PAYLOAD)))
    expect(res.status).toBe(403)
    expect(await res.text()).toBe('')
    expect(findEntry('instagram_signature_rejected')).toMatchObject({ reason: 'missing_header' })
    expect(findEntry('instagram_event')).toBeUndefined()
  })

  it('refuses a malformed signature header with 403', async () => {
    process.env.INSTAGRAM_APP_SECRET = APP_SECRET
    const body = JSON.stringify(PAYLOAD)
    const bare = createHmac('sha256', APP_SECRET).update(body).digest('hex')
    const res = await POST(postRequest(body, { 'x-hub-signature-256': bare }))
    expect(res.status).toBe(403)
    expect(findEntry('instagram_signature_rejected')).toMatchObject({ reason: 'malformed_header' })
  })

  // AC 4, the trap. HMAC accepts an empty key and anyone can compute a
  // signature keyed with one, so a forger signs with '' and hopes our secret
  // is empty too. Both shapes of "no secret" must refuse that forgery.
  it.each([
    ['unset', undefined],
    ['empty', ''],
  ])('refuses every delivery when INSTAGRAM_APP_SECRET is %s, even one signed with an empty key', async (_, value) => {
    if (value === undefined) delete process.env.INSTAGRAM_APP_SECRET
    else process.env.INSTAGRAM_APP_SECRET = value
    const body = JSON.stringify(PAYLOAD)

    const res = await POST(postRequest(body, signed(body, '')))
    expect(res.status).toBe(403)
    expect(await res.text()).toBe('')
    expect(findEntry('instagram_event')).toBeUndefined()
  })

  // The route's own guard, distinct from the verifier's. The verifier would
  // refuse an empty secret anyway; the route's job is to say it LOUDLY, at
  // error level under its own event, because this refusal alone means genuine
  // deliveries are failing. Without the route's check, this surfaces as an
  // ordinary rejection and the misconfiguration is indistinguishable from a
  // probe, which is what this test fails on.
  //
  // Both shapes, because an empty value is as much a misconfiguration as an
  // unset one and the verifier would refuse it either way: a route check that
  // only caught undefined would pass every status assertion in this file and
  // still log an empty secret as an ordinary rejection.
  it.each([
    ['unset', undefined],
    ['empty', ''],
  ])('reports a %s secret as misconfiguration, at error level, not as a rejection', async (_, value) => {
    if (value === undefined) delete process.env.INSTAGRAM_APP_SECRET
    else process.env.INSTAGRAM_APP_SECRET = value
    const body = JSON.stringify(PAYLOAD)
    await POST(postRequest(body, signed(body)))

    expect(console.error).toHaveBeenCalledWith(
      expect.any(String),
      { event: 'instagram_signature_misconfigured' },
    )
    expect(findEntry('instagram_signature_rejected')).toBeUndefined()
  })

  // Decided before the body is touched. A request whose body cannot even be
  // read is refused rather than reaching the read-failure path's 200.
  it.each([
    ['unset', undefined],
    ['empty', ''],
  ])('refuses without reading the body when the secret is %s', async (_, value) => {
    if (value === undefined) delete process.env.INSTAGRAM_APP_SECRET
    else process.env.INSTAGRAM_APP_SECRET = value
    const text = vi.fn(() => Promise.reject(new Error('stream aborted')))
    const unread = { url: ROUTE_URL, headers: new Headers(), text } as unknown as Request

    const res = await POST(unread)
    expect(res.status).toBe(403)
    expect(text).not.toHaveBeenCalled()
  })

  // Once the signature is trusted, our digest of a stranger's body IS a valid
  // signature for that body. Neither it nor the digest the caller sent may
  // reach a log line.
  it('never logs a digest when refusing', async () => {
    process.env.INSTAGRAM_APP_SECRET = APP_SECRET
    const forgedBody = JSON.stringify({ object: 'instagram', entry: [] })
    const sentDigest = 'ab'.repeat(32)
    const ourDigest = createHmac('sha256', APP_SECRET).update(forgedBody).digest('hex')

    await POST(postRequest(forgedBody, { 'x-hub-signature-256': `sha256=${sentDigest}` }))
    expect(findEntry('instagram_signature_rejected')).toBeDefined()
    expect(loggedText()).not.toContain(ourDigest)
    expect(loggedText()).not.toContain(sentDigest)
  })

  it('never logs a digest when accepting', async () => {
    process.env.INSTAGRAM_APP_SECRET = APP_SECRET
    const body = JSON.stringify(PAYLOAD)
    const digest = createHmac('sha256', APP_SECRET).update(body).digest('hex')
    await POST(postRequest(body, signed(body)))
    expect(loggedText()).not.toContain(digest)
  })

  // The refusal's field set is pinned: reason and user-agent, nothing else.
  // The user-agent is there so a refused Meta delivery, the revert signal, can
  // be told from a probe; it is caller-controlled, so it is capped.
  it('logs the reason and a capped user-agent when refusing, and nothing else', async () => {
    process.env.INSTAGRAM_APP_SECRET = APP_SECRET
    const body = JSON.stringify(PAYLOAD)

    await POST(postRequest(`${body} `, { ...signed(body), 'user-agent': 'test-agent/1.0' }))
    expect(findEntry('instagram_signature_rejected')).toEqual({
      event: 'instagram_signature_rejected',
      reason: 'mismatch',
      userAgent: 'test-agent/1.0',
    })

    logged = []
    await POST(postRequest(`${body} `, { ...signed(body), 'user-agent': 'x'.repeat(5000) }))
    expect(findEntry('instagram_signature_rejected')?.userAgent).toBe('x'.repeat(128))

    logged = []
    await POST(postRequest(`${body} `, signed(body)))
    expect(findEntry('instagram_signature_rejected')?.userAgent).toBeNull()
  })

  // AC 6. The raw-body capture is gone, so setting the old flag must change
  // nothing: no raw line, no guest content, on a well-formed body or on one
  // that fails to parse (the capture used to fire before the parse).
  it('logs no raw body and no guest content even with the retired INSTAGRAM_LOG_RAW_INBOUND set', async () => {
    process.env.INSTAGRAM_APP_SECRET = APP_SECRET
    process.env.INSTAGRAM_LOG_RAW_INBOUND = 'true'

    const body = JSON.stringify(PAYLOAD)
    const res = await POST(postRequest(body, signed(body)))
    expect(res.status).toBe(200)

    const malformed = `${MESSAGE_TEXT} {`
    const resMalformed = await POST(postRequest(malformed, signed(malformed)))
    expect(resMalformed.status).toBe(200)

    expect(findEntry('instagram_raw_inbound')).toBeUndefined()
    for (const args of logged) {
      const payload = args[1]
      if (typeof payload === 'object' && payload !== null) expect(payload).not.toHaveProperty('raw')
    }
    const text = loggedText()
    expect(text).not.toContain(MESSAGE_TEXT)
    expect(text).not.toContain(SENDER_IGSID)
    expect(text).not.toContain(ACCOUNT_ID)
  })

  it('acknowledges a correctly signed body that is not valid JSON', async () => {
    process.env.INSTAGRAM_APP_SECRET = APP_SECRET
    const res = await POST(postRequest('{not json', signed('{not json')))
    expect(res.status).toBe(200)
    // Field set pinned: V8's SyntaxError message echoes the opening bytes of
    // the body, so re-adding an `error` field here has to fail a test rather
    // than quietly reopen the leak below.
    expect(findEntry('instagram_invalid_json')).toEqual({
      event: 'instagram_invalid_json',
      bodyLength: '{not json'.length,
    })
  })

  it('never logs the app secret', async () => {
    process.env.INSTAGRAM_APP_SECRET = APP_SECRET
    const body = JSON.stringify(PAYLOAD)
    await POST(postRequest(body, signed(body)))
    await POST(postRequest(`${body} `, signed(body)))
    expect(loggedText()).not.toContain(APP_SECRET)
  })

  // With a genuine signature, nothing the guest wrote and no identifier may
  // reach the logs. summarize-payload.ts is what holds this now that it is the
  // only thing the route logs about a payload.
  it('keeps guest content and identifiers out of the logs on an accepted delivery', async () => {
    process.env.INSTAGRAM_APP_SECRET = APP_SECRET
    const body = JSON.stringify(PAYLOAD)
    await POST(postRequest(body, signed(body)))
    const text = loggedText()
    expect(text).not.toContain(MESSAGE_TEXT)
    expect(text).not.toContain(SENDER_IGSID)
    expect(text).not.toContain(ACCOUNT_ID)
  })

  // V8's SyntaxError message echoes the opening bytes of the body, so guest
  // text in a body that fails to parse would reach the logs if the error were
  // logged. The body LEADS with the content on purpose: V8 echoes only about
  // ten bytes ("oat milk a"), so a body opening with anything else never puts
  // the checked words in the echo and the test passes against the leak it is
  // named for. Signed, so it reaches the parse.
  it('keeps guest content out of the logs when a signed body fails to parse', async () => {
    process.env.INSTAGRAM_APP_SECRET = APP_SECRET
    const body = 'oat milk allergy, call me at 555-0100'
    const res = await POST(postRequest(body, signed(body)))
    expect(res.status).toBe(200)
    expect(findEntry('instagram_invalid_json')).toBeDefined()
    // Catches V8's short leading echo.
    expect(loggedText()).not.toContain('oat milk')
    // Catches a whole-body echo, should a different engine produce one.
    expect(loggedText()).not.toContain('555-0100')
  })

  // Meta disables a subscription after repeated non-2xx, so a throw while
  // reading the body acks. Nothing from the body is logged on this path,
  // because there is no body. This is one of the places the route diverges
  // from Sendblue and Square, which 500 so the provider retries.
  it('acknowledges when reading the body throws', async () => {
    process.env.INSTAGRAM_APP_SECRET = APP_SECRET
    const broken = {
      url: ROUTE_URL,
      headers: new Headers(),
      text: () => Promise.reject(new Error('stream aborted')),
    } as unknown as Request

    const res = await POST(broken)
    expect(res.status).toBe(200)
    expect(findEntry('instagram_unexpected_error')).toBeDefined()
    expect(findEntry('instagram_event')).toBeUndefined()
  })
})
