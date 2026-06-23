// Signed OAuth `state` — binds the connect→callback round-trip to a venue and
// proves the callback originated from our connect route (CSRF guard). Pure:
// the signing secret is passed in (routes read it from env). Format:
// "<venueId base64url>.<hmac base64url>".

import { createHmac, timingSafeEqual } from 'node:crypto'

export function signOAuthState(venueId: string, secret: string): string {
  const payload = Buffer.from(venueId, 'utf8').toString('base64url')
  const sig = createHmac('sha256', secret).update(payload).digest('base64url')
  return `${payload}.${sig}`
}

/** Returns the venueId if the state is well-formed and the signature matches; null otherwise. */
export function verifyOAuthState(state: string, secret: string): string | null {
  const parts = state.split('.')
  if (parts.length !== 2) return null
  const [payload, sig] = parts
  const expected = createHmac('sha256', secret).update(payload).digest('base64url')
  const a = Buffer.from(sig)
  const b = Buffer.from(expected)
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null
  return Buffer.from(payload, 'base64url').toString('utf8')
}
