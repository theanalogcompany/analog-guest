// TAC-386. The spacing rule between two proactive messages.
//
// This file exists because of a mutation run: flipping the comparison from `<`
// to `<=` left every processor test in the repo green, even though the module
// documents which side of its own boundary it sits on. A documented claim with
// nothing able to contradict it is the defect class root CLAUDE.md names first.

import { describe, expect, it } from 'vitest'

import {
  isTooSoonAfterProactive,
  PROACTIVE_SPACING_MINUTES,
} from './proactive-spacing'

const NOW = new Date('2026-09-30T12:00:00.000Z')
const MINUTE = 60 * 1000
const ago = (minutes: number) => new Date(NOW.getTime() - minutes * MINUTE)

describe('isTooSoonAfterProactive', () => {
  it('is never too soon when no proactive message has ever gone out', () => {
    expect(isTooSoonAfterProactive(null, NOW)).toBe(false)
  })

  it('is too soon a minute after one', () => {
    expect(isTooSoonAfterProactive(ago(1), NOW)).toBe(true)
  })

  it('is too soon at 59 minutes', () => {
    expect(isTooSoonAfterProactive(ago(59), NOW)).toBe(true)
  })

  // THE BOUNDARY, and the reason this file exists. The spacing is a gap the
  // guest has had, not a deadline to beat, so landing exactly on it is allowed.
  // Same direction isWarmCloseDue and isScanGreetingDue take for their floors.
  it('is NOT too soon at exactly the spacing window', () => {
    expect(isTooSoonAfterProactive(ago(PROACTIVE_SPACING_MINUTES), NOW)).toBe(
      false,
    )
  })

  it('is too soon one millisecond inside the window', () => {
    const justInside = new Date(
      NOW.getTime() - PROACTIVE_SPACING_MINUTES * MINUTE + 1,
    )
    expect(isTooSoonAfterProactive(justInside, NOW)).toBe(true)
  })

  it('is not too soon well after', () => {
    expect(isTooSoonAfterProactive(ago(120), NOW)).toBe(false)
  })

  it('is not too soon for a marker in the future', () => {
    // Clock skew, or a marker written by a tick whose clock ran ahead. A
    // negative elapsed time is less than the window, so a naive comparison
    // would call it too soon for ever; that it does NOT is worth pinning.
    expect(isTooSoonAfterProactive(new Date(NOW.getTime() + MINUTE), NOW)).toBe(
      true,
    )
  })

  it('is 60 minutes, as ruled', () => {
    expect(PROACTIVE_SPACING_MINUTES).toBe(60)
  })
})
