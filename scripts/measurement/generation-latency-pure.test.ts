import { describe, expect, it } from 'vitest'

import {
  evaluateCeilings,
  maxCountForRate,
  percentile,
  PRE_CHANGE_BASELINE,
  summarize,
  type HarnessUnit,
} from './generation-latency-pure'

function okUnit(overrides: Partial<HarnessUnit> = {}): HarnessUnit {
  return {
    outcome: 'ok',
    openState: 'open',
    contextBuildMs: 250,
    classifyMs: 300,
    retrieveVoiceMs: 40,
    retrieveKnowledgeMs: 200,
    generateMs: 5000,
    gateMs: 20,
    replyPathMs: 5810,
    attemptCount: 1,
    mechanicOffer: 'skipped',
    prosePromise: 'clean',
    cancellationClaim: 'clean',
    closedVenueArrival: 'skipped',
    ...overrides,
  }
}

describe('percentile', () => {
  it('returns null on an empty set — no data is not a number', () => {
    expect(percentile([], 50)).toBeNull()
  })

  it('interpolates linearly between ranks', () => {
    // rank for p50 over 4 values is 1.5 → midpoint of 20 and 30.
    expect(percentile([10, 20, 30, 40], 50)).toBe(25)
    expect(percentile([10, 20, 30, 40], 90)).toBeCloseTo(37, 5)
  })

  it('is order-independent and does not mutate its input', () => {
    const values = [30, 10, 20]
    expect(percentile(values, 50)).toBe(20)
    expect(values).toEqual([30, 10, 20])
  })
})

describe('maxCountForRate', () => {
  it('allows exactly one hit on a zero baseline', () => {
    expect(maxCountForRate(0, 30)).toBe(1)
  })

  it('is baseline expectation plus two binomial sigma, ceiled', () => {
    // the closed-venue baseline is the only non-zero rate left.
    const p = PRE_CHANGE_BASELINE.closedVenueFlaggedRate
    const expected = Math.ceil(30 * p + 2 * Math.sqrt(30 * p * (1 - p)))
    expect(maxCountForRate(p, 30)).toBe(expected)
  })

  it('returns 0 for an empty sample — nothing ran, nothing is allowed', () => {
    expect(maxCountForRate(0.5, 0)).toBe(0)
  })
})

describe('summarize', () => {
  it('excludes units missing a stage field from that stage percentile', () => {
    const s = summarize([
      okUnit({ generateMs: 4000 }),
      okUnit({ generateMs: 6000 }),
      okUnit({
        outcome: 'crisis_short_circuit',
        generateMs: undefined,
        replyPathMs: undefined,
        attemptCount: undefined,
      }),
    ])
    expect(s.stages.generateMs.n).toBe(2)
    expect(s.stages.generateMs.p50).toBe(5000)
    expect(s.stages.classifyMs.n).toBe(3)
  })

  it('counts a verifier denominator over ran checks, not skipped ones', () => {
    const s = summarize([
      okUnit({ mechanicOffer: 'clean' }),
      okUnit({ mechanicOffer: 'flagged' }),
      okUnit({ mechanicOffer: 'skipped' }),
    ])
    expect(s.verifiers.mechanicOffer.ran).toBe(2)
    expect(s.verifiers.mechanicOffer.flagged).toBe(1)
    expect(s.verifiers.mechanicOffer.counts).toEqual({
      clean: 1,
      flagged: 1,
      skipped: 1,
    })
  })

  it('counts regenerations over completed generations only', () => {
    const s = summarize([
      okUnit({ attemptCount: 1 }),
      okUnit({ attemptCount: 2 }),
      okUnit({ outcome: 'failed', attemptCount: undefined }),
    ])
    expect(s.regen).toEqual({ generations: 2, regenerated: 1 })
  })

  it('records the venue clock state distribution', () => {
    const s = summarize([okUnit(), okUnit({ openState: 'closed' }), okUnit()])
    expect(s.openStates).toEqual({ open: 2, closed: 1 })
  })
})

describe('evaluateCeilings', () => {
  it('passes a clean run at the pre-change shape', () => {
    const report = evaluateCeilings(
      summarize(Array.from({ length: 10 }, () => okUnit())),
    )
    expect(report.disqualified).toBe(false)
    expect(report.allPass).toBe(true)
  })

  it('fails on any refused generation', () => {
    const report = evaluateCeilings(
      summarize([okUnit(), { ...okUnit(), outcome: 'refused' as const }]),
    )
    expect(report.allPass).toBe(false)
    expect(
      report.verdicts.find((v) => v.name === 'refused_generations')?.pass,
    ).toBe(false)
  })

  it('fails when a zero-baseline verifier flags twice', () => {
    const report = evaluateCeilings(
      summarize([
        okUnit({ prosePromise: 'flagged' }),
        okUnit({ prosePromise: 'flagged' }),
        okUnit(),
      ]),
    )
    expect(
      report.verdicts.find((v) => v.name === 'prosePromise_flagged')?.pass,
    ).toBe(false)
    expect(report.allPass).toBe(false)
  })

  it('fails generate p50 above 1.2x the production baseline', () => {
    const slow = Array.from({ length: 4 }, () =>
      okUnit({ generateMs: PRE_CHANGE_BASELINE.generateP50Ms * 1.3 }),
    )
    const report = evaluateCeilings(summarize(slow))
    expect(
      report.verdicts.find((v) => v.name === 'generate_p50_ms')?.pass,
    ).toBe(false)
  })

  it('reports no-data generate p50 as a failure, never a pass', () => {
    const report = evaluateCeilings(
      summarize([
        okUnit({ outcome: 'crisis_short_circuit', generateMs: undefined }),
      ]),
    )
    const verdict = report.verdicts.find((v) => v.name === 'generate_p50_ms')
    expect(verdict?.actual).toBe('no data')
    expect(verdict?.pass).toBe(false)
  })

  it('disqualifies the whole run when any unit failed, whatever the counts read', () => {
    const units = Array.from({ length: 9 }, () => okUnit())
    units.push({ ...okUnit(), outcome: 'failed' as const })
    const report = evaluateCeilings(summarize(units))
    expect(report.disqualified).toBe(true)
    expect(report.allPass).toBe(false)
  })
})
