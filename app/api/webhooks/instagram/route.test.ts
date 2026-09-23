import { createHmac } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { formatWithOptions } from 'node:util'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createInstagramDbFake, type FakeRow } from '@/lib/messaging/instagram/testing/db-fake'

import { GET, POST } from './route'

// The route saves through the admin client and would hand a guest message to
// the agent. Both are replaced: the store with the same in-memory fake the
// handler's own tests use, the agent and waitUntil with spies, so a test can
// assert the agent is NEVER reached while the TAC-469 gate is shut.
const mocks = vi.hoisted(() => ({
  createAdminClient: vi.fn(),
  handleInbound: vi.fn(),
  waitUntil: vi.fn(),
  refreshInstagramProfile: vi.fn(),
  captureScanUnattributed: vi.fn(),
}))
vi.mock('@/lib/db/admin', () => ({ createAdminClient: mocks.createAdminClient }))
vi.mock('@/lib/agent', () => ({ handleInbound: mocks.handleInbound }))
vi.mock('@vercel/functions', () => ({ waitUntil: mocks.waitUntil }))
// TAC-479. The refresh itself is replaced by a spy, so these tests see what
// the route hands to waitUntil and never make a Graph call. Which outcomes get
// one is decided by the REAL profileRefreshTargetFor, so a route that stopped
// asking it would fail here.
// TAC-518. The real decision (scanUnattributedReason) still runs; only the
// emit is a spy, so a route that stopped asking, or asked with the wrong
// fields, fails here. Partial, so nothing else this module exports is stubbed.
vi.mock('@/lib/analytics/posthog', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/analytics/posthog')>()
  return { ...actual, captureInstagramScanUnattributed: mocks.captureScanUnattributed }
})
vi.mock('@/lib/messaging/instagram/refresh-profile', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/messaging/instagram/refresh-profile')>()
  return { ...actual, refreshInstagramProfile: mocks.refreshInstagramProfile }
})

// The real gate, except that a test can open it. That is the one thing
// The gate is OPEN as it ships (TAC-469 PR C), so most tests run with it open
// and a few force it shut to cover what a rollback restores. THREE properties
// keep this mock from hiding a bypass, and the third already earned its keep:
// an `enabled` the ROUTE passes is honoured, so a route that forced the gate
// open would still fail the shut-gate tests; `null` means "use the real
// constant", so flipping that constant changes what these tests see; and it is
// tri-state rather than a boolean OR, because `false || CONSTANT` could not
// express "shut" once the constant went true and would have silently dropped
// the shut-gate coverage at exactly the moment it started mattering.
const gate = vi.hoisted(() => ({ open: null as boolean | null }))
vi.mock('@/lib/messaging/instagram/agent-gate', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/messaging/instagram/agent-gate')>()
  return {
    ...actual,
    resolveAgentHandoff: (
      outcome: Parameters<typeof actual.resolveAgentHandoff>[0],
      enabled?: boolean,
    ) =>
      actual.resolveAgentHandoff(
        outcome,
        enabled ?? gate.open ?? actual.INSTAGRAM_AGENT_REPLIES_ENABLED,
      ),
  }
})

let db = createInstagramDbFake()

function useDb(seed: Parameters<typeof createInstagramDbFake>[0] = {}): void {
  db = createInstagramDbFake(seed)
  mocks.createAdminClient.mockReturnValue(db.client)
}

// The route hands the ledger write (TAC-523) to waitUntil, which is a spy here
// and does not await it. The insert is already in flight; this lets it settle.
function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

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
  mocks.createAdminClient.mockReset()
  mocks.handleInbound.mockReset()
  mocks.waitUntil.mockReset()
  mocks.refreshInstagramProfile.mockReset()
  mocks.refreshInstagramProfile.mockResolvedValue({ status: 'not_due' })
  mocks.captureScanUnattributed.mockReset()
  mocks.captureScanUnattributed.mockResolvedValue(undefined)
  gate.open = null
  useDb()
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
    // Handles nothing includes saving nothing: the store is never opened.
    expect(mocks.createAdminClient).not.toHaveBeenCalled()
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
    // TAC-468 AC8: still 200, and nothing is saved from a body that can't be read.
    expect(mocks.createAdminClient).not.toHaveBeenCalled()
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

// Real deliveries captured from Meta on 2026-09-17, identifiers replaced (see
// lib/messaging/instagram/fixtures/README.md). The synthetic payloads above
// test the rules; these test that a body shaped exactly as Meta sends it,
// including an echo, a read receipt and a postback carrying a referral,
// verifies, is acknowledged, and puts none of its identifiers, text, ref,
// title or payload in the logs.
const FIXTURES = join(__dirname, '../../../../lib/messaging/instagram/fixtures')
// The replacement IDs in the fixtures (fixtures/README.md).
const FIXTURE_ACCOUNT_ID = '17841400000000001'
const FIXTURE_GUEST_IGSID = '1000000000000001'
const FIXTURE_VENUE: FakeRow = { id: 'venue-1', instagram_account_id: FIXTURE_ACCOUNT_ID }
const FIXTURE_GUEST: FakeRow = { id: 'guest-1', venue_id: 'venue-1', instagram_scoped_id: FIXTURE_GUEST_IGSID }

describe('POST /api/webhooks/instagram with recorded Meta payloads', () => {

  // Venue mapped and guest known, so each delivery goes all the way through
  // its save path and logs its outcome line: the lines the leak check must
  // cover as well as the shape line.
  it.each(['message', 'echo', 'read', 'postback-referral'])('verifies and acknowledges the recorded %s delivery', async (name) => {
    process.env.INSTAGRAM_APP_SECRET = APP_SECRET
    useDb({ venues: [FIXTURE_VENUE], guests: [FIXTURE_GUEST] })
    const body = readFileSync(join(FIXTURES, `${name}.json`), 'utf8')

    const res = await POST(postRequest(body, signed(body)))
    expect(res.status).toBe(200)
    expect(findEntry('instagram_event')).toMatchObject({ object: 'instagram', entryCount: 1 })

    const values = [...body.matchAll(/"(?:id|mid|text|ref|title|payload)":"([^"]+)"/g)].map((m) => m[1] ?? '')
    expect(values.length).toBeGreaterThan(0)
    const text = loggedText()
    for (const value of values) expect(text).not.toContain(value)
  })
})

// TAC-468. The handler's own tests cover what each kind writes; these cover
// the route around it: a signed recorded delivery reaches the store, the agent
// is never handed anything while the TAC-469 gate is shut, and every path
// still answers 200.
describe('POST /api/webhooks/instagram saving events', () => {
  function post(body: string): Promise<Response> {
    process.env.INSTAGRAM_APP_SECRET = APP_SECRET
    return POST(postRequest(body, signed(body)))
  }

  function recorded(name: string): string {
    return readFileSync(join(FIXTURES, `${name}.json`), 'utf8')
  }

  // The gate, forced SHUT. This is what a rollback restores, so it keeps its
  // coverage after the flip: saving still works, and nothing reaches the agent.
  // Before PR C these ran on the shipped constant and were what failed when it
  // was flipped, which is how the flip proved it reached the route at all.
  it.each(['message', 'postback-referral'])(
    'saves the recorded %s as an Instagram row and does not run the agent when the gate is shut',
    async (name) => {
      gate.open = false
      useDb({ venues: [FIXTURE_VENUE] })
      const refresh = Promise.resolve({ status: 'not_due' })
      mocks.refreshInstagramProfile.mockReturnValue(refresh)
      const res = await post(recorded(name))

      expect(res.status).toBe(200)
      expect(db.inserts('messages')).toMatchObject([{ channel: 'instagram', direction: 'inbound' }])
      expect(findEntry('instagram_event_persisted')).toMatchObject({ guestCreated: true })
      expect(mocks.handleInbound).not.toHaveBeenCalled()
      // TAC-479's profile refresh, plus TAC-523's ledger write. Both are
      // background work and neither is behind the agent gate.
      expect(mocks.waitUntil).toHaveBeenCalledTimes(2)
      expect(mocks.waitUntil).toHaveBeenCalledWith(refresh)

      // THE 2026-09-20 INCIDENT, end to end. A guest's first message was saved
      // and dropped because this gate was false in the deployment serving the
      // request, and NOTHING recorded it — the cause was nameable two days
      // later only because Vercel still held the runtime logs. This row is
      // what makes it a query instead.
      await flushMicrotasks()
      expect(db.inserts('inbound_turn_outcomes')).toMatchObject([
        {
          layer: 'webhook',
          outcome: 'not_run',
          reason: 'gate_shut',
          channel: 'instagram',
          venue_id: FIXTURE_VENUE.id,
          agent_run_id: null,
        },
      ])
      // Tied to the inbound it is about; without that the count is a number
      // with nothing behind it. Cross-checked against the id the handler's own
      // saved-event line reported, rather than against the fake's internals.
      const savedMessageId = (findEntry('instagram_event_persisted') as { messageId: string })
        .messageId
      expect(savedMessageId).toBeTruthy()
      expect(db.inserts('inbound_turn_outcomes')[0].inbound_message_id).toBe(savedMessageId)
    },
  )

  // Runs on the SHIPPED constant — `gate.open` is left null — so this is the
  // one route test that fails if the constant is flipped back. Without it,
  // every route test forces the gate explicitly and the route could stop
  // consulting the constant at all with nothing to show for it. That property
  // is what caught PR C's flip reaching the route in the first place, and
  // making the shut-gate tests explicit would otherwise have thrown it away.
  it('runs the agent on a new guest message with the gate as it ships', async () => {
    useDb({ venues: [FIXTURE_VENUE] })
    const agentRun = Promise.resolve()
    mocks.handleInbound.mockReturnValue(agentRun)

    const res = await post(recorded('message'))

    expect(res.status).toBe(200)
    const [saved] = db.tables.messages
    expect(mocks.handleInbound).toHaveBeenCalledTimes(1)
    expect(mocks.handleInbound).toHaveBeenCalledWith(saved?.id)
    expect(mocks.waitUntil).toHaveBeenCalledWith(agentRun)
  })

  it('logs an unhandled field and acknowledges it', async () => {
    const body = JSON.stringify({
      object: 'instagram',
      entry: [{ id: FIXTURE_ACCOUNT_ID, time: 1, changes: [{ field: 'comments', value: { text: 'nice spot' } }] }],
    })
    const res = await post(body)

    expect(res.status).toBe(200)
    expect(findEntry('instagram_event_unhandled')).toEqual({
      event: 'instagram_event_unhandled',
      reason: 'changes_field',
      fields: ['comments'],
    })
    expect(loggedText()).not.toContain('nice spot')
  })

  it('acknowledges a delivery whose save fails', async () => {
    useDb({ venues: [FIXTURE_VENUE] })
    db.failNext('messages', 'insert', { code: '08006', message: 'connection failure' })
    const res = await post(recorded('message'))

    expect(res.status).toBe(200)
    expect(findEntry('instagram_event_persist_failed')).toMatchObject({ stage: 'message_insert', code: '08006' })

    // TAC-523: a guest's real message reached us and was not filed. That is the
    // single most important row this table holds, and before the ledger it was
    // a console line behind a 200. The gate-shut case got an end-to-end
    // assertion and this one did not; code review caught the asymmetry.
    await flushMicrotasks()
    expect(db.inserts('inbound_turn_outcomes')).toMatchObject([
      { layer: 'webhook', outcome: 'not_run', reason: 'event_not_persisted', channel: 'instagram' },
    ])
  })

  it('acknowledges when the store cannot be opened', async () => {
    mocks.createAdminClient.mockImplementation(() => {
      throw new Error('Missing env var: SUPABASE_SECRET_KEY')
    })
    const res = await post(recorded('message'))

    expect(res.status).toBe(200)
    expect(findEntry('instagram_unexpected_error')).toBeDefined()
  })

  it('skips, logs and acknowledges a delivery for an account no venue is mapped to', async () => {
    const res = await post(recorded('message'))

    expect(res.status).toBe(200)
    expect(findEntry('instagram_event_skipped')).toEqual({
      event: 'instagram_event_skipped',
      kind: 'message',
      reason: 'venue_not_found',
    })
    expect(db.inserts('messages')).toEqual([])
  })
})

// With the gate open, as TAC-469 will run it. Without these, deleting the
// route's hand-off line passes every other test in this file, since they can
// only assert that the agent is NOT called.
describe('POST /api/webhooks/instagram with the agent gate open', () => {
  function post(body: string): Promise<Response> {
    process.env.INSTAGRAM_APP_SECRET = APP_SECRET
    return POST(postRequest(body, signed(body)))
  }

  function recorded(name: string): string {
    return readFileSync(join(FIXTURES, `${name}.json`), 'utf8')
  }

  it.each(['message', 'postback-referral'])(
    'hands the newly saved %s row to the agent in the background',
    async (name) => {
      gate.open = true
      useDb({ venues: [FIXTURE_VENUE] })
      const agentRun = Promise.resolve()
      mocks.handleInbound.mockReturnValue(agentRun)

      const res = await post(recorded(name))

      expect(res.status).toBe(200)
      const [saved] = db.tables.messages
      expect(mocks.handleInbound).toHaveBeenCalledTimes(1)
      expect(mocks.handleInbound).toHaveBeenCalledWith(saved?.id)
      // The agent run and the profile refresh (TAC-479), each handed off once.
      expect(mocks.waitUntil).toHaveBeenCalledTimes(2)
      expect(mocks.waitUntil).toHaveBeenCalledWith(agentRun)
    },
  )

  it.each(['echo', 'read'])('never hands the recorded %s to the agent', async (name) => {
    gate.open = true
    const echoRow: FakeRow = { id: 'msg-echo', venue_id: 'venue-1', guest_id: 'guest-1' }
    useDb({ venues: [FIXTURE_VENUE], guests: [FIXTURE_GUEST], messages: name === 'read' ? [echoRow] : [] })

    await post(recorded(name))

    expect(mocks.handleInbound).not.toHaveBeenCalled()
    expect(mocks.waitUntil).not.toHaveBeenCalled()
  })

  it('never hands a redelivered message to the agent a second time', async () => {
    gate.open = true
    useDb({ venues: [FIXTURE_VENUE] })
    const body = recorded('message')

    await post(body)
    await post(body)

    expect(mocks.handleInbound).toHaveBeenCalledTimes(1)
    expect(findEntry('instagram_event_duplicate')).toBeDefined()
  })
})

// TAC-479. The profile refresh runs AFTER the webhook answers: handed to
// waitUntil, never awaited, so no Graph call sits on Meta's delivery
// deadline. The refresh's own behaviour is tested in refresh-profile.test.ts.
describe('POST /api/webhooks/instagram refreshing the guest profile', () => {
  function post(body: string): Promise<Response> {
    process.env.INSTAGRAM_APP_SECRET = APP_SECRET
    return POST(postRequest(body, signed(body)))
  }

  function recorded(name: string): string {
    return readFileSync(join(FIXTURES, `${name}.json`), 'utf8')
  }

  /** One delivery carrying a guest message per (igsid, mid) pair. */
  function messages(...items: Array<[igsid: string, mid: string]>): string {
    return JSON.stringify({
      object: 'instagram',
      entry: [
        {
          id: FIXTURE_ACCOUNT_ID,
          time: 1789704055296,
          messaging: items.map(([igsid, mid]) => ({
            sender: { id: igsid },
            recipient: { id: FIXTURE_ACCOUNT_ID },
            timestamp: 1789704054588,
            message: { mid, text: 'hi' },
          })),
        },
      ],
    })
  }

  // A refresh that never finishes. If the route awaited it, POST would never
  // resolve and this test would time out rather than pass.
  it.each(['message', 'postback-referral'])(
    'hands the refresh for a saved %s to waitUntil and answers without waiting for it',
    async (name) => {
      useDb({ venues: [FIXTURE_VENUE] })
      const neverFinishes = new Promise(() => undefined)
      mocks.refreshInstagramProfile.mockReturnValue(neverFinishes)

      const res = await post(recorded(name))

      expect(res.status).toBe(200)
      const [guest] = db.tables.guests
      expect(mocks.refreshInstagramProfile).toHaveBeenCalledTimes(1)
      expect(mocks.refreshInstagramProfile).toHaveBeenCalledWith(db.client, { guestId: guest?.id, venueId: 'venue-1' })
      expect(mocks.waitUntil).toHaveBeenCalledWith(neverFinishes)
    },
    2000,
  )

  it.each(['echo', 'read'])('does not refresh anyone for a recorded %s', async (name) => {
    const echoRow: FakeRow = { id: 'msg-echo', venue_id: 'venue-1', guest_id: 'guest-1' }
    useDb({ venues: [FIXTURE_VENUE], guests: [FIXTURE_GUEST], messages: name === 'read' ? [echoRow] : [] })

    await post(recorded(name))

    expect(mocks.refreshInstagramProfile).not.toHaveBeenCalled()
    expect(mocks.waitUntil).not.toHaveBeenCalled()
  })

  it('does not refresh again for a redelivered message', async () => {
    useDb({ venues: [FIXTURE_VENUE] })
    const body = recorded('message')

    await post(body)
    await post(body)

    expect(mocks.refreshInstagramProfile).toHaveBeenCalledTimes(1)
  })

  it('refreshes a guest once however many of their messages a delivery carries', async () => {
    useDb({ venues: [FIXTURE_VENUE], guests: [FIXTURE_GUEST] })

    await post(messages([FIXTURE_GUEST_IGSID, 'm-1'], [FIXTURE_GUEST_IGSID, 'm-2'], [FIXTURE_GUEST_IGSID, 'm-3']))

    expect(db.inserts('messages')).toHaveLength(3)
    expect(mocks.refreshInstagramProfile).toHaveBeenCalledTimes(1)
    expect(mocks.refreshInstagramProfile).toHaveBeenCalledWith(db.client, { guestId: 'guest-1', venueId: 'venue-1' })
  })

  // 15 and 16 digits have both been seen. Nothing here may assume a width.
  it('refreshes each guest in a delivery, whatever the length of their scoped ID', async () => {
    const shortIdGuest: FakeRow = { id: 'guest-2', venue_id: 'venue-1', instagram_scoped_id: '100000000000002' }
    useDb({ venues: [FIXTURE_VENUE], guests: [FIXTURE_GUEST, shortIdGuest] })

    await post(messages([FIXTURE_GUEST_IGSID, 'm-1'], ['100000000000002', 'm-2']))

    expect(mocks.refreshInstagramProfile.mock.calls.map((call) => call[1])).toEqual([
      { guestId: 'guest-1', venueId: 'venue-1' },
      { guestId: 'guest-2', venueId: 'venue-1' },
    ])
  })
})


// TAC-518. An inbound that looks like it came from the venue's link and carries
// nothing to prove it. This is the signal that tells us whether the returning-
// guest case delivers a referral at all, so it is wired end to end rather than
// left to the pure test in handle-events.test.ts.
describe('POST /api/webhooks/instagram reporting an unattributable scan', () => {
  const FIXTURES_DIR = join(__dirname, '../../../../lib/messaging/instagram/fixtures')

  function post(body: string): Promise<Response> {
    process.env.INSTAGRAM_APP_SECRET = APP_SECRET
    return POST(postRequest(body, signed(body)))
  }

  /** The recorded icebreaker tap with its referral removed: a returning guest's scan, if Meta drops it. */
  function postbackWithoutReferral(): string {
    const payload = JSON.parse(readFileSync(join(FIXTURES_DIR, 'postback-referral.json'), 'utf8'))
    for (const entry of payload.entry) {
      for (const item of entry.messaging) {
        delete item.referral
        delete item.postback?.referral
      }
    }
    return JSON.stringify(payload)
  }

  it('reports an icebreaker tap that carries no referral', async () => {
    useDb({ venues: [FIXTURE_VENUE] })
    mocks.refreshInstagramProfile.mockReturnValue(Promise.resolve({ status: 'not_due' }))
    const emitted = Promise.resolve()
    mocks.captureScanUnattributed.mockReturnValue(emitted)

    const res = await post(postbackWithoutReferral())

    expect(res.status).toBe(200)
    const [guest] = db.tables.guests as FakeRow[]
    const [message] = db.tables.messages as FakeRow[]
    expect(mocks.captureScanUnattributed).toHaveBeenCalledWith({
      venueId: 'venue-1',
      guestId: guest?.id,
      messageId: message?.id,
      reason: 'postback_without_referral',
      referralSource: null,
      guestCreated: true,
    })
    // Handed to waitUntil, never awaited: the emit posts to Slack, and this
    // route answers 200 inside Meta's delivery deadline or the subscription is
    // eventually switched off.
    //
    // IDENTITY, not toHaveBeenCalledWith. A promise has no own enumerable
    // properties, so vitest's deep equality reads any two resolved promises as
    // equal — the first version of this line used toHaveBeenCalledWith and an
    // `await` in place of waitUntil passed it, because the profile refresh's
    // promise compared equal to the emit's.
    expect(mocks.waitUntil.mock.calls.some(([arg]) => arg === emitted)).toBe(true)
    // And it logs, per the ruling's "logs AND PostHog".
    expect(findEntry('instagram_scan_unattributed')).toMatchObject({
      reason: 'postback_without_referral',
      venueId: 'venue-1',
    })
  })

  // The recorded tap, unmodified: its referral is a real SHORTLINK, so there is
  // nothing to report. Without this the test above would pass against a route
  // that reported every postback.
  it('reports nothing for the recorded tap that does carry its referral', async () => {
    useDb({ venues: [FIXTURE_VENUE] })
    mocks.refreshInstagramProfile.mockReturnValue(Promise.resolve({ status: 'not_due' }))

    const res = await post(readFileSync(join(FIXTURES_DIR, 'postback-referral.json'), 'utf8'))

    expect(res.status).toBe(200)
    expect(mocks.captureScanUnattributed).not.toHaveBeenCalled()
  })

  // An ordinary DM. If this fired, the signal would mean nothing.
  it('reports nothing for an ordinary message with no referral', async () => {
    useDb({ venues: [FIXTURE_VENUE] })
    mocks.refreshInstagramProfile.mockReturnValue(Promise.resolve({ status: 'not_due' }))

    const res = await post(readFileSync(join(FIXTURES_DIR, 'message.json'), 'utf8'))

    expect(res.status).toBe(200)
    expect(mocks.captureScanUnattributed).not.toHaveBeenCalled()
  })
})
