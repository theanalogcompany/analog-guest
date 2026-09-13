import { describe, expect, it } from 'vitest'
import {
  containsEmoji,
  countEmoji,
  EMOJI_PROBABILITY,
  resolveEmojiDirective,
} from './emoji-cadence'

describe('EMOJI_PROBABILITY (TAC-362)', () => {
  // These two are the load-bearing assertions of the whole module, and they
  // assert ABSENCE of a flip. `never` and `sparingly` each measured 0 emoji
  // across 240 live responses; giving either a probability would change a
  // venue nobody asked to change. A future "let's just make sparingly mean
  // sparingly" edit should have to delete a test that says why not.
  it('never does not vary per message', () => {
    expect(EMOJI_PROBABILITY.never).toBeNull()
  })

  it('sparingly does not vary per message (deliberate — its own ticket)', () => {
    expect(EMOJI_PROBABILITY.sparingly).toBeNull()
  })

  // Pinned by VALUE, not just by "is a number". TAC-358's lesson: every
  // floor test around KNOWLEDGE_RELEVANCE_FLOOR was written relative to the
  // constant, so when the constant was wrong nothing failed. One pinned
  // assertion is what makes a change to this number deliberate.
  it('frequent flips at 0.75', () => {
    expect(EMOJI_PROBABILITY.frequent).toBe(0.75)
  })
})

describe('resolveEmojiDirective (TAC-362)', () => {
  it('returns null for never — and does not consume the rng', () => {
    let calls = 0
    const rng = () => {
      calls++
      return 0
    }
    expect(resolveEmojiDirective('never', rng)).toBeNull()
    expect(calls).toBe(0)
  })

  it('returns null for sparingly — and does not consume the rng', () => {
    let calls = 0
    const rng = () => {
      calls++
      return 0
    }
    expect(resolveEmojiDirective('sparingly', rng)).toBeNull()
    expect(calls).toBe(0)
  })

  it('frequent: a low draw permits an emoji', () => {
    expect(resolveEmojiDirective('frequent', () => 0)).toBe('allowed')
  })

  it('frequent: a high draw forbids one', () => {
    expect(resolveEmojiDirective('frequent', () => 0.99)).toBe('none')
  })

  // The comparison is `<`, so a draw landing exactly ON the probability
  // falls to 'none'. Pinned because the boundary is the kind of thing a
  // refactor flips to `<=` without noticing.
  it('frequent: a draw exactly at the probability is none, not allowed', () => {
    expect(resolveEmojiDirective('frequent', () => 0.75)).toBe('none')
    expect(resolveEmojiDirective('frequent', () => 0.7499)).toBe('allowed')
  })

  // The actual claim the ticket makes: a run of messages is not a pattern.
  // A fixed rng would satisfy every test above and still produce a template.
  it('varies across a run of generations', () => {
    const draws = [0.1, 0.9, 0.2, 0.95, 0.5, 0.99, 0.3, 0.8]
    let i = 0
    const rng = () => draws[i++] ?? 0
    const run = draws.map(() => resolveEmojiDirective('frequent', rng))
    expect(run).toContain('allowed')
    expect(run).toContain('none')
  })
})

describe('emoji detection (TAC-362)', () => {
  it('detects a plain emoji', () => {
    expect(containsEmoji('We close at 3 😊')).toBe(true)
    expect(countEmoji('We close at 3 😊')).toBe(1)
  })

  it('detects the emoji from each live UAT message in the ticket', () => {
    expect(containsEmoji('Hey, welcome! 👋 glad you found this number')).toBe(true)
    expect(containsEmoji('or Muni if you can swing it 🚌')).toBe(true)
    expect(containsEmoji("it's the most work we put into any drink 🌸")).toBe(true)
  })

  it('returns false for a body with no emoji', () => {
    expect(containsEmoji('Blossom Tonic, honestly')).toBe(false)
    expect(countEmoji('Blossom Tonic, honestly')).toBe(0)
  })

  // Dashes are the adjacent deterministic check (THE-225) and sit in a
  // neighbouring Unicode range. A detector that caught them would make the
  // dash regen loop and the emoji observation fire on each other.
  it('does not treat an em dash or en dash as an emoji', () => {
    expect(containsEmoji('open until 3 — come by')).toBe(false)
    expect(containsEmoji('7–3 every day')).toBe(false)
  })

  // Arrows split across the Extended_Pictographic boundary, so "arrows don't
  // count" would be a false claim: U+2192 doesn't carry the property, but
  // U+2194 and U+21A9 DO. Both are asserted, because a test that only used
  // the first would pass under a detector that still counted the second.
  it('does not treat any arrow as an emoji, property-carrying or not', () => {
    expect(containsEmoji('Polk → Bush')).toBe(false)
    expect(containsEmoji('Polk ↔ Bush')).toBe(false)
    expect(containsEmoji('reply ↩ here')).toBe(false)
  })

  // The false-positive class the Emoji_Presentation base exists to exclude.
  // Every one of these carries Extended_Pictographic, so a detector built on
  // that property alone would grade "Analog®" as an emoji — and at a `never`
  // venue (grader limit 0) that is a finding on a clean reply.
  it('does not treat text-default pictographic symbols as emoji', () => {
    for (const body of ['Analog® coffee', 'Le Mil™', '© 2026 Le Mils', 'see ℹ for info', '▶ play', '‼ urgent']) {
      expect(containsEmoji(body)).toBe(false)
    }
  })

  // The other half of that rule: the SAME codepoints do count once the text
  // explicitly asks for emoji presentation with U+FE0F. Without this, the
  // exclusion above would be over-broad and would miss real emoji.
  it('counts a text-default symbol when U+FE0F requests emoji presentation', () => {
    expect(countEmoji('sunny ☀️ today')).toBe(1)
    expect(countEmoji('thanks ❤️')).toBe(1)
  })

  // Emoji-default symbols outside the big pictographic blocks still count —
  // ☕ is the one the live Le Mil's run actually produced most often.
  it('counts emoji-default symbols from the low blocks', () => {
    expect(countEmoji('back at 7 ☕')).toBe(1)
    expect(countEmoji('⌚ 3pm')).toBe(1)
  })

  it('counts a variation-selector emoji once, not as an orphaned selector', () => {
    expect(countEmoji('thanks ❤️')).toBe(1)
  })

  it('counts a skin-tone modified emoji once', () => {
    expect(countEmoji('see you 👋🏽')).toBe(1)
  })

  // The delta that matters most for the grader's `sparingly` limit of 1: a
  // joined family is ONE emoji. The old block-range regex counted its
  // component codepoints and would have reported 3.
  it('counts a ZWJ-joined sequence as one emoji', () => {
    expect(countEmoji('the whole family 👨‍👩‍👧')).toBe(1)
  })

  it('counts a flag as one emoji', () => {
    expect(countEmoji('roasted in 🇪🇹')).toBe(1)
  })

  it('counts multiple distinct emoji separately', () => {
    expect(countEmoji('🙌 ☕ 😄')).toBe(3)
  })

  // Guards the lastIndex hazard: a module-level /g regex driven by .test()
  // alternates true/false for the same input. The exported API is
  // count/contains precisely so no caller can trip this, and this test is
  // what would catch a refactor that exported the regex instead.
  it('is stable across repeated calls with the same input', () => {
    const body = 'We close at 3 😊'
    expect([containsEmoji(body), containsEmoji(body), containsEmoji(body)]).toEqual([
      true,
      true,
      true,
    ])
    expect([countEmoji(body), countEmoji(body)]).toEqual([1, 1])
  })
})
