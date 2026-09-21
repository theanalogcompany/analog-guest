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
    // A mid-sentence question mark is caught by the literal "?" check even
    // with no recognized opener — confirms the two checks are OR'd.
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
