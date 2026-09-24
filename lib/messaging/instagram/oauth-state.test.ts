// TAC-516: the three refusals the acceptance criteria name — unverified,
// expired, replayed — split across the two halves that can actually catch
// them. This file covers the first two. The third is oauth-state-store's,
// because a signature structurally cannot catch a replay.

import { createHmac } from 'node:crypto'

import { describe, expect, it } from 'vitest'

import {
  deriveInstagramStateSigningKey,
  signInstagramOAuthState,
  verifyInstagramOAuthState,
  type InstagramOAuthStatePayload,
} from './oauth-state'

const KEY = deriveInstagramStateSigningKey(Buffer.alloc(32, 4).toString('base64'))
const OTHER_KEY = deriveInstagramStateSigningKey(Buffer.alloc(32, 9).toString('base64'))
const NOW = new Date('2026-10-01T12:00:00.000Z')

const PAYLOAD: InstagramOAuthStatePayload = {
  venueId: 'venue-1',
  operatorId: 'operator-1',
  nonce: 'nonce-abc',
  expiresAtMs: NOW.getTime() + 10 * 60 * 1000,
}

describe('deriveInstagramStateSigningKey', () => {
  it('is deterministic, so a state signed before a deploy verifies after it', () => {
    const raw = Buffer.alloc(32, 4).toString('base64')
    expect(deriveInstagramStateSigningKey(raw)).toEqual(deriveInstagramStateSigningKey(raw))
  })

  // Key separation: the signing key must not BE the encryption key, or one
  // key is doing two cryptographic jobs.
  it('is not the encryption key it came from', () => {
    const raw = Buffer.alloc(32, 4).toString('base64')
    expect(deriveInstagramStateSigningKey(raw).toString('base64')).not.toBe(raw)
  })

  it('differs for different encryption keys', () => {
    expect(KEY).not.toEqual(OTHER_KEY)
  })
})

describe('verifyInstagramOAuthState', () => {
  it('round-trips a state it signed', () => {
    const state = signInstagramOAuthState(PAYLOAD, KEY)
    expect(verifyInstagramOAuthState(state, KEY, NOW)).toEqual({ ok: true, payload: PAYLOAD })
  })

  it('carries the venue and operator through unchanged', () => {
    const state = signInstagramOAuthState(PAYLOAD, KEY)
    const result = verifyInstagramOAuthState(state, KEY, NOW)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.payload.venueId).toBe('venue-1')
    expect(result.payload.operatorId).toBe('operator-1')
    expect(result.payload.nonce).toBe('nonce-abc')
  })

  // TAMPERED. The HMAC covers the whole payload, so no field can move.
  it.each([
    ['venueId', { ...PAYLOAD, venueId: 'venue-2' }],
    ['operatorId', { ...PAYLOAD, operatorId: 'operator-2' }],
    ['nonce', { ...PAYLOAD, nonce: 'nonce-other' }],
    ['a later expiry', { ...PAYLOAD, expiresAtMs: PAYLOAD.expiresAtMs + 60 * 60 * 1000 }],
  ])('refuses a payload with a swapped %s', (_label, swapped) => {
    const forged = Buffer.from(JSON.stringify(swapped), 'utf8').toString('base64url')
    const original = signInstagramOAuthState(PAYLOAD, KEY)
    const signature = original.split('.')[1]
    expect(verifyInstagramOAuthState(`${forged}.${signature}`, KEY, NOW)).toEqual({
      ok: false,
      reason: 'tampered',
    })
  })

  it('refuses a state signed with a different key', () => {
    const state = signInstagramOAuthState(PAYLOAD, OTHER_KEY)
    expect(verifyInstagramOAuthState(state, KEY, NOW)).toEqual({ ok: false, reason: 'tampered' })
  })

  it.each([
    ['empty', ''],
    ['no separator', 'abcdef'],
    ['too many parts', 'a.b.c'],
    ['an empty payload half', '.signature'],
    ['an empty signature half', 'payload.'],
  ])('refuses a %s state as malformed', (_label, state) => {
    expect(verifyInstagramOAuthState(state, KEY, NOW)).toEqual({ ok: false, reason: 'malformed' })
  })

  // EXPIRED. The deadline is inside the signature, so it cannot be extended
  // without breaking it — which is why the tampered case above covers the
  // attack and this one only covers honest lateness.
  it('refuses a state past its expiry', () => {
    const state = signInstagramOAuthState(PAYLOAD, KEY)
    const later = new Date(PAYLOAD.expiresAtMs + 1)
    expect(verifyInstagramOAuthState(state, KEY, later)).toEqual({ ok: false, reason: 'expired' })
  })

  it('refuses a state at exactly its expiry, rather than one millisecond past', () => {
    const state = signInstagramOAuthState(PAYLOAD, KEY)
    expect(verifyInstagramOAuthState(state, KEY, new Date(PAYLOAD.expiresAtMs))).toEqual({
      ok: false,
      reason: 'expired',
    })
  })

  it('accepts a state one millisecond before expiry', () => {
    const state = signInstagramOAuthState(PAYLOAD, KEY)
    expect(verifyInstagramOAuthState(state, KEY, new Date(PAYLOAD.expiresAtMs - 1)).ok).toBe(true)
  })

  // The signature is checked BEFORE the payload is parsed, so an
  // attacker-controlled blob never reaches JSON.parse on a value we did not
  // sign. A validly-signed but nonsensical payload is malformed, not tampered.
  it.each([
    ['not json at all', 'not-json'],
    ['a json array', JSON.stringify([1, 2, 3])],
    ['a missing field', JSON.stringify({ venueId: 'v', operatorId: 'o', nonce: 'n' })],
    ['a blank venueId', JSON.stringify({ venueId: '', operatorId: 'o', nonce: 'n', expiresAtMs: 1 })],
    ['a non-numeric expiry', JSON.stringify({ venueId: 'v', operatorId: 'o', nonce: 'n', expiresAtMs: 'soon' })],
  ])('refuses a correctly-signed but %s payload as malformed', (_label, raw) => {
    const payloadB64 = Buffer.from(raw, 'utf8').toString('base64url')
    const signature = createHmac('sha256', KEY).update(payloadB64).digest('base64url')
    expect(verifyInstagramOAuthState(`${payloadB64}.${signature}`, KEY, NOW)).toEqual({
      ok: false,
      reason: 'malformed',
    })
  })

  // THE LIMIT OF THIS MODULE, stated as a test so nobody reads the signature
  // as covering replay. Verifying twice succeeds twice, by design. What
  // refuses the second one is the database claim in oauth-state-store.
  it('verifies the SAME state twice: a signature cannot refuse a replay', () => {
    const state = signInstagramOAuthState(PAYLOAD, KEY)
    expect(verifyInstagramOAuthState(state, KEY, NOW).ok).toBe(true)
    expect(verifyInstagramOAuthState(state, KEY, NOW).ok).toBe(true)
  })

  it('never puts the signing key in the state it produces', () => {
    const state = signInstagramOAuthState(PAYLOAD, KEY)
    expect(state).not.toContain(KEY.toString('base64'))
    expect(state).not.toContain(KEY.toString('base64url'))
    expect(state).not.toContain(KEY.toString('hex'))
  })
})
