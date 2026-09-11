/**
 * TAC-347 Stage 3. Running-total cost tracker backing `--max-cost`. Pure,
 * no imports.
 *
 * Honesty note (also surfaced in the CLI's own report, not just here): this
 * repo's production `lib/ai` functions (classifyMessage, generateMessage)
 * do not expose token usage on their success path — usage only appears
 * inside an internal error-logging branch in generate-message.ts, not in
 * AIResult<T>. Adding it would mean widening the production AI-result
 * contract, which is out of this harness's charter (it must not touch
 * lib/ai or lib/agent/stages.ts). So: grading calls (this repo's own new
 * code) are tracked from REAL token usage; classify+generate calls are
 * tracked from the same per-scenario cost ESTIMATE Stage 1 used, clearly
 * labeled as such everywhere it's reported. The running total --max-cost
 * checks against is a mix of measured and estimated cost, not a pure
 * measurement — the best achievable without touching restricted files.
 */

export const PRICE_PER_MTOK_INPUT = 3
export const PRICE_PER_MTOK_OUTPUT = 15
// Haiku pricing (per Anthropic's published rates at time of writing) — used
// only for the grading-call cost, which does run on Haiku by default.
export const HAIKU_PRICE_PER_MTOK_INPUT = 0.8
export const HAIKU_PRICE_PER_MTOK_OUTPUT = 4

// Same per-scenario classify+generate estimate as the Stage 1 cost comment
// (classify ~1500in/150out; generate ~1.4 attempts avg at ~3500in/200out
// each) — reused here, not re-derived, so the two numbers this repo reports
// can't quietly drift apart.
export const EST_CLASSIFY_INPUT_TOKENS = 1500
export const EST_CLASSIFY_OUTPUT_TOKENS = 150
export const EST_GENERATE_ATTEMPTS_AVG = 1.4
export const EST_GENERATE_INPUT_TOKENS_PER_ATTEMPT = 3500
export const EST_GENERATE_OUTPUT_TOKENS_PER_ATTEMPT = 200

export function estimateClassifyGenerateCostUsd(): number {
  const inputTokens = EST_CLASSIFY_INPUT_TOKENS + EST_GENERATE_ATTEMPTS_AVG * EST_GENERATE_INPUT_TOKENS_PER_ATTEMPT
  const outputTokens = EST_CLASSIFY_OUTPUT_TOKENS + EST_GENERATE_ATTEMPTS_AVG * EST_GENERATE_OUTPUT_TOKENS_PER_ATTEMPT
  return (inputTokens / 1_000_000) * PRICE_PER_MTOK_INPUT + (outputTokens / 1_000_000) * PRICE_PER_MTOK_OUTPUT
}

export function measuredGradeCostUsd(input: { inputTokens: number; outputTokens: number; model: string }): number {
  const isSonnet = input.model.includes('sonnet')
  const inPrice = isSonnet ? PRICE_PER_MTOK_INPUT : HAIKU_PRICE_PER_MTOK_INPUT
  const outPrice = isSonnet ? PRICE_PER_MTOK_OUTPUT : HAIKU_PRICE_PER_MTOK_OUTPUT
  return (input.inputTokens / 1_000_000) * inPrice + (input.outputTokens / 1_000_000) * outPrice
}

export interface CostTrackerState {
  estimatedUsd: number // classify+generate, estimate-based
  measuredUsd: number // grading calls, usage-based
  scenariosRun: number
  scenariosGraded: number
}

export function newCostTracker(): CostTrackerState {
  return { estimatedUsd: 0, measuredUsd: 0, scenariosRun: 0, scenariosGraded: 0 }
}

export function totalCostUsd(state: CostTrackerState): number {
  return state.estimatedUsd + state.measuredUsd
}

export function addScenarioRun(state: CostTrackerState): CostTrackerState {
  return { ...state, estimatedUsd: state.estimatedUsd + estimateClassifyGenerateCostUsd(), scenariosRun: state.scenariosRun + 1 }
}

export function addGrade(
  state: CostTrackerState,
  usage: { inputTokens: number; outputTokens: number; model: string },
): CostTrackerState {
  return {
    ...state,
    measuredUsd: state.measuredUsd + measuredGradeCostUsd(usage),
    scenariosGraded: state.scenariosGraded + 1,
  }
}

/** Would running one more scenario (run + grade) push the total past the cap? */
export function wouldExceedCap(state: CostTrackerState, maxCostUsd: number | null): boolean {
  if (maxCostUsd === null) return false
  // Conservative: charge the next unit at the classify+generate estimate
  // plus a Haiku-grade estimate (~2000in/300out), since we don't know the
  // real grading cost until after the call.
  const nextUnitEstimate =
    estimateClassifyGenerateCostUsd() + (2000 / 1_000_000) * HAIKU_PRICE_PER_MTOK_INPUT + (300 / 1_000_000) * HAIKU_PRICE_PER_MTOK_OUTPUT
  return totalCostUsd(state) + nextUnitEstimate > maxCostUsd
}
