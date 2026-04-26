import {
  ENGAGEMENT_EVENT_WEIGHTS,
  type RawSignals,
  type RelationshipSignals,
  type RelationshipStrengthFormula,
} from './types'

const MS_PER_DAY = 24 * 60 * 60 * 1000

const RECENCY_BANDS: Array<{ maxDays: number; score: number }> = [
  { maxDays: 0, score: 100 },
  { maxDays: 7, score: 90 },
  { maxDays: 30, score: 60 },
  { maxDays: 60, score: 30 },
  { maxDays: Number.POSITIVE_INFINITY, score: 0 },
]

const VISIT_FREQ_MAX_VISITS = 12         // 12+ unique-day visits in 90d → 100 (pre-multiplier)
const MONEY_MAX_DOLLARS = 300            // $300 in 90d → 100
const REFERRAL_MADE_PTS = 5
const REFERRAL_CONVERTED_PTS = 20
const RESPONSE_MIN_SAMPLE = 3
const ENGAGEMENT_MAX_WEIGHTED_SUM = Object.values(ENGAGEMENT_EVENT_WEIGHTS).reduce(
  (acc, w) => acc + w,
  0,
)
const CONSISTENCY_MIN_VISITS = 4

function clamp01to100(n: number): number {
  if (n < 0) return 0
  if (n > 100) return 100
  return n
}

function normalizeRecency(daysSinceLastVisit: number): number {
  for (const band of RECENCY_BANDS) {
    if (daysSinceLastVisit <= band.maxDays) return band.score
  }
  return 0
}

function normalizeVisitFrequency(visits: number, multiplierTotal: number): number {
  const base = Math.min(visits / VISIT_FREQ_MAX_VISITS, 1) * 100
  return clamp01to100(base * multiplierTotal)
}

function normalizeEngagementEvents(eventsByType: Record<string, number>): number {
  let weighted = 0
  for (const [eventType, weight] of Object.entries(ENGAGEMENT_EVENT_WEIGHTS)) {
    const count = eventsByType[eventType] ?? 0
    weighted += count * weight
  }
  return clamp01to100((weighted / ENGAGEMENT_MAX_WEIGHTED_SUM) * 100)
}

function normalizeMoneySpent(totalDollars: number): number {
  return clamp01to100((totalDollars / MONEY_MAX_DOLLARS) * 100)
}

function normalizeResponseRate(replied: number, sent: number): number {
  if (sent < RESPONSE_MIN_SAMPLE) return 0
  return clamp01to100((replied / sent) * 100)
}

function normalizePercentMenuExplored(unique: number, total: number): number {
  if (total === 0) return 0
  return clamp01to100((unique / total) * 100)
}

function normalizeReferrals(made: number, converted: number): number {
  return clamp01to100(made * REFERRAL_MADE_PTS + converted * REFERRAL_CONVERTED_PTS)
}

/**
 * Pure: pick the first matching distance band by ascending maxMiles. A null
 * distance (unknown — no postal code on file yet) returns 1.0 (no boost).
 * Bands run closer-to-farther; closer = no bonus, farther = larger bonus.
 */
export function computeDistanceMultiplier(
  distanceMiles: number | null,
  formula: RelationshipStrengthFormula,
): number {
  if (distanceMiles === null) return 1.0
  for (const band of formula.multipliers.distance.bands) {
    if (band.maxMiles === null || distanceMiles <= band.maxMiles) {
      return band.factor
    }
  }
  return 1.0
}

/**
 * Pure: standard deviation (in days) of inter-visit intervals, then pick the
 * matching band. Fewer than CONSISTENCY_MIN_VISITS visits returns 1.0 (not
 * enough data).
 */
export function computeConsistencyMultiplier(
  visitDates: Date[],
  formula: RelationshipStrengthFormula,
): number {
  if (visitDates.length < CONSISTENCY_MIN_VISITS) return 1.0
  const sorted = [...visitDates].sort((a, b) => a.getTime() - b.getTime())
  const intervals: number[] = []
  for (let i = 1; i < sorted.length; i++) {
    intervals.push((sorted[i].getTime() - sorted[i - 1].getTime()) / MS_PER_DAY)
  }
  const mean = intervals.reduce((acc, v) => acc + v, 0) / intervals.length
  const variance = intervals.reduce((acc, v) => acc + (v - mean) ** 2, 0) / intervals.length
  const stdDev = Math.sqrt(variance)
  for (const band of formula.multipliers.consistency.bands) {
    if (band.maxVariance === null || stdDev <= band.maxVariance) {
      return band.factor
    }
  }
  return 1.0
}

/**
 * Additive stacking with cap: 1 + (distance − 1) + (consistency − 1), then
 * clamped to [1.0, cap]. A 1.0 multiplier contributes 0 to the additive
 * surplus; the cap prevents either signal from dominating.
 */
export function computeTotalMultiplier(
  distance: number,
  consistency: number,
  cap: number,
): number {
  const additive = 1 + (distance - 1) + (consistency - 1)
  return Math.min(Math.max(additive, 1.0), cap)
}

/**
 * Pure: turn raw signal values into a 0–100 normalized RelationshipSignals
 * object. Multipliers are computed once and applied to visitFrequency only;
 * other signals are not multiplier-boosted by design (recency is a pure step
 * function, money/menu/response are intrinsically capped).
 */
export function normalizeSignals(
  raw: RawSignals,
  formula: RelationshipStrengthFormula,
): RelationshipSignals {
  const distance = computeDistanceMultiplier(raw.distanceMiles, formula)
  const consistency = computeConsistencyMultiplier(raw.visitDateList, formula)
  const total = computeTotalMultiplier(distance, consistency, formula.multiplierStackingCap)

  return {
    recency: normalizeRecency(raw.daysSinceLastVisit),
    visitFrequency: normalizeVisitFrequency(raw.visitsLast90Days, total),
    engagementEvents: normalizeEngagementEvents(raw.engagementEventsByType),
    moneySpent: normalizeMoneySpent(raw.totalSpentLast90Days),
    responseRate: normalizeResponseRate(raw.repliedMessageCount, raw.outboundMessageCount),
    percentMenuExplored: normalizePercentMenuExplored(
      raw.uniqueMenuItemsOrdered,
      raw.totalMenuItems,
    ),
    referrals: normalizeReferrals(raw.referralsMade, raw.referralsConverted),
    appliedMultipliers: { distance, consistency, total },
  }
}