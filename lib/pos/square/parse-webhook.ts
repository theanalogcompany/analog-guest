// Parse a verified Square webhook body into normalized events. Pure: takes the
// raw body string, returns PosResult<NormalizedEvent[]>. The route handles
// signature verification + idempotency; this layer only decodes + normalizes.

import { z } from 'zod'

import type { NormalizedEvent, PosResult } from '../types'
import {
  mapSquareInventoryCounts,
  mapSquarePaymentToTransaction,
} from './map'

// Permissive envelope — we only require the fields we branch on. Unknown event
// types are surfaced as { kind: 'unknown' } rather than rejected, so a new
// Square event type the route isn't subscribed to never throws.
const EnvelopeSchema = z.object({
  merchant_id: z.string().optional(),
  type: z.string(),
  event_id: z.string(),
  created_at: z.string().optional(),
  data: z
    .object({
      type: z.string().optional(),
      id: z.string().optional(),
      object: z.record(z.string(), z.unknown()).optional(),
    })
    .optional(),
})

/**
 * Decode a Square webhook body into normalized events. Returns an error result
 * on invalid JSON or an envelope missing `type`/`event_id` (the route maps that
 * to 400). A recognized envelope whose inner payload doesn't map yields an
 * 'unknown' event rather than an error — the delivery is still acknowledged.
 */
export function parseSquareWebhook(rawBody: string): PosResult<NormalizedEvent[]> {
  let json: unknown
  try {
    json = JSON.parse(rawBody)
  } catch {
    return { ok: false, error: 'invalid JSON body', errorCode: 'invalid_json' }
  }

  const parsed = EnvelopeSchema.safeParse(json)
  if (!parsed.success) {
    return { ok: false, error: 'envelope missing type/event_id', errorCode: 'invalid_envelope' }
  }

  const env = parsed.data
  const eventId = env.event_id
  const object = env.data?.object

  switch (env.type) {
    case 'payment.created':
    case 'payment.updated': {
      // Square nests the payment under data.object.payment.
      const payment = (object as Record<string, unknown> | undefined)?.payment
      const txn = mapSquarePaymentToTransaction(payment)
      if (!txn) return { ok: true, data: [{ kind: 'unknown', eventId, type: env.type }] }
      // The merchant id lives on the envelope, not the payment object.
      txn.merchantExternalId = env.merchant_id ?? null
      return { ok: true, data: [{ kind: 'transaction', eventId, data: txn }] }
    }

    case 'catalog.version.updated':
      return {
        ok: true,
        data: [{ kind: 'catalog_updated', eventId, merchantExternalId: env.merchant_id ?? null }],
      }

    case 'inventory.count.updated': {
      const counts = (object as Record<string, unknown> | undefined)?.inventory_counts
      return {
        ok: true,
        data: [{ kind: 'inventory_updated', eventId, counts: mapSquareInventoryCounts(counts) }],
      }
    }

    default:
      return { ok: true, data: [{ kind: 'unknown', eventId, type: env.type }] }
  }
}
