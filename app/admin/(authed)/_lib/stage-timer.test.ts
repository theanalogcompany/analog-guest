import { describe, expect, it } from 'vitest'
import { createStageTimer } from './stage-timer'

function clock(...ticks: number[]) {
  let i = 0
  return () => ticks[Math.min(i++, ticks.length - 1)]
}

describe('createStageTimer', () => {
  it('records each stage as time since the previous mark', () => {
    // start=100, then marks at 140, 400, 410
    const timer = createStageTimer(clock(100, 140, 400, 410, 500))
    timer.mark('auth')
    timer.mark('venues')
    timer.mark('conversation')
    expect(timer.stages()).toEqual({ auth: 40, venues: 260, conversation: 10 })
    expect(timer.totalMs()).toBe(400)
  })

  it('names the last completed stage, and omits one that never finished', () => {
    const timer = createStageTimer(clock(0, 50, 80))
    timer.mark('auth')
    timer.mark('venues')
    expect(timer.lastStage()).toBe('venues')
    expect(timer.stages()).not.toHaveProperty('conversation')
  })

  it('has no last stage before the first mark', () => {
    expect(createStageTimer(clock(0)).lastStage()).toBeNull()
  })
})
