import { createAdminClient } from '@/lib/db/admin'
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
 */
export async function loadVoices(allowedVenueIds: string[]): Promise<VoiceListRow[]> {
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
    // venue_configs is an embedded relation; PostgREST returns it as a nested
    // object or array depending on cardinality inference.
    const configRaw = v.venue_configs
    const config = Array.isArray(configRaw) ? configRaw[0] ?? null : configRaw
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
