// Best-effort availability lookup for the agent ("do you have croissants
// left?"). Matches catalog items by name and joins the latest inventory counts.
//
// Best-effort by design: inventory is only as good as the venue's habits, so a
// missing count means "unknown", not "out of stock". The agent hedges
// accordingly. Wiring this into the prompt is a separate (runtime-contract)
// ticket — this helper just exposes the data.

import { createAdminClient } from '@/lib/db/admin'
import type { RAGResult } from '@/lib/rag/types'

type AdminClient = ReturnType<typeof createAdminClient>

export type ItemAvailability = {
  name: string
  isAvailable: boolean
  // null = inventory not tracked for this item (unknown), not "zero".
  quantity: number | null
}

export type AvailabilityResult = {
  found: boolean
  items: ItemAvailability[]
}

export async function getAvailability(opts: {
  venueId: string
  itemName: string
  supabase?: AdminClient
}): Promise<RAGResult<AvailabilityResult>> {
  const supabase = opts.supabase ?? createAdminClient()
  const term = opts.itemName.trim()
  if (term.length === 0) return { ok: true, data: { found: false, items: [] } }

  const { data: items, error } = await supabase
    .from('pos_catalog_items')
    .select('external_id, name, is_available')
    .eq('venue_id', opts.venueId)
    .ilike('name', `%${term}%`)
    .limit(20)
  if (error) {
    return { ok: false, error: error.message, errorCode: 'availability_lookup_failed' }
  }
  if (!items || items.length === 0) {
    return { ok: true, data: { found: false, items: [] } }
  }

  const variationIds = items.map((i) => i.external_id)
  const { data: counts, error: invError } = await supabase
    .from('pos_inventory_counts')
    .select('catalog_external_id, quantity')
    .eq('venue_id', opts.venueId)
    .in('catalog_external_id', variationIds)
  if (invError) {
    return { ok: false, error: invError.message, errorCode: 'availability_inventory_failed' }
  }

  const quantityByVariation = new Map<string, number | null>()
  for (const c of counts ?? []) {
    quantityByVariation.set(c.catalog_external_id, c.quantity)
  }

  const out: ItemAvailability[] = items.map((i) => ({
    name: i.name,
    isAvailable: i.is_available,
    quantity: quantityByVariation.has(i.external_id)
      ? (quantityByVariation.get(i.external_id) ?? null)
      : null,
  }))

  return { ok: true, data: { found: true, items: out } }
}
