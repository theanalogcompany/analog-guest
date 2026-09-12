import { describe, expect, it } from 'vitest'
import { matchSelfTalk, SELF_TALK_PATTERNS } from './self-talk-detector'

describe('matchSelfTalk — positive (should fire)', () => {
  const POSITIVES: readonly string[] = [
    // The literal TAC-355 failing reply (le-mils-coffee-010).
    "It's made with chicory, nutmeg, and dandelion root — actually wait, no dashes. Chicory, nutmeg, and dandelion root extract.",
    'actually, wait, let me rephrase that',
    'let me rewrite that for you',
    "let me rewrite this, I shouldn't have said it that way",
    'I should not have said that',
    "I shouldn't say that",
    'sorry, no dashes allowed',
    'writing this without a dash this time',
    "can't use a dash here",
    "can't use an em-dash here",
    'speaking as an AI, I can tell you',
    'as an assistant I have to say',
    'as a bot I should mention',
    'as a language model I cannot promise that',
    "I'm an AI so I can't guarantee that",
    'my instructions say not to mention that',
    'our rules say I have to check first',
    "I'm programming to always confirm this",
    'per my instructions I have to clarify',
    'per my guidelines this is not allowed',
  ]

  for (const body of POSITIVES) {
    it(`fires on: "${body}"`, () => {
      const r = matchSelfTalk(body)
      expect(r.matched).toBe(true)
    })
  }
})

describe('matchSelfTalk — negative (must NOT fire)', () => {
  const NEGATIVES: readonly string[] = [
    // Ordinary venue copy naming rules/instructions without self-reference.
    'no outside food per house rules',
    'kids under 12 must be accompanied per city rules',
    'here are instructions to redeem your card',
    'the rules for the dog park are posted out front',
    'follow the instructions on the machine',
    // A guest asking about "the rules" — this module only ever scans the
    // agent's own body, but confirm it's still inert against this phrasing.
    'what are the rules for the loyalty deck out front?',
    // Legitimate guest-facing correction unrelated to the model's own output —
    // no "wait"/dash/rules-as-subject language present.
    'the oat latte is great, actually the almond one too',
    // Ordinary replies with no self-talk at all.
    'the almost latte is caffeine-free, made with chicory and dandelion root',
    'we open at 7 and close at 3 on weekdays',
    'happy to hold one for you, just let us know when you arrive',
  ]

  for (const body of NEGATIVES) {
    it(`does not fire on: "${body}"`, () => {
      const r = matchSelfTalk(body)
      expect(r.matched).toBe(false)
    })
  }
})

describe('matchSelfTalk — accepted over-inclusion', () => {
  // "actually wait" is deliberately NOT scoped to require dash/rules context
  // (see the TAC-355 audit's false-positive analysis in the module header) —
  // a guest-facing correction that happens to start this way ("actually,
  // wait until after 3pm for the patio") also fires. Accepted: the cost is
  // one harmless regen attempt, never a queue or a block, while narrowing
  // the pattern risks missing the real failure case it exists to catch.
  it('fires on ordinary guest-facing "actually, wait" phrasing too', () => {
    const r = matchSelfTalk('actually, wait until after 3pm for the patio to open')
    expect(r.matched).toBe(true)
  })
})

describe('matchSelfTalk — pattern surface', () => {
  it('exposes the matched pattern source on a positive match', () => {
    const r = matchSelfTalk('actually wait, no dashes')
    expect(r.matched).toBe(true)
    if (!r.matched) return
    expect(typeof r.pattern).toBe('string')
    expect(r.pattern.length).toBeGreaterThan(0)
  })

  it('SELF_TALK_PATTERNS is non-empty', () => {
    expect(SELF_TALK_PATTERNS.length).toBeGreaterThan(5)
  })
})
