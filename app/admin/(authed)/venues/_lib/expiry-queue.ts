import { classifyContextEntry, type VenueContextNote } from '@/lib/schemas'

// Partitions currentContext entries for the venue page's "Right now" section
// + expiry queue (TAC-343 §2). Built on `classifyContextEntry` (extracted
// from lib/schemas/venue-info.ts in this same ticket) so this can't drift
// from what the agent's own `filterActiveContext` considers active — the
// two read the identical per-entry classification.
//
// Unlike filterActiveContext (which only needs the active half for the
// prompt), the admin page needs to show every non-active entry too — that's
// the point of the expiry queue. `malformed` gets its own bucket rather than
// being folded into `expired`: an entry with a broken expiresAt string may
// still hold a perfectly good permanent fact once the date is fixed or
// dropped, which is a different operator action than "this one's done."

export interface PartitionedContext<T extends VenueContextNote> {
  active: T[]
  expired: T[]
  malformed: T[]
}

export function partitionCurrentContext<T extends VenueContextNote>(
  entries: readonly T[],
  now: Date,
): PartitionedContext<T> {
  const active: T[] = []
  const expired: T[] = []
  const malformed: T[] = []

  for (const entry of entries) {
    const classification = classifyContextEntry(entry, now)
    if (classification === 'active') active.push(entry)
    else if (classification === 'expired') expired.push(entry)
    else malformed.push(entry)
  }

  return { active, expired, malformed }
}
