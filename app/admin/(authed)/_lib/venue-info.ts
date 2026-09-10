import { type createAdminClient } from '@/lib/db/admin'
import { VenueInfoSchema } from '@/lib/schemas'

// Shared by every venue_info read-modify-write call site (the Stage C PATCH
// route and Stage D's currentContext helpers) — same select/parse shape,
// same error-message wording, so the two surfaces can't drift on what
// "venue_info lookup failed" or "venue_info parse failed" means.
export type LoadVenueInfoResult =
  | { ok: true; venueInfo: ReturnType<typeof VenueInfoSchema.parse> }
  | { ok: false; error: string }

export async function loadVenueInfo(
  supabase: ReturnType<typeof createAdminClient>,
  venueId: string,
): Promise<LoadVenueInfoResult> {
  const { data: row, error: readErr } = await supabase
    .from('venue_configs')
    .select('venue_info')
    .eq('venue_id', venueId)
    .single()
  if (readErr || !row) {
    return { ok: false, error: `venue_configs lookup failed: ${readErr?.message ?? 'no row'}` }
  }
  const parsed = VenueInfoSchema.safeParse(row.venue_info)
  if (!parsed.success) {
    return { ok: false, error: `venue_info parse failed: ${parsed.error.message}` }
  }
  return { ok: true, venueInfo: parsed.data }
}
