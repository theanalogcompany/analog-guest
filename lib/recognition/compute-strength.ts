import { createAdminClient } from '@/lib/db/admin'
import { loadSignals } from './load-signals'
import { normalizeSignals } from './normalize-signals'
import {
  DEFAULT_FORMULA,
  RelationshipStrengthFormulaSchema,
  type RecognitionResult,
  type RelationshipSignals,
  type RelationshipStrengthFormula,
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
}): Promise<RecognitionResult<{ score: number; signals: RelationshipSignals }>> {
  const formulaResult = await loadFormula(venueId)
  if (!formulaResult.ok) return formulaResult
  const formula = formulaResult.data

  const signalsResult = await loadSignals({ guestId, venueId })
  if (!signalsResult.ok) return signalsResult

  const signals = normalizeSignals(signalsResult.data, formula)
  const { weights } = formula
  const weightedSum =
    signals.recency * weights.recency +
    signals.visitFrequency * weights.visitFrequency +
    signals.engagementEvents * weights.engagementEvents +
    signals.moneySpent * weights.moneySpent +
    signals.responseRate * weights.responseRate +
    signals.percentMenuExplored * weights.percentMenuExplored +
    signals.referrals * weights.referrals

  const score = Math.round(weightedSum)

  return { ok: true, data: { score, signals } }
}