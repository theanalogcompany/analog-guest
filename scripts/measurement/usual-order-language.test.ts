import { describe, expect, it } from 'vitest'
import {
  countWords,
  findCountClaim,
  findOrderFrequencyPhrase,
  findOtherHistoryItems,
  findSellingLanguage,
  findVisitFrequencyClaim,
  isBareLabel,
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
    // THE LIVE MISS. A real treatment reply in the first full run read exactly
    // this, and the first version of TALLY_CONTEXT had no time-period words,
    // so the clearest R23 breach in the run went undetected by the very
    // ceiling written to catch it. A count over a period is the most natural
    // way to state a frequency.
    [
      'a count over a period',
      "that one's become your thing. third one in two weeks.",
    ],
    ['days beside a digit', '3 days in a row now'],
    ['months beside a spelled number', 'four months running'],
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

  // THE LIVE FALSE POSITIVE. Run 2 reported a count-ceiling breach on
  // freq-17, and there is no count in that reply at all: `one` after `the` is
  // a pronoun, and `come` landed inside the tally window. The arm was reported
  // as breaching a pre-registered ceiling on the strength of this bug, so
  // every one of these is pinned with the shape that produced it.
  it.each([
    ['the live body, verbatim', "that's the one you always come back to."],
    ['that one, beside a tally word', 'that one you order more than anything'],
    ['this one, beside had', "this one you've had before"],
    ['another one, beside come', 'another one when you come in'],
  ])('does NOT read a determiner `one` as a count: %s', (_label, body) => {
    expect(findCountClaim(body).found).toBe(false)
  })

  // The determiner fix must not cost the ordinal. Run 1's real breach is the
  // reason the ceiling exists, and `third` is what catches it, not `one`.
  it('still finds an ordinal introduced by a determiner', () => {
    const v = findCountClaim("that's the third one in two weeks")
    expect(v.found).toBe(true)
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
    expect(
      findCountClaim('two croissants, you had a good run there').found,
    ).toBe(true)
  })
})

describe('findVisitFrequencyClaim — advisory, not a bar', () => {
  it.each([
    ["R23's own example", 'you come in so often'],
    ['every visit', 'every visit you stop by'],
    ['regular', "you're a regular at this point"],
  ])('flags a VISIT frequency claim: %s', (_label, body) => {
    expect(findVisitFrequencyClaim(body).found).toBe(true)
  })

  // RULING 5 moved order frequency out of this detector. These are about what
  // the guest ORDERS, which is now the recognition the rule asks for, so
  // scoring them here would report the desired output as a breach.
  it.each([
    ['every time, about the item', "that one's yours every time"],
    ['always come back to', "that's the one you always come back to"],
    ['keeps coming back to', 'you keep coming back to that one'],
  ])('does NOT flag order frequency: %s', (_label, body) => {
    expect(findVisitFrequencyClaim(body).found).toBe(false)
  })

  it.each([
    [
      'recognising the ORDER, not the visits',
      "that's the one you order more than anything",
    ],
    ['a plain prior-order reference', "you've had that before"],
    ['an ordinary reply', 'nice, enjoy it'],
    ['the item being named back', 'cortado, good one'],
  ])('does NOT fire on: %s', (_label, body) => {
    expect(findVisitFrequencyClaim(body).found).toBe(false)
  })

  it('deduplicates repeated matches of the same phrase', () => {
    const v = findVisitFrequencyClaim('every visit, and I mean every visit')
    expect(v.matches).toEqual(['every visit'])
  })
})

// RULING 5 (2026-09-29): this is the shape the rule WANTS, so a high rate here
// is a good sign rather than a finding. It is reported so the permitted
// recognition is countable, and it is deliberately not a bar in either
// direction: nothing says every reply must phrase recognition this way.
describe('findOrderFrequencyPhrase — the permitted recognition', () => {
  it.each([
    ['every time, about the item', "that one's yours every time"],
    ['always come back to', "that's the one you always come back to"],
    ['go-to', "that cappuccino's been your go-to lately"],
    ['your move', "that's your move"],
    ['become your thing', "that one's become your thing"],
    ['keeps coming back', 'you keep coming back to it'],
  ])('finds it: %s', (_label, body) => {
    expect(findOrderFrequencyPhrase(body).found).toBe(true)
  })

  it.each([
    ['a plain receipt', 'nice, enjoy it'],
    ['a well-wish', 'hope it hit right'],
    [
      'a visit-frequency claim, which is the other detector',
      'you come in so often',
    ],
  ])('does NOT fire on: %s', (_label, body) => {
    expect(findOrderFrequencyPhrase(body).found).toBe(false)
  })

  it('deduplicates repeated matches of the same phrase', () => {
    const v = findOrderFrequencyPhrase('every time, and I mean every time')
    expect(v.matches).toEqual(['every time'])
  })

  // A count is banned however warmly it is phrased, so the two detectors are
  // independent rather than exclusive: this body is permitted recognition AND
  // a ceiling breach, and the run has to see both.
  it('is independent of the count ceiling', () => {
    const body = "that one's become your thing. third one in two weeks."
    expect(findOrderFrequencyPhrase(body).found).toBe(true)
    expect(findCountClaim(body).found).toBe(true)
  })
})

describe('isBareLabel — the pre-registered bare-label ceiling', () => {
  it.each([
    ['the measured template', 'your usual ☕'],
    ['three words plus an emoji', "that's your go-to ☕"],
    ['a label with no emoji', 'the usual'],
    ['four words exactly', 'that one you know'],
  ])('flags a label: %s', (_label, body) => {
    expect(isBareLabel(body)).toBe(true)
  })

  it.each([
    [
      'a real sentence with recognition and warmth',
      'your usual, and honestly a good one to keep coming back to',
    ],
    ['five words', 'good to see you back'],
  ])('does NOT flag: %s', (_label, body) => {
    expect(isBareLabel(body)).toBe(false)
  })

  // Emoji must not inflate the count, or a four-word label reads as five and
  // slips the ceiling. The measured template was two words plus an emoji.
  it('does not count an emoji as a word', () => {
    expect(countWords('your usual ☕')).toBe(2)
    expect(countWords('that one you know ☕ 😄')).toBe(4)
  })

  it('counts an empty body as zero words', () => {
    expect(countWords('')).toBe(0)
  })
})

describe('findSellingLanguage — the pitch cross-check', () => {
  it.each([
    ['a price', 'that bean is $17 for a 10 oz bag'],
    ['a bag size', 'we do 1 lb bags of it'],
    ['the shop URL', "it's on lemils.com if you want some"],
    ['a buy instruction', 'you can buy it whole bean'],
    ['whole bean phrasing', 'we have it as whole bean'],
    ['online', 'grab it online'],
  ])('flags selling language: %s', (_label, body) => {
    expect(findSellingLanguage(body).found).toBe(true)
  })

  it.each([
    [
      'a pure origin story',
      "that one's the Bhadra, 100% Indian robusta, which is why it hits so hard",
    ],
    [
      'a taking-home aside with no commerce',
      'people take that one home to brew, it holds up in a moka pot',
    ],
    ['plain recognition and warmth', 'your usual, good to have you back in'],
  ])('does NOT fire on: %s', (_label, body) => {
    expect(findSellingLanguage(body).found).toBe(false)
  })

  // NON-GOAL, recorded deliberately: a reply answering a guest who ASKED the
  // price matches here. That is correct to surface and wrong to call a
  // violation; the caller knows whether the guest asked.
  it('KNOWN FALSE POSITIVE: a price the guest asked for', () => {
    expect(findSellingLanguage("it's $17 for the 10 oz").found).toBe(true)
  })
})

describe('findOtherHistoryItems — advisory R15 cross-check', () => {
  const history = ['Cortado', 'Blossom Tonic', 'Croissant']

  it('finds a past item that is not the one the guest just named', () => {
    const v = findOtherHistoryItems(
      'cortado again, and that blossom tonic was good too',
      history,
      'Cortado',
    )
    expect(v.found).toBe(true)
    expect(v.matches).toEqual(['Blossom Tonic'])
  })

  it('does NOT count the named item itself', () => {
    expect(
      findOtherHistoryItems('cortado, the usual', history, 'Cortado').found,
    ).toBe(false)
  })

  it('is case and punctuation insensitive', () => {
    const v = findOtherHistoryItems('that CROISSANT!', history, 'Cortado')
    expect(v.matches).toEqual(['Croissant'])
  })

  // The whole-word guard: without it a short item name matches inside a
  // longer word, which is the TAC-326 "san" inside "Hi Sana!" trap.
  it('does not match an item name inside a longer word', () => {
    const v = findOtherHistoryItems(
      'the tonics are all good',
      ['Tonic'],
      'Cortado',
    )
    expect(v.found).toBe(false)
  })

  it('ignores an empty item name', () => {
    expect(
      findOtherHistoryItems('anything', ['', 'Cortado'], 'Cortado').found,
    ).toBe(false)
  })
})
