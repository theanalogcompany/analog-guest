import { isObligationType } from '@/lib/guests/commitment-expiry'
import type { VenueCommitmentRow } from '../../_lib/load-venue-commitments'

// TAC-381: pure display helpers for the venue page's commitments section.
// Split out of the component so they're unit-testable — this repo has no React
// component test harness (no .test.tsx anywhere, no jsdom in vitest.config),
// the same reason TAC-379 split definition-display.ts out.

const MS_PER_DAY = 24 * 60 * 60 * 1000

export type CommitmentKind = 'obligation' | 'recommendation'

/**
 * Obligation (money or product owed) vs recommendation (a suggestion).
 *
 * Delegates to isObligationType rather than re-listing comp/hold/discount.
 * That set is TAC-341's OBLIGATION_TYPES, deliberately an ALLOWLIST so a fifth
 * commitment type defaults to being left alone rather than inheriting a
 * negation nobody revisited — a local copy here would silently opt this page
 * out of that decision.
 */
export function classifyKind(row: Pick<VenueCommitmentRow, 'type'>): CommitmentKind {
  return isObligationType(row.type) ? 'obligation' : 'recommendation'
}

/** A human has been told about this obligation (TAC-341). */
export function isEscalated(row: Pick<VenueCommitmentRow, 'escalatedAt'>): boolean {
  return row.escalatedAt !== null
}

/**
 * No arrival information at all.
 *
 * This is the case the ticket was filed about: with both columns null the row
 * cannot match the arrival cron (findScheduledOpenCommitments requires
 * arrival_signal='scheduled' AND expected_arrival NOT NULL) and cannot reach
 * the operator heads-up queue (listHeadsUpQueue reads status='pending_ack'
 * only). It is visible nowhere but the agent's own prompt.
 */
export function isUntimed(
  row: Pick<VenueCommitmentRow, 'expectedArrival' | 'arrivalSignal'>,
): boolean {
  return row.expectedArrival === null && row.arrivalSignal === null
}

/**
 * Display rank. Lower sorts first.
 *
 * Escalated obligations lead because §2 asks for exactly that ("the most
 * important thing on the page and should read that way"). Recommendations sort
 * last because a comp must never be read as a suggestion.
 */
export function displayRank(row: VenueCommitmentRow): number {
  if (classifyKind(row) === 'recommendation') return 2
  return isEscalated(row) ? 0 : 1
}

/**
 * Sort for rendering: escalated obligations, then other obligations, then
 * recommendations; oldest first within each band, because age is what makes an
 * unclaimed promise worth looking at.
 *
 * Returns a new array — the input is a loader result that other callers may
 * read, and an in-place sort would reorder it under them.
 */
export function sortForDisplay(rows: readonly VenueCommitmentRow[]): VenueCommitmentRow[] {
  return [...rows].sort((a, b) => {
    const rank = displayRank(a) - displayRank(b)
    if (rank !== 0) return rank
    return a.createdAt.localeCompare(b.createdAt)
  })
}

/**
 * How long ago something happened, in whole days.
 *
 * Deliberately NOT lib/ai/prompts/serializers.ts's formatTimeDelta, even
 * though it computes something similar. That function is the AGENT'S PROMPT
 * VOCABULARY: importing it would mean a prompt-wording change silently
 * restyles this admin page, and a display tweak here would become an
 * agent-runtime change — which TAC-381 explicitly forbids. Two callers with
 * genuinely different jobs, kept apart on purpose. Do not "de-duplicate" these.
 */
export function formatAge(iso: string, now: Date): string {
  const then = new Date(iso)
  if (Number.isNaN(then.getTime())) return iso
  const days = Math.floor((now.getTime() - then.getTime()) / MS_PER_DAY)
  if (days < 0) return 'in the future'
  if (days === 0) return 'today'
  if (days === 1) return '1 day ago'
  return `${days} days ago`
}

/**
 * The expiry cell.
 *
 * A null horizon is rendered as a STATEMENT, never as a blank. TAC-341 scoped
 * expiry to obligations, so every recommendation carries a null expires_at
 * forever (TAC-380 owns that), and pre-TAC-341 obligations carry null until
 * the hand-applied backfill runs. A blank cell reads as missing data; these
 * two absences mean different things and the page says which.
 */
export function formatExpiry(
  row: Pick<VenueCommitmentRow, 'expiresAt' | 'type'>,
  now: Date,
): string {
  if (row.expiresAt === null) {
    return isObligationType(row.type) ? 'no horizon set' : 'no horizon'
  }
  const at = new Date(row.expiresAt)
  if (Number.isNaN(at.getTime())) return row.expiresAt
  // FLOOR, not ceil: whole days actually remaining. Ceil rounds a horizon six
  // hours away up to "expires in 1 day", which overstates the time left on an
  // obligation about to lapse — the wrong direction to be wrong in — and
  // leaves "expires today" reachable only on an exact-millisecond tie.
  const days = Math.floor((at.getTime() - now.getTime()) / MS_PER_DAY)
  if (days < 0) return 'past due'
  if (days === 0) return 'expires today'
  if (days === 1) return 'expires in 1 day'
  return `expires in ${days} days`
}
