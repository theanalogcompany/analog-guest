// TAC-516: the signed `state` for the Instagram connect round trip.
//
// Pure: the signing key is passed in, so this is testable with fixed vectors
// and never reads env. Format: "<base64url(payload json)>.<base64url(hmac)>".
//
// WHAT A SIGNATURE CAN AND CANNOT DO, because the AC asks for three refusals
// and only two of them live here:
//   - TAMPERED: caught here. The HMAC covers the whole payload, so a changed
//     venue, operator or expiry does not verify.
//   - EXPIRED: caught here. The expiry is inside the signed payload, so it
//     cannot be extended without breaking the signature.
//   - REPLAYED: NOT caught here, and cannot be. The same correctly-signed,
//     unexpired value verifies every time it is presented; nothing about it
//     changes between presentations. Single use needs server-side state,
//     which is `instagram_oauth_states` and its CAS claim (oauth-state-store).
//
// This is why `lib/pos/square/oauth-state.ts` could not be reused rather than
// merely extended: it signs a bare venue id with NO expiry and NO nonce, so
// its values are valid forever and replayable without limit. Square's flow
// accepts that; this ticket's acceptance criteria do not.
//
// KEY SEPARATION. The signing key is DERIVED from INSTAGRAM_TOKEN_ENC_KEY
// rather than being it. Square signs with POS_TOKEN_ENC_KEY directly, which
// uses one key as both an AES-GCM encryption key and an HMAC key. Deriving
// costs one HMAC and no new environment variable, and keeps the two uses
// cryptographically independent, so this improves on the precedent rather
// than copying it. It is not a new secret to provision or rotate.

import { createHmac, timingSafeEqual } from 'node:crypto'

/** Domain separator, so the derived key cannot collide with another use. */
const SIGNING_KEY_INFO = 'tac-516:instagram-oauth-state:v1'

export type InstagramOAuthStatePayload = {
  venueId: string
  operatorId: string
  /** The single-use nonce. Claimed in the database, not here. */
  nonce: string
  /** Epoch milliseconds. Inside the signature, so it cannot be extended. */
  expiresAtMs: number
}

export type VerifyInstagramOAuthStateResult =
  | { ok: true; payload: InstagramOAuthStatePayload }
  | { ok: false; reason: 'malformed' | 'tampered' | 'expired' }

/**
 * The HMAC key for state signing, derived from the encryption key so the two
 * uses stay independent. Deterministic: the same env value always derives the
 * same signing key, so a state signed before a deploy verifies after it.
 */
export function deriveInstagramStateSigningKey(encryptionKey: string): Buffer {
  return createHmac('sha256', encryptionKey).update(SIGNING_KEY_INFO).digest()
}

function sign(payloadB64: string, key: Buffer): string {
  return createHmac('sha256', key).update(payloadB64).digest('base64url')
}

export function signInstagramOAuthState(payload: InstagramOAuthStatePayload, key: Buffer): string {
  const payloadB64 = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
  return `${payloadB64}.${sign(payloadB64, key)}`
}

export function verifyInstagramOAuthState(
  state: string,
  key: Buffer,
  now: Date,
): VerifyInstagramOAuthStateResult {
  const parts = state.split('.')
  if (parts.length !== 2 || parts[0] === '' || parts[1] === '') return { ok: false, reason: 'malformed' }
  const [payloadB64, presented] = parts

  // Compare the SIGNATURE before parsing the payload: an unverified payload is
  // attacker-controlled, and JSON.parse on it should not be the first thing
  // that runs. timingSafeEqual needs equal lengths, and an unequal length is
  // itself a mismatch, so the length check is not a timing leak of anything
  // secret — it leaks only the length of what the caller sent.
  const expected = Buffer.from(sign(payloadB64, key))
  const actual = Buffer.from(presented)
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    return { ok: false, reason: 'tampered' }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'))
  } catch {
    // Signed by us and still unparseable: not an attack, but not usable.
    return { ok: false, reason: 'malformed' }
  }
  if (typeof parsed !== 'object' || parsed === null) return { ok: false, reason: 'malformed' }
  const { venueId, operatorId, nonce, expiresAtMs } = parsed as Record<string, unknown>
  if (
    typeof venueId !== 'string' ||
    typeof operatorId !== 'string' ||
    typeof nonce !== 'string' ||
    typeof expiresAtMs !== 'number' ||
    venueId === '' ||
    operatorId === '' ||
    nonce === ''
  ) {
    return { ok: false, reason: 'malformed' }
  }

  // Expiry is checked AFTER the signature, so an expired state and a forged
  // one are told apart only for a value we actually issued.
  if (expiresAtMs <= now.getTime()) return { ok: false, reason: 'expired' }

  return { ok: true, payload: { venueId, operatorId, nonce, expiresAtMs } }
}
