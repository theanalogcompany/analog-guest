import { NextResponse } from 'next/server'
import { z } from 'zod'
import { requireVenueAdmin } from '@/lib/auth'
import { createAdminClient } from '@/lib/db/admin'
import { toJson } from '@/lib/db/json'
import {
  VenueAddressSchema,
  VenueAmenitiesSchema,
  VenueContactSchema,
  VenueHoursSchema,
  VenueInfoSchema,
  VenueMenuSchema,
} from '@/lib/schemas'
import { loadVenueInfo } from '../../../../../_lib/venue-info'

// PATCH /admin/venues/api/venues/[venueId]/venue-info — single writer for
// everything editable in venue_info (TAC-343 Stage C). Mirrors
// /admin/voices/api/persona/[venueId] exactly: read-modify-write through the
// full schema so a partial write can never drop a sibling key. That
// property is load-bearing here in a way it isn't for brand_persona —
// venue_info renders into EVERY prompt turn, so a silently-dropped field
// (address, hours, a menu item) isn't a display bug, it's the agent losing
// a fact it's supposed to know, with no error anywhere to point at.
//
// `currentContext` is NOT editable through this route — the expiry queue's
// Drop/Promote actions (a later stage) own that field's lifecycle.
//
// The client sends the WHOLE sub-object it's changing (the whole `menu`
// object to change one item, the whole `address` object to change one
// line), matching the array/object-replace convention already established
// for `menu.items` in Stage A/B — there's no per-field PATCH for anything
// nested one level deeper than this route's own top-level keys.

const PatchBodySchema = z.object({
  address: VenueAddressSchema.optional(),
  contact: VenueContactSchema.optional(),
  hours: VenueHoursSchema.optional(),
  amenities: VenueAmenitiesSchema.optional(),
  menu: VenueMenuSchema.optional(),
  staff: z.array(z.string()).optional(),
  qrEnrollmentMessage: z.string().optional(),
})

export const dynamic = 'force-dynamic'

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ venueId: string }> },
): Promise<NextResponse> {
  const { venueId } = await params
  const auth = await requireVenueAdmin(venueId)
  if (!auth.ok) return auth.response

  let body: z.infer<typeof PatchBodySchema>
  try {
    const raw = await request.json()
    const parsed = PatchBodySchema.safeParse(raw)
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'invalid body', detail: parsed.error.message },
        { status: 400 },
      )
    }
    body = parsed.data
  } catch {
    return NextResponse.json({ error: 'invalid json' }, { status: 400 })
  }

  const supabase = createAdminClient()
  const loaded = await loadVenueInfo(supabase, venueId)
  if (!loaded.ok) {
    return NextResponse.json({ error: 'venue_info lookup failed', detail: loaded.error }, { status: 500 })
  }

  const merged = { ...loaded.venueInfo, ...body }
  const validated = VenueInfoSchema.safeParse(merged)
  if (!validated.success) {
    return NextResponse.json(
      { error: 'venue_info invalid after merge', detail: validated.error.message },
      { status: 400 },
    )
  }

  const { error: writeErr } = await supabase
    .from('venue_configs')
    .update({ venue_info: toJson(validated.data) })
    .eq('venue_id', venueId)
  if (writeErr) {
    return NextResponse.json(
      { error: 'venue_info write failed', detail: writeErr.message },
      { status: 500 },
    )
  }

  return NextResponse.json({ success: true, venueInfo: validated.data })
}
