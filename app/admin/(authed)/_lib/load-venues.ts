import { cache } from 'react'
import { createAdminClient } from '@/lib/db/admin'
import { venueFilterIds, type VenueScope } from '@/lib/auth/venue-scope'

// TAC-343: shared loader for the /admin/venues list page. Mirrors
// load-voices.ts's shape — one query, alphabetical by name, allowlist-scoped
// exactly like the Voices list (a fleet-wide venueScope means analog-admin
// scope, sees everything).

export interface VenueListRow {
  venueId: string
  slug: string
  name: string
  timezone: string
}

export const loadVenues = cache(_loadVenues)

async function _loadVenues(venueScope: VenueScope): Promise<VenueListRow[]> {
  const supabase = createAdminClient()
  let query = supabase
    .from('venues')
    .select('id, slug, name, timezone')
    .order('name', { ascending: true })
  // TAC-530: null means fleet-wide (an analog admin with no explicit
  // grants), so no filter. An EMPTY list is still applied as a filter and
  // matches nothing -- the two are no longer the same value.
  const venueIds = venueFilterIds(venueScope)
  if (venueIds !== null) {
    query = query.in('id', venueIds)
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
