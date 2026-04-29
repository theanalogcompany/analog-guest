import { GUEST_STATES, type GuestState } from './types'

const STATE_RANK: Record<GuestState, number> = Object.fromEntries(
  GUEST_STATES.map((s, i) => [s, i]),
) as Record<GuestState, number>

/**
 * True when `current` meets or exceeds `min`. Null/undefined/empty `min` is
 * treated as ungated (returns true). Malformed `min` (a string that isn't one
 * of GUEST_STATES) logs and returns false — matches the "permissive schema +
 * filter-time validation" pattern (THE-150 / THE-170): a bad value drops the
 * gated item rather than crashing the agent run.
 */
export function isStateAtLeast(
  current: GuestState,
  min: string | null | undefined,
): boolean {
  if (!min) return true
  const minRank = STATE_RANK[min as GuestState]
  if (minRank === undefined) {
    console.warn(`[state-bands] unknown min_state "${min}" — treating as ineligible`)
    return false
  }
  return STATE_RANK[current] >= minRank
}