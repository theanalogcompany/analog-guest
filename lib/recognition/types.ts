import { z } from 'zod'

// Order is meaningful: state-bands ranking compares by index ('new' < 'returning'
// < 'regular' < 'raving_fan'). See lib/recognition/state-bands.ts.
export const GUEST_STATES = ['new', 'returning', 'regular', 'raving_fan'] as const
export type GuestState = (typeof GUEST_STATES)[number]

export type EngagementEventWeights = {
  first_visit: number
  perk_unlocked: number
  perk_redeemed: number
  mechanic_redeemed: number
  event_attended: number
  merch_redeemed: number
  milestone_reached: number
}

// Excluded from the engagement signal because they overlap with other base
// signals or are otherwise out of scope for v1:
//   - return_visit       → already counted by visit-frequency signal
//   - message_engagement → already counted by response-rate signal
//   - referral_made      → already counted by referrals signal
//   - state_transition   → meta-event about this module's own writes
//   - community_join     → TODO: revisit weighting once community ships
// Renamed from your original 'first_contact', which is not in the
// engagement_events.event_type check constraint; the equivalent is 'first_visit'.
//
// 'mechanic_redeemed' (THE-170) is the unified redemption event for any
// mechanic regardless of underlying type. Legacy 'perk_redeemed' /
// 'merch_redeemed' weights are kept at parity for back-compat but new code
// emits 'mechanic_redeemed' only.
export const ENGAGEMENT_EVENT_WEIGHTS: EngagementEventWeights = {
  first_visit: 1,
  perk_unlocked: 0.5,
  perk_redeemed: 3,
  mechanic_redeemed: 3,
  event_attended: 4,
  merch_redeemed: 3,
  milestone_reached: 2,
}

export type RelationshipSignals = {
  recency: number
  visitFrequency: number
  engagementEvents: number
  moneySpent: number
  responseRate: number
  percentMenuExplored: number
  referrals: number
  appliedMultipliers: { distance: number; consistency: number; total: number }
}

export const RelationshipStrengthFormulaSchema = z.object({
  schemaVersion: z.literal(1),
  weights: z.object({
    recency: z.number(),
    visitFrequency: z.number(),
    engagementEvents: z.number(),
    moneySpent: z.number(),
    responseRate: z.number(),
    percentMenuExplored: z.number(),
    referrals: z.number(),
  }),
  multipliers: z.object({
    distance: z.object({
      bands: z.array(
        z.object({
          maxMiles: z.number().nullable(),
          factor: z.number(),
        }),
      ),
    }),
    consistency: z.object({
      bands: z.array(
        z.object({
          maxVariance: z.number().nullable(),
          factor: z.number(),
        }),
      ),
    }),
  }),
  multiplierStackingCap: z.number(),
})

export type RelationshipStrengthFormula = z.infer<typeof RelationshipStrengthFormulaSchema>

export const StateThresholdsSchema = z.object({
  schemaVersion: z.literal(1),
  thresholds: z.array(
    z.object({
      state: z.enum(GUEST_STATES),
      minScore: z.number(),
      maxScore: z.number(),
    }),
  ),
})

export type StateThresholds = z.infer<typeof StateThresholdsSchema>

export const DEFAULT_FORMULA: RelationshipStrengthFormula = {
  schemaVersion: 1,
  weights: {
    recency: 0.25,
    visitFrequency: 0.20,
    engagementEvents: 0.15,
    moneySpent: 0.10,
    responseRate: 0.10,
    percentMenuExplored: 0.10,
    referrals: 0.10,
  },
  multipliers: {
    distance: {
      bands: [
        { maxMiles: 1, factor: 1.0 },
        { maxMiles: 5, factor: 1.1 },
        { maxMiles: 15, factor: 1.2 },
        { maxMiles: null, factor: 1.3 },
      ],
    },
    consistency: {
      bands: [
        { maxVariance: 5, factor: 1.2 },
        { maxVariance: 14, factor: 1.1 },
        { maxVariance: null, factor: 1.0 },
      ],
    },
  },
  multiplierStackingCap: 1.5,
}

export const DEFAULT_STATE_THRESHOLDS: StateThresholds = {
  schemaVersion: 1,
  thresholds: [
    { state: 'new', minScore: 0, maxScore: 24 },
    { state: 'returning', minScore: 25, maxScore: 49 },
    { state: 'regular', minScore: 50, maxScore: 74 },
    { state: 'raving_fan', minScore: 75, maxScore: 100 },
  ],
}

export type ComputeStateInput = {
  guestId: string
  venueId: string
}

export type ComputeStateResult = {
  score: number
  state: GuestState
  signals: RelationshipSignals
  stateChanged: boolean
}

// Internal: not re-exported from index.ts. Shared between load-signals and
// normalize-signals.
export type RawSignals = {
  visitsLast90Days: number
  daysSinceLastVisit: number
  totalSpentLast90Days: number
  outboundMessageCount: number
  repliedMessageCount: number
  engagementEventsByType: Record<string, number>
  uniqueMenuItemsOrdered: number
  totalMenuItems: number
  referralsMade: number
  referralsConverted: number
  distanceMiles: number | null
  visitDateList: Date[]
}

export type RecognitionResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: string; errorCode?: string }