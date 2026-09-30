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
  closesFirstConversation,
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

describe('weAskedAQuestion (TAC-560, fixed by TAC-568)', () => {
  it('reads a question mark in our own last message', () => {
    expect(weAskedAQuestion('glad you liked it. first time in?')).toBe(true)
  })

  it('reads a raised getting-to-know-you question, which IS the last bubble', () => {
    // TAC-554 guarantees a raised question its own final message, and the
    // candidate body IS the newest row, so this is the shape the deleted
    // rendered-intentions arm was supposed to catch and never could.
    expect(weAskedAQuestion("what's your name, by the way?")).toBe(true)
  })

  // THE DOUBLED-PAUSE BUG, and the reason this test exists at all.
  //
  // Before TAC-568 this call carried a second argument: how many intentions had
  // been RENDERED into the draft's prompt. A non-zero count returned true on its
  // own, so a turn where the intentions block rendered and the model raised
  // nothing deferred the close by a full extra interval - twenty minutes of
  // silence owed to a question that was never asked.
  //
  // There is no argument to pass any more, so the defect is unrepresentable
  // rather than merely untriggered. What remains is the body.
  it('does not defer when the reply asked nothing, however much rendered', () => {
    expect(weAskedAQuestion('nice, glad it landed')).toBe(false)
  })

  it('is false for an ordinary statement', () => {
    expect(
      weAskedAQuestion('the cortado is our house pour, glad it landed'),
    ).toBe(false)
  })

  it('is false on an empty body', () => {
    expect(weAskedAQuestion('')).toBe(false)
  })
})

// TAC-568. The predicate both in-conversation paths turn on, driven directly
// rather than only through the orchestrator.
//
// WHY MORE CASES THAN USUAL: this function decides whether a guest spends their
// one warm close, for ever, so each arm is driven from both sides and the two
// gates are asserted to beat BOTH arms rather than just the one a single example
// would exercise.
//
// NOT AN EXHAUSTIVE TRUTH TABLE, which an earlier version of this comment
// claimed it was. It covers 4 of the 8 combinations of the three arm inputs; the
// name/goodbye co-fire in particular is exercised through the orchestrator
// (handle-inbound.test.ts, "claims once when the name and the goodbye both
// fire"), not here.
describe('closesFirstConversation (TAC-568)', () => {
  const TEXT = 'if you ever need anything, we are always here to help'

  const base = {
    guestSignedOff: false,
    agentSaidGoodbye: false,
    nameJustStored: false,
    isFirstConversation: true,
    warmCloseText: TEXT,
  }

  describe('the goodbye arm', () => {
    it('closes when the guest signed off AND the agent said goodbye', () => {
      expect(
        closesFirstConversation({
          ...base,
          guestSignedOff: true,
          agentSaidGoodbye: true,
        }),
      ).toBe(true)
    })

    // The AND, from both sides. Either alone must not close: a false positive
    // spends the close permanently, and the pause timer covers a false negative
    // ten minutes later.
    it('does not close on the sign-off alone', () => {
      expect(closesFirstConversation({ ...base, guestSignedOff: true })).toBe(
        false,
      )
    })

    it('does not close on the self-report alone', () => {
      expect(closesFirstConversation({ ...base, agentSaidGoodbye: true })).toBe(
        false,
      )
    })
  })

  describe('the name arm', () => {
    // The whole follow-on ruling in one assertion: no goodbye anywhere, and the
    // conversation still closes, because the name landed.
    it('closes on a stored name with no goodbye at all', () => {
      expect(closesFirstConversation({ ...base, nameJustStored: true })).toBe(
        true,
      )
    })

    it('needs no partner signal, unlike the goodbye arm', () => {
      expect(
        closesFirstConversation({
          ...base,
          nameJustStored: true,
          guestSignedOff: false,
          agentSaidGoodbye: false,
        }),
      ).toBe(true)
    })

    it('does not close when no name was stored', () => {
      expect(closesFirstConversation(base)).toBe(false)
    })
  })

  // Both gates beat both arms. Asserted against each arm separately: a gate
  // tested only against the goodbye arm would let a regression through on the
  // name arm, which is now the path that actually fires in production.
  describe('the gates beat both arms', () => {
    const goodbye = { guestSignedOff: true, agentSaidGoodbye: true }
    const named = { nameJustStored: true }

    it.each([
      ['goodbye', goodbye],
      ['name', named],
    ])('a later conversation does not close (%s arm)', (_label, arm) => {
      expect(
        closesFirstConversation({
          ...base,
          ...arm,
          isFirstConversation: false,
        }),
      ).toBe(false)
    })

    it.each([
      ['goodbye', goodbye],
      ['name', named],
    ])('an unconfigured venue does not close (%s arm)', (_label, arm) => {
      expect(
        closesFirstConversation({ ...base, ...arm, warmCloseText: '' }),
      ).toBe(false)
    })

    // Whitespace is not a message. Checked here rather than at dispatch so the
    // marker is never claimed for a bubble that would render empty.
    it.each([
      ['goodbye', goodbye],
      ['name', named],
    ])('a whitespace-only setting does not close (%s arm)', (_label, arm) => {
      expect(
        closesFirstConversation({ ...base, ...arm, warmCloseText: '   \n ' }),
      ).toBe(false)
    })
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
