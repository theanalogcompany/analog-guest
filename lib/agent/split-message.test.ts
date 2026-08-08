import { describe, expect, it } from 'vitest'

import {
  BUBBLE_DELIMITER,
  INTER_BUBBLE_GAP_MS,
  MAX_BUBBLES_PER_RESPONSE,
  collapseToSingleMessage,
  splitIntoBubbles,
} from './split-message'

describe('splitIntoBubbles', () => {
  it('returns the body unchanged as one bubble when no delimiter is present', () => {
    // The common case. Splitting is the exception, not the default.
    expect(splitIntoBubbles('Open until 4')).toEqual(['Open until 4'])
  })

  it('splits a pick from its description (the TAC-313 issue #7 case)', () => {
    const body = `I'd go for the Frosty Gandhi${BUBBLE_DELIMITER}Espresso, chai, peppermint`
    expect(splitIntoBubbles(body)).toEqual([
      "I'd go for the Frosty Gandhi",
      'Espresso, chai, peppermint',
    ])
  })

  it('splits two picks into two bubbles', () => {
    const body = `The cortado if you want something short${BUBBLE_DELIMITER}Otherwise the au lait`
    expect(splitIntoBubbles(body)).toEqual([
      'The cortado if you want something short',
      'Otherwise the au lait',
    ])
  })

  it('strips whitespace around the delimiter without eating the words', () => {
    expect(splitIntoBubbles(`first  \n\n  ${BUBBLE_DELIMITER}   second`)).toEqual([
      'first',
      'second',
    ])
  })

  it('collapses internal whitespace runs inside each bubble', () => {
    expect(splitIntoBubbles('open   until\n\n4')).toEqual(['open until 4'])
  })

  // ── near-miss tolerance ───────────────────────────────────────────────
  // A malformed delimiter surviving the split is the one way this feature
  // reaches a guest, so each of these asserts the delimiter is GONE from the
  // output, not merely that a split occurred.

  it.each([
    ['single brackets', '[BREAK]'],
    ['lowercase', '[[break]]'],
    ['mixed case', '[[Break]]'],
    ['inner whitespace', '[[ BREAK ]]'],
    ['missing one closing bracket', '[[BREAK]'],
    ['missing both closing brackets', '[[BREAK'],
    ['extra opening bracket dropped', '[BREAK]]'],
  ])('tolerates a near-miss delimiter: %s', (_label, delimiter) => {
    const out = splitIntoBubbles(`first${delimiter}second`)
    expect(out).toEqual(['first', 'second'])
    for (const bubble of out) {
      expect(bubble.toUpperCase()).not.toContain('BREAK')
      expect(bubble).not.toContain('[')
      expect(bubble).not.toContain(']')
    }
  })

  it('splits a double-bracket delimiter fused straight into the next word', () => {
    // Both closing brackets and the space lost. Two opening brackets is an
    // unambiguous signal, so this still splits.
    expect(splitIntoBubbles('first[[BREAKsecond')).toEqual(['first', 'second'])
  })

  it('does NOT match BREAK inside a longer word after a SINGLE bracket', () => {
    // The single-bracket alternative requires a word boundary. Without it this
    // would match `[BREAK` and leave a dangling `FAST]` in a message a guest
    // actually reads — which is why the fused single-bracket shape
    // (`a[BREAKb`) is deliberately left unmatched.
    expect(splitIntoBubbles('see the [BREAKFAST] menu')).toEqual([
      'see the [BREAKFAST] menu',
    ])
  })

  it('does NOT match a bare unbracketed BREAK', () => {
    // Accepted residual: the unbracketed word appears in ordinary prose, and
    // stripping it would corrupt real messages.
    expect(splitIntoBubbles('we take a break at three')).toEqual([
      'we take a break at three',
    ])
  })

  // ── cap ───────────────────────────────────────────────────────────────

  it('caps at MAX_BUBBLES_PER_RESPONSE', () => {
    const body = ['a', 'b', 'c', 'd', 'e'].join(BUBBLE_DELIMITER)
    expect(splitIntoBubbles(body)).toHaveLength(MAX_BUBBLES_PER_RESPONSE)
  })

  it('MERGES beats past the cap rather than discarding them', () => {
    // The direction matters: truncating would silently delete a sentence the
    // model meant to send. Every word survives, in order.
    const body = ['a', 'b', 'c', 'd', 'e'].join(BUBBLE_DELIMITER)
    expect(splitIntoBubbles(body)).toEqual(['a', 'b', 'c d e'])
  })

  it('preserves every word from an over-cap body', () => {
    const beats = ['one', 'two', 'three', 'four', 'five', 'six']
    const out = splitIntoBubbles(beats.join(BUBBLE_DELIMITER))
    expect(out.join(' ').split(' ')).toEqual(beats)
  })

  // ── degenerate input ──────────────────────────────────────────────────

  it('drops empty segments from doubled delimiters', () => {
    const body = `first${BUBBLE_DELIMITER}${BUBBLE_DELIMITER}second`
    expect(splitIntoBubbles(body)).toEqual(['first', 'second'])
  })

  it('ignores a leading or trailing delimiter', () => {
    const body = `${BUBBLE_DELIMITER}only thing${BUBBLE_DELIMITER}`
    expect(splitIntoBubbles(body)).toEqual(['only thing'])
  })

  it('returns an empty array for a delimiter-only body', () => {
    // The caller treats this as an empty body and takes its existing failure
    // path, rather than dispatching nothing and reporting success.
    expect(splitIntoBubbles(BUBBLE_DELIMITER)).toEqual([])
  })

  it('returns an empty array for an empty or whitespace-only body', () => {
    expect(splitIntoBubbles('')).toEqual([])
    expect(splitIntoBubbles('   \n  ')).toEqual([])
  })

  it('is not stateful across calls (shared regex lastIndex)', () => {
    const body = `first${BUBBLE_DELIMITER}second`
    const a = splitIntoBubbles(body)
    const b = splitIntoBubbles(body)
    expect(a).toEqual(b)
  })
})

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
