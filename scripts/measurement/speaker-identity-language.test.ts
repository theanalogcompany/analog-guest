import { describe, expect, it } from 'vitest'

import { classifySpeakerIdentity, sentencesOf } from './speaker-identity-language'

// Le Mil's real roster, which is what the harness passes.
const OPTS = {
  personNames: ['Himanshu', 'Milana', 'Asia', 'Christopher', 'Spade', 'Alisha', 'Morgan', 'Parker', 'Trinity'],
  venueNames: ["Le Mil's", 'Le Mils'],
} as const

const verdict = (body: string) => classifySpeakerIdentity(body, OPTS)

describe('namedSelfIntro — the ticket', () => {
  // THE DEFECT, verbatim from the 2026-09-26 device test.
  it('catches the live defect body', () => {
    const v = verdict("I'm Himanshu 👋 what did you end up getting?")
    expect(v.namedSelfIntro).toBe(true)
    expect(v.namedSelfIntroMatch).toContain('himanshu')
  })

  it.each([
    "I'm Himanshu, what did you get?",
    'I am Milana, glad you came by.',
    'this is Himanshu, what did you grab?',
    "you've reached Himanshu.",
    'Himanshu here. what did you get?',
  ])('catches the self-introduction frame in %j', (body) => {
    expect(verdict(body).namedSelfIntro).toBe(true)
  })

  it('catches a sign-off', () => {
    expect(verdict('hope that helps.\n- Himanshu').namedSelfIntro).toBe(true)
    expect(verdict('see you soon\nMilana').namedSelfIntro).toBe(true)
  })

  // RULING 1 KEEPS THESE. A detector that flagged them would report the fix as
  // broken on exactly the behaviour the ruling preserves, so these negatives
  // carry as much weight as the positives above.
  it.each([
    'Himanshu roasts these himself.',
    'that one was developed by Himanshu at the farmers market.',
    'Milana handles the sourcing, she picked that lot.',
    'Himanshu arranges catering directly, not through here.',
    "we'll pass that on to Himanshu.",
    'Alisha teaches the latte art class.',
  ])('leaves a mention of a person as a person alone: %j', (body) => {
    expect(verdict(body).namedSelfIntro).toBe(false)
  })

  it('leaves the venue speaking as itself alone', () => {
    const v = verdict("hey! you've reached Le Mil's. what did you get?")
    expect(v.namedSelfIntro).toBe(false)
    expect(v.namesVenue).toBe(true)
  })

  // The roster-free fallback, which is what catches a name nobody listed.
  it('catches an unrostered name introduced with a frame', () => {
    const v = verdict("I'm Priya, what did you get?")
    expect(v.namedSelfIntro).toBe(true)
  })

  // ...and its known false-positive direction, pinned so it is a decision
  // rather than a surprise. Recall is the safe direction here: a body I read
  // and discard costs nothing, a missed defect reports the fix as landed.
  it('KNOWN over-match: a capitalised non-name after a frame', () => {
    expect(verdict("I'm Indian coffee's biggest fan").namedSelfIntro).toBe(true)
  })
})

describe('bareNameAsk — defect 2', () => {
  // THE DEFECT, verbatim from the same thread.
  it('catches the live defect body', () => {
    const v = verdict('ha, yeah that foam is basically a topping. what\'s your name?')
    expect(v.asksName).toBe(true)
    expect(v.bareNameAsk).toBe(true)
  })

  it.each([
    "by the way, what's your name?",
    "nice. what's your name, by the way?",
    "oh and what should we call you?",
    "so we know it's you next time, what's your name?",
    "while you're here, what should we call you?",
  ])('does not call a softened ask bare: %j', (body) => {
    const v = verdict(body)
    expect(v.asksName).toBe(true)
    expect(v.bareNameAsk).toBe(false)
  })

  // The softener routinely lands in the sentence BEFORE the question, which is
  // why bareness is judged on the whole reply rather than the question alone.
  it('sees a softener in an earlier sentence', () => {
    const v = verdict("that foam is basically a topping. oh and, what's your name?")
    expect(v.bareNameAsk).toBe(false)
  })

  it.each([
    'what should we call you?',
    'who am i talking to?',
    'can we get your name?',
    'what do you go by?',
  ])('catches other bare shapes: %j', (body) => {
    expect(verdict(body).bareNameAsk).toBe(true)
  })

  it('does not see a name ask where there is none', () => {
    const v = verdict("good pick. what did you think of the foam?")
    expect(v.asksName).toBe(false)
    expect(v.bareNameAsk).toBe(false)
  })

  it('reports the approved wording separately from bareness', () => {
    expect(verdict("by the way, what's your name?").usesByTheWay).toBe(true)
    expect(verdict("oh and, what's your name?").usesByTheWay).toBe(false)
  })
})

describe('whatToCallYouReason — R37, as corrected 2026-09-26', () => {
  // R37's reason after the correction. The earlier draft promised recognition
  // and was cut: nobody at the counter can actually recognise a guest.
  it.each([
    'just so we know what to call you',
    'so we know what to call you 😊',
    "nothing formal, we just like to know what to call you",
    'so we have something to call you',
    'just so we know what you go by',
  ])('catches %j', (body) => {
    expect(verdict(body).whatToCallYouReason).toBe(true)
  })

  // THE CUT REASON IS A MISS, NOT A HIT, and this is the load-bearing pair.
  // The old wording is fluent and plausible, so a detector that accepted it
  // would report the correction as landed while the model kept over-promising.
  it.each([
    'so we remember you next time you come in',
    'so we can recognise you next time',
    "so we know it's you next time",
  ])('does NOT count the cut recognition reason as R37s reason: %j', (body) => {
    const v = verdict(body)
    expect(v.whatToCallYouReason).toBe(false)
    expect(v.overPromisesRecognition).toBe(true)
  })

  it('counts the two independently when a reply gives both', () => {
    const v = verdict('so we know what to call you, and so we remember you next time')
    expect(v.whatToCallYouReason).toBe(true)
    expect(v.overPromisesRecognition).toBe(true)
  })

  // The failure R37 was written against: deflecting, or the `unknown`
  // category's holding response winning.
  it.each([
    'no reason, ignore me.',
    'let me check on that and get back to you.',
    'sorry, forget i asked.',
    'no worries either way!',
  ])('does not see a reason in a deflection: %j', (body) => {
    const v = verdict(body)
    expect(v.whatToCallYouReason).toBe(false)
    expect(v.overPromisesRecognition).toBe(false)
  })

  // "next time" on its own is ordinary venue talk and must not count as
  // either thing.
  it('does not match a bare next-time invitation', () => {
    const v = verdict('try the SoFi next time you come in.')
    expect(v.whatToCallYouReason).toBe(false)
    expect(v.overPromisesRecognition).toBe(false)
  })
})

describe('questionCount — the ceiling input', () => {
  it('counts one', () => {
    expect(verdict("hey! what did you get?").questionCount).toBe(1)
  })

  // TAC-519's own interrogation ceiling, verbatim from its run log.
  it('counts two in the interrogation shape', () => {
    expect(verdict('Did you just come by today? What did you grab?').questionCount).toBe(2)
  })

  it('counts none in a statement', () => {
    expect(verdict('good pick, that one sells out.').questionCount).toBe(0)
  })
})

describe('sentencesOf', () => {
  it('splits on terminators and newlines', () => {
    expect(sentencesOf('hey there. what did you get?\nnice one')).toEqual([
      'hey there.',
      'what did you get?',
      'nice one',
    ])
  })
})
