// Sync a venue's menu from the POS catalog into pos_catalog_items. Run as a
// backfill on connect and on every catalog.version.updated webhook. Full upsert
// (idempotent on UNIQUE(venue_id, provider, external_id)).

import { createAdminClient } from '@/lib/db/admin'
import type { RAGResult } from '@/lib/rag/types'

import { getProvider } from './registry'
import { squareEnvCredential } from './square/credential'

type AdminClient = ReturnType<typeof createAdminClient>

export async function syncCatalog(opts: {
  venueId: string
  supabase?: AdminClient
}): Promise<RAGResult<{ upserted: number }>> {
  const supabase = opts.supabase ?? createAdminClient()
  const provider = getProvider('square')

  const res = await provider.fetchCatalog(squareEnvCredential(opts.venueId, null))
  if (!res.ok) {
    return { ok: false, error: res.error, errorCode: res.errorCode ?? 'fetch_catalog_failed' }
  }
  if (res.data.length === 0) {
    return { ok: true, data: { upserted: 0 } }
  }

  const rows = res.data.map((m) => ({
    venue_id: opts.venueId,
    provider: 'square',
    external_id: m.externalId,
    parent_external_id: m.parentExternalId,
    name: m.name,
    category: m.category,
    price_cents: m.price?.amountCents ?? null,
    is_available: m.isAvailable,
    version: m.version,
    raw_data: { price: m.price },
  }))

  const { error } = await supabase
    .from('pos_catalog_items')
    .upsert(rows, { onConflict: 'venue_id,provider,external_id' })
  if (error) {
    return { ok: false, error: error.message, errorCode: 'catalog_upsert_failed' }
  }
  return { ok: true, data: { upserted: rows.length } }
}
