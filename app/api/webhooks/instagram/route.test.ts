import { createHmac } from 'node:crypto'

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

/** Everything written to the console this test, flattened for substring checks. */
function loggedText(): string {
  return logged
    .map((args) =>
      args.map((arg) => (typeof arg === 'string' ? arg : JSON.stringify(arg))).join(' '),
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
  it('acknowledges a well-formed delivery', async () => {
    process.env.INSTAGRAM_APP_SECRET = APP_SECRET
    const body = JSON.stringify(PAYLOAD)
    const res = await POST(postRequest(body, signed(body)))
    expect(res.status).toBe(200)
    expect(findEntry('instagram_event')).toMatchObject({ object: 'instagram', entryCount: 1 })
  })

  it('acknowledges a malformed body', async () => {
    process.env.INSTAGRAM_APP_SECRET = APP_SECRET
    const res = await POST(postRequest('{not json'))
    expect(res.status).toBe(200)
    // Field set pinned: V8's SyntaxError message echoes the opening bytes of
    // the body, so re-adding an `error` field here has to fail a test rather
    // than quietly reopen the leak below.
    expect(findEntry('instagram_invalid_json')).toEqual({
      event: 'instagram_invalid_json',
      bodyLength: '{not json'.length,
    })
  })

  // Runs the REAL verifier, and asserts BOTH directions. Asserting only that a
  // log line exists would pass against a hardcoded `matched: false`.
  it('computes the signature and reports a match', async () => {
    process.env.INSTAGRAM_APP_SECRET = APP_SECRET
    const body = JSON.stringify(PAYLOAD)
    const digest = createHmac('sha256', APP_SECRET).update(body).digest('hex')

    const res = await POST(postRequest(body, signed(body)))
    expect(res.status).toBe(200)
    // toEqual, not toMatchObject: `received` is the field that makes this
    // scaffold diagnostic at all — "what did Meta send vs what did we
    // compute" — and a partial match lets it disappear silently.
    expect(findEntry('instagram_signature_check')).toEqual({
      event: 'instagram_signature_check',
      matched: true,
      computed: digest,
      received: digest,
      enforced: false,
    })
  })

  it('computes the signature and reports a mismatch without rejecting', async () => {
    process.env.INSTAGRAM_APP_SECRET = APP_SECRET
    const body = JSON.stringify(PAYLOAD)
    // Signed correctly, then tampered with — the shape a real forgery takes.
    const res = await POST(postRequest(`${body} `, signed(body)))
    expect(findEntry('instagram_signature_check')).toMatchObject({ matched: false })
    // AC: a mismatch is logged, never rejected, while the scaffold stands.
    expect(res.status).toBe(200)
  })

  it('acknowledges and says so when INSTAGRAM_APP_SECRET is unset', async () => {
    delete process.env.INSTAGRAM_APP_SECRET
    const body = JSON.stringify(PAYLOAD)
    const res = await POST(postRequest(body, signed(body)))
    expect(res.status).toBe(200)
    expect(findEntry('instagram_signature_unavailable')).toBeDefined()
    expect(findEntry('instagram_signature_check')).toBeUndefined()
  })

  it('never logs the app secret', async () => {
    process.env.INSTAGRAM_APP_SECRET = APP_SECRET
    const body = JSON.stringify(PAYLOAD)
    await POST(postRequest(body, signed(body)))
    expect(loggedText()).not.toContain(APP_SECRET)
  })

  it('logs the raw body only when the flag is exactly "true"', async () => {
    process.env.INSTAGRAM_APP_SECRET = APP_SECRET
    const body = JSON.stringify(PAYLOAD)

    process.env.INSTAGRAM_LOG_RAW_INBOUND = 'true'
    await POST(postRequest(body, signed(body)))
    expect(findEntry('instagram_raw_inbound')).toMatchObject({ raw: body })

    logged = []
    process.env.INSTAGRAM_LOG_RAW_INBOUND = '1'
    await POST(postRequest(body, signed(body)))
    expect(findEntry('instagram_raw_inbound')).toBeUndefined()

    logged = []
    delete process.env.INSTAGRAM_LOG_RAW_INBOUND
    await POST(postRequest(body, signed(body)))
    expect(findEntry('instagram_raw_inbound')).toBeUndefined()
  })

  // The route-level companion to the summarizer's own leak test. With the flag
  // off — the default, and so the steady state — nothing the guest wrote and
  // no identifier may reach the logs.
  it('keeps guest content and identifiers out of the logs when the flag is off', async () => {
    process.env.INSTAGRAM_APP_SECRET = APP_SECRET
    const body = JSON.stringify(PAYLOAD)
    await POST(postRequest(body, signed(body)))
    const text = loggedText()
    expect(text).not.toContain(MESSAGE_TEXT)
    expect(text).not.toContain(SENDER_IGSID)
    expect(text).not.toContain(ACCOUNT_ID)
  })

  // The intersection the two tests above each half-covered: the well-formed
  // leak test never enters the parse-error branch, and the malformed-body test
  // only checked the status. V8's SyntaxError message echoes the opening bytes
  // of the body, so guest text in a body that fails to parse used to reach the
  // logs with the flag OFF.
  //
  // The body LEADS with the content on purpose, and the first version of this
  // test got that wrong. V8 echoes only about ten bytes ("oat milk a"), so a
  // body opening with anything else never puts the checked words in the echo
  // and the test passes against the leak it is named for. This is the exact
  // reproduction measured in code review.
  it('keeps guest content out of the logs when a malformed body fails to parse', async () => {
    process.env.INSTAGRAM_APP_SECRET = APP_SECRET
    delete process.env.INSTAGRAM_LOG_RAW_INBOUND
    const res = await POST(postRequest('oat milk allergy, call me at 555-0100'))
    expect(res.status).toBe(200)
    expect(findEntry('instagram_invalid_json')).toBeDefined()
    // Catches V8's short leading echo.
    expect(loggedText()).not.toContain('oat milk')
    // Catches a whole-body echo, should a different engine produce one.
    expect(loggedText()).not.toContain('555-0100')
  })

  it('captures the raw body even when the payload will not parse', async () => {
    process.env.INSTAGRAM_APP_SECRET = APP_SECRET
    process.env.INSTAGRAM_LOG_RAW_INBOUND = 'true'
    const res = await POST(postRequest('{not json'))
    expect(res.status).toBe(200)
    expect(findEntry('instagram_raw_inbound')).toMatchObject({ raw: '{not json' })
  })

  // Meta disables a subscription after repeated non-2xx, so even an unhandled
  // throw acks. This is the one place the route diverges from Sendblue and
  // Square, which 500 so the provider retries.
  it('acknowledges even when reading the body throws', async () => {
    process.env.INSTAGRAM_APP_SECRET = APP_SECRET
    const broken = {
      url: ROUTE_URL,
      headers: new Headers(),
      text: () => Promise.reject(new Error('stream aborted')),
    } as unknown as Request

    const res = await POST(broken)
    expect(res.status).toBe(200)
    expect(findEntry('instagram_unexpected_error')).toBeDefined()
  })
})
