import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import {
  deauthorizeInstagramCredential,
  loadInstagramCredential,
  readInstagramAccessToken,
  resolveInstagramAccessToken,
  upsertInstagramCredential,
} from './credentials-store'
import { callsNamed, queryRecorder } from './testing/query-recorder'
import { decryptInstagramToken, encryptInstagramToken } from './token-crypto'

const PREV_KEY = process.env.INSTAGRAM_TOKEN_ENC_KEY
beforeAll(() => {
  process.env.INSTAGRAM_TOKEN_ENC_KEY = Buffer.alloc(32, 5).toString('base64')
})
afterAll(() => {
  process.env.INSTAGRAM_TOKEN_ENC_KEY = PREV_KEY
})

const VENUE_ID = '11111111-1111-4111-8111-111111111111'
const VENUE_TOKEN = 'IGAAvenue000000000000000000000000000000000000000'
const ENV_TOKEN = 'IGAAenv00000000000000000000000000000000000000000'

function credentialRow(overrides: Record<string, unknown> = {}) {
  return {
    venue_id: VENUE_ID,
    instagram_username: 'lemilscoffee',
    access_token_enc: encryptInstagramToken(VENUE_TOKEN),
    token_expires_at: '2026-11-21T00:00:00.000Z',
    connected_at: '2026-09-22T00:00:00.000Z',
    last_refreshed_at: null,
    is_active: true,
    deauthorized_at: null,
    ...overrides,
  }
}

const envReader = (token: string | null) => () => token

describe('loadInstagramCredential', () => {
  // The filter is the correctness here: a query scoped to the wrong column
  // would hand one venue another venue's credential.
  it('reads the venue its caller named, and nothing else', async () => {
    const { client, queries } = queryRecorder({
      instagram_credentials: [{ data: credentialRow(), error: null }],
    })
    const result = await loadInstagramCredential(client, VENUE_ID)
    expect(result).toMatchObject({ ok: true })

    expect(queries).toHaveLength(1)
    expect(queries[0].table).toBe('instagram_credentials')
    expect(callsNamed(queries[0], 'eq')).toEqual([['venue_id', VENUE_ID]])
    expect(callsNamed(queries[0], 'maybeSingle')).toHaveLength(1)
  })

  it('selects every column the readers need', async () => {
    const { client, queries } = queryRecorder({
      instagram_credentials: [{ data: credentialRow(), error: null }],
    })
    await loadInstagramCredential(client, VENUE_ID)
    const selected = String(callsNamed(queries[0], 'select')[0][0])
    for (const column of [
      'venue_id',
      'instagram_username',
      'access_token_enc',
      'token_expires_at',
      'connected_at',
      'last_refreshed_at',
      'is_active',
      'deauthorized_at',
    ]) {
      expect(selected).toContain(column)
    }
  })

  it('returns null for a venue that has never connected', async () => {
    const { client } = queryRecorder({ instagram_credentials: [{ data: null, error: null }] })
    expect(await loadInstagramCredential(client, VENUE_ID)).toEqual({ ok: true, credential: null })
  })

  // Deauthorized is NOT absent: the operator endpoint has to tell
  // "disconnected after being connected" from "never connected".
  it('still returns a deauthorized row, marked inactive', async () => {
    const { client } = queryRecorder({
      instagram_credentials: [
        {
          data: credentialRow({ is_active: false, deauthorized_at: '2026-10-01T00:00:00.000Z' }),
          error: null,
        },
      ],
    })
    const result = await loadInstagramCredential(client, VENUE_ID)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.credential?.isActive).toBe(false)
    expect(result.credential?.deauthorizedAt).toEqual(new Date('2026-10-01T00:00:00.000Z'))
  })

  it('refuses a row whose NOT NULL timestamps are unreadable rather than guessing', async () => {
    const { client } = queryRecorder({
      instagram_credentials: [{ data: credentialRow({ token_expires_at: 'not-a-date' }), error: null }],
    })
    expect(await loadInstagramCredential(client, VENUE_ID)).toMatchObject({ ok: false })
  })

  it('reports a read failure as a failure, never as "no credential"', async () => {
    const { client } = queryRecorder({
      instagram_credentials: [{ data: null, error: { message: 'connection reset' } }],
    })
    expect(await loadInstagramCredential(client, VENUE_ID)).toEqual({
      ok: false,
      error: 'connection reset',
    })
  })
})

describe('resolveInstagramAccessToken', () => {
  it("uses the venue's own token when it has one", async () => {
    const { client } = queryRecorder({
      instagram_credentials: [{ data: credentialRow(), error: null }],
    })
    const result = await resolveInstagramAccessToken(client, VENUE_ID, envReader(ENV_TOKEN))
    expect(result).toEqual({
      ok: true,
      resolved: {
        token: VENUE_TOKEN,
        source: 'venue',
        expiresAt: new Date('2026-11-21T00:00:00.000Z'),
      },
    })
  })

  // THE CUTOVER GUARANTEE: a venue with no row behaves exactly as it did
  // before TAC-516. If this test fails, deploying this ticket changes
  // behaviour for every venue on the day it lands.
  it('falls back to the env token for a venue that has never connected', async () => {
    const { client } = queryRecorder({ instagram_credentials: [{ data: null, error: null }] })
    expect(await resolveInstagramAccessToken(client, VENUE_ID, envReader(ENV_TOKEN))).toEqual({
      ok: true,
      resolved: { token: ENV_TOKEN, source: 'env', expiresAt: null },
    })
  })

  it('falls back to the env token for a deauthorized venue', async () => {
    const { client } = queryRecorder({
      instagram_credentials: [{ data: credentialRow({ is_active: false }), error: null }],
    })
    const result = await resolveInstagramAccessToken(client, VENUE_ID, envReader(ENV_TOKEN))
    expect(result).toMatchObject({ ok: true, resolved: { source: 'env' } })
  })

  // An expired token is a TRUE token that Meta will reject with code 190,
  // which is a specific signal. Refusing here would report `token_missing`,
  // which says something false.
  it('returns an expired venue token rather than reporting none', async () => {
    const { client } = queryRecorder({
      instagram_credentials: [
        { data: credentialRow({ token_expires_at: '2020-01-01T00:00:00.000Z' }), error: null },
      ],
    })
    const result = await resolveInstagramAccessToken(client, VENUE_ID, envReader(ENV_TOKEN))
    expect(result).toMatchObject({ ok: true, resolved: { token: VENUE_TOKEN, source: 'venue' } })
  })

  // The sharp one. A connected venue whose token cannot be decrypted must
  // NEVER borrow the shared env token: venues.instagram_account_id already
  // points at that venue's own account, so the env token belongs to a
  // different account and Meta would reject it as a mystery.
  it('fails hard when a connected venue token cannot be decrypted, never falling back', async () => {
    const { client } = queryRecorder({
      instagram_credentials: [
        { data: credentialRow({ access_token_enc: 'garbage.not.valid' }), error: null },
      ],
    })
    const result = await resolveInstagramAccessToken(client, VENUE_ID, envReader(ENV_TOKEN))
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toMatch(/could not decrypt/)
    expect(result.error).not.toContain(ENV_TOKEN)
    expect(result.error).not.toContain(VENUE_TOKEN)
  })

  it('resolves nothing when there is neither a credential nor an env token', async () => {
    const { client } = queryRecorder({ instagram_credentials: [{ data: null, error: null }] })
    expect(await resolveInstagramAccessToken(client, VENUE_ID, envReader(null))).toEqual({
      ok: true,
      resolved: null,
    })
  })

  it('passes a read failure through rather than silently using the env token', async () => {
    const { client } = queryRecorder({
      instagram_credentials: [{ data: null, error: { message: 'timeout' } }],
    })
    expect(await resolveInstagramAccessToken(client, VENUE_ID, envReader(ENV_TOKEN))).toEqual({
      ok: false,
      error: 'timeout',
    })
  })
})

describe('upsertInstagramCredential', () => {
  it('stores the token encrypted, keyed on venue_id, and never in plaintext', async () => {
    const { client, queries } = queryRecorder({
      instagram_credentials: [{ data: null, error: null }],
    })
    const result = await upsertInstagramCredential(client, {
      venueId: VENUE_ID,
      accessToken: VENUE_TOKEN,
      tokenExpiresAt: new Date('2026-11-21T00:00:00.000Z'),
      instagramUsername: 'lemilscoffee',
      connectedByOperatorId: '22222222-2222-4222-8222-222222222222',
      now: new Date('2026-09-22T00:00:00.000Z'),
    })
    expect(result).toEqual({ ok: true })

    const [[row, options]] = callsNamed(queries[0], 'upsert') as [
      [Record<string, unknown>, Record<string, unknown>],
    ]
    expect(options).toEqual({ onConflict: 'venue_id' })
    expect(row.venue_id).toBe(VENUE_ID)
    expect(row.instagram_username).toBe('lemilscoffee')
    // The whole point of the column: what is written is ciphertext, and it
    // round-trips back to the token we were handed.
    expect(JSON.stringify(row)).not.toContain(VENUE_TOKEN)
    expect(decryptInstagramToken(String(row.access_token_enc))).toBe(VENUE_TOKEN)
  })

  // A reconnect is a brand new token. Carrying the previous token's failure
  // onto it would show an operator a stale error about a credential that no
  // longer exists.
  it('clears the previous deauthorization and refresh errors on reconnect', async () => {
    const { client, queries } = queryRecorder({
      instagram_credentials: [{ data: null, error: null }],
    })
    await upsertInstagramCredential(client, {
      venueId: VENUE_ID,
      accessToken: VENUE_TOKEN,
      tokenExpiresAt: new Date('2026-11-21T00:00:00.000Z'),
      instagramUsername: null,
      connectedByOperatorId: null,
      now: new Date('2026-09-22T00:00:00.000Z'),
    })
    const [[row]] = callsNamed(queries[0], 'upsert') as [[Record<string, unknown>]]
    expect(row).toMatchObject({
      is_active: true,
      deauthorized_at: null,
      last_refreshed_at: null,
      last_refresh_error: null,
      last_refresh_error_at: null,
    })
  })

  it('reports a write failure without leaking the token', async () => {
    const { client } = queryRecorder({
      instagram_credentials: [{ data: null, error: { message: 'unique violation', code: '23505' } }],
    })
    const result = await upsertInstagramCredential(client, {
      venueId: VENUE_ID,
      accessToken: VENUE_TOKEN,
      tokenExpiresAt: new Date('2026-11-21T00:00:00.000Z'),
      instagramUsername: null,
      connectedByOperatorId: null,
      now: new Date(),
    })
    expect(result).toEqual({ ok: false, error: 'unique violation' })
  })

  it('reports a missing encryption key without writing anything', async () => {
    const prev = process.env.INSTAGRAM_TOKEN_ENC_KEY
    delete process.env.INSTAGRAM_TOKEN_ENC_KEY
    try {
      // No scripted answer: if it tried to write, the recorder would throw.
      const { client, queries } = queryRecorder({ instagram_credentials: [] })
      const result = await upsertInstagramCredential(client, {
        venueId: VENUE_ID,
        accessToken: VENUE_TOKEN,
        tokenExpiresAt: new Date('2026-11-21T00:00:00.000Z'),
        instagramUsername: null,
        connectedByOperatorId: null,
        now: new Date(),
      })
      expect(result).toMatchObject({ ok: false })
      if (!result.ok) expect(result.error).toMatch(/INSTAGRAM_TOKEN_ENC_KEY/)
      expect(queries).toHaveLength(0)
    } finally {
      process.env.INSTAGRAM_TOKEN_ENC_KEY = prev
    }
  })
})

describe('readInstagramAccessToken', () => {
  it('trims, and treats blank as absent', () => {
    expect(readInstagramAccessToken({ INSTAGRAM_ACCESS_TOKEN: ' abc ' } as unknown as NodeJS.ProcessEnv)).toBe('abc')
    expect(readInstagramAccessToken({ INSTAGRAM_ACCESS_TOKEN: '  ' } as unknown as NodeJS.ProcessEnv)).toBeNull()
    expect(readInstagramAccessToken({} as unknown as NodeJS.ProcessEnv)).toBeNull()
  })
})

describe('deauthorizeInstagramCredential', () => {
  it('marks the credential inactive and frees the account id', async () => {
    const { client, queries } = queryRecorder({
      venues: [{ data: { id: VENUE_ID }, error: null }, { data: null, error: null }],
      instagram_credentials: [{ data: null, error: null }],
    })
    const now = new Date('2026-10-01T12:00:00.000Z')
    expect(await deauthorizeInstagramCredential(client, 'acct-1', now)).toEqual({
      ok: true,
      venueId: VENUE_ID,
    })

    const credentialUpdate = queries.find((q) => q.table === 'instagram_credentials')!
    const [[patch]] = callsNamed(credentialUpdate, 'update') as [[Record<string, unknown>]]
    expect(patch).toEqual({ is_active: false, deauthorized_at: now.toISOString() })

    // Clearing the account id is what frees it to be connected again.
    const venueUpdate = queries.filter((q) => q.table === 'venues')[1]
    const [[venuePatch]] = callsNamed(venueUpdate, 'update') as [[Record<string, unknown>]]
    expect(venuePatch).toEqual({ instagram_account_id: null })
  })

  // Revocation stops future traffic. What to do with past data is the
  // deletion callback's question, with its own ruling.
  it('touches no table but venues and instagram_credentials', async () => {
    const { client, queries } = queryRecorder({
      venues: [{ data: { id: VENUE_ID }, error: null }, { data: null, error: null }],
      instagram_credentials: [{ data: null, error: null }],
    })
    await deauthorizeInstagramCredential(client, 'acct-1', new Date())
    expect(new Set(queries.map((q) => q.table))).toEqual(new Set(['venues', 'instagram_credentials']))
  })

  // Meta can send this for an account we never finished connecting, or one
  // already disconnected. Not an error.
  it('is a no-op for an account no venue owns', async () => {
    const { client, queries } = queryRecorder({ venues: [{ data: null, error: null }] })
    expect(await deauthorizeInstagramCredential(client, 'unknown', new Date())).toEqual({
      ok: true,
      venueId: null,
    })
    expect(queries).toHaveLength(1)
  })

  it('reports a lookup or write failure rather than claiming success', async () => {
    const lookupFailed = queryRecorder({ venues: [{ data: null, error: { message: 'timeout' } }] })
    expect(await deauthorizeInstagramCredential(lookupFailed.client, 'acct-1', new Date())).toEqual({
      ok: false,
      error: 'timeout',
    })

    const writeFailed = queryRecorder({
      venues: [{ data: { id: VENUE_ID }, error: null }],
      instagram_credentials: [{ data: null, error: { message: 'write conflict' } }],
    })
    expect(await deauthorizeInstagramCredential(writeFailed.client, 'acct-1', new Date())).toEqual({
      ok: false,
      error: 'write conflict',
    })
  })
})
