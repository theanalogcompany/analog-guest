/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, expect, it } from 'vitest'

import type { createAdminClient } from '@/lib/db/admin'

import { getAvailability } from './availability'
import { applyInventoryCounts } from './sync-inventory'
import type { InventoryCount } from './types'

type AdminClient = ReturnType<typeof createAdminClient>

interface Cfg {
  data?: Record<string, unknown[] | null>
  error?: Record<string, { message: string } | null>
}

function makeClient(cfg: Cfg): {
  client: AdminClient
  captured: { upserts: Record<string, unknown[]> }
} {
  const captured = { upserts: {} as Record<string, unknown[]> }
  function chain(table: string): any {
    const self: any = {}
    const ret = () => self
    self.select = ret
    self.eq = ret
    self.ilike = ret
    self.in = ret
    self.limit = ret
    self.upsert = (rows: unknown[]) => {
      captured.upserts[table] = rows
      return self
    }
    self.then = (resolve: (r: { data: unknown; error: unknown }) => unknown) =>
      resolve({ data: cfg.data?.[table] ?? null, error: cfg.error?.[table] ?? null })
    return self
  }
  return { client: { from: (t: string) => chain(t) } as unknown as AdminClient, captured }
}

const VENUE = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'

describe('applyInventoryCounts', () => {
  it('no-ops on empty counts without touching the DB', async () => {
    const { client, captured } = makeClient({})
    const res = await applyInventoryCounts({ venueId: VENUE, counts: [], supabase: client })
    expect(res).toEqual({ ok: true, data: { upserted: 0 } })
    expect(captured.upserts.pos_inventory_counts).toBeUndefined()
  })

  it('upserts mapped rows', async () => {
    const counts: InventoryCount[] = [
      { catalogExternalId: 'v1', locationExternalId: 'L1', quantity: 5, state: 'IN_STOCK' },
    ]
    const { client, captured } = makeClient({})
    const res = await applyInventoryCounts({ venueId: VENUE, counts, supabase: client })
    expect(res).toEqual({ ok: true, data: { upserted: 1 } })
    expect(captured.upserts.pos_inventory_counts).toEqual([
      {
        venue_id: VENUE,
        provider: 'square',
        catalog_external_id: 'v1',
        location_external_id: 'L1',
        quantity: 5,
        state: 'IN_STOCK',
      },
    ])
  })

  it('surfaces an upsert error', async () => {
    const counts: InventoryCount[] = [
      { catalogExternalId: 'v1', locationExternalId: 'L1', quantity: 5, state: null },
    ]
    const { client } = makeClient({ error: { pos_inventory_counts: { message: 'dup' } } })
    const res = await applyInventoryCounts({ venueId: VENUE, counts, supabase: client })
    expect(res).toEqual({ ok: false, error: 'dup', errorCode: 'inventory_upsert_failed' })
  })
})

describe('getAvailability', () => {
  it('returns found:false when no catalog item matches', async () => {
    const { client } = makeClient({ data: { pos_catalog_items: [] } })
    const res = await getAvailability({ venueId: VENUE, itemName: 'croissant', supabase: client })
    expect(res).toEqual({ ok: true, data: { found: false, items: [] } })
  })

  it('joins inventory counts; untracked items report quantity null', async () => {
    const { client } = makeClient({
      data: {
        pos_catalog_items: [
          { external_id: 'v1', name: 'Croissant', is_available: true },
          { external_id: 'v2', name: 'Almond Croissant', is_available: true },
        ],
        pos_inventory_counts: [{ catalog_external_id: 'v1', quantity: 2 }],
      },
    })
    const res = await getAvailability({ venueId: VENUE, itemName: 'croissant', supabase: client })
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.data.found).toBe(true)
    expect(res.data.items).toEqual([
      { name: 'Croissant', isAvailable: true, quantity: 2 },
      { name: 'Almond Croissant', isAvailable: true, quantity: null },
    ])
  })

  it('returns found:false on empty search term', async () => {
    const { client } = makeClient({})
    const res = await getAvailability({ venueId: VENUE, itemName: '  ', supabase: client })
    expect(res).toEqual({ ok: true, data: { found: false, items: [] } })
  })

  it('surfaces a catalog lookup error', async () => {
    const { client } = makeClient({ error: { pos_catalog_items: { message: 'boom' } } })
    const res = await getAvailability({ venueId: VENUE, itemName: 'x', supabase: client })
    expect(res).toEqual({ ok: false, error: 'boom', errorCode: 'availability_lookup_failed' })
  })
})
