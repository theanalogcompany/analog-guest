import { describe, expect, it } from 'vitest'
import { looksLikeQuestion } from './looks-like-question'

describe('looksLikeQuestion — positive (reads as a question)', () => {
  const POSITIVES: readonly string[] = [
    'what grade is the matcha?',
    'are you open till 6?',
    'what are the four SoFi variations?',
    'what time do you open on sundaus',
    'Do you have oat milk',
    'Can I get a refill',
    'is the cortado good',
    'How much for a latte?',
    '  what time do you close  ',
    'any chance you have gluten free options',
    'Was that today or yesterday',
    'Were you open on Labor Day',
    // A genuinely MID-SENTENCE question mark, with no recognized opener.
    // Code review found the fixture that used to sit here ('not sure, does it
    // matter?') put the "?" at the END, so `includes` narrowed to `endsWith`
    // survived while the comment claimed this exact property. The repo's own
    // "test whose stated rationale was never true" pattern.
    'the matcha, is it ceremonial? i will be in at 3',
    'not sure, does it matter?',
  ]

  for (const body of POSITIVES) {
    it(`reads as a question: "${body}"`, () => {
      expect(looksLikeQuestion(body)).toBe(true)
    })
  }
})

describe('looksLikeQuestion — negative (does not read as a question)', () => {
  const NEGATIVES: readonly string[] = [
    // The literal TAC-484 incident body: a self-reported order, no "?", no
    // recognized opener.
    'oh and i got the pink panther yesterday',
    'thanks so much',
    'that was amazing',
    'see you tomorrow',
    'sounds good',
    // The apostrophe in the first-word regex is load-bearing. Drop it and the
    // first word here is "can", which IS in INTERROGATIVE_OPENERS, so a plain
    // statement reads as a question. Found by a surviving mutant in review.
    "can't wait to try it",
    "won't be in till late",
    '',
    '   ',
  ]

  for (const body of NEGATIVES) {
    it(`does not read as a question: "${body}"`, () => {
      expect(looksLikeQuestion(body)).toBe(false)
    })
  }
})

describe('looksLikeQuestion — accepted precision-over-recall tradeoff', () => {
  // A real question with no "?" and no recognized opener loses the nudge.
  // Documented and accepted (module header) rather than fixed by widening the
  // opener list indefinitely.
  it('misses a real question phrased without "?" or a recognized opener', () => {
    expect(looksLikeQuestion('tell me the wifi password')).toBe(false)
  })
})
