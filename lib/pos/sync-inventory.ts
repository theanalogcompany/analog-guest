// Apply inventory counts into pos_inventory_counts. Fed by inventory.count.updated
// webhook deltas (counts already parsed) and by the on-connect backfill
// (provider.fetchInventory). Idempotent upsert on
// UNIQUE(venue_id, provider, catalog_external_id, location_external_id).

import { createAdminClient } from '@/lib/db/admin'
import type { RAGResult } from '@/lib/rag/types'

import type { InventoryCount } from './types'

type AdminClient = ReturnType<typeof createAdminClient>

export async function applyInventoryCounts(opts: {
  venueId: string
  counts: InventoryCount[]
  supabase?: AdminClient
}): Promise<RAGResult<{ upserted: number }>> {
  if (opts.counts.length === 0) return { ok: true, data: { upserted: 0 } }
  const supabase = opts.supabase ?? createAdminClient()

  const rows = opts.counts.map((c) => ({
    venue_id: opts.venueId,
    provider: 'square',
    catalog_external_id: c.catalogExternalId,
    location_external_id: c.locationExternalId,
    quantity: c.quantity,
    state: c.state,
  }))

  const { error } = await supabase
    .from('pos_inventory_counts')
    .upsert(rows, { onConflict: 'venue_id,provider,catalog_external_id,location_external_id' })
  if (error) {
    return { ok: false, error: error.message, errorCode: 'inventory_upsert_failed' }
  }
  return { ok: true, data: { upserted: rows.length } }
}
