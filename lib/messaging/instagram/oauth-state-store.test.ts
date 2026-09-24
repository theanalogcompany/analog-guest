// TAC-516: the REPLAY refusal, which is the one the signature cannot make.
//
// These assert on the query the claim sends, not on a fake's opinion of it. A
// claim missing any one of its three predicates still "works" against a
// cooperative stub while being wrong in production, which is exactly the trap
// query-recorder exists for.

import { describe, expect, it } from 'vitest'

import {
  INSTAGRAM_OAUTH_STATE_TTL_MS,
  claimInstagramOAuthState,
  issueInstagramOAuthState,
} from './oauth-state-store'
import { callsNamed, queryRecorder } from './testing/query-recorder'

const NOW = new Date('2026-10-01T12:00:00.000Z')
const NONCE = 'nonce-abc'
const VENUE_ID = 'venue-1'
const OPERATOR_ID = 'operator-1'

describe('INSTAGRAM_OAUTH_STATE_TTL_MS', () => {
  // Pinned so shortening it past usefulness, or widening it to hours, is a
  // deliberate act that has to delete a test saying why not.
  it('gives an operator ten minutes to get through Meta\'s screen', () => {
    expect(INSTAGRAM_OAUTH_STATE_TTL_MS).toBe(10 * 60 * 1000)
  })
})

describe('issueInstagramOAuthState', () => {
  it('records the nonce against the venue and operator that started the flow', async () => {
    const { client, queries } = queryRecorder({ instagram_oauth_states: [{ data: null, error: null }] })
    const expiresAt = new Date(NOW.getTime() + INSTAGRAM_OAUTH_STATE_TTL_MS)
    expect(
      await issueInstagramOAuthState(client, { nonce: NONCE, venueId: VENUE_ID, operatorId: OPERATOR_ID, expiresAt }),
    ).toEqual({ ok: true })

    const [[row]] = callsNamed(queries[0], 'insert') as [[Record<string, unknown>]]
    expect(row).toEqual({
      state_nonce: NONCE,
      venue_id: VENUE_ID,
      operator_id: OPERATOR_ID,
      expires_at: expiresAt.toISOString(),
    })
  })

  it('reports a write failure rather than pretending the state was issued', async () => {
    const { client } = queryRecorder({
      instagram_oauth_states: [{ data: null, error: { message: 'duplicate key' } }],
    })
    expect(
      await issueInstagramOAuthState(client, {
        nonce: NONCE,
        venueId: VENUE_ID,
        operatorId: OPERATOR_ID,
        expiresAt: NOW,
      }),
    ).toEqual({ ok: false, error: 'duplicate key' })
  })
})

describe('claimInstagramOAuthState', () => {
  // ALL THREE PREDICATES ARE THE MECHANISM. Without consumed_at IS NULL a
  // replay succeeds; without the expiry a stale state succeeds; without the
  // nonce it claims somebody else's. A test that only checked the return
  // value would pass with any of them removed.
  it('claims by nonce, only while unconsumed and unexpired, in one UPDATE', async () => {
    const { client, queries } = queryRecorder({
      instagram_oauth_states: [
        { data: [{ venue_id: VENUE_ID, operator_id: OPERATOR_ID }], error: null },
      ],
    })
    const result = await claimInstagramOAuthState(client, NONCE, NOW)
    expect(result).toEqual({ ok: true, venueId: VENUE_ID, operatorId: OPERATOR_ID })

    const query = queries[0]
    const [[patch]] = callsNamed(query, 'update') as [[Record<string, unknown>]]
    expect(patch).toEqual({ consumed_at: NOW.toISOString() })
    expect(callsNamed(query, 'eq')).toEqual([['state_nonce', NONCE]])
    expect(callsNamed(query, 'is')).toEqual([['consumed_at', null]])
    expect(callsNamed(query, 'gt')).toEqual([['expires_at', NOW.toISOString()]])
  })

  // THE REPLAY. The second presentation of a correctly-signed, unexpired
  // state matches no row, because the first one consumed it.
  it('refuses a second claim of the same nonce', async () => {
    const { client } = queryRecorder({
      instagram_oauth_states: [
        { data: [{ venue_id: VENUE_ID, operator_id: OPERATOR_ID }], error: null },
        { data: [], error: null },
      ],
    })
    expect((await claimInstagramOAuthState(client, NONCE, NOW)).ok).toBe(true)
    expect(await claimInstagramOAuthState(client, NONCE, NOW)).toEqual({
      ok: false,
      reason: 'unclaimable',
    })
  })

  // Not found, already consumed and expired-in-the-database are ONE outcome:
  // the callback page must not tell an unauthenticated caller which, and no
  // branch would behave differently.
  it('reports an unknown, consumed or expired nonce identically', async () => {
    const { client } = queryRecorder({
      instagram_oauth_states: [{ data: [], error: null }, { data: null, error: null }],
    })
    expect(await claimInstagramOAuthState(client, 'unknown', NOW)).toEqual({
      ok: false,
      reason: 'unclaimable',
    })
    expect(await claimInstagramOAuthState(client, 'also-unknown', NOW)).toEqual({
      ok: false,
      reason: 'unclaimable',
    })
  })

  // Two rows can never come back (state_nonce is UNIQUE), but if they did,
  // claiming is ambiguous and refusing beats picking one.
  it('refuses rather than choosing when more than one row somehow matches', async () => {
    const { client } = queryRecorder({
      instagram_oauth_states: [
        {
          data: [
            { venue_id: VENUE_ID, operator_id: OPERATOR_ID },
            { venue_id: 'venue-2', operator_id: OPERATOR_ID },
          ],
          error: null,
        },
      ],
    })
    expect(await claimInstagramOAuthState(client, NONCE, NOW)).toEqual({
      ok: false,
      reason: 'unclaimable',
    })
  })

  // A database failure is NOT a replay. Collapsing them would report a blip
  // as "this state was already used", which is a false and confusing answer.
  it('separates a database failure from an unclaimable state', async () => {
    const { client } = queryRecorder({
      instagram_oauth_states: [{ data: null, error: { message: 'connection reset' } }],
    })
    expect(await claimInstagramOAuthState(client, NONCE, NOW)).toEqual({
      ok: false,
      reason: 'error',
      error: 'connection reset',
    })
  })

  it('returns the venue and operator the state was ISSUED for, not what a caller claims', async () => {
    const { client } = queryRecorder({
      instagram_oauth_states: [
        { data: [{ venue_id: 'venue-issued', operator_id: 'operator-issued' }], error: null },
      ],
    })
    expect(await claimInstagramOAuthState(client, NONCE, NOW)).toEqual({
      ok: true,
      venueId: 'venue-issued',
      operatorId: 'operator-issued',
    })
  })
})
