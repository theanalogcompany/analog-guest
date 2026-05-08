import { cache } from 'react'
import { createAdminClient } from '@/lib/db/admin'
import { firstOrNull } from '@/lib/db/postgrest'
import { BrandPersonaSchema } from '@/lib/schemas'

// THE-237: shared loader for the Voices command-center surface. Used by the
// authed admin layout (sidebar group) and `/admin/voices` (list page). One
// query, one Zod parse per row, sorted alphabetically by displayed label.
//
// `displayLabel` is `voiceName ?? venueName`. Voices without a voiceName
// inherit the venue name; the UI renders them in italic Fraunces to signal
// the fallback.

export interface VoiceListRow {
  venueId: string
  slug: string
  venueName: string
  voiceName: string | null
  /** voiceName ?? venueName — what the sidebar + list page render. */
  displayLabel: string
  /** True when displayLabel came from venueName (no voiceName set). */
  fallbackToVenueName: boolean
}

/**
 * Load every voice the operator has access to.
 *
 * `allowedVenueIds` empty means analog admin scope (see
 * `verifyAnalogAdminAccess`) — return everything. Non-empty: scope to that
 * list. Mirrors the conversations page's allowlist treatment.
 *
 * Server-only. Never throws — returns [] on DB error after logging, so a
 * malformed venue config can't break sidebar rendering for every other
 * admin page. Per-row parse errors fall back to venueName.
 *
 * Wrapped in React.cache so concurrent calls within a single RSC render
 * (sidebar via the layout, voice list page, etc.) dedup to one DB query.
 * Cache is per-request — no cross-request leak.
 */
export const loadVoices = cache(_loadVoices)

async function _loadVoices(allowedVenueIds: string[]): Promise<VoiceListRow[]> {
  const supabase = createAdminClient()
  let query = supabase
    .from('venues')
    .select('id, slug, name, venue_configs(brand_persona)')
    .order('name', { ascending: true })
  if (allowedVenueIds.length > 0) {
    query = query.in('id', allowedVenueIds)
  }
  const { data, error } = await query
  if (error) {
    console.warn('[loadVoices] venues query failed', error.message)
    return []
  }

  const rows: VoiceListRow[] = []
  for (const v of data ?? []) {
    const config = firstOrNull(v.venue_configs)
    let voiceName: string | null = null
    if (config) {
      const parsed = BrandPersonaSchema.safeParse(config.brand_persona)
      if (parsed.success && parsed.data.voiceName) {
        voiceName = parsed.data.voiceName
      } else if (!parsed.success) {
        console.warn(`[loadVoices] persona parse failed for ${v.slug}: ${parsed.error.message}`)
      }
    }
    rows.push({
      venueId: v.id,
      slug: v.slug,
      venueName: v.name,
      voiceName,
      displayLabel: voiceName ?? v.name,
      fallbackToVenueName: voiceName === null,
    })
  }

  // Sort by displayLabel case-insensitively. The DB ORDER BY above sorts by
  // venue.name; we re-sort in JS once voiceName has been merged in.
  rows.sort((a, b) =>
    a.displayLabel.toLowerCase().localeCompare(b.displayLabel.toLowerCase()),
  )
  return rows
}
