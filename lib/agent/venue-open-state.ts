// TAC-363: the one place the agent runtime decides whether a venue is open.
//
// Before this ticket there was exactly one consumer — `buildAiRuntime`, which
// rendered the verdict as the `- Status:` line TAC-301 added to `## Right now`.
// TAC-363 adds two more: arrival capture (which must not record an arrival at a
// closed venue) and the approval gate (which holds a reply that confirms one).
// Three independent computations of the same verdict is how the three drift, so
// they share this function instead.
//
// It is deliberately thin. All the real work — parsing seven free-text weekday
// ranges, overnight ranges, the refusal to guess on ambiguous input — lives in
// `resolveOpenState` (lib/schemas/venue-hours.ts) and is not duplicated here.
// What this adds is the agent-runtime CONTRACT around that call: which fields
// it reads, and what an unreadable clock means.
//
// THE GOVERNING RULE IS INHERITED, NOT RESTATED: `resolveOpenState` never
// claims OPEN or CLOSED on input it did not positively understand. Every
// ambiguous case resolves to `unknown`. Callers here test `=== 'closed'` and
// nothing else, so `unknown` and `open` take the same path by construction
// rather than by each caller remembering to treat them alike — which is what
// ruling 2(a) of 2026-09-21 asks for ("unknown hours behave as open").
//
// On the invalid-timezone case, which is the one piece of reasoning worth
// keeping: `buildAiRuntime` guards its own render with a `timezoneSubstituted`
// flag, because when `isValidTimezone` fails it swaps in FALLBACK_TIMEZONE to
// render the clock and must not then resolve the verdict against a zone the
// venue does not live in. This function needs no such flag and is still
// equivalent, because it passes the venue's OWN timezone straight through:
// `venueLocalNow` builds an `Intl.DateTimeFormat` with it, that throws on an
// invalid zone exactly as `isValidTimezone`'s own probe does, and
// `resolveOpenState` maps the throw to `unknown`. Same verdict, one fewer
// moving part. `venue-open-state.test.ts` pins that equivalence directly so a
// future change to either side cannot quietly break it.

import type { OpenState, VenueInfo } from '@/lib/schemas'
import { resolveOpenState } from '@/lib/schemas'

/**
 * The venue fields an open/closed verdict needs. A `Pick` rather than the whole
 * `VenueContext` so callers that hold only these two can pass them, and so a
 * test fixture does not have to build a venue it never reads.
 */
export interface VenueOpenStateInput {
  venueInfo: Pick<VenueInfo, 'hours'>
  timezone: string
}

/**
 * Resolve whether this venue is open at `now`, on its own clock.
 *
 * Returns `unknown` whenever the hours or the timezone cannot be positively
 * understood. Callers must treat `unknown` as "do not act", never as closed:
 * see the module header.
 */
export function resolveVenueOpenState(venue: VenueOpenStateInput, now: Date): OpenState {
  return resolveOpenState(venue.venueInfo.hours, venue.timezone, now)
}

/**
 * True only when the venue is positively known to be closed.
 *
 * Exists so no caller has to write `=== 'closed'` itself. That comparison is
 * correct and the negation of it is not: `!== 'open'` folds `unknown` in with
 * `closed` and inverts ruling 2(a) on every venue whose hours nobody has filled
 * in. Naming the safe form once is cheaper than catching the unsafe one in
 * review each time a consumer is added.
 */
export function isVenueClosed(venue: VenueOpenStateInput, now: Date): boolean {
  return resolveVenueOpenState(venue, now).state === 'closed'
}
