import { createAdminClient } from '@/lib/db/admin'
import { loadSignals } from './load-signals'
import { normalizeSignals } from './normalize-signals'
import {
  DEFAULT_FORMULA,
  RelationshipStrengthFormulaSchema,
  type RecognitionResult,
  type RelationshipSignals,
  type RelationshipStrengthFormula,
  type SignalContributions,
} from './types'

async function loadFormula(
  venueId: string,
): Promise<RecognitionResult<RelationshipStrengthFormula>> {
  const supabase = createAdminClient()
  const { data, error } = await supabase
    .from('venue_configs')
    .select('relationship_strength_formula')
    .eq('venue_id', venueId)
    .maybeSingle()

  if (error) {
    return { ok: false, error: error.message, errorCode: 'load_formula_failed' }
  }

  const raw = data?.relationship_strength_formula
  // venue_configs.relationship_strength_formula defaults to '{}' jsonb. Treat
  // null/missing/empty-object as "use defaults".
  if (
    raw === null ||
    raw === undefined ||
    (typeof raw === 'object' && !Array.isArray(raw) && Object.keys(raw).length === 0)
  ) {
    return { ok: true, data: DEFAULT_FORMULA }
  }

  const parsed = RelationshipStrengthFormulaSchema.safeParse(raw)
  if (!parsed.success) {
    return { ok: false, error: parsed.error.message, errorCode: 'invalid_formula' }
  }
  return { ok: true, data: parsed.data }
}

/**
 * Compute the live relationship-strength score for a guest at a venue.
 *
 * Server-only. Uses the admin DB client, which bypasses RLS. Loads the
 * venue's formula (falling back to DEFAULT_FORMULA when unset), loads raw
 * signals, normalizes them, and returns a 0–100 integer score plus the
 * per-signal breakdown. No caching — always reads fresh.
 */
export async function computeRelationshipStrength({
  guestId,
  venueId,
}: {
  guestId: string
  venueId: string
}): Promise<
  RecognitionResult<{
    score: number
    signals: RelationshipSignals
    weights: RelationshipStrengthFormula['weights']
    contributions: SignalContributions
  }>
> {
  const formulaResult = await loadFormula(venueId)
  if (!formulaResult.ok) return formulaResult
  const formula = formulaResult.data

  const signalsResult = await loadSignals({ guestId, venueId })
  if (!signalsResult.ok) return signalsResult

  const signals = normalizeSignals(signalsResult.data, formula)
  const { weights } = formula
  // Per-signal score-point contributions surfaced for trace observability
  // (THE-216). Sum equals the pre-rounding `weightedSum`, so the score below
  // is `Math.round(sum-of-contributions)` by construction.
  const contributions: SignalContributions = {
    recency: signals.recency * weights.recency,
    visitFrequency: signals.visitFrequency * weights.visitFrequency,
    engagementEvents: signals.engagementEvents * weights.engagementEvents,
    moneySpent: signals.moneySpent * weights.moneySpent,
    responseRate: signals.responseRate * weights.responseRate,
    percentMenuExplored: signals.percentMenuExplored * weights.percentMenuExplored,
    referrals: signals.referrals * weights.referrals,
  }
  const weightedSum =
    contributions.recency +
    contributions.visitFrequency +
    contributions.engagementEvents +
    contributions.moneySpent +
    contributions.responseRate +
    contributions.percentMenuExplored +
    contributions.referrals

  const score = Math.round(weightedSum)

  return { ok: true, data: { score, signals, weights, contributions } }
}