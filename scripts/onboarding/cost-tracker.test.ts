import { describe, expect, it } from 'vitest'
import {
  addGrade,
  addScenarioRun,
  measuredGradeCostUsd,
  newCostTracker,
  totalCostUsd,
  wouldExceedCap,
} from './cost-tracker'

describe('cost-tracker', () => {
  it('starts at zero', () => {
    const state = newCostTracker()
    expect(totalCostUsd(state)).toBe(0)
    expect(state.scenariosRun).toBe(0)
    expect(state.scenariosGraded).toBe(0)
  })

  it('accumulates estimated cost per scenario run', () => {
    let state = newCostTracker()
    state = addScenarioRun(state)
    state = addScenarioRun(state)
    expect(state.scenariosRun).toBe(2)
    expect(totalCostUsd(state)).toBeGreaterThan(0)
  })

  it('accumulates measured cost per grade, using haiku pricing by default', () => {
    let state = newCostTracker()
    state = addGrade(state, { inputTokens: 1_000_000, outputTokens: 1_000_000, model: 'claude-haiku-4-5-20251001' })
    // 1M in @ $0.80 + 1M out @ $4.00 = $4.80
    expect(totalCostUsd(state)).toBeCloseTo(4.8, 5)
    expect(state.scenariosGraded).toBe(1)
  })

  it('uses sonnet pricing when the model name contains sonnet', () => {
    const cost = measuredGradeCostUsd({ inputTokens: 1_000_000, outputTokens: 1_000_000, model: 'claude-sonnet-4-6' })
    // 1M in @ $3 + 1M out @ $15 = $18
    expect(cost).toBeCloseTo(18, 5)
  })

  it('wouldExceedCap is always false when maxCostUsd is null', () => {
    let state = newCostTracker()
    for (let i = 0; i < 100; i++) state = addScenarioRun(state)
    expect(wouldExceedCap(state, null)).toBe(false)
  })

  it('wouldExceedCap returns true once the running total plus the next unit estimate would cross the cap', () => {
    let state = newCostTracker()
    // Push the total up close to a small cap.
    for (let i = 0; i < 50; i++) state = addScenarioRun(state)
    expect(wouldExceedCap(state, 0.001)).toBe(true)
  })

  it('wouldExceedCap returns false when comfortably under the cap', () => {
    const state = newCostTracker()
    expect(wouldExceedCap(state, 100)).toBe(false)
  })
})
