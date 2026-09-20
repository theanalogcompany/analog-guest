// TAC-476: order the conversations dropdown by a guest's most recent activity.
//
// Pure, so the ordering can be tested without a page render. The page fetches
// the venue's guests and calls `venue_guest_activity` in parallel, then joins
// them here.
//
// Before this, the page ordered on `guests.last_interaction_at`, which is
// written once at guest creation and never updated — it equals
// `first_contacted_at` on every row but one, so the list was ordered by
// enrollment date.
//
// ORDERING IS NOT COSMETIC HERE. The page caps the list at RECENT_GUESTS_LIMIT,
// so at a venue with more guests than the cap, sorting by enrollment made an
// active guest unselectable rather than merely mis-sorted — the same truncation
// shape TAC-316 fixed in the thread query, on a different column.

/** A guest with no activity at all. Sorts last, never dropped. */
const NO_ACTIVITY = -1

export interface GuestActivityRow {
  guest_id: string
  /**
   * `max(created_at)` across both directions for this guest at this venue.
   *
   * `db/types.ts` types every RPC return column non-null, which is a lie the
   * generator tells about every function in this schema. This one really is
   * non-null in practice — a guest only appears in the result at all if they
   * have at least one message, and `max()` over a non-empty group of a NOT NULL
   * column cannot be null — but the declared type is not what makes that true,
   * so `parseActivityTime` handles an unparseable value rather than trusting it.
   */
  last_interaction_at: string
}

export interface GuestLike {
  id: string
}

/**
 * Milliseconds for a timestamp, or NO_ACTIVITY when it cannot be read.
 * An unparseable value sorts a guest last rather than throwing or, worse,
 * seeding the comparator with NaN — `NaN - x` is NaN, which Array.sort treats
 * as "equal", silently scrambling the whole list rather than misplacing one row.
 */
function parseActivityTime(iso: string): number {
  const ms = new Date(iso).getTime()
  return Number.isFinite(ms) ? ms : NO_ACTIVITY
}

/**
 * Build the guest -> last-activity lookup the sort reads.
 */
export function activityIndex(rows: readonly GuestActivityRow[]): Map<string, number> {
  const index = new Map<string, number>()
  for (const row of rows) {
    index.set(row.guest_id, parseActivityTime(row.last_interaction_at))
  }
  return index
}

/**
 * Guests, most recently active first, capped at `limit`.
 *
 * Does not mutate its input. A guest with no activity row sorts last but stays
 * in the list — a venue's newest guest has no messages for the seconds between
 * their row being created and their first message landing, and dropping them
 * would make them unselectable in exactly that window.
 *
 * Ties break on guest id, so the order is total: two guests sharing a
 * millisecond (a seeded venue, or a split response) would otherwise sort
 * unstably across renders and make the dropdown jump between page loads.
 */
export function orderGuestsByActivity<T extends GuestLike>(
  guests: readonly T[],
  activity: ReadonlyMap<string, number>,
  limit: number,
): T[] {
  return [...guests]
    .sort((a, b) => {
      const delta = (activity.get(b.id) ?? NO_ACTIVITY) - (activity.get(a.id) ?? NO_ACTIVITY)
      return delta !== 0 ? delta : a.id.localeCompare(b.id)
    })
    .slice(0, limit)
}
