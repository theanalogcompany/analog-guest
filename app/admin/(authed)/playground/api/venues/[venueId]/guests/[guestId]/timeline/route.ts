import { NextResponse } from 'next/server'
import { z } from 'zod'
import { requireVenueAdmin } from '@/lib/auth'
import { createAdminClient } from '@/lib/db/admin'
import type {
  TimelineMessage,
  TimelineResponse,
} from '@/app/admin/(authed)/playground/_lib/types'

// GET /admin/playground/api/venues/[venueId]/guests/[guestId]/timeline - the
// replay-mode message timeline. Windowed NEWEST-first and reversed in JS
// (the conversations-viewer lesson: an ASC LIMIT keeps the oldest rows and
// hides everything newer the night a guest crosses the cap), fetched
// LIMIT + 1 so `hasMore` is a fact rather than an inference from length.

export const dynamic = 'force-dynamic'
export const maxDuration = 30

// Not exported: Next's route-module type check rejects non-handler exports.
const TIMELINE_LIMIT = 50

const UuidSchema = z.string().uuid()

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ venueId: string; guestId: string }> },
): Promise<NextResponse> {
  const { venueId, guestId } = await params
  const auth = await requireVenueAdmin(venueId)
  if (!auth.ok) return auth.response

  if (!UuidSchema.safeParse(guestId).success) {
    return NextResponse.json({ error: 'invalid guestId' }, { status: 400 })
  }

  const supabase = createAdminClient()

  // Scope the guest to the venue before reading messages - a guest id from
  // another venue must 404, not leak a cross-venue timeline.
  const guestRow = await supabase
    .from('guests')
    .select('id')
    .eq('id', guestId)
    .eq('venue_id', venueId)
    .maybeSingle()
  if (guestRow.error) {
    return NextResponse.json(
      { error: 'guest lookup failed', detail: guestRow.error.message },
      { status: 500 },
    )
  }
  if (!guestRow.data) {
    return NextResponse.json({ error: 'guest not found' }, { status: 404 })
  }

  const { data, error } = await supabase
    .from('messages')
    .select('id, direction, body, status, created_at')
    .eq('venue_id', venueId)
    .eq('guest_id', guestId)
    .order('created_at', { ascending: false })
    .limit(TIMELINE_LIMIT + 1)
  if (error) {
    return NextResponse.json(
      { error: 'timeline load failed', detail: error.message },
      { status: 500 },
    )
  }

  const rows = data ?? []
  const hasMore = rows.length > TIMELINE_LIMIT
  const windowed = rows.slice(0, TIMELINE_LIMIT).reverse()

  const messages: TimelineMessage[] = windowed.map((m) => ({
    id: m.id,
    direction: m.direction === 'inbound' ? 'inbound' : 'outbound',
    body: m.body ?? '',
    status: m.status,
    createdAt: m.created_at,
  }))

  const response: TimelineResponse = { messages, hasMore }
  return NextResponse.json(response)
}
