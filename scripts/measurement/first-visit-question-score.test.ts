import { describe, expect, it } from 'vitest'
import {
  isSubjectOnlyPhrase,
  readOnTarget,
  scoreConversation,
  scoreVariety,
  SUBJECT_WORDS,
  type TurnRecord,
} from './first-visit-question-score'

const turn = (o: Partial<TurnRecord> = {}): TurnRecord => ({
  stage: 'reply',
  renderedKeys: [],
  raisedKeys: [],
  orderOnRecord: true,
  intentionQuestion: '',
  bubbles: [],
  storedHistory: undefined,
  attributedTo: [],
  failed: false,
  ...o,
})

describe('isSubjectOnlyPhrase', () => {
  it('accepts a phrase made only of the question topic', () => {
    expect(isSubjectOnlyPhrase('first time')).toBe(true)
    expect(isSubjectOnlyPhrase('been coming')).toBe(true)
  })

  // THE BOUNDARY, and the reason the list is short. Scaffolding the model chose
  // is a template finding even when most of the phrase is topic words.
  it('rejects a phrase carrying any word outside the topic', () => {
    expect(isSubjectOnlyPhrase('is this your first')).toBe(false)
    expect(isSubjectOnlyPhrase('first time here or')).toBe(false)
  })

  it('rejects an empty phrase rather than vacuously accepting it', () => {
    expect(isSubjectOnlyPhrase('')).toBe(false)
    expect(isSubjectOnlyPhrase('   ')).toBe(false)
  })

  // The list excuses a repeat, so it stays the topic plus the interrogative
  // scaffolding approved 2026-09-30 and nothing else. `you` LEFT this forbidden
  // list in that decision, which is recorded on SUBJECT_WORDS rather than left
  // for a reader to infer from its absence here.
  //
  // What stays forbidden is the rest of sentence construction: admitting `or`,
  // `a` or `this` would excuse `or have you` and `a while`, which are the
  // phrases the shipped wording still breaches on. Those breaches are reported,
  // not scored away.
  it('keeps the subject list to the topic and the approved scaffolding', () => {
    for (const forbidden of ['is', 'this', 'your', 'or', 'a', 'the', 'while']) {
      expect(SUBJECT_WORDS, forbidden).not.toContain(forbidden)
    }
  })

  // The three phrases the widening was approved for, each now subject-only.
  it.each(['have you', 'you been', 'have you been'])(
    'reads the approved scaffolding phrase %j as subject-only',
    (phrase) => {
      expect(isSubjectOnlyPhrase(phrase)).toBe(true)
    },
  )

  // AND THE WIDENING STOPS THERE. These are the phrases the shipped wording
  // actually breaches on, and they must still score - otherwise the widening
  // silently became "make it pass".
  it.each(['or have', 'a while', 'in or', 'or have you', 'in or have'])(
    'still scores %j, so the widening did not lift the bar',
    (phrase) => {
      expect(isSubjectOnlyPhrase(phrase)).toBe(false)
    },
  )
})

describe('scoreVariety', () => {
  // Twelve genuinely different wordings. Nothing should score.
  it('passes a varied set', () => {
    const qs = [
      'whats bringing you in today',
      'have we met before',
      'are you local to the neighbourhood',
      'do you know the place already',
      'new to us or an old hand',
      'had you found us before now',
      'is this somewhere you drop by often',
      'were you here last season at all',
      'do you know our cortado yet',
      'anyone send you our way',
      'discovered us recently',
      'has it been a while since you stopped by',
    ]
    const v = scoreVariety(qs)
    expect(v.pass).toBe(true)
    expect(v.scored).toEqual([])
  })

  // THE INFORMATIONAL CASE. Every question shares the topic and nothing else,
  // so n=2 fires and the verdict still passes - which is the pre-registered
  // reading rule doing its job rather than being applied by hand afterwards.
  it('reports a subject-only n=2 repeat without failing the arm', () => {
    const qs = [
      'first time with us',
      'first time around these parts',
      'first time meeting you',
      'first time dropping by',
    ]
    const v = scoreVariety(qs)
    expect(v.findings.some((f) => f.n === 2 && f.subjectOnly)).toBe(true)
    expect(v.pass).toBe(true)
  })

  // A REAL TEMPLATE. The same four-word scaffold in every reply, which is what
  // the criterion is about. It must fail, and it must fail on a SCORED finding
  // rather than only appearing in the informational list.
  it('fails a genuine template', () => {
    const qs = [
      'is this your first time in',
      'is this your first time in',
      'is this your first time in',
      'something else entirely',
    ]
    const v = scoreVariety(qs)
    expect(v.pass).toBe(false)
    expect(v.scored.length).toBeGreaterThan(0)
    expect(v.scored.some((f) => !f.subjectOnly)).toBe(true)
  })

  // The small-N floor, inherited from repeatedPhrases. One question cannot be a
  // repeated phrasing however the share arithmetic reads.
  it('never reports a template from a single question', () => {
    expect(scoreVariety(['is this your first time in']).pass).toBe(true)
  })
})

describe('scoreConversation', () => {
  it('reports a clean raise on the reply turn', () => {
    const v = scoreConversation([
      turn({ stage: 'scan', orderOnRecord: false }),
      turn({ stage: 'order', orderOnRecord: false }),
      turn({
        stage: 'reply',
        raisedKeys: ['are_they_new_here'],
        intentionQuestion: 'have we met before?',
        bubbles: ['open till 3 today', 'have we met before?'],
      }),
      turn({ stage: 'answer', storedHistory: 'been coming a few months' }),
    ])
    expect(v).toMatchObject({
      raised: true,
      raisedBeforeOrder: false,
      ownLastBubble: true,
      answerStored: true,
      invalid: false,
      question: 'have we met before?',
    })
  })

  // AC 1's hard zero, read off the turn's OWN order state rather than its stage
  // label. A harness bug that mislabels a stage must not be able to hide this.
  it('flags a raise on a turn with no order on record', () => {
    const v = scoreConversation([
      turn({
        stage: 'order',
        orderOnRecord: false,
        raisedKeys: ['are_they_new_here'],
        intentionQuestion: 'first time in?',
        bubbles: ['nice', 'first time in?'],
      }),
    ])
    expect(v.raisedBeforeOrder).toBe(true)
  })

  // Convention 5. A failed call produces no verdict, so it must not read as a
  // clean "did not raise" - a wholly broken run would otherwise report a zero
  // before-order count and look like a passing control arm.
  it('invalidates a conversation with a failed turn rather than scoring it', () => {
    const v = scoreConversation([
      turn({ failed: true }),
      turn({ raisedKeys: ['are_they_new_here'], intentionQuestion: 'hi?' }),
    ])
    expect(v.invalid).toBe(true)
    expect(v.raised).toBe(false)
    expect(v.raisedBeforeOrder).toBe(false)
  })

  it('does not credit an own-bubble when the question is not the last bubble', () => {
    const v = scoreConversation([
      turn({
        raisedKeys: ['are_they_new_here'],
        intentionQuestion: 'have we met?',
        bubbles: ['have we met?', 'open till 3'],
      }),
    ])
    expect(v.raised).toBe(true)
    expect(v.ownLastBubble).toBe(false)
  })

  // Another intention raising on the same turn is not this one raising.
  it('ignores a turn that raised a different intention', () => {
    const v = scoreConversation([
      turn({
        raisedKeys: ['learn_name'],
        intentionQuestion: 'whats your name?',
      }),
    ])
    expect(v.raised).toBe(false)
    expect(v.question).toBe('')
  })

  it('does not count a blank stored history as stored', () => {
    const v = scoreConversation([turn({ storedHistory: '   ' })])
    expect(v.answerStored).toBe(false)
  })
})

// The on-target read, added after the first run reported 12/20 raised where six
// of the twelve questions were about somewhere the guest lives or their name.
describe('readOnTarget / verdict.onTarget', () => {
  it('reads a question the full ballot attributes to the target as on target', () => {
    const r = readOnTarget(['are_they_new_here'])
    expect(r.onTarget).toBe(true)
    expect(r.offTarget).toEqual([])
  })

  // THE CASE IT EXISTS FOR. Production's gate offers only the OPEN keys, so a
  // one-intention turn is a forced choice and an are_they_local question lands in
  // the one available bucket. The full ballot names where it really belongs.
  it('names the intention a question really belongs to', () => {
    const r = readOnTarget(['are_they_local'])
    expect(r.onTarget).toBe(false)
    expect(r.offTarget).toEqual(['are_they_local'])
  })

  it('reads an empty attribution as off target, not on', () => {
    const r = readOnTarget([])
    expect(r.onTarget).toBe(false)
    expect(r.offTarget).toEqual([])
  })

  // A question can genuinely do two things; the target being among them counts.
  it('counts the target as on target even alongside another', () => {
    const r = readOnTarget(['are_they_new_here', 'are_they_local'])
    expect(r.onTarget).toBe(true)
    expect(r.offTarget).toEqual(['are_they_local'])
  })

  it('carries the read through the conversation verdict', () => {
    const v = scoreConversation([
      turn({
        raisedKeys: ['are_they_new_here'],
        intentionQuestion: 'do you live close by?',
        bubbles: ['open till 3', 'do you live close by?'],
        attributedTo: ['are_they_local'],
      }),
    ])
    // The gate raised it; the fair ballot says it asked something else. Both are
    // reported, and onTarget is the one to read.
    expect(v.raised).toBe(true)
    expect(v.onTarget).toBe(false)
    expect(v.offTarget).toEqual(['are_they_local'])
  })

  it('does not call an unraised conversation on target', () => {
    const v = scoreConversation([turn({ attributedTo: ['are_they_new_here'] })])
    expect(v.raised).toBe(false)
    expect(v.onTarget).toBe(false)
  })
})
