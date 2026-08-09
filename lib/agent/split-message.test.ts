import { describe, expect, it } from 'vitest'

import {
  BUBBLE_DELIMITER,
  INTER_BUBBLE_GAP_MS,
  MAX_BUBBLES_PER_RESPONSE,
  collapseToSingleMessage,
} from './split-message'

// TAC-319: splitIntoBubbles (the model-delimiter-driven splitter) is retired —
// dispatch decides splits deterministically in ./sentence-split. What this
// file still covers is the surviving defensive machinery: the tolerant
// delimiter matcher via collapseToSingleMessage, and the shared constants.

describe('collapseToSingleMessage', () => {
  it('replaces the delimiter with a single space', () => {
    const body = `I'd go for the Frosty Gandhi${BUBBLE_DELIMITER}Espresso, chai, peppermint`
    expect(collapseToSingleMessage(body)).toBe(
      "I'd go for the Frosty Gandhi Espresso, chai, peppermint",
    )
  })

  it('leaves a body with no delimiter untouched', () => {
    expect(collapseToSingleMessage('Open until 4')).toBe('Open until 4')
  })

  it('collapses whitespace and trims', () => {
    expect(collapseToSingleMessage(`  first   ${BUBBLE_DELIMITER}\n\n second  `)).toBe(
      'first second',
    )
  })

  it.each([
    ['single brackets', '[BREAK]'],
    ['lowercase', '[[break]]'],
    ['inner whitespace', '[[ BREAK ]]'],
    ['missing one closing bracket', '[[BREAK]'],
    ['missing both closing brackets', '[[BREAK'],
  ])('strips a near-miss delimiter: %s', (_label, delimiter) => {
    const out = collapseToSingleMessage(`first${delimiter}second`)
    expect(out).toBe('first second')
    expect(out.toUpperCase()).not.toContain('BREAK')
  })

  it('never leaves a bracket-wrapped BREAK in the output for any variant', () => {
    // The queue-path guarantee, stated as one assertion: whatever shape the
    // model emitted, an operator reading the card sees prose.
    const variants = ['[[BREAK]]', '[BREAK]', '[[break]]', '[[ Break ]]', '[[BREAK]']
    for (const v of variants) {
      expect(collapseToSingleMessage(`a${v}b`)).toBe('a b')
    }
  })

  it('returns an empty string for a delimiter-only body', () => {
    expect(collapseToSingleMessage(BUBBLE_DELIMITER)).toBe('')
  })

  // Ported from the retired splitIntoBubbles suite (TAC-319): these guard the
  // MATCHER, which survives, not the retired splitter. Losing either would
  // let the stripper corrupt real menu text or ordinary prose.

  it('does NOT match BREAK inside a longer word after a SINGLE bracket', () => {
    // The single-bracket alternative requires a word boundary. Without it the
    // stripper would eat `[BREAK` out of `[BREAKFAST]` and leave a dangling
    // `FAST]` in a message a guest actually reads.
    expect(collapseToSingleMessage('see the [BREAKFAST] menu')).toBe(
      'see the [BREAKFAST] menu',
    )
  })

  it('does NOT match a bare unbracketed BREAK', () => {
    // Accepted residual: the unbracketed word appears in ordinary prose, and
    // stripping it would corrupt real messages.
    expect(collapseToSingleMessage('we take a break at three')).toBe(
      'we take a break at three',
    )
  })
})

describe('constants', () => {
  it('caps bubbles at three', () => {
    expect(MAX_BUBBLES_PER_RESPONSE).toBe(3)
  })

  it('uses a short fixed inter-bubble gap', () => {
    // Specified directly rather than derived from sampleTiming — TAC-313 §6
    // puts all timing tuning out of scope.
    expect(INTER_BUBBLE_GAP_MS).toBe(1_500)
  })
})
