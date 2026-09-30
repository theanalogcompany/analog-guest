// TAC-386. The detectors behind arm B.
//
// These are not the bars. The bars are hand-read, and this file exists so the
// instrument narrowing that reading can itself fail: a detector that cannot
// return the wrong answer is not evidence, and its agreement with a hand-read
// would prove only that it ran.

import { describe, expect, it } from 'vitest'

import {
  contentWords,
  findsReference,
  findsRepetition,
  findsVisitClaim,
  findsVoiceProblems,
} from './inquiry-followup-language'

const QUESTION = 'where do I park around there'
const ANSWER =
  'Street parking on Polk is usually fine before 9. The lot behind the building is permit only.'

describe('contentWords', () => {
  it('drops stopwords and short words', () => {
    expect([...contentWords('where do I park around there')]).toEqual(['park'])
  })

  it('stems crudely so a paraphrase matches the question', () => {
    // "parking" in the follow-up has to match "park" in the question, which is
    // the whole reason the stem exists.
    expect(contentWords('parking')).toEqual(contentWords('park'))
    expect(contentWords('beans')).toEqual(contentWords('bean'))
  })

  it('folds case and curly apostrophes', () => {
    expect(contentWords('Polk’s')).toEqual(contentWords('polk'))
  })
})

describe('findsReference (bar 1)', () => {
  it('finds both halves in a message that names the thing and our advice', () => {
    const v = findsReference(
      'Hope the parking worked out. Polk is usually the easier bet.',
      QUESTION,
      ANSWER,
    )
    expect(v.sharedWithQuestion).toContain('park')
    expect(v.sharedWithAnswerOnly).toContain('polk')
    expect(v.referencesBoth).toBe(true)
  })

  it('does NOT pass a message that could have been sent to anyone', () => {
    // The failure bar 1 exists to catch.
    const v = findsReference(
      'Hope that all worked out for you!',
      QUESTION,
      ANSWER,
    )
    expect(v.referencesBoth).toBe(false)
  })

  it('does not pass a message echoing only the question', () => {
    // THE case the answer-only exclusion exists for. Our answer restates the
    // topic, so a plain overlap would have counted `park` twice and called this
    // a reference to our advice. It references the subject and nothing we said.
    const v = findsReference('Did the parking work out?', QUESTION, ANSWER)
    expect(v.sharedWithQuestion).toContain('park')
    expect(v.sharedWithAnswerOnly).toEqual([])
    expect(v.referencesBoth).toBe(false)
  })

  it('does not pass a message echoing only our answer', () => {
    const v = findsReference(
      'Was the lot behind the building alright in the end?',
      'which beans should I buy',
      ANSWER,
    )
    expect(v.sharedWithQuestion).toEqual([])
    expect(v.sharedWithAnswerOnly.length).toBeGreaterThan(0)
    expect(v.referencesBoth).toBe(false)
  })
})

describe('findsVisitClaim (bar 2)', () => {
  it.each([
    'Did you come in yesterday?',
    'Did you end up making it over?',
    'How was your visit?',
    'Thanks for stopping by!',
    'Good to see you earlier.',
    'Hope you enjoyed it.',
    'Saw you at the counter.',
  ])('flags %s as asserting or asking about a visit', (body) => {
    expect(findsVisitClaim(body).clean).toBe(false)
  })

  it.each([
    'Come by any time.',
    'Hope to see you soon.',
    'Swing by this week and we will sort you out.',
  ])('flags %s as pushing them to come in', (body) => {
    const v = findsVisitClaim(body)
    expect(v.pushes.length).toBeGreaterThan(0)
    expect(v.clean).toBe(false)
  })

  it('passes a message that checks the help without touching the visit', () => {
    const v = findsVisitClaim(
      'Hope the parking worked out. Polk is usually the easier bet that early.',
    )
    expect(v).toMatchObject({ claims: [], pushes: [], clean: true })
  })

  it('separates the two kinds so a report says which rule was broken', () => {
    const v = findsVisitClaim('Did you come in? Come by again soon.')
    expect(v.claims.length).toBeGreaterThan(0)
    expect(v.pushes.length).toBeGreaterThan(0)
  })
})

describe('findsRepetition (bar 3)', () => {
  // Each unique body has to share NO 4-gram with the others. The first version
  // of this fixture used "a completely different sentence number N about coffee
  // here", which shares "a completely different sentence" across all of them, so
  // the worst count was the number of unique bodies rather than of repeated
  // ones. A fixture that cannot express "no repetition" cannot test a
  // repetition bar.
  const WORDS =
    'alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima mike november oscar'.split(
      ' ',
    )
  const fifteen = (unique: number, repeated: number) => [
    ...Array.from({ length: unique }, (_, i) =>
      [WORDS[i % WORDS.length], i, 'zulu', i * 7, 'quebec', i * 13].join(' '),
    ),
    ...Array.from(
      { length: repeated },
      () => 'hope the parking worked out for you',
    ),
  ]

  it('is within the bar at exactly a quarter of the set', () => {
    // 3 of 15. Math.floor(15 / 4) is 3, so three is allowed.
    const v = findsRepetition(fifteen(12, 3))
    expect(v.limit).toBe(3)
    expect(v.worst).toBe(3)
    expect(v.withinBar).toBe(true)
  })

  it('breaches at one more than a quarter', () => {
    const v = findsRepetition(fifteen(11, 4))
    expect(v.worst).toBe(4)
    expect(v.withinBar).toBe(false)
  })

  it('catches fifteen messages that are all the same sentence', () => {
    // THE failure this bar exists for: every message can pass bars 1 and 2 and
    // still be one template.
    const v = findsRepetition(fifteen(0, 15))
    expect(v.worst).toBe(15)
    expect(v.withinBar).toBe(false)
  })

  it('reports the offending phrase, worst first, for the hand-read', () => {
    const v = findsRepetition(fifteen(11, 4))
    // A 4-gram, so the reported phrase is a window on the template rather than
    // the whole sentence.
    expect(v.phrases[0]?.phrase).toContain('parking worked')
    expect(v.phrases[0]?.count).toBe(4)
  })

  it('counts a message once however many times it repeats itself internally', () => {
    // A single rambling message must not look like a set-wide template. `worst`
    // is the worst count among SHARED phrases, so a set with no sharing scores
    // 0 rather than 1.
    const v = findsRepetition([
      'hope the parking worked out hope the parking worked out',
      'something else entirely about the beans we roast',
    ])
    expect(v.worst).toBeLessThan(2)
    expect(v.withinBar).toBe(true)
  })

  it('finds no repetition in a set with none', () => {
    const v = findsRepetition([
      'glad the lot worked for you in the end',
      'that bag should hold up for a fortnight or so',
      'the pour over ratio is worth a second try',
    ])
    expect(v.worst).toBeLessThan(2)
    expect(v.withinBar).toBe(true)
  })
})

describe('findsVoiceProblems', () => {
  it('flags an em dash and an en dash', () => {
    expect(findsVoiceProblems('one — two').emDash).toBe(true)
    expect(findsVoiceProblems('one – two').emDash).toBe(true)
    expect(findsVoiceProblems('one, two').emDash).toBe(false)
  })

  it('flags a named speaker, because outreach comes from the shop', () => {
    expect(
      findsVoiceProblems('Himanshu here, hope that worked').namedSpeaker,
    ).toContain('himanshu')
    expect(findsVoiceProblems('hope that worked out').namedSpeaker).toEqual([])
  })

  it('flags loyalty-program language', () => {
    expect(findsVoiceProblems('you earned 5 points').loyalty).toEqual(
      expect.arrayContaining(['points', 'earn']),
    )
    expect(findsVoiceProblems('hope the parking worked out').loyalty).toEqual(
      [],
    )
  })
})
