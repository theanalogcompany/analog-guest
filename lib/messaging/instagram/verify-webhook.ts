// Instagram (Meta) webhook verification. Both helpers are pure — the secret is
// passed in rather than read from env — so they're unit-testable with known
// vectors; the route reads the env vars and passes them. Mirrors
// lib/pos/square/verify-webhook.ts, which is the repo's HMAC precedent.
//
// NOT lib/messaging/verify-webhook.ts: that one is Sendblue's, and Sendblue
// doesn't sign anything. It echoes the configured secret in plaintext in an
// `sb-signing-secret` header and the helper constant-time-compares it. Wrong
// scheme entirely for Meta, and it throws when its env var is unset.
//
// TAC-445 scaffolded the signature check as a report the route only logged.
// TAC-458 made it a gate: the route refuses anything that does not verify.
// Two things changed with that, and both are why the result below carries a
// reason and nothing else.
//
// 1. The computed digest is never returned. Our digest of a body IS a valid
//    signature for that body for as long as the secret is unchanged, so a log
//    line carrying it lets anyone who can read the logs replay that body as a
//    signed delivery. TAC-445 logged it on every delivery while nothing was
//    enforced, which only looked harmless: enforcing made every one of those
//    lines valid at once, and they stay valid until the secret is rotated.
//    Returning only a reason makes it impossible to log one by accident.
//
// 2. An empty secret is refused here, not only in the route. HMAC accepts an
//    empty key, and a signature keyed with one is computable by anyone, so a
//    caller that passed '' would otherwise verify a forgery. Same trap as the
//    '' === '' comparison verifyMetaChallengeToken guards below.

import { createHmac, timingSafeEqual } from 'node:crypto'

const SIGNATURE_HEADER = 'x-hub-signature-256'
const SIGNATURE_PREFIX = 'sha256='

/**
 * Why a delivery was refused. Safe to log: none of these carries anything from
 * the request or the secret.
 *
 * - `secret_unset` — no app secret to verify with. Misconfiguration, not
 *   forgery: every genuine delivery fails this way until the secret is set.
 * - `missing_header` — no `x-hub-signature-256` header at all.
 * - `malformed_header` — present but not `sha256=<digest>`.
 * - `mismatch` — `sha256=` followed by anything but the right digest,
 *   including one of the wrong length or not hex. What a forgery, a tampered
 *   body or a rotated secret all look like.
 */
export type InstagramSignatureRejection =
  | 'secret_unset'
  | 'missing_header'
  | 'malformed_header'
  | 'mismatch'

export type InstagramSignatureResult =
  | { ok: true }
  | { ok: false; reason: InstagramSignatureRejection }

/**
 * Verify the `x-hub-signature-256` header on an Instagram webhook delivery.
 * Never throws.
 *
 * Meta signs the EXACT bytes of the request body, so `rawBody` must be the
 * unparsed text — re-serialized JSON will not match, which is why the route
 * reads the body with `.text()` before parsing.
 */
export function verifyInstagramSignature(
  rawBody: string,
  headers: Headers,
  appSecret: string | undefined,
): InstagramSignatureResult {
  if (!appSecret) return { ok: false, reason: 'secret_unset' }

  const header = headers.get(SIGNATURE_HEADER)
  if (header === null) return { ok: false, reason: 'missing_header' }
  if (!header.startsWith(SIGNATURE_PREFIX) || header.length === SIGNATURE_PREFIX.length) {
    return { ok: false, reason: 'malformed_header' }
  }

  const received = Buffer.from(header.slice(SIGNATURE_PREFIX.length))
  const computed = Buffer.from(createHmac('sha256', appSecret).update(rawBody).digest('hex'))

  // Length check guards timingSafeEqual (it throws on length mismatch) and is
  // not a meaningful timing leak — the digest length is fixed/public.
  if (received.length !== computed.length) return { ok: false, reason: 'mismatch' }
  return timingSafeEqual(received, computed) ? { ok: true } : { ok: false, reason: 'mismatch' }
}

/**
 * Constant-time compare for the GET handshake's `hub.verify_token`.
 *
 * An EMPTY `expected` is always false, and that guard is load-bearing rather
 * than defensive padding: the natural spelling of this comparison coalesces
 * both sides to '' when unset, and '' === '' would verify an attacker's
 * handshake against a token we never configured.
 *
 * Constant-time because this compares a shared secret against a value the
 * caller controls, matching the discipline the Sendblue and Square verifiers
 * already use. The handshake is rare enough that timing is not a live threat;
 * the point is that the question doesn't have to be re-asked.
 */
export function verifyMetaChallengeToken(
  received: string | null,
  expected: string | undefined,
): boolean {
  if (!expected || !received) return false

  const a = Buffer.from(received)
  const b = Buffer.from(expected)
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}
