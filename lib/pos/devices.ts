// eink device helpers. Pure functions (no I/O) so they're unit-testable; the
// route does the DB work and calls these.
//
// The device polls its event feed and, for each new transaction, writes the
// issued tap_token into the NFC payload. When a guest taps + sends, the
// SendBlue inbound carries that tap_token back, and the tap reconciler matches
// it to the linked transaction.

import { createHash, createHmac, timingSafeEqual } from 'node:crypto'

export type DeviceEvent = {
  type: 'transaction'
  txId: string
  at: string
  // 'returning' if the transaction already matched a known guest (fingerprint),
  // 'new' if unmatched — drives the display artwork.
  guest: 'new' | 'returning'
  tapToken: string
  hasNotes: boolean
}

/** sha256 hex of a device bearer token (what we store in pos_devices). */
export function hashDeviceToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

/** Constant-time compare of a presented token against the stored hash. */
export function verifyDeviceToken(presentedToken: string, storedHash: string): boolean {
  const a = Buffer.from(hashDeviceToken(presentedToken))
  const b = Buffer.from(storedHash)
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

/**
 * Deterministic tap token for a transaction: HMAC(transactionId) → stable +
 * unguessable. Deterministic so re-polling the same transaction issues the same
 * token (idempotent tap_events upsert), and the device can rewrite the NFC
 * payload safely on every poll.
 */
export function deriveTapToken(transactionId: string, secret: string): string {
  const sig = createHmac('sha256', secret).update(transactionId).digest('base64url')
  return `tt_${sig.slice(0, 32)}`
}

type TransactionRow = {
  id: string
  occurred_at: string
  guest_id: string | null
}

/** Project transaction rows into the device event feed. */
export function buildDeviceEvents(
  rows: readonly TransactionRow[],
  deriveToken: (transactionId: string) => string,
): DeviceEvent[] {
  return rows.map((r) => ({
    type: 'transaction',
    txId: r.id,
    at: r.occurred_at,
    guest: r.guest_id ? 'returning' : 'new',
    tapToken: deriveToken(r.id),
    hasNotes: true,
  }))
}
