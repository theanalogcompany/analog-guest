import { describe, expect, it } from 'vitest'
import { COMP_PATTERNS, matchComp } from './comp-backstop'

describe('matchComp — positive (should fire)', () => {
  // We assert matched=true only. Several bodies legitimately match more than
  // one pattern (e.g. "next one's on me" matches both `\bon (us|me|the house)\b`
  // and `\bnext one(?:'?s)? on (?:me|us|the house)\b` — enumeration order
  // returns the first hit, which is the broad one). Pinning to a specific
  // pattern fragment would be brittle; the contract this test guards is
  // "the regex fires," not "the regex fires on the most specific pattern."
  const POSITIVES: readonly string[] = [
    // High-precision solo phrases
    "that one's on us today",
    "the latte's on me",
    "coffee's on the house tonight",
    'my treat',
    'our treat. come by',
    "I'll comp the drink",
    'comped the pastry',
    'complimentary refill on espresso',
    "we'll refund the difference",
    'issued a refund this morning',
    'gratis on your next visit',
    // Operator-action with context
    "next one's on me",
    "first one's on us",
    "the next round's on the house",
    "won't charge you for the second",
    "won't bill for the espresso",
    "don't worry about the bill",
    'take care of this for you',
    "I'll cover this one",
    'let me get the bill',
    // Money-with-zero
    'that one comes to $0',
    'free of charge for you',
    'no cost to you on this round',
    'zero cost for the refill',
    // Contextual free X
    'free coffee with that',
    'have a free pastry',
    'grab a free refill',
    // Contextual discount
    'we can discount your order',
    'discount this one',
    '20% off the order',
    // Contextual no charge
    'no charge for this',
    'no charge for your refill',
  ]

  for (const body of POSITIVES) {
    it(`fires on: "${body}"`, () => {
      const r = matchComp(body)
      expect(r.matched).toBe(true)
    })
  }
})

describe('matchComp — negative (must NOT fire)', () => {
  // Benign café-speak that surface keywords like `free` / `discount` /
  // `no charge` show up in. The plan-review revision says: never fire on
  // bare keywords without the operator-action qualifier.
  const NEGATIVES: readonly string[] = [
    'we have free wifi here',
    'free parking out front',
    'free range eggs on the menu',
    'discount on Tuesdays',
    'student discount available',
    'happy hour discount',
    'no charge for the wifi password',
    'no charge for using the bathroom',
    "the wine list is free of pretension",
    'come in any time',
    "we close at 11. come by anytime.",
    'yeah, oat and almond.',
    'thanks for the heads up',
    "the espresso is house-made",
    'cappuccino is our most popular',
    'a treat for the senses',
    'we have plenty of espresso',
    'this is on schedule for opening',
    "I'll get you a menu",
  ]

  for (const body of NEGATIVES) {
    it(`does not fire on: "${body}"`, () => {
      const r = matchComp(body)
      expect(r.matched).toBe(false)
    })
  }
})

describe('matchComp — pattern surface', () => {
  it('exposes the matched pattern source on a positive match', () => {
    const r = matchComp("anyway, that one's on us")
    expect(r.matched).toBe(true)
    if (!r.matched) return
    expect(r.pattern).toBe('\\bon (us|me|the house)\\b')
  })

  it('COMP_PATTERNS length stays in sync with the tunable manifest entry', () => {
    // The manifest's comp_backstop_pattern_count entry imports COMP_PATTERNS.length
    // directly, so this assertion is mostly a guard against accidental deletion
    // of the entire array. If the count changes legitimately, update the manifest
    // entry's description and (if relevant) related tests; the value tracks
    // through the import.
    expect(COMP_PATTERNS.length).toBeGreaterThan(15)
  })
})
