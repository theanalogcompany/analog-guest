// TAC-516: venue connection state.
//
// The expectations are transcribed from the ticket's `## Contract`, not read
// back out of the implementation: this is cross-repo surface and TAC-517
// builds against the same text.

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { queryRecorder } from '@/lib/messaging/instagram/testing/query-recorder'

import { INSTAGRAM_EXPIRING_WINDOW_MS, loadVenueConnectionState } from './venue-connection'

const PREV_KEY = process.env.INSTAGRAM_TOKEN_ENC_KEY
beforeAll(() => {
  process.env.INSTAGRAM_TOKEN_ENC_KEY = Buffer.alloc(32, 2).toString('base64')
})
afterAll(() => {
  process.env.INSTAGRAM_TOKEN_ENC_KEY = PREV_KEY
})

const NOW = new Date('2026-10-01T12:00:00.000Z')
const DAY = 24 * 60 * 60 * 1000
const VENUE_ID = 'venue-1'

function credential(overrides: Record<string, unknown> = {}) {
  return {
    venue_id: VENUE_ID,
    instagram_username: 'lemilscoffee',
    access_token_enc: 'iv.tag.ct',
    token_expires_at: new Date(NOW.getTime() + 30 * DAY).toISOString(),
    connected_at: new Date(NOW.getTime() - 30 * DAY).toISOString(),
    last_refreshed_at: null,
    is_active: true,
    deauthorized_at: null,
    ...overrides,
  }
}

function load(row: unknown, accountId: string | null = '17841479626987104') {
  const { client } = queryRecorder({
    instagram_credentials: [{ data: row, error: null }],
    venues: [{ data: { instagram_account_id: accountId }, error: null }],
  })
  return loadVenueConnectionState(client, VENUE_ID, NOW)
}

describe('INSTAGRAM_EXPIRING_WINDOW_MS', () => {
  // The Contract's literal threshold. Pinned because TAC-517 renders a
  // different state on either side of it.
  it('is 7 days, the Contract\'s threshold, not the 10-day refresh window', () => {
    expect(INSTAGRAM_EXPIRING_WINDOW_MS).toBe(7 * DAY)
  })
})

describe('loadVenueConnectionState', () => {
  it('reports a healthy connection in the Contract shape', async () => {
    const result = await load(credential())
    expect(result).toEqual({
      ok: true,
      state: {
        instagram: {
          status: 'connected',
          username: 'lemilscoffee',
          expiresAt: new Date(NOW.getTime() + 30 * DAY).toISOString(),
        },
      },
    })
  })

  // "Always present, never undefined" is the Contract's own wording, and it
  // is what lets the client parse without branching on presence.
  it('always carries all three fields, even when nothing is connected', async () => {
    const result = await load(null)
    expect(result).toEqual({
      ok: true,
      state: { instagram: { status: 'disconnected', username: null, expiresAt: null } },
    })
    if (!result.ok) return
    expect(Object.keys(result.state.instagram).sort()).toEqual(['expiresAt', 'status', 'username'])
  })

  it.each([
    ['8 days out', 8 * DAY, 'connected'],
    ['exactly 7 days out', 7 * DAY, 'connected'],
    ['just under 7 days', 7 * DAY - 1000, 'expiring'],
    ['1 day out', DAY, 'expiring'],
  ])('reports a token %s as %s', async (_label, remaining, status) => {
    const result = await load(
      credential({ token_expires_at: new Date(NOW.getTime() + remaining).toISOString() }),
    )
    expect(result).toMatchObject({ ok: true, state: { instagram: { status } } })
  })

  // Not a fourth status: the Contract has three, and the operator's action is
  // the same as for expiring.
  it('reports an already-expired token as expiring rather than inventing a status', async () => {
    const result = await load(
      credential({ token_expires_at: new Date(NOW.getTime() - DAY).toISOString() }),
    )
    expect(result).toMatchObject({ ok: true, state: { instagram: { status: 'expiring' } } })
  })

  it.each([
    ['deauthorized', { deauthorized_at: new Date(NOW.getTime() - DAY).toISOString() }],
    ['inactive', { is_active: false }],
  ])('reports a %s venue as disconnected, with nulls', async (_label, overrides) => {
    const result = await load(credential(overrides))
    expect(result).toEqual({
      ok: true,
      state: { instagram: { status: 'disconnected', username: null, expiresAt: null } },
    })
  })

  it('carries a missing handle through as null without changing the status', async () => {
    const result = await load(credential({ instagram_username: null }))
    expect(result).toMatchObject({
      ok: true,
      state: { instagram: { status: 'connected', username: null } },
    })
  })

  // A failed read must NOT report "disconnected": that would tell an operator
  // their Instagram is down when it is working, and send them to reconnect a
  // connection that is fine.
  // A credential with no venue pointer is a venue that CANNOT send: the
  // callback writes the credential first, so any failure on the pointer write
  // leaves exactly this. Reporting `connected` told an operator their
  // Instagram worked while every send refused (found in code review).
  it('reports disconnected when the venue has a credential but no account pointer', async () => {
    const result = await load(credential(), null)
    expect(result).toEqual({
      ok: true,
      state: { instagram: { status: 'disconnected', username: null, expiresAt: null } },
    })
  })

  it('treats a blank account pointer the same as a missing one', async () => {
    expect(await load(credential(), '   ')).toMatchObject({
      ok: true,
      state: { instagram: { status: 'disconnected' } },
    })
  })

  it('reports a read failure as a failure, never as disconnected', async () => {
    const { client } = queryRecorder({
      instagram_credentials: [{ data: null, error: { message: 'timeout' } }],
      venues: [{ data: { instagram_account_id: 'acct' }, error: null }],
    })
    expect(await loadVenueConnectionState(client, VENUE_ID, NOW)).toEqual({
      ok: false,
      error: 'timeout',
    })
  })

  it('reports a failed venue read as a failure too', async () => {
    const { client } = queryRecorder({
      instagram_credentials: [{ data: credential(), error: null }],
      venues: [{ data: null, error: { message: 'venue timeout' } }],
    })
    expect(await loadVenueConnectionState(client, VENUE_ID, NOW)).toEqual({
      ok: false,
      error: 'venue timeout',
    })
  })

  // The token is in the row this reads. It must never reach a payload the
  // operator app receives.
  it('never carries the stored ciphertext into the state', async () => {
    const result = await load(credential({ access_token_enc: 'iv.tag.SECRETCIPHERTEXT' }))
    expect(JSON.stringify(result)).not.toContain('SECRETCIPHERTEXT')
  })
})
