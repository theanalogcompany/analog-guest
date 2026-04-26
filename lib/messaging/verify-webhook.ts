import { timingSafeEqual } from 'node:crypto'

const SIGNATURE_HEADER = 'sb-signing-secret'

function getHeader(
  headers: Headers | Record<string, string | string[] | undefined>,
  name: string,
): string | null {
  if (headers instanceof Headers) {
    return headers.get(name)
  }
  const lower = name.toLowerCase()
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== lower) continue
    if (value === undefined) return null
    return Array.isArray(value) ? value[0] ?? null : value
  }
  return null
}

/**
 * Verify the signature of a Sendblue webhook request.
 *
 * Sendblue echoes the configured signing secret in the `sb-signing-secret`
 * header. We compare it against the SENDBLUE_SIGNING_SECRET env var using a
 * constant-time comparison.
 *
 * Returns false (does not throw) if the header is missing, empty, or has a
 * different length than the expected secret. Throws only if the
 * SENDBLUE_SIGNING_SECRET env var itself is unset.
 */
export function verifyWebhookSignature(
  headers: Headers | Record<string, string | string[] | undefined>,
): boolean {
  const expected = process.env.SENDBLUE_SIGNING_SECRET
  if (!expected) throw new Error('Missing env var: SENDBLUE_SIGNING_SECRET')

  const received = getHeader(headers, SIGNATURE_HEADER)
  if (received === null || received.length === 0) return false

  const a = Buffer.from(received)
  const b = Buffer.from(expected)
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}