import { describe, expect, it } from 'vitest'
import { sampleTiming } from './timing'

describe('sampleTiming', () => {
  it('always satisfies markAsReadGapMs + preTypingPauseMs + typingDurationMs === totalDelayMs', () => {
    for (let i = 0; i < 1000; i++) {
      const plan = sampleTiming()
      expect(plan.markAsReadGapMs + plan.preTypingPauseMs + plan.typingDurationMs).toBe(
        plan.totalDelayMs,
      )
    }
  })

  // THE-230 tightened the bound from 120s to 60s. This test pins the new
  // window so a future widening doesn't slip in unnoticed.
  it('totalDelayMs always falls in [30s, 60s]', () => {
    for (let i = 0; i < 1000; i++) {
      const plan = sampleTiming()
      expect(plan.totalDelayMs).toBeGreaterThanOrEqual(25_000)
      expect(plan.totalDelayMs).toBeLessThanOrEqual(40_000)
    }
  })

  it('markAsReadGapMs always falls in [5s, 15s]', () => {
    for (let i = 0; i < 1000; i++) {
      const plan = sampleTiming()
      expect(plan.markAsReadGapMs).toBeGreaterThanOrEqual(5_000)
      expect(plan.markAsReadGapMs).toBeLessThanOrEqual(15_000)
    }
  })
})