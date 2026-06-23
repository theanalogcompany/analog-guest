// Square webhook signature verification. Pure (signature key passed in, not
// read from env) so it's unit-testable with known vectors; the provider reads
// SQUARE_WEBHOOK_SIGNATURE_KEY and passes it.
//
// Square signs each delivery with HMAC-SHA256 over (notificationUrl + rawBody),
// base64-encoded, in the `x-square-hmacsha256-signature` header. The
// notification URL MUST be the exact URL configured in the Square dashboard —
// it is part of the signed payload, so any mismatch (scheme, trailing slash)
// fails verification. See SQUARE_WEBHOOK_URL in .env.local.example.

import { createHmac, timingSafeEqual } from 'node:crypto'

const SIGNATURE_HEADER = 'x-square-hmacsha256-signature'

/**
 * Verify a Square webhook delivery. Returns false (never throws) on a missing
 * header or signature mismatch; the route maps false → 401. `rawBody` MUST be
 * the unparsed request body — re-serialized JSON will not match the HMAC.
 */
export function verifySquareWebhook(
  rawBody: string,
  headers: Headers,
  notificationUrl: string,
  signatureKey: string,
): boolean {
  const received = headers.get(SIGNATURE_HEADER)
  if (received === null || received.length === 0) return false

  const expected = createHmac('sha256', signatureKey)
    .update(notificationUrl + rawBody)
    .digest('base64')

  const a = Buffer.from(received)
  const b = Buffer.from(expected)
  // Length check guards timingSafeEqual (it throws on length mismatch) and is
  // not a meaningful timing leak — the digest length is fixed/public.
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}
