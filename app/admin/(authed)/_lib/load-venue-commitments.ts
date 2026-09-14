import { cache } from 'react'
import { createAdminClient } from '@/lib/db/admin'
import {
  GuestCommitmentRowSchema,
  type ArrivalSignal,
  type CommitmentStatus,
  type CommitmentType,
} from '@/lib/schemas/guest-commitment'
import { guestNameWithPhone } from './guest-name'

// TAC-381: every commitment for one venue, for the read-only venue page.
// Mirrors load-intention-prompts.ts's shape — cache(), createAdminClient, the
// guest join riding a PostgREST embedded relation in one round trip rather
// than an N+1, and warn-and-degrade rather than throw so a DB hiccup costs
// this section and leaves the rest of the venue page intact.
//
// Deliberately NOT in lib/guests/commitments.ts. Every read there is consumed
// by the agent or a cron; this one is consumed by an admin page and by nothing
// else. Adding it there to "keep commitment reads together" would widen a
// hot-path module for a surface the runtime never calls.
//
// NOT on the agent's hot path. Runs on one admin page render.

/**
 * Every commitment status, assigned to exactly one of the page's two lists.
 *
 * A TOTAL map via `satisfies Record<CommitmentStatus, …>`, which is what makes
 * a seventh status a `tsc` error here rather than a row that matches neither
 * `.in()` filter and is invisible on the page with nothing to indicate it
 * exists. The same mechanism `push-policy.ts` uses for `ApprovalTrigger`.
 *
 * An earlier version of this was two hand-written arrays typed
 * `readonly CommitmentStatus[]` carrying this exact claim in a comment. The
 * claim was FALSE — an array type is not exhaustiveness-checked, so adding a
 * status compiled clean and the whole suite stayed green. Caught in code
 * review by actually adding one. The arrays below are derived, so the
 * guarantee is now the one the comment describes.
 */
const STATUS_PARTITION = {
  // Still owed. The same set the agent's `## Active commitments` block renders
  // (findActiveCommitmentsForGuest) and the same set migration 026's
  // `idx_guest_commitments_active_for_guest` partial index covers, so the open
  // query is indexed on its leading `venue_id`.
  open: 'nonTerminal',
  pending_ack: 'nonTerminal',
  // History. Separated and secondary on the page, never mixed with the above.
  acknowledged: 'terminal',
  redeemed: 'terminal',
  expired: 'terminal',
  cancelled: 'terminal',
} satisfies Record<CommitmentStatus, 'nonTerminal' | 'terminal'>

const ALL_STATUSES = Object.keys(STATUS_PARTITION) as CommitmentStatus[]

export const NON_TERMINAL_STATUSES: readonly CommitmentStatus[] = ALL_STATUSES.filter(
  (s) => STATUS_PARTITION[s] === 'nonTerminal',
)

export const TERMINAL_STATUSES: readonly CommitmentStatus[] = ALL_STATUSES.filter(
  (s) => STATUS_PARTITION[s] === 'terminal',
)

/**
 * Cap on the secondary history list. Bounded and STATED on the page rather
 * than applied silently, per the TAC-316 lesson: a cap nobody can see reads as
 * "this is all there is."
 */
export const CLOSED_COMMITMENTS_LIMIT = 20

export interface VenueCommitmentRow {
  id: string
  type: CommitmentType
  status: CommitmentStatus
  description: string
  code: string | null
  guestLabel: string
  createdAt: string
  expiresAt: string | null
  escalatedAt: string | null
  expectedArrival: string | null
  arrivalSignal: ArrivalSignal | null
}

export interface VenueCommitments {
  open: VenueCommitmentRow[]
  closed: VenueCommitmentRow[]
  /** True only when a closed row beyond the cap actually exists. */
  closedHasMore: boolean
  /**
   * True when the open read failed and the list ran degraded.
   *
   * The page MUST branch on this rather than rendering its ordinary empty
   * state, because that state asserts the venue owes nobody anything — a
   * claim about money owed, made off a query that did not run. The sibling
   * intentions loader carries the same flag for the same reason; this is the
   * half where being wrong is more expensive.
   */
  openDegraded: boolean
  /**
   * True when the history read failed. Without it the closed block simply
   * vanishes (it renders only when non-empty), which is indistinguishable
   * from a venue that has never closed a commitment.
   */
  closedDegraded: boolean
}

interface JoinedGuestShape {
  first_name: string | null
  last_name: string | null
  phone_number: string
}

/** PostgREST returns a to-one embed as an object, but has returned arrays; normalize both. */
function firstOrNull<T>(raw: T | T[] | null): T | null {
  return Array.isArray(raw) ? (raw[0] ?? null) : raw
}

const SELECT =
  'id, type, status, description, code, created_at, expires_at, escalated_at, expected_arrival, arrival_signal, guest_id, venue_id, created_by, updated_at, acknowledged_at, acknowledged_by, redeemed_at, source_message_id, guest:guests!inner(first_name, last_name, phone_number)'

/**
 * Project a raw row, parsed through the canonical schema, into the display
 * shape. Returns null when the row does not parse.
 *
 * Logged rather than silently skipped: GuestCommitmentRowSchema closes the
 * type/status/arrival_signal enums, so a future migration widening any of them
 * without updating the schema would empty this page with nothing to show for
 * it — the same failure findOpenObligations guards against.
 */
function projectRow(raw: unknown): VenueCommitmentRow | null {
  const row = raw as Record<string, unknown> & { guest?: unknown }
  const parsed = GuestCommitmentRowSchema.safeParse(row)
  if (!parsed.success) {
    console.warn(
      `[loadVenueCommitments] skipping unparseable guest_commitments row: ${parsed.error.message}`,
    )
    return null
  }
  const guest = firstOrNull(row.guest as JoinedGuestShape | JoinedGuestShape[] | null)
  return {
    id: parsed.data.id,
    type: parsed.data.type,
    status: parsed.data.status,
    description: parsed.data.description,
    code: parsed.data.code,
    guestLabel: guest
      ? guestNameWithPhone({
          firstName: guest.first_name,
          lastName: guest.last_name,
          phoneNumber: guest.phone_number,
        })
      : '(unknown guest)',
    createdAt: parsed.data.created_at,
    expiresAt: parsed.data.expires_at,
    escalatedAt: parsed.data.escalated_at,
    expectedArrival: parsed.data.expected_arrival,
    arrivalSignal: parsed.data.arrival_signal,
  }
}

export const loadVenueCommitments = cache(_loadVenueCommitments)

async function _loadVenueCommitments(venueId: string): Promise<VenueCommitments> {
  const supabase = createAdminClient()

  // Two queries, not one filtered in JS: the open set must be complete
  // (an uncapped comp is the whole point of the page) while the closed set is
  // history and is capped. One query would force a single cap across both, and
  // a busy month of expiries could then push a live obligation off the page.
  const [openResult, closedResult] = await Promise.all([
    supabase
      .from('guest_commitments')
      .select(SELECT)
      .eq('venue_id', venueId)
      .in('status', [...NON_TERMINAL_STATUSES])
      .order('created_at', { ascending: true }),
    supabase
      .from('guest_commitments')
      .select(SELECT)
      .eq('venue_id', venueId)
      .in('status', [...TERMINAL_STATUSES])
      .order('updated_at', { ascending: false })
      .limit(CLOSED_COMMITMENTS_LIMIT + 1),
  ])

  let open: VenueCommitmentRow[] = []
  let openDegraded = false
  if (openResult.error) {
    openDegraded = true
    console.warn(
      `[loadVenueCommitments] open commitments query failed: ${openResult.error.message}`,
    )
  } else {
    open = (openResult.data ?? [])
      .map(projectRow)
      .filter((r): r is VenueCommitmentRow => r !== null)
  }

  // The two halves degrade independently. A failure reading history must not
  // blank the open list, which is the half that represents money owed.
  let closed: VenueCommitmentRow[] = []
  let closedHasMore = false
  let closedDegraded = false
  if (closedResult.error) {
    closedDegraded = true
    console.warn(
      `[loadVenueCommitments] closed commitments query failed: ${closedResult.error.message}`,
    )
  } else {
    const all = closedResult.data ?? []
    // Fetch cap + 1 and drop the probe, rather than comparing length to the
    // cap: that comparison cannot tell exactly-at-cap from over-cap, and the
    // page states "older exist" as fact.
    closedHasMore = all.length > CLOSED_COMMITMENTS_LIMIT
    closed = all
      .slice(0, CLOSED_COMMITMENTS_LIMIT)
      .map(projectRow)
      .filter((r): r is VenueCommitmentRow => r !== null)
  }

  return { open, closed, closedHasMore, openDegraded, closedDegraded }
}
