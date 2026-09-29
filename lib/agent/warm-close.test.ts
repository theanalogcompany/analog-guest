import { describe, expect, it } from 'vitest'

import {
  isFirstConversation,
  isWarmCloseDue,
  isWarmCloseTooLate,
  NEVER_SPLIT_RNG,
  warmCloseFloorMs,
  WARM_CLOSE_MAX_AGE_MS,
  WARM_CLOSE_PAUSE_MINUTES_DEFAULT,
  WARM_CLOSE_QUESTION_FLOOR_MULTIPLIER,
  weAskedAQuestion,
} from './warm-close'
import { SPLIT_PROBABILITY } from './sentence-split'

const MIN = 60 * 1000
const PAUSE = WARM_CLOSE_PAUSE_MINUTES_DEFAULT * MIN
const T0 = new Date('2026-09-29T14:00:00.000Z')
const at = (ms: number) => new Date(T0.getTime() + ms)

describe('warmCloseFloorMs (TAC-560)', () => {
  it('is the plain pause when our last message asked nothing', () => {
    expect(warmCloseFloorMs(PAUSE, false)).toBe(PAUSE)
  })

  it('DOUBLES when our last message asked the guest something', () => {
    // "Defer once, then skip": the deferral is this multiplier, the skip is the
    // max age. Neither needs stored state, which is what lets the due set stay
    // derived from `messages`.
    expect(warmCloseFloorMs(PAUSE, true)).toBe(PAUSE * 2)
    expect(WARM_CLOSE_QUESTION_FLOOR_MULTIPLIER).toBe(2)
  })
})

describe('isWarmCloseDue (TAC-560)', () => {
  it('is false before the floor', () => {
    expect(isWarmCloseDue(T0, at(PAUSE - 1), PAUSE)).toBe(false)
  })

  it('fires exactly ON the floor', () => {
    // `>=`, not `>`: the pause is a floor the guest has had, not a deadline to
    // beat, and a tick landing on the millisecond should not wait another minute.
    expect(isWarmCloseDue(T0, at(PAUSE), PAUSE)).toBe(true)
  })

  it('does NOT fire at the plain pause when we asked a question, and does at double', () => {
    // The deferral, end to end through the two pure functions the processor uses.
    const floor = warmCloseFloorMs(PAUSE, true)
    expect(isWarmCloseDue(T0, at(PAUSE + MIN), floor)).toBe(false)
    expect(isWarmCloseDue(T0, at(2 * PAUSE), floor)).toBe(true)
  })
})

describe('isWarmCloseTooLate (TAC-560)', () => {
  it('is two hours, and the bound itself is still inside', () => {
    expect(WARM_CLOSE_MAX_AGE_MS).toBe(2 * 60 * 60 * 1000)
    // `>` not `>=`, so this and isWarmCloseDue cannot both refuse one instant.
    expect(isWarmCloseTooLate(T0, at(WARM_CLOSE_MAX_AGE_MS))).toBe(false)
    expect(isWarmCloseTooLate(T0, at(WARM_CLOSE_MAX_AGE_MS + 1))).toBe(true)
  })

  it('leaves room for the deferred case to still fire', () => {
    // A guarantee worth pinning rather than assuming: if the doubled floor ever
    // exceeded the max age, the question branch could never fire at all and the
    // deferral would silently be a permanent skip.
    expect(warmCloseFloorMs(PAUSE, true)).toBeLessThan(WARM_CLOSE_MAX_AGE_MS)
  })
})

describe('weAskedAQuestion (TAC-560)', () => {
  it('reads a question mark in our own last message', () => {
    expect(weAskedAQuestion('glad you liked it. first time in?', 0)).toBe(true)
  })

  it('reads a rendered getting-to-know-you question with no question mark in the body', () => {
    // TAC-554 guarantees the question is the last message whenever anything
    // rendered, so the column is the stronger signal and does not depend on text.
    expect(weAskedAQuestion('nice, glad it landed', 1)).toBe(true)
  })

  it('is false for an ordinary statement with nothing rendered', () => {
    expect(weAskedAQuestion('the cortado is our house pour, glad it landed', 0)).toBe(false)
  })

  it('is false on an empty body', () => {
    expect(weAskedAQuestion('', 0)).toBe(false)
  })
})

describe('isFirstConversation (TAC-560)', () => {
  const WINDOW = 48 * 60 * MIN

  it('is true inside the conversation window', () => {
    expect(isFirstConversation(at(-2 * 60 * MIN), T0, WINDOW)).toBe(true)
  })

  it('is true exactly ON the window', () => {
    expect(isFirstConversation(at(-WINDOW), T0, WINDOW)).toBe(true)
  })

  it('is false past it', () => {
    expect(isFirstConversation(at(-WINDOW - 1), T0, WINDOW)).toBe(false)
  })

  it('is false for a first contact in the future', () => {
    // Clock skew, or a replay. A guest who has not been contacted yet is not in
    // their first conversation; the safe direction is not to close them.
    expect(isFirstConversation(at(MIN), T0, WINDOW)).toBe(false)
  })

  it('is false for an unreadable date rather than throwing', () => {
    expect(isFirstConversation(new Date('nonsense'), T0, WINDOW)).toBe(false)
  })
})

describe('NEVER_SPLIT_RNG (TAC-560)', () => {
  it('is above the split probability, so the close is always one message', () => {
    // The property, not the literal: resolveDispatchBubbles splits when
    // `rng() < SPLIT_PROBABILITY`, so this has to sit at or above it. Pinned
    // against the real constant so a change to either is caught here rather than
    // by a guest receiving the close in two bubbles.
    expect(NEVER_SPLIT_RNG()).toBeGreaterThanOrEqual(SPLIT_PROBABILITY)
  })
})
