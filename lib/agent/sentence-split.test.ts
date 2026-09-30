import { describe, expect, it, vi } from 'vitest'
import {
  SPLIT_PROBABILITY,
  hasRenderableContent,
  intentionTailFor,
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
    expect(splitIntoSentences('Open until 4 tonight')).toEqual([
      'Open until 4 tonight',
    ])
  })

  it('splits on period + whitespace + capital', () => {
    expect(
      splitIntoSentences(
        'Espresso with a small dollop of foam on top. Similar ratio to a flat white.',
      ),
    ).toEqual([
      'Espresso with a small dollop of foam on top.',
      'Similar ratio to a flat white.',
    ])
  })

  it('splits on ? and ! boundaries', () => {
    expect(
      splitIntoSentences('Want it iced? We can do that! Just say when.'),
    ).toEqual(['Want it iced?', 'We can do that!', 'Just say when.'])
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
    expect(
      splitIntoSentences('The mocha is $7.95. It comes iced too.'),
    ).toEqual(['The mocha is $7.95.', 'It comes iced too.'])
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
    expect(
      splitIntoSentences('Honestly... Maybe the cortado. Ask for it iced.'),
    ).toEqual(['Honestly... Maybe the cortado.', 'Ask for it iced.'])
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
    expect(stripTerminalPeriod('Maybe the cortado...')).toBe(
      'Maybe the cortado...',
    )
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
    expect(
      resolveDispatchBubbles('Open until 4 tonight.', rng, '', ''),
    ).toEqual(['Open until 4 tonight.'])
    expect(rng).not.toHaveBeenCalled()
  })

  it('splits a two-sentence body when the flip says split', () => {
    expect(
      resolveDispatchBubbles(
        'Espresso with foam on top. Stronger than a cortado.',
        alwaysSplit,
        '',
        '',
      ),
    ).toEqual(['Espresso with foam on top', 'Stronger than a cortado'])
  })

  it('keeps a two-sentence body whole when the flip says no', () => {
    expect(
      resolveDispatchBubbles(
        'Espresso with foam on top. Stronger than a cortado.',
        neverSplit,
        '',
        '',
      ),
    ).toEqual(['Espresso with foam on top. Stronger than a cortado.'])
  })

  it('is all-or-nothing at three sentences', () => {
    const body = 'First one here. Second one here. Third one here.'
    expect(resolveDispatchBubbles(body, alwaysSplit, '', '')).toEqual([
      'First one here',
      'Second one here',
      'Third one here',
    ])
    expect(resolveDispatchBubbles(body, neverSplit, '', '')).toEqual([body])
  })

  // TAC-319 ruling #1: 4+ sentences never flip. The cap would force partial
  // grouping, violating all-or-nothing; long answers stay single.
  it('sends a 4+ sentence body as ONE block without consulting the rng', () => {
    const rng = vi.fn(() => 0)
    const body = 'One here. Two here. Three here. Four here.'
    expect(resolveDispatchBubbles(body, rng, '', '')).toEqual([body])
    expect(rng).not.toHaveBeenCalled()
  })

  it('consults the rng exactly once per flippable body', () => {
    const rng = vi.fn(() => 0)
    resolveDispatchBubbles('First one. Second one. Third one.', rng, '', '')
    expect(rng).toHaveBeenCalledTimes(1)
  })

  it('strips terminal periods on the split branch but keeps ? and !', () => {
    expect(
      resolveDispatchBubbles(
        'Want it iced? We hold it until 6.',
        alwaysSplit,
        '',
        '',
      ),
    ).toEqual(['Want it iced?', 'We hold it until 6'])
  })

  it('leaves the single-block branch punctuation untouched', () => {
    const body = 'Want it iced? We hold it until 6.'
    expect(resolveDispatchBubbles(body, neverSplit, '', '')).toEqual([body])
  })

  // ── stray delimiter markers are noise now ─────────────────────────────

  it('strips stray [[BREAK]] markers before splitting, on both branches', () => {
    const body = `First one here.${BUBBLE_DELIMITER}Second one here.`
    expect(resolveDispatchBubbles(body, alwaysSplit, '', '')).toEqual([
      'First one here',
      'Second one here',
    ])
    expect(resolveDispatchBubbles(body, neverSplit, '', '')).toEqual([
      'First one here. Second one here.',
    ])
  })

  it('never lets a delimiter or near-miss reach the output', () => {
    const body = `see the menu [[BREAK] here${BUBBLE_DELIMITER}thanks`
    for (const rng of [alwaysSplit, neverSplit]) {
      for (const bubble of resolveDispatchBubbles(body, rng, '', '')) {
        expect(bubble.toUpperCase()).not.toContain('BREAK')
      }
    }
  })

  it('returns [] for empty, whitespace-only, or delimiter-only bodies', () => {
    expect(resolveDispatchBubbles('', alwaysSplit, '', '')).toEqual([])
    expect(resolveDispatchBubbles('   \n  ', alwaysSplit, '', '')).toEqual([])
    expect(
      resolveDispatchBubbles(BUBBLE_DELIMITER, alwaysSplit, '', ''),
    ).toEqual([])
  })

  it('flips exactly at the SPLIT_PROBABILITY threshold boundary', () => {
    const body = 'First one here. Second one here.'
    // rng() < SPLIT_PROBABILITY splits; exactly at the threshold does not.
    expect(
      resolveDispatchBubbles(body, () => SPLIT_PROBABILITY - 0.0001, '', ''),
    ).toHaveLength(2)
    expect(
      resolveDispatchBubbles(body, () => SPLIT_PROBABILITY, '', ''),
    ).toHaveLength(1)
  })

  it('caps the flippable range at MAX_BUBBLES_PER_RESPONSE', () => {
    // Guard against the cap and the flip range drifting apart: exactly at the
    // cap still flips, one past it does not.
    const atCap = Array.from(
      { length: MAX_BUBBLES_PER_RESPONSE },
      (_, i) => `Sentence ${i + 1} here.`,
    ).join(' ')
    const pastCap = Array.from(
      { length: MAX_BUBBLES_PER_RESPONSE + 1 },
      (_, i) => `Sentence ${i + 1} here.`,
    ).join(' ')
    expect(resolveDispatchBubbles(atCap, alwaysSplit, '', '')).toHaveLength(
      MAX_BUBBLES_PER_RESPONSE,
    )
    expect(resolveDispatchBubbles(pastCap, alwaysSplit, '', '')).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// TAC-554: the getting-to-know-you question is always its own last message.
//
// Jaipal ruled it; a persona rule saying so failed twice on device. The two
// failures are reproduced below as the first two tests, because they are the
// reason this is code rather than wording: one rode the coin and lost, and the
// other had no detectable sentence boundary and could not have split at all.
// ---------------------------------------------------------------------------

describe('hasRenderableContent', () => {
  it('accepts a letter or a digit', () => {
    expect(hasRenderableContent('hi')).toBe(true)
    expect(hasRenderableContent('7')).toBe(true)
    expect(hasRenderableContent('¿cómo?')).toBe(true)
  })

  // The reachable case: replaceDashes refuses a substitution that would empty a
  // non-empty string, so an intentionQuestion of only an em dash survives as
  // "—" and would otherwise become a bubble containing a dash.
  it('rejects punctuation, whitespace or an emoji alone', () => {
    expect(hasRenderableContent('')).toBe(false)
    expect(hasRenderableContent('   ')).toBe(false)
    expect(hasRenderableContent('—')).toBe(false)
    expect(hasRenderableContent('?!')).toBe(false)
    expect(hasRenderableContent('🙂')).toBe(false)
  })
})

describe('intentionTailFor — the gate', () => {
  it('passes the question through when the intentions block rendered', () => {
    expect(intentionTailFor("what's your name?", 1)).toBe("what's your name?")
    expect(intentionTailFor("what's your name?", 3)).toBe("what's your name?")
  })

  // The belt to the model's braces. renderableIntentions already excludes
  // opt_out, comp_complaint and pending-question turns, so a question emitted
  // on one of those turns must never become its own bubble.
  it('drops the question when nothing rendered', () => {
    expect(intentionTailFor("what's your name?", 0)).toBe('')
  })
})

describe('resolveDispatchBubbles — the intention tail', () => {
  // FAILURE 1 FROM THE TICKET, on the code that shipped it. Three sentences
  // puts this in the flippable range, so it rode a fair coin and lost.
  it("the ticket's first failure: three sentences that lost the coin stay one message", () => {
    const body =
      "nice! what variation did you go with? and by the way, what's your name?"
    expect(resolveDispatchBubbles(body, neverSplit, '', '')).toEqual([body])
  })

  // FAILURE 2 FROM THE TICKET. There is no `.?!` before "do", so
  // splitIntoSentences finds ONE sentence and no coin value could have split
  // it. This is the test that shows wording could never have carried the rule.
  it("the ticket's second failure: one detectable sentence could not split at ANY coin value", () => {
    const body =
      'Foncii, nice to meet you 🙂 do you live or work around Polk Street?'
    expect(splitIntoSentences(body)).toHaveLength(1)
    expect(resolveDispatchBubbles(body, alwaysSplit, '', '')).toEqual([body])
    expect(resolveDispatchBubbles(body, neverSplit, '', '')).toEqual([body])
  })

  // The same second failure, now with the question arriving as its own string.
  // No sentence boundary is needed, because there is no sentence to cut.
  it('separates the question with no detectable boundary in front of it', () => {
    const tail = 'do you live or work around Polk Street?'
    const body = `Foncii, nice to meet you 🙂 ${tail}`
    expect(resolveDispatchBubbles(body, neverSplit, tail, '')).toEqual([
      'Foncii, nice to meet you 🙂',
      tail,
    ])
  })

  it('puts the question last and alone whichever way the coin lands', () => {
    const tail = "by the way, what's your name?"
    const body = `Open until 3 on Sundays. Same on Saturdays. ${tail}`
    for (const rng of [alwaysSplit, neverSplit]) {
      const bubbles = resolveDispatchBubbles(body, rng, tail, '')
      expect(bubbles[bubbles.length - 1]).toBe(tail)
      expect(bubbles.slice(0, -1).join(' ')).not.toContain(tail)
    }
  })

  // THE STRUCTURAL IDENTITY. The last bubble is the tail character for
  // character, because generation composed the body by joining them.
  it('makes the last bubble the tail exactly', () => {
    const tail = 'where are you coming from?'
    const bubbles = resolveDispatchBubbles(
      `Open until 3. ${tail}`,
      alwaysSplit,
      tail,
      '',
    )
    expect(bubbles[bubbles.length - 1]).toBe(tail)
  })

  it('never produces an empty or contentless bubble, whatever the inputs', () => {
    const cases: [string, string][] = [
      ['Open until 3. what is your name?', 'what is your name?'],
      ['   Open until 3.    what is your name?   ', 'what is your name?'],
      ['what is your name?', 'what is your name?'],
      ['Open until 3. —', '—'],
      ['Open until 3.', '   '],
      ['Open until 3. One. Two. what is your name?', 'what is your name?'],
    ]
    for (const [body, tail] of cases) {
      for (const rng of [alwaysSplit, neverSplit]) {
        const bubbles = resolveDispatchBubbles(body, rng, tail, '')
        expect(bubbles.length).toBeGreaterThan(0)
        for (const b of bubbles) {
          expect(b.trim()).not.toBe('')
          expect(hasRenderableContent(b)).toBe(true)
        }
      }
    }
  })

  it('honours the bubble cap with the question included', () => {
    const tail = 'what is your name?'
    // Two answer sentences plus the question is the maximum shape.
    const body = `One sentence here. Two sentences here. ${tail}`
    expect(resolveDispatchBubbles(body, alwaysSplit, tail, '')).toEqual([
      'One sentence here',
      'Two sentences here',
      tail,
    ])
    // Three answer sentences would make four messages, so the answer stays
    // whole and the total is two. Four bubbles is what MAX_BUBBLES_PER_RESPONSE
    // exists to prevent, and the question does not get to break it.
    const longer = `One here. Two here. Three here. ${tail}`
    const bubbles = resolveDispatchBubbles(longer, alwaysSplit, tail, '')
    expect(bubbles).toEqual(['One here. Two here. Three here', tail])
    expect(bubbles.length).toBeLessThanOrEqual(MAX_BUBBLES_PER_RESPONSE)
  })

  it('sends the question alone when the answer is empty', () => {
    const tail = 'what is your name?'
    expect(resolveDispatchBubbles(tail, alwaysSplit, tail, '')).toEqual([tail])
    expect(resolveDispatchBubbles(`   ${tail}`, neverSplit, tail, '')).toEqual([
      tail,
    ])
  })

  it('drops a contentless question rather than bubbling it', () => {
    // An em dash survives replaceDashes' refusal, so this shape is reachable.
    expect(
      resolveDispatchBubbles('Open until 3. —', neverSplit, '—', ''),
    ).toEqual(['Open until 3. —'])
    expect(
      resolveDispatchBubbles('Open until 3.', neverSplit, '  ', ''),
    ).toEqual(['Open until 3.'])
  })

  // THE BELT. The composition guarantees the tail is a suffix; if it ever is
  // not, send one correct message rather than slice at a meaningless offset.
  it('falls back to the old path when the tail is not a suffix of the body', () => {
    const bubbles = resolveDispatchBubbles(
      'Open until 3 tonight.',
      neverSplit,
      'what is your name?',
      '',
    )
    expect(bubbles).toEqual(['Open until 3 tonight.'])
  })

  it('returns [] for an empty body whatever the tail says', () => {
    expect(
      resolveDispatchBubbles('', alwaysSplit, 'what is your name?', ''),
    ).toEqual([])
    expect(
      resolveDispatchBubbles('   ', alwaysSplit, 'what is your name?', ''),
    ).toEqual([])
  })

  // An answer that becomes its own message should not end in a period, which
  // is TAC-319's own rule for a piece that dispatches as a bubble.
  it("strips the answer's terminal period once it is a message of its own", () => {
    const tail = 'what is your name?'
    expect(
      resolveDispatchBubbles(
        `Open until 3 tonight. ${tail}`,
        neverSplit,
        tail,
        '',
      ),
    ).toEqual(['Open until 3 tonight', tail])
  })

  // THE NO-CHANGE GUARANTEE, and it is asserted as an EQUIVALENCE rather than
  // by restating expected bubbles: an empty tail must produce exactly what the
  // pre-TAC-554 two-argument call produced. Both paths run splitToBubbles with
  // the same text, the same rng and the original cap, so this holds by
  // construction — and this test is what would catch it stopping to.
  it('is unchanged from the old behaviour when no question is asked', () => {
    const bodies = [
      'Open until 4 tonight.',
      'Espresso with foam on top. Stronger than a cortado.',
      'One. Two. Three.',
      'One. Two. Three. Four.',
      `Open until 3.${BUBBLE_DELIMITER}Come by.`,
      '',
    ]
    for (const body of bodies) {
      for (const flip of [0, 0.49, SPLIT_PROBABILITY, 0.99]) {
        const withEmptyTail = resolveDispatchBubbles(body, () => flip, '', '')
        // Reconstruct the old rule independently rather than calling the new
        // function a second way, so this compares against a statement of the
        // old behaviour and not against itself.
        const sentences = splitIntoSentences(
          body.replace(BUBBLE_DELIMITER, ' ').replace(/\s+/g, ' ').trim(),
        )
        const cleaned = body
          .replace(BUBBLE_DELIMITER, ' ')
          .replace(/\s+/g, ' ')
          .trim()
        const expected =
          cleaned === ''
            ? []
            : sentences.length < 2 ||
                sentences.length > MAX_BUBBLES_PER_RESPONSE
              ? [cleaned]
              : flip < SPLIT_PROBABILITY
                ? sentences.map(stripTerminalPeriod)
                : [cleaned]
        expect(withEmptyTail).toEqual(expected)
      }
    }
  })
})

// TAC-568: the fixed warm close rides as the response's own LAST bubble.
//
// The properties that matter are all about what is NOT done to it. It is appended
// verbatim, never sliced out of the body the way the intention tail is, so it is
// the one piece of guest-facing text in this module that must survive byte for
// byte.
describe('resolveDispatchBubbles — the warm close bubble (TAC-568)', () => {
  // Le Mil's live wording, and deliberately the awkward case: an apostrophe, two
  // commas, no terminal punctuation, and a trailing multi-byte emoji. If any
  // normalizer touches the tail, one of these is what it damages.
  const CLOSE =
    "by the way, you can always message us here, whether it's about our coffee and beans, what to get next time, or what's coming up at the shop ☕"

  const never = (): number => 1 // never split
  const always = (): number => 0 // always split

  it('appends it as the last bubble, byte for byte', () => {
    const out = resolveDispatchBubbles('see you soon', never, '', CLOSE)
    expect(out).toEqual(['see you soon', CLOSE])
    // The byte-level check, not just ===: this is the assertion that a trim, a
    // whitespace collapse or an emoji re-encode would fail.
    expect(Buffer.from(out[1] as string, 'utf8')).toEqual(
      Buffer.from(CLOSE, 'utf8'),
    )
    expect((out[1] as string).length).toBe(CLOSE.length)
  })

  it('does not strip a terminal period from it', () => {
    // stripTerminalPeriod runs on every bubble the SPLITTER produces. The close
    // is not one of those: it is a venue's setting, and editing it here would
    // make "byte-identical" untrue for any venue that ends theirs with a period.
    const withPeriod = 'message us anytime.'
    const out = resolveDispatchBubbles('see you soon', never, '', withPeriod)
    expect(out[out.length - 1]).toBe(withPeriod)
  })

  it('does not sentence-split it, however many sentences it has', () => {
    // Capitalised so it IS splittable: a body the splitter would never split
    // anyway could not show that this one is exempt.
    const two = 'The line is open. Message us anytime'
    const out = resolveDispatchBubbles('see you soon', always, '', two)
    expect(out[out.length - 1]).toBe(two)
  })

  it('leaves every turn without one byte-identical to before', () => {
    // The no-close path must be the call it was before TAC-568. Same body, same
    // coin, same tail, and '' for the close.
    for (const flip of [always, never]) {
      for (const body of [
        'One sentence only',
        'First thing. Second thing',
        'First thing. Second thing. Third thing',
        '',
        '   ',
      ]) {
        expect(resolveDispatchBubbles(body, flip, '', '')).toEqual(
          resolveDispatchBubbles(body, flip, '', ''),
        )
      }
    }
    // And the splitting itself still happens when no close is present, so the
    // equality above is not vacuously true of a path that stopped splitting.
    expect(
      resolveDispatchBubbles('First thing. Second thing', always, '', ''),
    ).toEqual(['First thing', 'Second thing'])
  })

  it('cannot rescue an empty body', () => {
    // A close with no reply in front of it is not a reply, the same rule the
    // intention tail follows. The body is checked first, so '' stays [].
    expect(resolveDispatchBubbles('', never, '', CLOSE)).toEqual([])
    expect(resolveDispatchBubbles('   ', never, '', CLOSE)).toEqual([])
  })

  it('ignores a setting that holds no renderable content', () => {
    // Whitespace or punctuation alone is not a message; appending it would send
    // the guest an empty bubble.
    for (const junk of ['', '   ', '...', '—']) {
      expect(resolveDispatchBubbles('see you soon', never, '', junk)).toEqual([
        'see you soon',
      ])
    }
  })

  it('never pushes the response past the bubble cap', () => {
    // The close takes a slot off the top, so the answer splits within what is
    // left. Four bubbles in a row stops reading as texting, which is the whole
    // reason MAX_BUBBLES_PER_RESPONSE exists.
    const three = 'First thing. Second thing. Third thing'
    const out = resolveDispatchBubbles(three, always, '', CLOSE)
    expect(out.length).toBeLessThanOrEqual(MAX_BUBBLES_PER_RESPONSE)
    expect(out[out.length - 1]).toBe(CLOSE)
  })

  it('stays inside the cap with an intention question as well', () => {
    // Both tails on one turn. Rare (TAC-567's never-two-questions gate makes it
    // rarer) but reachable, and the arithmetic has to hold rather than be argued.
    const question = 'are you nearby?'
    const out = resolveDispatchBubbles(
      `Glad it landed. ${question}`,
      always,
      question,
      CLOSE,
    )
    expect(out.length).toBeLessThanOrEqual(MAX_BUBBLES_PER_RESPONSE)
    expect(out[out.length - 1]).toBe(CLOSE)
    // The question keeps its own bubble, immediately before the close.
    expect(out[out.length - 2]).toBe(question)
  })

  it('puts it after a question that used the whole body', () => {
    const question = 'are you nearby?'
    const out = resolveDispatchBubbles(question, never, question, CLOSE)
    expect(out).toEqual([question, CLOSE])
  })
})
