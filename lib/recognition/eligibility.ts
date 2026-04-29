import { z } from 'zod'
import { isStateAtLeast } from './state-bands'
import type { GuestState } from './types'

export type MechanicType = 'perk' | 'referral' | 'content_unlock' | 'event_invite' | 'merch'
export type RedemptionPolicy = 'one_time' | 'renewable'

/**
 * Shape of `engagement_events.data` for rows where `event_type =
 * 'mechanic_redeemed'`. The `engagement_events.mechanic_id` FK column is the
 * source of truth for which mechanic was redeemed; `mechanic_id` is repeated in
 * the data jsonb only as a defensive cross-check (and so SQL operators
 * inserting via the documented template don't have to look up the FK).
 *
 * No app code emits these rows yet — operators write redemptions directly via
 * SQL during the pilot. This schema documents the shape for future emitters.
 */
export const MechanicRedeemedDataSchema = z.object({
  mechanic_id: z.uuid(),
  source: z.enum(['operator_marked', 'agent_inferred', 'pos_derived']),
  recorded_by_operator_id: z.uuid().optional(),
  notes: z.string().optional(),
})

export type MechanicRedeemedData = z.infer<typeof MechanicRedeemedDataSchema>

export interface RedemptionRecord {
  mechanicId: string
  createdAt: Date
}

export interface EligibilityCandidate {
  id: string
  type: MechanicType
  name: string
  description: string | null
  qualification: string | null
  rewardDescription: string | null
  minState: string | null
  redemptionPolicy: RedemptionPolicy
  redemptionWindowDays: number | null
}

export interface EligibleMechanic {
  id: string
  type: MechanicType
  name: string
  description: string | null
  qualification: string | null
  rewardDescription: string | null
  minState: GuestState | null
}

const MS_PER_DAY = 24 * 60 * 60 * 1000

/**
 * True when an active redemption exists for this mechanic. 'one_time' policy
 * blocks forever after any redemption; 'renewable' blocks only within the
 * configured window. Misconfigured renewable (no window_days) is treated as
 * blocked defensively — the DB CHECK constraint should prevent this state but
 * a runtime drift shouldn't crash the agent.
 */
export function isRedemptionActive(
  redemptions: readonly RedemptionRecord[],
  mechanic: Pick<EligibilityCandidate, 'id' | 'redemptionPolicy' | 'redemptionWindowDays'>,
  now: Date,
): boolean {
  const forThisMechanic = redemptions.filter((r) => r.mechanicId === mechanic.id)
  if (forThisMechanic.length === 0) return false
  if (mechanic.redemptionPolicy === 'one_time') return true
  if (mechanic.redemptionWindowDays === null) {
    console.warn(
      `[eligibility] mechanic "${mechanic.id}" has redemption_policy='renewable' but no redemption_window_days — treating as blocked`,
    )
    return true
  }
  const windowMs = mechanic.redemptionWindowDays * MS_PER_DAY
  const mostRecentMs = forThisMechanic.reduce(
    (latest, r) => Math.max(latest, r.createdAt.getTime()),
    0,
  )
  return now.getTime() - mostRecentMs < windowMs
}

/**
 * Drop mechanics ineligible for the guest's current state OR currently
 * blocked by an active redemption. Order is preserved.
 */
export function filterEligibleMechanics(
  mechanics: readonly EligibilityCandidate[],
  redemptions: readonly RedemptionRecord[],
  currentState: GuestState,
  now: Date,
): EligibleMechanic[] {
  return mechanics
    .filter((m) => isStateAtLeast(currentState, m.minState))
    .filter((m) => !isRedemptionActive(redemptions, m, now))
    .map((m) => ({
      id: m.id,
      type: m.type,
      name: m.name,
      description: m.description,
      qualification: m.qualification,
      rewardDescription: m.rewardDescription,
      minState: (m.minState as GuestState | null) ?? null,
    }))
}