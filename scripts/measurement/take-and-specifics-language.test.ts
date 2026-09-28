import { describe, expect, it } from 'vitest'

import {
  countSpecificHits,
  findPersonalTake,
  repeatedPhrases,
  type Specific,
} from './take-and-specifics-language'

const BHADRA: Specific[] = [
  { label: 'dark chocolate', variants: ['dark chocolate', 'chocolate'] },
  { label: 'tobacco', variants: ['tobacco'] },
  { label: 'black tea', variants: ['black tea'] },
]

describe('countSpecificHits', () => {
  it('counts each distinct specific once, however many variants match', () => {
    const v = countSpecificHits('dark chocolate, chocolate, tobacco', BHADRA)
    expect(v.hits).toBe(2)
    expect(v.hitLabels).toEqual(['dark chocolate', 'tobacco'])
    expect(v.available).toBe(3)
  })

  it('reports zero without inventing a hit', () => {
    expect(countSpecificHits("it's strong, you'll like it", BHADRA).hits).toBe(0)
  })

  // TAC-326: unanchored containment matched "san" inside "Hi Sana!" and "ice"
  // inside "nice". Both ends must be a boundary.
  it('does not match a variant glued inside a longer word', () => {
    const specs: Specific[] = [{ label: 'tea', variants: ['tea'] }]
    expect(countSpecificHits('the steam wand', specs).hits).toBe(0)
    expect(countSpecificHits('a steak', specs).hits).toBe(0)
    expect(countSpecificHits('black tea, actually', specs).hits).toBe(1)
  })

  it('matches a multi-word variant across a line break', () => {
    expect(countSpecificHits('notes of dark\nchocolate', BHADRA).hits).toBe(1)
  })

  it('folds case and curly apostrophes so phrasing cannot hide a hit', () => {
    const specs: Specific[] = [{ label: 'himanshus pick', variants: ["himanshu's pick"] }]
    expect(countSpecificHits('Himanshu’s Pick, honestly', specs).hits).toBe(1)
  })

  it('folds diacritics', () => {
    const specs: Specific[] = [{ label: 'cafe', variants: ['cafe'] }]
    expect(countSpecificHits('at the café', specs).hits).toBe(1)
  })

  // The stated limit, pinned so nobody reads the rate as a ceiling: an
  // unanticipated paraphrase scores as a miss. This test documents that the
  // number is a FLOOR.
  it('misses a paraphrase that is not a listed variant (the stated floor)', () => {
    expect(countSpecificHits('tastes chocolatey and smoky', BHADRA).hits).toBe(0)
  })
})

describe('findPersonalTake', () => {
  it('fires on the reply Jaipal named as the voice working', () => {
    const v = findPersonalTake("Bhadra is intense, honestly. 100% Robusta so it hits hard")
    expect(v.hasTake).toBe(true)
    expect(v.matches).toContain('honestly')
  })

  it('does not fire on a purely factual reply', () => {
    const v = findPersonalTake(
      'Bhadra is 100% Indian Robusta, roasted dark. Notes of dark chocolate, tobacco and black tea.',
    )
    expect(v.hasTake).toBe(false)
    expect(v.matches).toEqual([])
  })

  it('reports its matches so a verdict can be read rather than trusted', () => {
    const v = findPersonalTake("it's my favourite, honestly")
    expect(v.matches.length).toBeGreaterThan(1)
  })

  it('catches a preference and a guest-taste address', () => {
    expect(findPersonalTake('I love it with milk').hasTake).toBe(true)
    expect(findPersonalTake('if you like it strong, this is the one').hasTake).toBe(true)
  })

  // The stated limit. A take carried entirely by phrasing no marker lists is
  // invisible here, which is why the judge is primary.
  it('misses a take carried by phrasing alone (the stated recall limit)', () => {
    expect(findPersonalTake('that one always surprises people.').hasTake).toBe(false)
  })
})

describe('repeatedPhrases', () => {
  const template = (tail: string) => `it has notes of dark chocolate and ${tail}`

  it('flags a phrase in more than a quarter of replies', () => {
    const replies = [
      template('tobacco'),
      template('malt'),
      template('citrus'),
      'completely different sentence here',
      'another different one entirely',
      'a third different one entirely',
      'a fourth different one entirely',
      'a fifth different one entirely',
    ]
    const found = repeatedPhrases(replies, { n: 5, maxShare: 0.25 })
    expect(found.length).toBeGreaterThan(0)
    expect(found[0]?.replies).toBe(3)
    expect(found[0]?.phrase).toContain('notes of dark chocolate')
  })

  it('counts replies, not occurrences, so one self-repeating reply is not a template', () => {
    const replies = [
      'same phrase here and same phrase here and same phrase here again now',
      'nothing alike at all',
      'nor this one either',
      'nor this fourth one',
    ]
    expect(repeatedPhrases(replies, { n: 5, maxShare: 0.25 })).toEqual([])
  })

  it('is silent when every reply is phrased differently', () => {
    const replies = [
      'chocolate and tobacco, very strong',
      'toffee with a bit of orange',
      'caramel, grapefruit, star jasmine',
      'malty and heavy, made for espresso',
    ]
    expect(repeatedPhrases(replies, { n: 5, maxShare: 0.25 })).toEqual([])
  })

  it('reports one template once rather than every window inside it', () => {
    const replies = [
      'the exact same seven word template phrase appears',
      'the exact same seven word template phrase appears',
      'the exact same seven word template phrase appears',
      'unrelated',
    ]
    const found = repeatedPhrases(replies, { n: 5, maxShare: 0.25 })
    expect(found).toHaveLength(1)
  })

  it('ignores punctuation and case when spotting a repeat', () => {
    const replies = [
      "It's made for espresso, honestly.",
      "it's made for espresso -- honestly",
      "IT'S MADE FOR ESPRESSO, honestly!",
      'nothing like the others at all',
    ]
    expect(repeatedPhrases(replies, { n: 4, maxShare: 0.25 }).length).toBeGreaterThan(0)
  })
})

describe('repeatedPhrases — small-run floor', () => {
  // Found on a two-question smoke run: a quarter of 2 is 0.5, so a phrase in a
  // single reply cleared the threshold and the ceiling reported a template
  // that did not exist. A phrase in one reply is never a repeated phrasing.
  it('never flags a phrase that appears in only one reply', () => {
    expect(repeatedPhrases(['a totally unique sentence here', 'something else'], { n: 5 })).toEqual([])
    expect(repeatedPhrases(['a totally unique sentence here'], { n: 5 })).toEqual([])
  })

  it('still flags a genuine repeat at small N', () => {
    const found = repeatedPhrases(
      ['it is made for espresso honestly', 'it is made for espresso honestly', 'nothing alike'],
      { n: 5 },
    )
    expect(found.length).toBeGreaterThan(0)
  })
})
