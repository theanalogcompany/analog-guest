import { describe, expect, it } from 'vitest'
import { MAX_BUBBLES_PER_RESPONSE } from '@/lib/agent/split-message'
import {
  MAX_BUBBLES_CEILING,
  answerRepeatsQuestion,
  hasContent,
  normalizeForDuplicate,
  scoreUnit,
} from './intention-bubble-score'

const noKeys = { whole: [], last: [], earlier: [] }

describe('MAX_BUBBLES_CEILING', () => {
  // The scorer restates the constant rather than importing it, so that a
  // change raising the shipped cap cannot silently raise this ceiling too.
  // THIS is where the divergence must fail.
  it('matches the shipped MAX_BUBBLES_PER_RESPONSE', () => {
    expect(MAX_BUBBLES_CEILING).toBe(MAX_BUBBLES_PER_RESPONSE)
  })
})

describe('hasContent', () => {
  it('accepts a letter or a digit', () => {
    expect(hasContent('hi')).toBe(true)
    expect(hasContent('7')).toBe(true)
    expect(hasContent('¿cómo?')).toBe(true)
  })

  it('rejects punctuation or an emoji alone', () => {
    expect(hasContent('')).toBe(false)
    expect(hasContent('   ')).toBe(false)
    expect(hasContent('?!')).toBe(false)
    expect(hasContent('🙂')).toBe(false)
    expect(hasContent(' — ')).toBe(false)
  })
})

describe('scoreUnit — the ruling', () => {
  it('passes a raised intention that is its own last bubble', () => {
    const v = scoreUnit({
      bubbles: ['open till 3 on sundays', "by the way, what's your name?"],
      intentionQuestion: "by the way, what's your name?",
      judge: { whole: ['learn_name'], last: ['learn_name'], earlier: [] },
    })
    expect(v).toEqual({ raised: true, separateLastBubble: true, breaches: [], pass: true })
  })

  // THE CASE-2 FAILURE from the ticket: one bubble, because splitIntoSentences
  // finds no boundary before "do". It raises, and it is not separate.
  it('fails a one-bubble reply that carries the question inline', () => {
    const v = scoreUnit({
      bubbles: ['Foncii, nice to meet you 🙂 do you live or work around Polk Street?'],
      intentionQuestion: '',
      judge: { whole: ['are_they_local'], last: ['are_they_local'], earlier: [] },
    })
    expect(v.raised).toBe(true)
    expect(v.separateLastBubble).toBe(false)
    expect(v.pass).toBe(false)
  })

  // THE CASE-1 FAILURE: it split, but an earlier bubble carries the question
  // too, so the question was not alone.
  it('fails when an earlier bubble also raises the intention', () => {
    const v = scoreUnit({
      bubbles: ["nice! and by the way, what's your name?", 'anyway, open till 3'],
      intentionQuestion: '',
      judge: { whole: ['learn_name'], last: [], earlier: ['learn_name'] },
    })
    expect(v.separateLastBubble).toBe(false)
    expect(v.pass).toBe(false)
  })

  it('does not count a turn that raised nothing as either pass or failure', () => {
    const v = scoreUnit({
      bubbles: ['open till 3 on sundays'],
      intentionQuestion: '',
      judge: noKeys,
    })
    expect(v.raised).toBe(false)
    expect(v.pass).toBe(false)
  })

  // A separate bubble that the judge does not read as the question is NOT a
  // pass. Without this, anything with two bubbles would score clean.
  it('fails a two-bubble reply whose last bubble raises nothing', () => {
    const v = scoreUnit({
      bubbles: ['open till 3 on sundays', 'see you then'],
      intentionQuestion: 'see you then',
      judge: { whole: ['learn_name'], last: [], earlier: ['learn_name'] },
    })
    expect(v.pass).toBe(false)
  })
})

describe('scoreUnit — ceilings', () => {
  const raising = { whole: ['learn_name'], last: ['learn_name'], earlier: [] }

  it('breaches on more bubbles than the cap', () => {
    const v = scoreUnit({
      bubbles: ['a', 'b', 'c', "what's your name?"],
      intentionQuestion: "what's your name?",
      judge: raising,
    })
    expect(v.breaches).toContain('too_many_bubbles')
    expect(v.pass).toBe(false)
  })

  it('breaches on an empty bubble', () => {
    const v = scoreUnit({
      bubbles: ['open till 3', '   ', "what's your name?"],
      intentionQuestion: "what's your name?",
      judge: raising,
    })
    expect(v.breaches).toContain('empty_bubble')
    expect(v.breaches).toContain('contentless_bubble')
    expect(v.pass).toBe(false)
  })

  it('breaches on a bubble that is only an emoji', () => {
    const v = scoreUnit({
      bubbles: ['🙂', "what's your name?"],
      intentionQuestion: "what's your name?",
      judge: raising,
    })
    expect(v.breaches).toEqual(['contentless_bubble'])
    expect(v.pass).toBe(false)
  })

  // The mechanism check. If this fires the composition and the slice disagree,
  // which is a defect in the code rather than in the model's text.
  it('breaches when the question is not exactly the last bubble', () => {
    const v = scoreUnit({
      bubbles: ['open till 3', "what's your name"],
      intentionQuestion: "what's your name?",
      judge: raising,
    })
    expect(v.breaches).toEqual(['tail_not_last_bubble'])
    expect(v.pass).toBe(false)
  })

  it('does not apply the identity check on an arm with no field', () => {
    const v = scoreUnit({
      bubbles: ['open till 3', "what's your name?"],
      intentionQuestion: '',
      judge: raising,
    })
    expect(v.breaches).toEqual([])
    expect(v.pass).toBe(true)
  })
})

describe('answerRepeatsQuestion', () => {
  it('catches the question repeated at the end of the answer', () => {
    expect(
      answerRepeatsQuestion("nice one. by the way, what's your name?", "what's your name?"),
    ).toBe(true)
  })

  it('ignores punctuation and case differences', () => {
    expect(answerRepeatsQuestion('so, Whats your NAME', "what's your name?")).toBe(true)
  })

  it('does not fire when the answer merely mentions similar words earlier', () => {
    expect(
      answerRepeatsQuestion("what's your name is a thing we ask later. open till 3", "what's your name?"),
    ).toBe(false)
  })

  it('does not fire on an empty question', () => {
    expect(answerRepeatsQuestion('open till 3', '')).toBe(false)
    expect(answerRepeatsQuestion('open till 3', '   ')).toBe(false)
  })

  // A question of pure punctuation normalizes to '', and endsWith('') is true
  // for every string — which would report a duplicate on every unit.
  it('does not fire on a question with no letters or digits', () => {
    expect(answerRepeatsQuestion('open till 3', '?!')).toBe(false)
  })
})

describe('normalizeForDuplicate', () => {
  it('strips everything but letters and digits, case-folded', () => {
    expect(normalizeForDuplicate("What's your name? 🙂")).toBe('whatsyourname')
  })
})
