// TAC-516: Meta's `signed_request`, which is how the deauthorize and data
// deletion callbacks authenticate themselves.
//
// A DIFFERENT SCHEME from the webhook's `x-hub-signature-256`, and from our
// own OAuth state, so it gets its own parser rather than being squeezed into
// either:
//   - The webhook signs the RAW BODY and sends the digest in a HEADER.
//   - This sends ONE form field, "<signatureB64url>.<payloadB64url>", with
//     the SIGNATURE FIRST. Note the order: our own state module puts the
//     payload first, and swapping them silently verifies nothing.
//   - Both are HMAC-SHA256 keyed by INSTAGRAM_APP_SECRET.
//
// The same two rules as verify-webhook.ts, for the same reasons:
//
//   1. THE COMPUTED DIGEST IS NEVER RETURNED. Our digest of a payload is a
//      valid signature for that payload until the secret rotates, so a log
//      line carrying it hands out a forgery. Returning only a reason makes
//      logging one impossible rather than merely discouraged.
//   2. AN EMPTY SECRET IS REFUSED HERE, not only at the route. HMAC accepts
//      an empty key and produces a digest anyone can compute, so a caller
//      passing '' would verify a forgery. Refusing in both places means
//      removing either guard still fails closed, which is why each has its
//      own test.
//
// REPLAY IS OPEN, AND THAT IS A DECISION RATHER THAN AN OVERSIGHT (found in
// code review). `issued_at` is parsed and carried through; nothing refuses a
// payload for being old, so a captured genuine request stays valid until the
// secret rotates. Meta signs no nonce, so the only available check is an age
// window — and on THESE two callbacks the refusal is worse than the replay:
//
//   - Refusing a genuine deauthorize keeps a token the venue revoked, which
//     is the credential-storage failure this whole ticket exists to avoid.
//   - Refusing a genuine deletion is a compliance failure with a deadline.
//
// Both refusals are reachable by ordinary clock skew or a delayed Meta
// retry, where the replays are bounded: deauthorizing an already-revoked
// venue is idempotent, and re-running a deletion re-redacts rows that are
// already redacted. The one real exposure is narrow and worth stating — a
// guest who messages the venue AFTER a deletion, whose new rows a replayed
// request would then redact too.
//
// So the window is deliberately left open. Closing it needs something other
// than a clock (deduping the request itself), which is its own decision.

import { createHmac, timingSafeEqual } from 'node:crypto'

/**
 * Why a signed request was refused. Safe to log: none carries anything from
 * the request or the secret.
 */
export type SignedRequestRejection =
  | 'secret_unset'
  | 'malformed'
  | 'mismatch'
  /** Verified, but the payload is not the shape Meta documents. */
  | 'unreadable_payload'

export type SignedRequestPayload = {
  /**
   * The Instagram account that authorized this app and is now revoking or
   * deleting. Meta calls it `user_id`.
   *
   * WHETHER THIS EQUALS venues.instagram_account_id IS A META-SIDE FACT this
   * repo cannot settle. CLAUDE.md already records that Meta distinguishes an
   * app-scoped `id` from `user_id` on /me. If the two differ here, a deletion
   * request matches no venue — which is why the caller ALERTS on an unmatched
   * account rather than passing quietly, and why the ticket's AC verifies
   * this against Meta's own tester.
   */
  userId: string
  /** Present on some callbacks; carried through but not required. */
  issuedAt: number | null
}

export type ParseSignedRequestResult =
  | { ok: true; payload: SignedRequestPayload }
  | { ok: false; reason: SignedRequestRejection }

export function parseSignedRequest(raw: string, secret: string): ParseSignedRequestResult {
  // See rule 2. This must stay here even though the routes check too.
  if (secret === '') return { ok: false, reason: 'secret_unset' }

  const parts = raw.split('.')
  if (parts.length !== 2 || parts[0] === '' || parts[1] === '') {
    return { ok: false, reason: 'malformed' }
  }
  // SIGNATURE FIRST. Meta's order, not ours.
  const [signatureB64, payloadB64] = parts

  const expected = createHmac('sha256', secret).update(payloadB64).digest()
  let presented: Buffer
  try {
    presented = Buffer.from(signatureB64, 'base64url')
  } catch {
    return { ok: false, reason: 'malformed' }
  }
  // An unequal length is itself a mismatch, and timingSafeEqual requires
  // equal lengths. This leaks only the length of what the caller sent.
  if (presented.length !== expected.length || !timingSafeEqual(presented, expected)) {
    return { ok: false, reason: 'mismatch' }
  }

  // Only now is the payload parsed: it is attacker-controlled until the
  // signature has verified.
  let parsed: unknown
  try {
    parsed = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'))
  } catch {
    return { ok: false, reason: 'unreadable_payload' }
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return { ok: false, reason: 'unreadable_payload' }
  }

  const record = parsed as Record<string, unknown>
  const rawUserId = record.user_id
  const userId =
    typeof rawUserId === 'number'
      ? String(rawUserId)
      : typeof rawUserId === 'string' && rawUserId !== ''
        ? rawUserId
        : null
  if (userId === null) return { ok: false, reason: 'unreadable_payload' }

  const issuedAt = typeof record.issued_at === 'number' ? record.issued_at : null
  return { ok: true, payload: { userId, issuedAt } }
}
