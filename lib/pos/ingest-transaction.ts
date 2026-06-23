// Ingest a normalized TransactionEvent into the existing `transactions` table.
// Server-only (uses the admin DB client). Provider-agnostic — it consumes the
// normalized model, not a Square object.
//
// Lands the transaction, idempotently, with line items shaped into raw_data so
// the agent's ## Visit history block can read them. Guest matching (fingerprint
// / tap reconciliation) happens separately — rows land with guest_id=null and
// are reconciled afterward.

import { createAdminClient } from '@/lib/db/admin'

import { reconcileTransactionByFingerprint } from './reconcile'
import { getProvider } from './registry'
import { resolveVenueByLocation } from './resolve-venue'
import { squareEnvCredential } from './square/credential'
import type { TransactionEvent, TransactionLineItem } from './types'

export type IngestOutcome =
  | { status: 'ingested'; transactionId: string }
  | { status: 'venue_not_connected' }
  | { status: 'error'; error: string }

async function hydrateLineItems(event: TransactionEvent, venueId: string): Promise<TransactionLineItem[]> {
  if (event.lineItems.length > 0) return event.lineItems
  if (!event.orderExternalId) return []
  const provider = getProvider(event.provider)
  const cred = squareEnvCredential(venueId, event.locationExternalId)
  const res = await provider.fetchOrder(cred, event.orderExternalId)
  if (!res.ok) {
    // Degrade gracefully: land the transaction without items rather than drop
    // it. The agent's visit-history block simply omits this visit's items.
    console.warn('pos ingest: order hydration failed; landing transaction without items', {
      orderExternalId: event.orderExternalId,
      error: res.error,
    })
    return []
  }
  return res.data
}

/**
 * Upsert a transaction. Idempotent on the existing UNIQUE(venue_id, source,
 * external_id) constraint (migration 001) — a re-delivered payment.created or a
 * follow-on payment.updated updates the same row rather than duplicating.
 */
export async function ingestTransaction(event: TransactionEvent): Promise<IngestOutcome> {
  const supabase = createAdminClient()

  const venueId = await resolveVenueByLocation(supabase, event.provider, event.locationExternalId)
  if (!venueId) {
    console.warn('pos ingest: no connected venue for location; skipping', {
      provider: event.provider,
      locationExternalId: event.locationExternalId,
      externalId: event.externalId,
    })
    return { status: 'venue_not_connected' }
  }

  const lineItems = await hydrateLineItems(event, venueId)
  const itemCount = lineItems.reduce((sum, li) => sum + li.quantity, 0)

  const { data, error } = await supabase
    .from('transactions')
    .upsert(
      {
        venue_id: venueId,
        source: event.provider,
        external_id: event.externalId,
        amount_cents: event.amount.amountCents,
        occurred_at: event.occurredAt,
        item_count: itemCount > 0 ? itemCount : null,
        card_fingerprint: event.cardFingerprint,
        // raw_data.line_items[].name is the contract the agent reads
        // (lib/agent/extract-recent-visits.ts). Keep provider detail alongside.
        raw_data: {
          line_items: lineItems,
          square: {
            payment_id: event.externalId,
            order_id: event.orderExternalId,
            status: event.status,
            currency: event.amount.currency,
          },
        },
      },
      { onConflict: 'venue_id,source,external_id' },
    )
    .select('id')
    .single()

  if (error || !data) {
    console.error('pos ingest: transaction upsert failed', {
      venueId,
      externalId: event.externalId,
      error: error?.message ?? 'no row returned',
    })
    return { status: 'error', error: error?.message ?? 'no row returned' }
  }

  // Attempt fingerprint reconciliation immediately (returning-guest auto-match).
  // Non-fatal: a failed/no match leaves the row unattributed; the tap path can
  // reconcile it later. Logged for observability.
  const reconciled = await reconcileTransactionByFingerprint({
    transactionId: data.id,
    venueId,
    cardFingerprint: event.cardFingerprint,
    occurredAt: event.occurredAt,
    supabase,
  })
  if (!reconciled.ok) {
    console.warn('pos ingest: reconciliation failed', {
      transactionId: data.id,
      error: reconciled.error,
    })
  }

  return { status: 'ingested', transactionId: data.id }
}
