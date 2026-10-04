import { NextResponse } from 'next/server'
import { requireVenueAdmin } from '@/lib/auth'
import { createAdminClient } from '@/lib/db/admin'
import {
  activityIndex,
  orderGuestsByActivity,
} from '@/app/admin/(authed)/conversations/lib/order-guests-by-activity'
import type {
  GuestListItem,
  GuestListResponse,
} from '@/app/admin/(authed)/playground/_lib/types'

// GET /admin/playground/api/venues/[venueId]/guests - the replay-mode guest
// picker. Same two-query join as the conversations dropdown (guests +
// venue_guest_activity, ordered by derived activity), but as a route handler
// because the playground picks venues client-side without a navigation.
//
// Degrades like the sibling loaders: a failed activity read costs the
// ordering and the lastMessageAt column, never the list - and the response
// carries `activityDegraded` so the page can say so rather than render a
// silently mis-ordered list as fact.

export const dynamic = 'force-dynamic'
export const maxDuration = 30

const GUEST_LIMIT = 50
/** Bounded fetch before the in-JS activity sort; see load-venue-guests.ts FETCH_CEILING. */
const FETCH_CEILING = 2000

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ venueId: string }> },
): Promise<NextResponse> {
  const { venueId } = await params
  const auth = await requireVenueAdmin(venueId)
  if (!auth.ok) return auth.response

  const supabase = createAdminClient()
  const [guestsResult, activityResult] = await Promise.all([
    supabase
      .from('guests')
      .select(
        'id, first_name, last_name, phone_number, instagram_username, first_contacted_at',
      )
      .eq('venue_id', venueId)
      .order('first_contacted_at', { ascending: false, nullsFirst: false })
      .limit(FETCH_CEILING),
    supabase.rpc('venue_guest_activity', { p_venue_id: venueId }),
  ])

  if (guestsResult.error) {
    return NextResponse.json(
      { error: 'guest list load failed', detail: guestsResult.error.message },
      { status: 500 },
    )
  }

  const activityRows = activityResult.error ? [] : (activityResult.data ?? [])
  const activityDegraded =
    activityResult.error !== null || activityResult.data === null
  const lastMessageAt = new Map(
    activityRows.map((r) => [r.guest_id, r.last_interaction_at]),
  )

  const ordered = orderGuestsByActivity(
    guestsResult.data ?? [],
    activityIndex(activityRows),
    GUEST_LIMIT,
  )

  const guests: GuestListItem[] = ordered.map((g) => ({
    id: g.id,
    displayName: displayName(g),
    lastMessageAt: lastMessageAt.get(g.id) ?? null,
  }))

  const response: GuestListResponse = { guests, activityDegraded }
  return NextResponse.json(response)
}

function displayName(g: {
  id: string
  first_name: string | null
  last_name: string | null
  phone_number: string | null
  instagram_username: string | null
}): string {
  const name = [g.first_name, g.last_name].filter(Boolean).join(' ')
  if (name.length > 0) return name
  if (g.phone_number) return `…${g.phone_number.slice(-4)}`
  if (g.instagram_username) return `@${g.instagram_username}`
  return g.id.slice(0, 8)
}
