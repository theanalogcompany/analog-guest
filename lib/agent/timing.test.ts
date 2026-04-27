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
})