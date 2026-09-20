// TAC-476: the conversations dropdown's guest list, ordered by derived
// activity.
//
// Extracted out of the page so the WIRING is testable, not just the sort.
// `orderGuestsByActivity` had full unit coverage while the page's calls into
// it had none: a mutant that ignored the RPC entirely, and one that asked for
// the wrong venue, both passed the whole 4967-test suite. Reverting the page to
// the old enrollment ordering would have been green. Same remedy the engine
// got in this ticket and `heads-up-queue.ts` got in TAC-364 — capture the query
// arguments, because a mock answers whatever it is asked.
//
// Degrade-gracefully, like the sibling loaders here: a failed read costs the
// ordering, never the page.

import type { createAdminClient } from '@/lib/db/admin'
import {
  activityIndex,
  orderGuestsByActivity,
} from '../conversations/lib/order-guests-by-activity'

type AdminSupabaseClient = ReturnType<typeof createAdminClient>

export interface VenueGuestRow {
  id: string
  first_name: string | null
  last_name: string | null
  phone_number: string | null
  instagram_username: string | null
  first_contacted_at: string | null
}

export interface VenueGuestsResult {
  rows: VenueGuestRow[]
  /**
   * The activity read failed, so the list is ordered by enrollment alone.
   *
   * Surfaced rather than swallowed because the failure is otherwise INVISIBLE:
   * with no activity index every guest ties, the fallback ordering takes over,
   * and the operator sees a full, plausible-looking dropdown that is simply in
   * the wrong order. The engine chooses the opposite posture on the same RPC
   * (it refuses to scan the venue); this is a read-only debug surface where a
   * mis-ordered list beats no list.
   */
  activityDegraded: boolean
}

/**
 * A venue's guests, most recently active first, capped at `limit`.
 *
 * `FETCH_CEILING` bounds the unbounded read. It is deliberately far above any
 * plausible `limit`: the cap that matters is applied AFTER sorting by activity,
 * and this one only exists so a venue with an enormous guest list degrades
 * deterministically rather than on whatever order Postgres happens to return.
 * Ordering the fetch by `first_contacted_at` makes that degradation biased
 * toward recent enrollment, which is the old behaviour of this query and the
 * least surprising thing to lose first. A venue past the ceiling would still
 * hide an active long-enrolled guest — the TAC-316 truncation shape — so if one
 * ever approaches it, the fix is to order in SQL against the RPC, not to raise
 * the number.
 */
export const FETCH_CEILING = 2000

export async function loadVenueGuestsByActivity(
  supabase: AdminSupabaseClient,
  venueId: string,
  limit: number,
): Promise<VenueGuestsResult> {
  const [guestsResult, activityResult] = await Promise.all([
    supabase
      .from('guests')
      .select('id, first_name, last_name, phone_number, instagram_username, first_contacted_at')
      .eq('venue_id', venueId)
      .order('first_contacted_at', { ascending: false, nullsFirst: false })
      .limit(FETCH_CEILING),
    supabase.rpc('venue_guest_activity', { p_venue_id: venueId }),
  ])

  if (guestsResult.error) {
    console.warn('[admin] conversations: guest list load failed', {
      venueId,
      error: guestsResult.error.message,
    })
    return { rows: [], activityDegraded: false }
  }

  const activityDegraded = activityResult.error !== null || activityResult.data === null
  if (activityDegraded) {
    console.warn('[admin] conversations: guest activity load failed; list is ordered by enrollment', {
      venueId,
      error: activityResult.error?.message ?? 'no rows returned',
    })
  }

  return {
    rows: orderGuestsByActivity(
      guestsResult.data ?? [],
      activityIndex(activityResult.data ?? []),
      limit,
    ),
    activityDegraded,
  }
}
