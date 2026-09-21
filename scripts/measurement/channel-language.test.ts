import { describe, expect, it } from 'vitest'

import { claimsPhoneChannel, findChannelLanguage } from './channel-language'

const kinds = (body: string) => findChannelLanguage(body).map((m) => m.kind)
const phrases = (body: string) => findChannelLanguage(body).map((m) => m.phrase)

describe('phone claims, which are FALSE on Instagram', () => {
  it.each([
    ['just text us when you are close', 'text us'],
    ['text me a heads up', 'text me'],
    ['shoot us a text when you get here', 'shoot us a text'],
    ['save this number and message any time', 'this number'],
    ['our number is on the receipt', 'our number'],
    ['we will send you an SMS', 'sms'],
    ['reply to this text message', 'text message'],
    ['give us a call before 3', 'give us a call'],
    // Missed by the first real run: "first time texting in?" went unflagged
    // in the control arm, under-counting the number the control bar is read
    // against. There is no non-SMS reading of "texting".
    ['hey, welcome. first time texting in?', 'texting'],
    ['thanks for texting', 'texting'],
    ['you texted us last week', 'texted'],
  ])('catches %j', (body, expected) => {
    expect(claimsPhoneChannel(body)).toBe(true)
    expect(phrases(body)).toContain(expected)
  })
})

describe('ordinary words are not claims', () => {
  // The whole reason every pattern is word-bounded and most need an object.
  // A false positive costs a human reading one line, so these matter less than
  // the misses above — but a detector that fires on "context" is not read.
  it.each([
    'in the context of the new menu',
    'the texture is closer to a flat white',
    'we have a number of single origins on today',
    'numbers were down last week',
    'the text on the sign is hand painted',
    'that is a lot to unpack',
  ])('does not fire on %j', (body) => {
    expect(findChannelLanguage(body)).toEqual([])
  })
})

describe('a denied claim is not a claim', () => {
  // Both of these are REAL round-3 Instagram replies. The detector flagged
  // both as false claims when the model had answered correctly — the ideal
  // answer on a channel with no phone number is to say there is no phone
  // number, and a detector that fails the run for it is worse than useless.
  it.each([
    "we don't have a phone number, but you can reach us here or by email at shopper@lemils.com. what do you need?",
    "we don't have a public phone number. easiest way to reach us is right here, or by email at shopper@lemils.com.",
    'no phone number, sorry, but we are here all day',
    'there is no number to give out',
  ])('does not flag %j', (body) => {
    expect(claimsPhoneChannel(body)).toBe(false)
  })

  // The half that matters more: a negation about something ELSE must not
  // launder a real claim that follows it. A window wide enough to swallow
  // these is a window that hides the defect.
  it.each([
    ["we don't do holds, but text us when you're close", 'text us'],
    ['no reservations. give us a call before 3', 'give us a call'],
    ["we don't take orders ahead. this number works though", 'this number'],
  ])('still flags %j', (body, phrase) => {
    expect(claimsPhoneChannel(body)).toBe(true)
    expect(phrases(body)).toContain(phrase)
  })
})

describe('Instagram idioms, true but off-copy', () => {
  // TAC-495 deliberately says "message", never "DM". Naming the platform in
  // the opening line was the accepted cost; this is what it may invite.
  it.each([
    ['just DM us when you are on the way', 'dm'],
    ['we posted it on our story', 'our story'],
    ['send a direct message any time', 'direct message'],
  ])('flags %j as an idiom, not a false claim', (body, expected) => {
    expect(kinds(body)).toContain('instagram_idiom')
    expect(kinds(body)).not.toContain('phone_claim')
    expect(phrases(body)).toContain(expected)
    // Off-copy is not false, and a run must never report it as one.
    expect(claimsPhoneChannel(body)).toBe(false)
  })
})

describe('reporting', () => {
  it('carries enough surrounding text to judge the line by reading', () => {
    const body = 'Open until 3 today. Just text us when you are on your way and we will have it ready.'
    const [match] = findChannelLanguage(body)
    expect(match?.kind).toBe('phone_claim')
    expect(match?.context).toContain('on your way')
  })

  it('finds every claim in a body, not just the first', () => {
    const body = 'Text us at this number, or call us.'
    expect(findChannelLanguage(body).length).toBeGreaterThanOrEqual(3)
  })

  // The regexes are module-level and global, so a leaked lastIndex would make
  // the SECOND body scanned silently miss its first match. That would read as
  // the Instagram arm improving, which is the direction that gets believed.
  it('does not leak regex state between bodies', () => {
    const body = 'text us when you are close'
    const first = findChannelLanguage(body)
    const second = findChannelLanguage(body)
    expect(second).toEqual(first)
    expect(second.length).toBeGreaterThan(0)
  })
})
