import { NextResponse } from 'next/server'
import { z } from 'zod'
import { requireVenueAdmin } from '@/lib/auth'
import { addCurrentContextEntry } from '../../../../../_lib/current-context'

// POST /admin/venues/api/venues/[venueId]/current-context — add a new
// "right now" note. Venue-scoped, not entry-scoped: currentContext entries
// are array elements inside venue_info, not their own DB rows, so there's
// no per-entry auth lookup — requireVenueAdmin(venueId) is the whole check.

const PostBodySchema = z.object({
  content: z.string().min(1),
  // Permanent entries (no expiry) are valid per VenueContextNoteSchema, but
  // currentContext's whole purpose is time-bound facts — the UI defaults to
  // asking for a date without hard-requiring one.
  expiresAt: z.string().optional(),
})

export const dynamic = 'force-dynamic'

export async function POST(
  request: Request,
  { params }: { params: Promise<{ venueId: string }> },
): Promise<NextResponse> {
  const { venueId } = await params
  const auth = await requireVenueAdmin(venueId)
  if (!auth.ok) return auth.response

  let body: z.infer<typeof PostBodySchema>
  try {
    const raw = await request.json()
    const parsed = PostBodySchema.safeParse(raw)
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

  const result = await addCurrentContextEntry({
    venueId,
    content: body.content,
    expiresAt: body.expiresAt,
  })
  if (!result.ok) {
    const status = result.errorCode === 'invalid_after_merge' ? 400 : 500
    return NextResponse.json(
      { error: 'currentContext add failed', detail: result.error, errorCode: result.errorCode },
      { status },
    )
  }

  return NextResponse.json({ success: true, entry: result.entry })
}
