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
// TAC-445 SCAFFOLDS the signature check and does NOT enforce it: the route
// logs whether the digest matched and returns 200 either way. Enforcement
// lands with the real handler, once matches are confirmed on live traffic.
// checkInstagramSignature is named "check" rather than "verify" for exactly
// that reason — it returns a report, not a gate.

import { createHmac, timingSafeEqual } from 'node:crypto'

const SIGNATURE_HEADER = 'x-hub-signature-256'
const SIGNATURE_PREFIX = 'sha256='

export type InstagramSignatureCheck = {
  /**
   * Hex digest computed from the raw body and the app secret. Safe to log:
   * an HMAC digest does not reveal the key. Always present — the route logs
   * it on a miss too, which is the point of the scaffold.
   */
  computed: string
  /**
   * The digest Meta sent, with the `sha256=` prefix stripped and truncated to
   * the length of a real digest. Null when the header is absent or not in
   * `sha256=<hex>` form. Truncated because this value is attacker-controlled
   * and gets logged: the header is otherwise bounded only by the platform's
   * header limit.
   */
  received: string | null
  /** True only when a well-formed header was present AND matched. */
  matched: boolean
}

/**
 * Compute and compare the `x-hub-signature-256` digest for an Instagram
 * webhook delivery. Never throws.
 *
 * Meta signs the EXACT bytes of the request body, so `rawBody` must be the
 * unparsed text — re-serialized JSON will not match, which is why the route
 * reads the body with `.text()` before parsing.
 */
export function checkInstagramSignature(
  rawBody: string,
  headers: Headers,
  appSecret: string,
): InstagramSignatureCheck {
  const computed = createHmac('sha256', appSecret).update(rawBody).digest('hex')

  const header = headers.get(SIGNATURE_HEADER)
  if (header === null || !header.startsWith(SIGNATURE_PREFIX)) {
    return { computed, received: null, matched: false }
  }

  const received = header.slice(SIGNATURE_PREFIX.length)
  if (received.length === 0) {
    return { computed, received: null, matched: false }
  }

  const a = Buffer.from(received)
  const b = Buffer.from(computed)

  // Bound ONLY what we hand back for logging. The comparison above is built
  // from the full value, so truncation can never turn a long forgery into a
  // match by cutting it down to the right size — there is a test for exactly
  // that, because doing this in the other order would be a real hole. Nothing
  // diagnostic is lost either: a hex digest is a fixed, public length, so
  // anything past it is padding a stranger chose.
  const loggable = received.slice(0, computed.length)

  // Length check guards timingSafeEqual (it throws on length mismatch) and is
  // not a meaningful timing leak — the digest length is fixed/public.
  if (a.length !== b.length) return { computed, received: loggable, matched: false }
  return { computed, received: loggable, matched: timingSafeEqual(a, b) }
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
