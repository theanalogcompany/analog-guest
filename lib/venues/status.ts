// TAC-529: what `venues.status` means for processing.
//
// THE COLUMN EXISTED FROM MIGRATION 001 AND NOTHING READ IT. Before this,
// `venues.status` had exactly two readers in the repo and neither changed what
// ran: the Command Center conversations page rendered it as a label and a dot,
// and `scripts/onboarding/load-venue-context.ts`'s `assertVenueGuard` refused
// an OFFLINE test-scenario run when the status IS 'active'. So the only
// forceful reader ran backwards, and migration 001 built `idx_venues_status`
// for a filter nobody ever wrote. Mock Central Perk was set to `paused` at
// 16:30Z on 2026-09-23 and went on failing hourly at 17:10Z, which is the
// evidence that pausing a venue paused nothing.
//
// A DENY-LIST, NEVER AN ALLOW-LIST ON 'active'. This is the load-bearing
// decision in the file and it is a fact about production data, not taste:
// the statuses are inverted relative to any natural reading. Le Mil's, the
// only live venue, is 'pending'; both mock venues are 'active' (checked
// 2026-09-23). An allow-list admitting 'active' would therefore have switched
// the pilot venue off on the day it merged. This repo has already paid for the
// allow-list version of this mistake once: `shouldSendDraftFlaggedPush` was an
// allow-list, two triggers added later fell outside it, and pushes for them
// were silently dropped for two months. `PUSH_POLICY` is a deny-list now for
// exactly this reason, and this map copies it.
//
// 'pending' PROCESSES, and that is a decision rather than an omission. It is
// migration 001's `default 'pending'`, so it is what every venue row gets on
// creation and what `scripts/seed-venue.ts` prints a note about; making the
// default mean "off" is the one change here that could take a live venue down.
// Ruled 2026-09-23: it behaves like 'active' everywhere, INBOUND INCLUDED, so
// the fact that Le Mil's replies to guests today is a stated rule and not an
// accident of the field going unread.
//
// Domain-free on the `message-channel.ts` / `review-state.ts` model, and for
// the same stated reason: it has three callers that must agree and must not
// import each other — the follow-up engine (`lib/followups/engine.ts`), the
// arrival push (`lib/guests/commitments-due.ts`) and the inbound agent
// (`lib/agent/handle-inbound.ts`). Deliberately NOT added to `lib/venues/
// index.ts`: consumers import it by path, and a barrel entry would add a
// second import route for no gain.

/**
 * Every value `venues.status` can hold.
 *
 * The strict half is migration 001's `venues_status_check`, which permits
 * exactly these four. This list moves with it, and `status.test.ts` reads the
 * migration to hold the two equal, because SQL cannot import a constant.
 */
export const VENUE_STATUSES = ['pending', 'active', 'paused', 'archived'] as const

export type VenueStatus = (typeof VENUE_STATUSES)[number]

/**
 * Whether a venue's status stops us acting for it.
 *
 * `halted` means: no follow-up, no arrival push, no reply to an inbound. The
 * guest's message is still SAVED either way — see `handle-inbound.ts`; the
 * history is what you want when the venue is unpaused.
 */
export type VenueProcessing = 'process' | 'halted'

/**
 * The deny-list, as a TOTAL map.
 *
 * `satisfies Record<VenueStatus, VenueProcessing>` is what makes a fifth
 * status a `tsc` failure rather than something that silently inherits a
 * default. Adding one to `VENUE_STATUSES` without deciding here does not
 * compile. That is the same discipline `PUSH_POLICY` and
 * `CONVERSATION_CHANNEL_FACT` carry, for the same reason.
 */
export const VENUE_PROCESSING = {
  // Default on creation, and what the live pilot venue carries. See the
  // header: treating this as "not live yet" switches off real venues.
  pending: 'process',
  active: 'process',
  // The two that stop things. This is the whole point of the ticket.
  paused: 'halted',
  archived: 'halted',
} as const satisfies Record<VenueStatus, VenueProcessing>

export function isVenueStatus(value: unknown): value is VenueStatus {
  return (VENUE_STATUSES as readonly unknown[]).includes(value)
}

/**
 * Narrow a raw `venues.status` value to `VenueStatus`, or null.
 *
 * Permissive at the live boundary, per CLAUDE.md's strict-offline /
 * permissive-live split. The CHECK constraint is the strict half, so this only
 * fires on a value the constraint was widened to allow without this list
 * moving too — a deploy-ordering mistake, not a state a venue can reach on its
 * own. Null is not a guess at a status; `isVenueProcessingHalted` decides what
 * an unreadable one means.
 */
export function parseVenueStatus(value: string | null | undefined): VenueStatus | null {
  if (isVenueStatus(value)) return value
  if (value !== null && value !== undefined) {
    console.warn(`[venue-status] unrecognized venues.status "${value}", treating as unknown`)
  }
  return null
}

/**
 * Should we stop acting for this venue?
 *
 * The single predicate behind every gate this ticket adds, so the follow-up
 * engine, the arrival push and the inbound agent cannot drift on what "paused"
 * means. Two copies of a rule agree until one of them changes.
 *
 * AN UNREADABLE STATUS PROCESSES, and the direction is deliberate. Both
 * failures are real — a venue someone tried to stop keeps talking, versus a
 * venue that should be talking goes silent — and this one is chosen because a
 * value outside the CHECK can only arrive by someone widening the constraint
 * ahead of the code, while going quiet on a live venue would be caused by the
 * ordinary case of a column nobody has touched. It is also what keeps the
 * deny-list honest: only the two named values halt anything, and everything
 * else, known or not, carries on. It warns, so the misconfiguration is not
 * silent.
 */
export function isVenueProcessingHalted(value: string | null | undefined): boolean {
  const status = parseVenueStatus(value)
  if (status === null) return false
  return VENUE_PROCESSING[status] === 'halted'
}
