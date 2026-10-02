/**
 * Pure half of the generation-latency replay harness (module-split convention:
 * no `@/*` imports, so the test collects without SDK init). The CLI half is
 * `generation-latency.ts`; it builds `HarnessUnit` records and hands them
 * here for summarizing and for the pre-registered ceiling verdicts.
 *
 * WHY CEILINGS ARE IN CODE: measurement convention rule 8 — a ceiling that is
 * tallied but never evaluated prints PASS on a run that broke something. Every
 * ceiling below is evaluated by `evaluateCeilings`, and a unit that FAILED
 * (a stage threw) disqualifies the whole run whatever the counts read
 * (rule 5: an errored call produces no verdict and must not score like a
 * negative).
 */

export type UnitOutcome = 'ok' | 'refused' | 'crisis_short_circuit' | 'failed'

/** One replayed inbound turn. Stage fields are absent when the stage never ran. */
export interface HarnessUnit {
  outcome: UnitOutcome
  /** Venue clock state when this unit ran: 'open' | 'closed' | 'unknown'. */
  openState: string
  contextBuildMs?: number
  classifyMs?: number
  retrieveVoiceMs?: number
  retrieveKnowledgeMs?: number
  generateMs?: number
  gateMs?: number
  /** Sum of the timed reply-path stages: what the guest waits for, minus transport. */
  replyPathMs?: number
  /** attemptScores.length from the generation; >1 means a regeneration ran. */
  attemptCount?: number
  mechanicOffer?: string
  prosePromise?: string
  cancellationClaim?: string
  closedVenueArrival?: string
  [key: string]: unknown
}

export const STAGE_FIELDS = [
  'contextBuildMs',
  'classifyMs',
  'retrieveVoiceMs',
  'retrieveKnowledgeMs',
  'generateMs',
  'gateMs',
  'replyPathMs',
] as const

export const VERIFIER_FIELDS = [
  'mechanicOffer',
  'prosePromise',
  'cancellationClaim',
  'closedVenueArrival',
] as const

/**
 * Pre-change production baseline, measured 2026-09-30 from Langfuse over
 * 2026-09-23T05:50:05Z..2026-09-30T05:50:05Z (the 7 days before the PR #304
 * merge). Sources, both re-runnable:
 *  - stage latency: /api/public/v2/metrics, view=observations, grouped by name
 *  - verifier verdicts: /api/public/observations per verify_* span, counting
 *    `output.status` ('claim' for the cancellation check); rate over the runs
 *    that were not 'skipped'
 *  - regen rate: 11 attempt_2 spans against 87 attempt_1 on 2026-09-29
 * These are inputs to the ceilings below, frozen here so the run log is
 * self-describing. Re-derive rather than trusting them for anything else.
 */
export const PRE_CHANGE_BASELINE = {
  classifyP50Ms: 2188,
  retrieveVoiceP50Ms: 1793,
  retrieveKnowledgeP50Ms: 188,
  generateP50Ms: 6015,
  generateP90Ms: 10497,
  closedVenueFlaggedRate: 1 / 53,
  mechanicOfferFlaggedRate: 0,
  prosePromiseFlaggedRate: 0,
  cancellationClaimFlaggedRate: 0,
  regenRate: 11 / 87,
} as const

/**
 * Max acceptable count of "hits" in n draws given a baseline rate: the
 * baseline expectation plus two binomial standard deviations, ceiled. A zero
 * baseline gets an allowance of one — a single finding in a small sample is
 * indistinguishable from noise, but two are a signal.
 */
export function maxCountForRate(baselineRate: number, n: number): number {
  if (n <= 0) return 0
  if (baselineRate === 0) return 1
  const expected = n * baselineRate
  const sd = Math.sqrt(n * baselineRate * (1 - baselineRate))
  return Math.ceil(expected + 2 * sd)
}

export interface StageSummary {
  n: number
  p50: number | null
  p90: number | null
}

export interface VerifierSummary {
  /** Status counts as recorded, 'skipped' included. */
  counts: Record<string, number>
  /** Units where the check actually ran (status present and not 'skipped'). */
  ran: number
  flagged: number
}

export interface RunSummary {
  total: number
  outcomes: Record<UnitOutcome, number>
  stages: Record<(typeof STAGE_FIELDS)[number], StageSummary>
  verifiers: Record<(typeof VERIFIER_FIELDS)[number], VerifierSummary>
  /** Generations that completed (ok or refused) and how many regenerated. */
  regen: { generations: number; regenerated: number }
  openStates: Record<string, number>
}

/**
 * Linear-interpolation percentile over a copy of `values`. Matches the
 * common numpy/Langfuse convention closely enough for comparison; the exact
 * method matters less than using ONE method for both sides of a delta.
 */
export function percentile(
  values: readonly number[],
  p: number,
): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const rank = (p / 100) * (sorted.length - 1)
  const lo = Math.floor(rank)
  const hi = Math.ceil(rank)
  if (lo === hi) return sorted[lo]
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (rank - lo)
}

export function summarize(units: readonly HarnessUnit[]): RunSummary {
  const outcomes: Record<UnitOutcome, number> = {
    ok: 0,
    refused: 0,
    crisis_short_circuit: 0,
    failed: 0,
  }
  for (const u of units) outcomes[u.outcome] += 1

  const stages = {} as RunSummary['stages']
  for (const field of STAGE_FIELDS) {
    const values = units
      .map((u) => u[field])
      .filter((v): v is number => typeof v === 'number')
    stages[field] = {
      n: values.length,
      p50: percentile(values, 50),
      p90: percentile(values, 90),
    }
  }

  const verifiers = {} as RunSummary['verifiers']
  for (const field of VERIFIER_FIELDS) {
    const counts: Record<string, number> = {}
    let ran = 0
    let flagged = 0
    for (const u of units) {
      const status = u[field]
      if (typeof status !== 'string') continue
      counts[status] = (counts[status] ?? 0) + 1
      if (status !== 'skipped') ran += 1
      if (status === 'flagged') flagged += 1
    }
    verifiers[field] = { counts, ran, flagged }
  }

  let generations = 0
  let regenerated = 0
  for (const u of units) {
    if (typeof u.attemptCount !== 'number') continue
    generations += 1
    if (u.attemptCount > 1) regenerated += 1
  }

  const openStates: Record<string, number> = {}
  for (const u of units) {
    openStates[u.openState] = (openStates[u.openState] ?? 0) + 1
  }

  return {
    total: units.length,
    outcomes,
    stages,
    verifiers,
    regen: { generations, regenerated },
    openStates,
  }
}

export interface CeilingVerdict {
  name: string
  limit: string
  actual: string
  pass: boolean
}

export interface CeilingReport {
  verdicts: CeilingVerdict[]
  /** True when any unit failed outright — no PASS may be claimed (rule 5). */
  disqualified: boolean
  /** All ceilings pass AND nothing disqualified the run. */
  allPass: boolean
}

/**
 * The pre-registered ceilings, in code. A bar answers "did it work"; these
 * answer "did it break something while working":
 *  - no generation refused (fidelity-floor refusals were not a pre-change mode)
 *  - regen rate within baseline + 2σ
 *  - each verifier's flagged count within baseline + 2σ (min 1 on a zero baseline)
 *  - generate p50 within 20% of the pre-change production p50, because the
 *    change deliberately did not touch generation
 */
export function evaluateCeilings(s: RunSummary): CeilingReport {
  const verdicts: CeilingVerdict[] = []

  verdicts.push({
    name: 'refused_generations',
    limit: '0',
    actual: String(s.outcomes.refused),
    pass: s.outcomes.refused === 0,
  })

  const regenMax = maxCountForRate(
    PRE_CHANGE_BASELINE.regenRate,
    s.regen.generations,
  )
  verdicts.push({
    name: 'regenerated_attempts',
    limit: `<= ${regenMax} of ${s.regen.generations}`,
    actual: String(s.regen.regenerated),
    pass: s.regen.regenerated <= regenMax,
  })

  const verifierBaselines: Record<(typeof VERIFIER_FIELDS)[number], number> = {
    mechanicOffer: PRE_CHANGE_BASELINE.mechanicOfferFlaggedRate,
    prosePromise: PRE_CHANGE_BASELINE.prosePromiseFlaggedRate,
    cancellationClaim: PRE_CHANGE_BASELINE.cancellationClaimFlaggedRate,
    closedVenueArrival: PRE_CHANGE_BASELINE.closedVenueFlaggedRate,
  }
  for (const field of VERIFIER_FIELDS) {
    const v = s.verifiers[field]
    const max = maxCountForRate(verifierBaselines[field], v.ran)
    verdicts.push({
      name: `${field}_flagged`,
      limit: `<= ${max} of ${v.ran} ran`,
      actual: String(v.flagged),
      pass: v.flagged <= max,
    })
  }

  const generateP50 = s.stages.generateMs.p50
  const generateCeiling = PRE_CHANGE_BASELINE.generateP50Ms * 1.2
  verdicts.push({
    name: 'generate_p50_ms',
    limit: `<= ${Math.round(generateCeiling)}`,
    actual: generateP50 === null ? 'no data' : String(Math.round(generateP50)),
    pass: generateP50 !== null && generateP50 <= generateCeiling,
  })

  const disqualified = s.outcomes.failed > 0
  const allPass = !disqualified && verdicts.every((v) => v.pass)
  return { verdicts, disqualified, allPass }
}
