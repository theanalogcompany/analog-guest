// TAC-516 / TAC-460: the token refresh tick.
//
// The cases are TAC-460's own AC6 list — inside the margin, outside it, under
// 24 hours old, a refusal, and an already-expired token — plus the two this
// implementation adds (an undecryptable ciphertext, and a refresh that
// succeeded at Meta but could not be stored).
//
// Every assertion that matters is about what happens to the STORED token. A
// failed refresh must leave it alone: replacing a working token with nothing
// would turn a recoverable failure into the outage this job prevents.

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/analytics/posthog', () => ({
  captureInstagramTokenRefreshFailed: vi.fn(),
  captureInstagramTokenExpiredUnrecoverable: vi.fn(),
}))

import {
  captureInstagramTokenExpiredUnrecoverable,
  captureInstagramTokenRefreshFailed,
} from '@/lib/analytics/posthog'

import {
  INSTAGRAM_LONG_LIVED_TOKEN_MS,
  INSTAGRAM_TOKEN_MIN_AGE_MS,
  INSTAGRAM_TOKEN_REFRESH_WINDOW_MS,
  processInstagramTokenRefresh,
  tokenAcquiredAt,
} from './refresh-tokens'
import { callsNamed, queryRecorder } from './testing/query-recorder'
import { decryptInstagramToken, encryptInstagramToken } from './token-crypto'

const PREV_KEY = process.env.INSTAGRAM_TOKEN_ENC_KEY
beforeAll(() => {
  process.env.INSTAGRAM_TOKEN_ENC_KEY = Buffer.alloc(32, 3).toString('base64')
})
afterAll(() => {
  process.env.INSTAGRAM_TOKEN_ENC_KEY = PREV_KEY
})

const NOW = new Date('2026-10-01T12:00:00.000Z')
const DAY = 24 * 60 * 60 * 1000
const VENUE_ID = 'venue-1'
const OLD_TOKEN = 'IGAAold00000000000000000000000000000000000000000'
const NEW_TOKEN = 'IGAAnew00000000000000000000000000000000000000000'

function row(overrides: Record<string, unknown> = {}) {
  return {
    venue_id: VENUE_ID,
    access_token_enc: encryptInstagramToken(OLD_TOKEN),
    // 5 days out: inside the ten-day margin.
    token_expires_at: new Date(NOW.getTime() + 5 * DAY).toISOString(),
    // Acquired well over 24 hours ago.
    connected_at: new Date(NOW.getTime() - 40 * DAY).toISOString(),
    last_refreshed_at: null,
    ...overrides,
  }
}

/** Meta's own success shape. */
function metaOk(expiresInSeconds = 60 * 24 * 60 * 60) {
  return vi.fn(async () =>
    new Response(JSON.stringify({ access_token: NEW_TOKEN, token_type: 'bearer', expires_in: expiresInSeconds }), {
      status: 200,
    }),
  )
}

function metaRefuses(code = 190) {
  return vi.fn(async () =>
    new Response(
      JSON.stringify({
        error: {
          message: `Error validating access token: the token for ${OLD_TOKEN} is invalid`,
          type: 'OAuthException',
          code,
          error_subcode: 463,
          fbtrace_id: 'XyZ',
        },
      }),
      { status: 400 },
    ),
  )
}

const logged: unknown[][] = []
beforeEach(() => {
  vi.clearAllMocks()
  logged.length = 0
  for (const level of ['log', 'warn', 'error'] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
      logged.push(args)
    })
  }
})

function loggedText(): string {
  return logged.map((a) => a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ')).join('\n')
}

describe('tokenAcquiredAt', () => {
  it('uses connected_at until a refresh has happened, then the refresh', () => {
    const connected = new Date(NOW.getTime() - 40 * DAY).toISOString()
    const refreshed = new Date(NOW.getTime() - 2 * DAY).toISOString()
    expect(tokenAcquiredAt({ connected_at: connected, last_refreshed_at: null })).toEqual(new Date(connected))
    expect(tokenAcquiredAt({ connected_at: connected, last_refreshed_at: refreshed })).toEqual(new Date(refreshed))
  })

  // A refresh timestamp older than the connection is nonsense; taking the
  // later of the two means a corrupt row can only ever make the token look
  // OLDER, which fails toward attempting a refresh rather than skipping one.
  it('takes the later of the two, and survives an unreadable refresh time', () => {
    const connected = new Date(NOW.getTime() - 2 * DAY).toISOString()
    const older = new Date(NOW.getTime() - 40 * DAY).toISOString()
    expect(tokenAcquiredAt({ connected_at: connected, last_refreshed_at: older })).toEqual(new Date(connected))
    expect(tokenAcquiredAt({ connected_at: connected, last_refreshed_at: 'nonsense' })).toEqual(new Date(connected))
  })
})

describe('processInstagramTokenRefresh', () => {
  it('scans only live credentials inside the refresh margin', async () => {
    const { client, queries } = queryRecorder({ instagram_credentials: [{ data: [], error: null }] })
    const summary = await processInstagramTokenRefresh(NOW, { fetch: metaOk(), now: () => NOW }, client)

    expect(summary).toMatchObject({ scanned: 0, refreshed: 0 })
    expect(callsNamed(queries[0], 'eq')).toEqual([['is_active', true]])
    const [[column, horizon]] = callsNamed(queries[0], 'lte') as [[string, string]]
    expect(column).toBe('token_expires_at')
    expect(new Date(horizon)).toEqual(new Date(NOW.getTime() + INSTAGRAM_TOKEN_REFRESH_WINDOW_MS))
  })

  it('refreshes a token inside the margin and stores the new one encrypted', async () => {
    const { client, queries } = queryRecorder({
      instagram_credentials: [{ data: [row()], error: null }, { data: null, error: null }],
    })
    const fetchImpl = metaOk()
    const summary = await processInstagramTokenRefresh(NOW, { fetch: fetchImpl, now: () => NOW }, client)

    expect(summary).toMatchObject({ scanned: 1, refreshed: 1, failed: 0, errored: 0 })

    const [[patch]] = callsNamed(queries[1], 'update') as [[Record<string, unknown>]]
    expect(decryptInstagramToken(String(patch.access_token_enc))).toBe(NEW_TOKEN)
    expect(JSON.stringify(patch)).not.toContain(NEW_TOKEN)
    expect(patch.last_refreshed_at).toBe(NOW.toISOString())
    // A successful refresh clears the previous failure, or an operator would
    // keep seeing a stale error against a token that now works.
    expect(patch.last_refresh_error).toBeNull()
    expect(patch.last_refresh_error_at).toBeNull()
    expect(new Date(String(patch.token_expires_at))).toEqual(new Date(NOW.getTime() + 60 * DAY))
    expect(callsNamed(queries[1], 'eq')).toEqual([['venue_id', VENUE_ID]])
  })

  // graph.ts's rule: the token rides in the Authorization header, never the
  // query string, because a URL reaches request logs and error messages.
  it('sends the token in the header and never in the URL', async () => {
    const { client } = queryRecorder({
      instagram_credentials: [{ data: [row()], error: null }, { data: null, error: null }],
    })
    const fetchImpl = metaOk()
    await processInstagramTokenRefresh(NOW, { fetch: fetchImpl, now: () => NOW }, client)

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
    // THE FULL URL, not just the grant type. Meta documents this endpoint at
    // the Graph ROOT; it went through graphRequest at first, which prefixes
    // /v25.0, and nothing recorded the difference (found in code review).
    expect(url).toBe('https://graph.instagram.com/refresh_access_token?grant_type=ig_refresh_token')
    expect(url).not.toContain('/v25.0/')
    expect(url).not.toContain(OLD_TOKEN)
    expect((init.headers as Record<string, string>).authorization).toBe(`Bearer ${OLD_TOKEN}`)
  })

  it('falls back to 60 days when Meta omits expires_in, never to a past expiry', async () => {
    const { client, queries } = queryRecorder({
      instagram_credentials: [{ data: [row()], error: null }, { data: null, error: null }],
    })
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ access_token: NEW_TOKEN }), { status: 200 }),
    )
    await processInstagramTokenRefresh(NOW, { fetch: fetchImpl, now: () => NOW }, client)

    const [[patch]] = callsNamed(queries[1], 'update') as [[Record<string, unknown>]]
    expect(new Date(String(patch.token_expires_at))).toEqual(
      new Date(NOW.getTime() + INSTAGRAM_LONG_LIVED_TOKEN_MS),
    )
  })

  // TAC-460 AC5. Meta refuses a token under 24 hours old, so trying wastes
  // the attempt and logs a refusal that means nothing.
  it('skips a token younger than 24 hours without calling Meta', async () => {
    const { client } = queryRecorder({
      instagram_credentials: [
        {
          data: [
            row({ connected_at: new Date(NOW.getTime() - (INSTAGRAM_TOKEN_MIN_AGE_MS - 1000)).toISOString() }),
          ],
          error: null,
        },
      ],
    })
    const fetchImpl = metaOk()
    const summary = await processInstagramTokenRefresh(NOW, { fetch: fetchImpl, now: () => NOW }, client)

    expect(summary).toMatchObject({ scanned: 1, skippedTooYoung: 1, refreshed: 0 })
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('refreshes a token that has just crossed 24 hours old', async () => {
    const { client } = queryRecorder({
      instagram_credentials: [
        {
          data: [row({ connected_at: new Date(NOW.getTime() - INSTAGRAM_TOKEN_MIN_AGE_MS).toISOString() })],
          error: null,
        },
        { data: null, error: null },
      ],
    })
    const summary = await processInstagramTokenRefresh(NOW, { fetch: metaOk(), now: () => NOW }, client)
    expect(summary).toMatchObject({ refreshed: 1, skippedTooYoung: 0 })
  })

  // THE UNRECOVERABLE ONE. Meta cannot refresh an expired token at any price,
  // so this alerts under its OWN event: the action it needs is a human
  // reconnecting, not another retry.
  it('reports an already-expired token distinctly and never tries to refresh it', async () => {
    const { client } = queryRecorder({
      instagram_credentials: [
        { data: [row({ token_expires_at: new Date(NOW.getTime() - DAY).toISOString() })], error: null },
        { data: null, error: null },
      ],
    })
    const fetchImpl = metaOk()
    const summary = await processInstagramTokenRefresh(NOW, { fetch: fetchImpl, now: () => NOW }, client)

    expect(summary).toMatchObject({ expiredUnrecoverable: 1, refreshed: 0, failed: 0 })
    expect(fetchImpl).not.toHaveBeenCalled()
    expect(captureInstagramTokenExpiredUnrecoverable).toHaveBeenCalledWith(
      expect.objectContaining({ venueId: VENUE_ID }),
    )
    expect(captureInstagramTokenRefreshFailed).not.toHaveBeenCalled()
  })

  // The old token still works until it actually expires, and this runs daily
  // against a ten-day margin, so there are many more attempts. Clearing it
  // would create the outage the job exists to prevent.
  it('leaves the stored token in place when Meta refuses, and records why', async () => {
    const { client, queries } = queryRecorder({
      instagram_credentials: [{ data: [row()], error: null }, { data: null, error: null }],
    })
    const summary = await processInstagramTokenRefresh(NOW, { fetch: metaRefuses(), now: () => NOW }, client)

    expect(summary).toMatchObject({ failed: 1, refreshed: 0 })
    const [[patch]] = callsNamed(queries[1], 'update') as [[Record<string, unknown>]]
    // Only the error columns move. The token is untouched.
    expect(Object.keys(patch).sort()).toEqual(['last_refresh_error', 'last_refresh_error_at'])
    expect(String(patch.last_refresh_error)).toContain('code 190')
    expect(captureInstagramTokenRefreshFailed).toHaveBeenCalledWith(
      expect.objectContaining({ venueId: VENUE_ID }),
    )
  })

  // graph.ts drops Meta's error MESSAGE because it quotes the object it failed
  // on. Here that object is the token itself.
  it('never lets Meta\'s error message, or the token, reach the recorded reason or a log', async () => {
    const { client, queries } = queryRecorder({
      instagram_credentials: [{ data: [row()], error: null }, { data: null, error: null }],
    })
    await processInstagramTokenRefresh(NOW, { fetch: metaRefuses(), now: () => NOW }, client)

    const [[patch]] = callsNamed(queries[1], 'update') as [[Record<string, unknown>]]
    expect(String(patch.last_refresh_error)).not.toContain(OLD_TOKEN)
    expect(String(patch.last_refresh_error)).not.toContain('Error validating access token')
    expect(loggedText()).not.toContain(OLD_TOKEN)
  })

  it('counts an undecryptable stored token as an error, and does not call Meta', async () => {
    const { client } = queryRecorder({
      instagram_credentials: [
        { data: [row({ access_token_enc: 'not.valid.ciphertext' })], error: null },
        { data: null, error: null },
      ],
    })
    const fetchImpl = metaOk()
    const summary = await processInstagramTokenRefresh(NOW, { fetch: fetchImpl, now: () => NOW }, client)

    expect(summary).toMatchObject({ errored: 1, refreshed: 0, failed: 0 })
    expect(fetchImpl).not.toHaveBeenCalled()
    expect(captureInstagramTokenRefreshFailed).toHaveBeenCalled()
  })

  // Recoverable: the stored token still works, and the next tick refreshes
  // from it again. Counted as an error rather than a refusal because Meta did
  // its part.
  it('alerts when a refresh succeeded at Meta but could not be stored', async () => {
    const { client } = queryRecorder({
      instagram_credentials: [
        { data: [row()], error: null },
        { data: null, error: { message: 'write conflict' } },
      ],
    })
    const summary = await processInstagramTokenRefresh(NOW, { fetch: metaOk(), now: () => NOW }, client)

    expect(summary).toMatchObject({ errored: 1, refreshed: 0 })
    const [call] = vi.mocked(captureInstagramTokenRefreshFailed).mock.calls
    expect(String(call[0].reason)).toContain('could not store')
  })

  it('keeps going when one venue fails, so one bad row cannot cost the fleet its refresh', async () => {
    const { client } = queryRecorder({
      instagram_credentials: [
        {
          data: [
            row({ venue_id: 'venue-broken', access_token_enc: 'not.valid.ciphertext' }),
            row({ venue_id: 'venue-fine' }),
          ],
          error: null,
        },
        { data: null, error: null },
        { data: null, error: null },
      ],
    })
    const summary = await processInstagramTokenRefresh(NOW, { fetch: metaOk(), now: () => NOW }, client)
    expect(summary).toMatchObject({ scanned: 2, errored: 1, refreshed: 1 })
  })

  it('returns an empty summary when the scan itself fails', async () => {
    const { client } = queryRecorder({
      instagram_credentials: [{ data: null, error: { message: 'connection reset' } }],
    })
    const summary = await processInstagramTokenRefresh(NOW, { fetch: metaOk(), now: () => NOW }, client)
    expect(summary).toEqual({
      scanned: 0,
      refreshed: 0,
      skippedTooYoung: 0,
      expiredUnrecoverable: 0,
      failed: 0,
      errored: 0,
    })
  })
})
