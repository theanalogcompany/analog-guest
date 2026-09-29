import { describe, expect, it } from 'vitest'
import {
  findCountClaim,
  findOtherHistoryItems,
  findVisitFrequencyClaim,
} from './usual-order-language'

describe('findCountClaim — the pre-registered R23 ceiling', () => {
  it.each([
    ['your fifth time', 'this is your fifth time in'],
    ['a digit beside times', "you've been in 5 times this month"],
    ['twice, beside had', "you've had it twice now"],
    ['ordinal beside visit', 'your fourth visit this week'],
    ['spelled number beside ordered', "you've ordered that three times"],
    ['number before been', "four times you've been in for that"],
    ['once beside had', "you've only had it once"],
  ])('finds a tally: %s', (_label, body) => {
    const v = findCountClaim(body)
    expect(v.found).toBe(true)
    expect(v.matches.length).toBeGreaterThan(0)
  })

  it.each([
    ['an order quantity the guest named', 'a cortado and two croissants, nice'],
    ['a clock time', 'we close at 3 today'],
    ['a price', "that's 5 dollars even"],
    ['an idiom with no tally word', 'twice as good as the other one'],
    ['a bare number with no tally context', 'two shots in that one'],
    ['recognition with no number at all', "that's the one you always go for"],
  ])('does NOT fire on: %s', (_label, body) => {
    expect(findCountClaim(body).found).toBe(false)
  })

  it('reports the matched span so a false positive can be read', () => {
    const v = findCountClaim("you've had it twice now")
    expect(v.matches[0]).toContain('twice')
  })

  it('is empty for an empty body', () => {
    expect(findCountClaim('')).toEqual({ found: false, matches: [] })
  })

  // NON-GOALS. These are false positives the recall bias accepts on purpose:
  // the detector over-matches and prints what it matched, because a false
  // positive costs reading one body and a false negative ships an R23
  // violation. Pinned so a later "fix" is a deliberate change rather than a
  // silent narrowing of the ceiling.
  it('KNOWN FALSE POSITIVE: echoing a quantity the guest themselves ordered', () => {
    expect(findCountClaim("two croissants, you had a good run there").found).toBe(true)
  })
})

describe('findVisitFrequencyClaim — advisory, not a bar', () => {
  it.each([
    ["R23's own example", 'you come in so often'],
    ['always + come', 'you always come in around now'],
    ['every time', 'every time you stop by'],
    ['regular', "you're a regular at this point"],
  ])('flags a frequency claim: %s', (_label, body) => {
    expect(findVisitFrequencyClaim(body).found).toBe(true)
  })

  it.each([
    ['recognising the ORDER, not the visits', "that's the one you order more than anything"],
    ['a plain prior-order reference', "you've had that before"],
    ['an ordinary reply', 'nice, enjoy it'],
    ['the item being named back', 'cortado, good one']
  ])('does NOT fire on: %s', (_label, body) => {
    expect(findVisitFrequencyClaim(body).found).toBe(false)
  })

  it('deduplicates repeated matches of the same phrase', () => {
    const v = findVisitFrequencyClaim('every time, and I mean every time')
    expect(v.matches).toEqual(['every time'])
  })
})

describe('findOtherHistoryItems — advisory R15 cross-check', () => {
  const history = ['Cortado', 'Blossom Tonic', 'Croissant']

  it('finds a past item that is not the one the guest just named', () => {
    const v = findOtherHistoryItems('cortado again, and that blossom tonic was good too', history, 'Cortado')
    expect(v.found).toBe(true)
    expect(v.matches).toEqual(['Blossom Tonic'])
  })

  it('does NOT count the named item itself', () => {
    expect(findOtherHistoryItems('cortado, the usual', history, 'Cortado').found).toBe(false)
  })

  it('is case and punctuation insensitive', () => {
    const v = findOtherHistoryItems('that CROISSANT!', history, 'Cortado')
    expect(v.matches).toEqual(['Croissant'])
  })

  // The whole-word guard: without it a short item name matches inside a
  // longer word, which is the TAC-326 "san" inside "Hi Sana!" trap.
  it('does not match an item name inside a longer word', () => {
    const v = findOtherHistoryItems('the tonics are all good', ['Tonic'], 'Cortado')
    expect(v.found).toBe(false)
  })

  it('ignores an empty item name', () => {
    expect(findOtherHistoryItems('anything', ['', 'Cortado'], 'Cortado').found).toBe(false)
  })
})
