// TAC-386. The arithmetic behind arm A.
//
// Scoring code is where a measurement quietly lies, and the specific lie this
// file is written against is the FLATTERING one: a classifier that fires on
// nothing scoring 100% precision, an empty arm passing its own bar. Each of
// those has a test here.

import { describe, expect, it } from 'vitest'

import {
  scoreArm,
  scoreFalsePositiveArm,
  scoreHeadroom,
  type ScoredCase,
} from './follow-up-worthy-score'

const c = (
  expected: boolean,
  actual: boolean,
  id = `${expected}-${actual}`,
): ScoredCase => ({ id, body: 'a message', expected, actual })

describe('scoreArm', () => {
  it('counts the four cells', () => {
    const s = scoreArm('arm', [
      c(true, true),
      c(true, true, 'tp2'),
      c(false, true),
      c(false, false),
      c(true, false),
    ])
    expect(s).toMatchObject({
      total: 5,
      truePositives: 2,
      falsePositives: 1,
      trueNegatives: 1,
      falseNegatives: 1,
    })
  })

  it('computes precision and recall', () => {
    const s = scoreArm('arm', [
      c(true, true),
      c(false, true),
      c(true, false),
      c(false, false),
    ])
    expect(s.precision).toBeCloseTo(0.5)
    expect(s.recall).toBeCloseTo(0.5)
  })

  // THE FLATTERING ERROR. A classifier that never fires has UNDEFINED precision,
  // and reporting 1.0 there would make a completely inert field look perfect,
  // which is exactly the shape of result this project has been misled by before.
  it('reports precision as null, not 1, when it called nothing positive', () => {
    const s = scoreArm('arm', [c(true, false), c(false, false)])
    expect(s.precision).toBeNull()
    expect(s.recall).toBe(0)
  })

  it('reports recall as null when there was nothing to find', () => {
    const s = scoreArm('arm', [c(false, false), c(false, true)])
    expect(s.recall).toBeNull()
    expect(s.precision).toBe(0)
  })

  it('collects every disagreement, in both directions', () => {
    const s = scoreArm('arm', [
      c(true, true),
      c(false, true, 'fp'),
      c(true, false, 'fn'),
    ])
    expect(s.disagreements.map((d) => d.id)).toEqual(['fp', 'fn'])
  })
})

describe('scoreFalsePositiveArm', () => {
  const body = (id: string, actual: boolean) => ({
    id,
    body: 'what time do you close',
    actual,
  })

  it('passes when nothing fired', () => {
    const arm = scoreFalsePositiveArm('hours', [
      body('a', false),
      body('b', false),
    ])
    expect(arm.passed).toBe(true)
    expect(arm.fired).toEqual([])
    expect(arm.score.falsePositives).toBe(0)
  })

  it('fails on a single positive, because the bar is zero', () => {
    const arm = scoreFalsePositiveArm('hours', [
      body('a', false),
      body('b', true),
      body('c', false),
    ])
    expect(arm.passed).toBe(false)
    expect(arm.score.falsePositives).toBe(1)
  })

  it('reports WHICH bodies fired, which is what a failure has to show', () => {
    const arm = scoreFalsePositiveArm('hours', [
      body('a', false),
      body('fired-one', true),
    ])
    expect(arm.fired.map((f) => f.id)).toEqual(['fired-one'])
  })

  it('OVERRIDES a caller-supplied expected label rather than trusting it', () => {
    // The labels are the arm's definition, not an input: these bodies are
    // hand-chosen as not-follow-up-worthy, and a case arriving with
    // `expected: true` would turn the bar off for that case.
    //
    // THE CAST IS THE POINT. The parameter type has no `expected` field, so a
    // well-typed caller cannot do this and a test without the cast cannot fail:
    // a mutation flipping the spread order left the whole file green. The cast
    // stands in for the type widening, or a JS caller, that would make the
    // runtime order matter.
    const smuggled = [
      { id: 'a', body: 'what time do you close', actual: true, expected: true },
    ] as unknown as Parameters<typeof scoreFalsePositiveArm>[1]
    const arm = scoreFalsePositiveArm('hours', smuggled)
    expect(arm.score.truePositives).toBe(0)
    expect(arm.score.falsePositives).toBe(1)
    expect(arm.passed).toBe(false)
  })

  // An empty arm must not read as a pass. It proves nothing and the run that
  // produced it is broken, which a green tick would hide.
  it('has no cases to pass when the arm is empty', () => {
    const arm = scoreFalsePositiveArm('hours', [])
    expect(arm.score.total).toBe(0)
    expect(arm.score.precision).toBeNull()
  })
})

describe('scoreHeadroom', () => {
  it('reports the worst call as a fraction of the cap', () => {
    const h = scoreHeadroom(200, [40, 90, 120])
    expect(h.max).toBe(120)
    expect(h.worstUtilisation).toBeCloseTo(0.6)
    expect(h.mean).toBeCloseTo(83.333, 2)
    expect(h.anyAtCap).toBe(false)
  })

  it('flags a call that hit the cap, which is the truncation signal', () => {
    expect(scoreHeadroom(200, [40, 200]).anyAtCap).toBe(true)
  })

  it('flags a call that somehow exceeded the cap', () => {
    expect(scoreHeadroom(200, [260]).anyAtCap).toBe(true)
  })

  it('does not divide by zero on an empty run', () => {
    expect(scoreHeadroom(200, [])).toMatchObject({
      max: 0,
      mean: 0,
      worstUtilisation: 0,
      anyAtCap: false,
    })
  })
})
