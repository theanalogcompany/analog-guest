import { describe, expect, it } from 'vitest'

import {
  classifyGuestName,
  consecutiveNamePairs,
  countNameUses,
  findThirdPersonVenue,
  looksLikeDodge,
} from './guest-name-language'

const VENUES = ["Le Mil's", 'Le Mils', 'LeMils'] as const

describe('countNameUses', () => {
  it('counts a plain address', () => {
    expect(countNameUses('hey Jaipal, what can I get you', 'Jaipal').count).toBe(1)
  })

  it('is case-insensitive, and reports the casing the model wrote', () => {
    const r = countNameUses('morning jaipal', 'Jaipal')
    expect(r.count).toBe(1)
    expect(r.matches).toEqual(['jaipal'])
  })

  it('counts two uses in one reply separately (the bar is per conversation)', () => {
    expect(countNameUses('Jaipal! good to hear from you Jaipal', 'Jaipal').count).toBe(2)
  })

  it('counts a possessive as a use', () => {
    expect(countNameUses("that's Jaipal's usual", 'Jaipal').count).toBe(1)
  })

  // THE TAC-326 TRAP, which this repo has already paid for once: an unanchored
  // substring match found "san" inside "Hi Sana!". A name inside a longer word
  // is not a name use, in either direction.
  it('does not match a name glued inside a longer word', () => {
    expect(countNameUses('the sanitizer is by the door', 'San').count).toBe(0)
    expect(countNameUses('we have Sanpellegrino', 'San').count).toBe(0)
    expect(countNameUses('pass me the pal', 'Pa').count).toBe(0)
  })

  it('matches across a line break, because a body can wrap', () => {
    expect(countNameUses('closed today,\nJaipal. back at 7', 'Jaipal').count).toBe(1)
  })

  it('refuses a name it was not designed for rather than matching loosely', () => {
    expect(countNameUses('anything at all', '').count).toBe(0)
    expect(countNameUses('a b c', 'a').count).toBe(0)
    expect(countNameUses('call 555', '555').count).toBe(0)
  })

  // The reverse of the primary metric, and the one that would flatter the
  // treatment arm: a reply that uses no name must never score one.
  it('scores a reply that never addresses the guest as zero', () => {
    expect(countNameUses('closed for today. back at 7 tomorrow though', 'Jaipal').count).toBe(0)
  })
})

describe('findThirdPersonVenue', () => {
  it('flags the venue name as a third-person subject', () => {
    expect(findThirdPersonVenue("Le Mil's closes at 3", VENUES)).toContain('closes')
  })

  it('flags a bare third-person pronoun about the business', () => {
    expect(findThirdPersonVenue('they close at 3 today', VENUES)).not.toBeNull()
    expect(findThirdPersonVenue('their hours are on the door', VENUES)).not.toBeNull()
  })

  // FIRST PERSON NAMING THE VENUE IS FINE, and this is the distinction the
  // detector exists for: it cannot be "does the reply contain the venue name".
  it('does not flag the venue named in a first-person sentence', () => {
    expect(findThirdPersonVenue("we roast the Budan here at Le Mil's", VENUES)).toBeNull()
    expect(findThirdPersonVenue('we close at 3 today', VENUES)).toBeNull()
  })

  // "they" about other people is ordinary and correct.
  it('does not flag they/them about people', () => {
    expect(findThirdPersonVenue('if they ask, just say I sent you', VENUES)).toBeNull()
    expect(findThirdPersonVenue('they said it was great', VENUES)).toBeNull()
  })
})

describe('consecutiveNamePairs', () => {
  // The ticket's headline bar. The incident: three of four replies carried the
  // name, which is two consecutive pairs.
  it('counts the incident shape', () => {
    const replies = [
      'Jaipal! what did you get?',
      'pretty good over here 😊 how about you, Jaipal?',
      'closed for today, Jaipal. back at 7 tomorrow though 🙏',
      'sounds good',
    ]
    expect(consecutiveNamePairs(replies, 'Jaipal')).toBe(2)
  })

  it('counts zero when the name is used once', () => {
    expect(consecutiveNamePairs(['hey Jaipal', 'we close at 3', 'oat and almond', 'see you then'], 'Jaipal')).toBe(0)
  })

  it('counts zero when the name is never used', () => {
    expect(consecutiveNamePairs(['a', 'b', 'c', 'd'], 'Jaipal')).toBe(0)
  })

  // Non-adjacent uses are within the letter of "never in two replies in a row"
  // and still breach the per-conversation cap. The two bars are separate on
  // purpose, and this pins that this function only answers the first.
  it('counts zero for two non-adjacent uses, which the per-conversation cap catches instead', () => {
    expect(consecutiveNamePairs(['hey Jaipal', 'we close at 3', 'oat and almond Jaipal', 'bye'], 'Jaipal')).toBe(0)
  })
})

describe('classifyGuestName', () => {
  it('reports both questions for one reply', () => {
    const v = classifyGuestName("Jaipal, Le Mil's closes at 3", {
      firstName: 'Jaipal',
      venueNames: VENUES,
    })
    expect(v.nameUses).toBe(1)
    expect(v.thirdPersonVenue).toBe(true)
    expect(v.thirdPersonVenueMatch).not.toBeNull()
  })

  it('reports a clean reply as clean on both', () => {
    const v = classifyGuestName('we close at 3 today', {
      firstName: 'Jaipal',
      venueNames: VENUES,
    })
    expect(v.nameUses).toBe(0)
    expect(v.thirdPersonVenue).toBe(false)
  })
})

// THE FIRST VERSION OF THIS FLAGGED 14 REPLIES AND ALL 14 WERE ITS OWN FAULT.
// It required a yes/no token for every menu turn, so an open question answered
// with a full description read as a dodge. These pin both halves of the split
// that fixed it, and the real bodies from that run are the fixtures.
describe('looksLikeDodge', () => {
  it('never flags small talk, which asks nothing', () => {
    expect(looksLikeDodge('small_talk', "how's it going over there", 'pretty good over here')).toBe(false)
  })

  it('accepts an open menu question answered by describing the item', () => {
    expect(
      looksLikeDodge(
        'menu',
        "what's the blossom tonic",
        'espresso over jasmine, rose, and chamomile syrup with tonic, topped with a thick whipped cream foam',
      ),
    ).toBe(false)
  })

  it('accepts an open menu question answered by naming items', () => {
    expect(looksLikeDodge('menu', 'any cold drinks?', 'Pink Panther and Blossom Tonic are the two to try.')).toBe(false)
  })

  it('flags an open menu question answered with a bare deflection', () => {
    expect(looksLikeDodge('menu', 'any cold drinks?', 'not sure')).toBe(true)
    expect(looksLikeDodge('menu', "what's good today", "no idea!")).toBe(true)
  })

  // The last false positive the TAC-544 run produced, verbatim: a no that
  // arrives as "don't", which \bnot\b does not match inside.
  it('accepts a closed menu question answered with a contracted no', () => {
    expect(
      looksLikeDodge(
        'menu',
        'do you do decaf',
        "we don't have decaf beans, but the Almost Latte is caffeine-free. chicory, dandelion root and masala jaggery syrup",
      ),
    ).toBe(false)
  })

  it('still requires a yes or no on a CLOSED menu question', () => {
    expect(looksLikeDodge('menu', 'do you have oat milk', 'yeah, oat and almond')).toBe(false)
    expect(looksLikeDodge('menu', 'do you do decaf', "we've got a decaf pourover")).toBe(false)
    expect(looksLikeDodge('menu', 'do you have oat milk', 'the espresso is great today')).toBe(true)
  })

  it('flags an hours question answered with no time and no day', () => {
    expect(looksLikeDodge('hours', 'what time do you close', '3pm today')).toBe(false)
    expect(looksLikeDodge('hours', 'you open tomorrow?', 'yeah, open 7 to 3 tomorrow')).toBe(false)
    expect(looksLikeDodge('hours', 'what time do you close', 'come see us!')).toBe(true)
  })

  it('accepts an arrival acknowledged', () => {
    expect(looksLikeDodge('heading_over', 'omw', 'see you soon')).toBe(false)
    expect(looksLikeDodge('heading_over', 'omw', 'the blossom tonic has jasmine in it')).toBe(true)
  })
})
