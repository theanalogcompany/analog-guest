import { describe, expect, it, vi } from 'vitest'
import {
  SPLIT_PROBABILITY,
  resolveDispatchBubbles,
  splitIntoSentences,
  stripTerminalPeriod,
} from './sentence-split'
import { BUBBLE_DELIMITER, MAX_BUBBLES_PER_RESPONSE } from './split-message'

// TAC-319 round 3: splitting is deterministic code, not model judgment. These
// tests pin the three layers separately — sentence detection (with the guards
// the ruling says must not be discovered in UAT), terminal-punctuation
// stripping, and the flip orchestration with an injected rng.

const alwaysSplit = () => 0 // rng below SPLIT_PROBABILITY → split branch
const neverSplit = () => 0.99 // rng above SPLIT_PROBABILITY → single block

describe('splitIntoSentences', () => {
  it('returns a single-sentence body whole', () => {
    expect(splitIntoSentences('Open until 4 tonight')).toEqual(['Open until 4 tonight'])
  })

  it('splits on period + whitespace + capital', () => {
    expect(
      splitIntoSentences('Espresso with a small dollop of foam on top. Similar ratio to a flat white.'),
    ).toEqual([
      'Espresso with a small dollop of foam on top.',
      'Similar ratio to a flat white.',
    ])
  })

  it('splits on ? and ! boundaries', () => {
    expect(splitIntoSentences('Want it iced? We can do that! Just say when.')).toEqual([
      'Want it iced?',
      'We can do that!',
      'Just say when.',
    ])
  })

  it('splits when the next sentence opens with a digit', () => {
    expect(splitIntoSentences('We open early. 7am on weekdays.')).toEqual([
      'We open early.',
      '7am on weekdays.',
    ])
  })

  // The capital gate (TAC-319 ruling #2): lowercase after a boundary means no
  // split. The safe failure direction — one slightly-long message, never a
  // mangled one.
  it('does NOT split when the next word is lowercase', () => {
    expect(splitIntoSentences('we close at 11. come by anytime')).toEqual([
      'we close at 11. come by anytime',
    ])
  })

  // ── guards the ruling names: do not discover these in UAT ─────────────

  it('does not split inside prices or decimals', () => {
    expect(splitIntoSentences('The mocha is $7.95 and worth it')).toEqual([
      'The mocha is $7.95 and worth it',
    ])
    expect(splitIntoSentences('Each pour is 4.5 oz exactly')).toEqual([
      'Each pour is 4.5 oz exactly',
    ])
  })

  it('splits AFTER a price without harming the internal decimal', () => {
    expect(splitIntoSentences('The mocha is $7.95. It comes iced too.')).toEqual([
      'The mocha is $7.95.',
      'It comes iced too.',
    ])
  })

  it('does not split inside ratios or times', () => {
    expect(splitIntoSentences('We pull it 1:1 like a ristretto')).toEqual([
      'We pull it 1:1 like a ristretto',
    ])
    expect(splitIntoSentences('Doors at 7:30 on Fridays')).toEqual([
      'Doors at 7:30 on Fridays',
    ])
  })

  it.each([
    ['St.', 'Two blocks up on St. Marks Ave'],
    ['Ave.', 'Corner of Classon Ave. Right past the bank'],
    ['Dr.', 'Ask for Dr. Lee at the counter'],
    ['a.m.', 'We open at 8 a.m. Most days anyway'],
    ['p.m.', 'Kitchen closes at 9 p.m. Bar stays open'],
    ['etc.', 'Oat, almond, etc. Whatever you like'],
    ['vs.', 'Cortado vs. Flat white is mostly size'],
  ])('does not split after the abbreviation %s', (_label, body) => {
    expect(splitIntoSentences(body)).toEqual([body])
  })

  it('does not split at an ellipsis', () => {
    expect(splitIntoSentences('Honestly... Maybe the cortado')).toEqual([
      'Honestly... Maybe the cortado',
    ])
  })

  it('still splits a real boundary elsewhere in a body that contains an ellipsis', () => {
    expect(splitIntoSentences('Honestly... Maybe the cortado. Ask for it iced.')).toEqual([
      'Honestly... Maybe the cortado.',
      'Ask for it iced.',
    ])
  })

  it('treats an emoji as a sentence opener', () => {
    expect(splitIntoSentences('See you at 8. \u{1F44D} sounds good')).toEqual([
      'See you at 8.',
      '\u{1F44D} sounds good',
    ])
  })

  it('does not treat a trailing period with nothing after it as a boundary', () => {
    expect(splitIntoSentences('Open until 4. ')).toEqual(['Open until 4.'])
  })
})

describe('stripTerminalPeriod', () => {
  it('strips a single terminal period', () => {
    expect(stripTerminalPeriod('It comes iced too.')).toBe('It comes iced too')
  })

  it('keeps a terminal question mark', () => {
    expect(stripTerminalPeriod('Want it iced?')).toBe('Want it iced?')
  })

  it('keeps a terminal exclamation mark', () => {
    expect(stripTerminalPeriod('We can do that!')).toBe('We can do that!')
  })

  it('keeps a terminal ellipsis', () => {
    expect(stripTerminalPeriod('Maybe the cortado...')).toBe('Maybe the cortado...')
  })

  it('never touches internal punctuation', () => {
    expect(stripTerminalPeriod('The mocha is $7.95, iced or hot.')).toBe(
      'The mocha is $7.95, iced or hot',
    )
  })

  it('leaves a piece with no terminal punctuation alone', () => {
    expect(stripTerminalPeriod('open until 4')).toBe('open until 4')
  })
})

describe('resolveDispatchBubbles — the flip', () => {
  it('sends a one-sentence body as-is without consulting the rng', () => {
    const rng = vi.fn(() => 0)
    expect(resolveDispatchBubbles('Open until 4 tonight.', rng)).toEqual([
      'Open until 4 tonight.',
    ])
    expect(rng).not.toHaveBeenCalled()
  })

  it('splits a two-sentence body when the flip says split', () => {
    expect(
      resolveDispatchBubbles('Espresso with foam on top. Stronger than a cortado.', alwaysSplit),
    ).toEqual(['Espresso with foam on top', 'Stronger than a cortado'])
  })

  it('keeps a two-sentence body whole when the flip says no', () => {
    expect(
      resolveDispatchBubbles('Espresso with foam on top. Stronger than a cortado.', neverSplit),
    ).toEqual(['Espresso with foam on top. Stronger than a cortado.'])
  })

  it('is all-or-nothing at three sentences', () => {
    const body = 'First one here. Second one here. Third one here.'
    expect(resolveDispatchBubbles(body, alwaysSplit)).toEqual([
      'First one here',
      'Second one here',
      'Third one here',
    ])
    expect(resolveDispatchBubbles(body, neverSplit)).toEqual([body])
  })

  // TAC-319 ruling #1: 4+ sentences never flip. The cap would force partial
  // grouping, violating all-or-nothing; long answers stay single.
  it('sends a 4+ sentence body as ONE block without consulting the rng', () => {
    const rng = vi.fn(() => 0)
    const body = 'One here. Two here. Three here. Four here.'
    expect(resolveDispatchBubbles(body, rng)).toEqual([body])
    expect(rng).not.toHaveBeenCalled()
  })

  it('consults the rng exactly once per flippable body', () => {
    const rng = vi.fn(() => 0)
    resolveDispatchBubbles('First one. Second one. Third one.', rng)
    expect(rng).toHaveBeenCalledTimes(1)
  })

  it('strips terminal periods on the split branch but keeps ? and !', () => {
    expect(resolveDispatchBubbles('Want it iced? We hold it until 6.', alwaysSplit)).toEqual([
      'Want it iced?',
      'We hold it until 6',
    ])
  })

  it('leaves the single-block branch punctuation untouched', () => {
    const body = 'Want it iced? We hold it until 6.'
    expect(resolveDispatchBubbles(body, neverSplit)).toEqual([body])
  })

  // ── stray delimiter markers are noise now ─────────────────────────────

  it('strips stray [[BREAK]] markers before splitting, on both branches', () => {
    const body = `First one here.${BUBBLE_DELIMITER}Second one here.`
    expect(resolveDispatchBubbles(body, alwaysSplit)).toEqual([
      'First one here',
      'Second one here',
    ])
    expect(resolveDispatchBubbles(body, neverSplit)).toEqual([
      'First one here. Second one here.',
    ])
  })

  it('never lets a delimiter or near-miss reach the output', () => {
    const body = `see the menu [[BREAK] here${BUBBLE_DELIMITER}thanks`
    for (const rng of [alwaysSplit, neverSplit]) {
      for (const bubble of resolveDispatchBubbles(body, rng)) {
        expect(bubble.toUpperCase()).not.toContain('BREAK')
      }
    }
  })

  it('returns [] for empty, whitespace-only, or delimiter-only bodies', () => {
    expect(resolveDispatchBubbles('', alwaysSplit)).toEqual([])
    expect(resolveDispatchBubbles('   \n  ', alwaysSplit)).toEqual([])
    expect(resolveDispatchBubbles(BUBBLE_DELIMITER, alwaysSplit)).toEqual([])
  })

  it('flips exactly at the SPLIT_PROBABILITY threshold boundary', () => {
    const body = 'First one here. Second one here.'
    // rng() < SPLIT_PROBABILITY splits; exactly at the threshold does not.
    expect(resolveDispatchBubbles(body, () => SPLIT_PROBABILITY - 0.0001)).toHaveLength(2)
    expect(resolveDispatchBubbles(body, () => SPLIT_PROBABILITY)).toHaveLength(1)
  })

  it('caps the flippable range at MAX_BUBBLES_PER_RESPONSE', () => {
    // Guard against the cap and the flip range drifting apart: exactly at the
    // cap still flips, one past it does not.
    const atCap = Array.from({ length: MAX_BUBBLES_PER_RESPONSE }, (_, i) => `Sentence ${i + 1} here.`).join(' ')
    const pastCap = Array.from({ length: MAX_BUBBLES_PER_RESPONSE + 1 }, (_, i) => `Sentence ${i + 1} here.`).join(' ')
    expect(resolveDispatchBubbles(atCap, alwaysSplit)).toHaveLength(MAX_BUBBLES_PER_RESPONSE)
    expect(resolveDispatchBubbles(pastCap, alwaysSplit)).toHaveLength(1)
  })
})
