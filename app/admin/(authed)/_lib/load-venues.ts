import { cache } from 'react'
import { createAdminClient } from '@/lib/db/admin'

// TAC-343: shared loader for the /admin/venues list page. Mirrors
// load-voices.ts's shape — one query, alphabetical by name, allowlist-scoped
// exactly like the Voices list (empty allowedVenueIds means analog-admin
// scope, sees everything).

export interface VenueListRow {
  venueId: string
  slug: string
  name: string
  timezone: string
}

export const loadVenues = cache(_loadVenues)

async function _loadVenues(allowedVenueIds: string[]): Promise<VenueListRow[]> {
  const supabase = createAdminClient()
  let query = supabase
    .from('venues')
    .select('id, slug, name, timezone')
    .order('name', { ascending: true })
  if (allowedVenueIds.length > 0) {
    query = query.in('id', allowedVenueIds)
  }
  const { data, error } = await query
  if (error) {
    console.warn('[loadVenues] venues query failed', error.message)
    return []
  }

  return (data ?? []).map((v) => ({
    venueId: v.id,
    slug: v.slug,
    name: v.name,
    timezone: v.timezone,
  }))
}
