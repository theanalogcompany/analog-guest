import { createAdminClient } from '@/lib/db/admin'

type VenueLookupResult =
  | { ok: true; data: { id: string; slug: string; name: string } }
  | { ok: false; error: 'venue_not_found' | 'venue_lookup_failed'; details?: string }

/**
 * Find a venue by its slug.
 *
 * Server-only. Uses the admin DB client, which bypasses RLS.
 * Do not import this from client components or edge contexts.
 */
export async function findVenueBySlug(
  slug: string,
): Promise<VenueLookupResult> {
  const supabase = createAdminClient()
  const { data, error } = await supabase
    .from('venues')
    .select('id, slug, name')
    .eq('slug', slug)
    .single()

  if (error) {
    if (error.code === 'PGRST116') {
      return { ok: false, error: 'venue_not_found' }
    }
    return { ok: false, error: 'venue_lookup_failed', details: error.message }
  }

  return { ok: true, data }
}