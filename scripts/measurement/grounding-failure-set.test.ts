import { describe, expect, it } from 'vitest'
import {
  countByShape,
  FAILURE_SHAPES,
  loadGroundingFailureSet,
  negativeControls,
  reproducibleCases,
} from './grounding-failure-set'

// These run against the real fixture, not a stub. The fixture IS the artifact
// under test — a schema that only ever sees hand-built objects would pass
// while the committed JSON was malformed, which is the one failure that
// matters here.
const set = loadGroundingFailureSet()

describe('grounding failure set — fixture integrity', () => {
  it('parses against the schema', () => {
    // loadGroundingFailureSet throws on violation, so reaching here is the
    // assertion. Restated explicitly so a future reader does not mistake the
    // module-level load for incidental setup.
    expect(set.cases.length).toBeGreaterThan(0)
  })

  it('has unique, contiguous case ids', () => {
    const ids = set.cases.map((c) => c.id)
    expect(new Set(ids).size).toBe(ids.length)
    // Contiguity keeps `gf-NN` meaningful as a reference in a ticket or a
    // commit message. A gap means a case was deleted rather than marked, and
    // deleting a case silently loses the evidence it encoded.
    const numbers = ids.map((id) => Number(id.slice(3))).sort((a, b) => a - b)
    expect(numbers).toEqual(Array.from({ length: numbers.length }, (_, i) => i + 1))
  })

  it('documents every shape it uses, and uses every shape it documents', () => {
    // A documented-but-unused shape is a case someone meant to add and didn't.
    // A used-but-undocumented shape is a case whose failure mode nobody wrote
    // down, which is the whole value of the set.
    const used = new Set(set.cases.map((c) => c.shape))
    const documented = new Set(Object.keys(set.shapes))
    expect([...used].sort()).toEqual([...documented].sort())
  })

  it('keeps the shape enum and the fixture vocabulary in sync', () => {
    for (const shape of Object.keys(set.shapes)) {
      expect(FAILURE_SHAPES).toContain(shape)
    }
  })
})

describe('grounding failure set — the invariants that make it usable', () => {
  it('gives every reproducible case at least one forbidden claim', () => {
    // A reproducible case with no forbidden_claims cannot fail, so it would
    // sit in the set reporting a clean run forever and inflate confidence that
    // the generator had improved.
    for (const c of reproducibleCases(set)) {
      expect(c.forbidden_claims.length, `${c.id} has no forbidden_claims`).toBeGreaterThan(0)
    }
  })

  it('gives every negative control NO forbidden claims', () => {
    // The inverse. A negative control asserts the reply was fine; a forbidden
    // claim on one would assert the opposite in the same object.
    for (const c of negativeControls(set)) {
      expect(c.forbidden_claims, `${c.id} is a control but forbids something`).toEqual([])
    }
  })

  it('carries negative controls at all', () => {
    // Load-bearing, not decorative. A set built only from cases where the
    // verifier was RIGHT biases every retire-the-verifier decision toward
    // keeping it. TAC-409 shipped do-not-flag bullets for both of these.
    expect(negativeControls(set).length).toBeGreaterThan(0)
    for (const c of negativeControls(set)) {
      expect(c.shape).toBe('verifier_false_positive')
    }
  })

  it('marks every verifier_false_positive case as a control, and vice versa', () => {
    for (const c of set.cases) {
      expect(c.verdict_expected === 'clean').toBe(c.shape === 'verifier_false_positive')
    }
  })

  it('covers the fabricated-contact-detail shape, the reason the set exists', () => {
    // TAC-501. If a refactor ever drops this case, the set has lost the
    // highest-harm shape it was built to hold — a guest can act on an invented
    // phone number in a way they cannot act on an invented superlative.
    const fabrication = set.cases.filter((c) => c.shape === 'fabricated_contact_detail')
    expect(fabrication.length).toBeGreaterThan(0)
    expect(fabrication[0].note).toContain('TAC-501')
  })

  it('keeps the largest production cluster represented', () => {
    // asserting_absence was the most frequent shape in the 2026-09-23 sample.
    // Reporting is per-shape, so a shape reduced to one case stops being able
    // to show a partial improvement.
    const counts = countByShape(reproducibleCases(set))
    expect(counts.asserting_absence).toBeGreaterThanOrEqual(2)
  })
})

describe('grounding failure set — public-repo constraint', () => {
  it('states the synthetic provenance in the fixture itself', () => {
    // The rule lives with the data, not only in CLAUDE.md, because the person
    // most likely to paste a real body in is the one editing the JSON.
    expect(set.note).toMatch(/synthetic/i)
    expect(set.note).toMatch(/public/i)
  })

  it('carries no phone-number-shaped string in any case', () => {
    // The TAC-501 case is ABOUT a fabricated number and must describe one
    // without containing one — the single most likely way a real detail gets
    // committed here.
    //
    // ISO dates and ticket refs are stripped BEFORE the test rather than
    // excluded by a cleverer pattern. The first draft of this guard fired on
    // `2026-09-20` inside gf-12's own provenance note, which is exactly the
    // content these cases are supposed to carry. Deleting the date to satisfy
    // the guard would have been the wrong repair: the note is the evidence.
    // A phone number is >= 10 digits, an ISO date is 8, so the separation is
    // clean once the legitimate shapes are out of the way.
    const stripKnownSafe = (s: string) =>
      s.replace(/\d{4}-\d{2}-\d{2}/g, '').replace(/\bTAC-\d+\b/g, '')
    const digitRun = /\+?[\d][\d\s().-]{8,}[\d]/g
    for (const c of set.cases) {
      const haystack = stripKnownSafe(
        [c.inbound, c.premise, c.observed_claim, c.expected_behavior, c.note ?? ''].join(' '),
      )
      for (const match of haystack.match(digitRun) ?? []) {
        const digits = match.replace(/\D/g, '').length
        expect(digits, `${c.id} contains a phone-number-shaped string: ${match}`).toBeLessThan(10)
      }
    }
  })

  it('carries no bare URL in any case', () => {
    // Same reasoning for the link cases: gf-04 is about an inferred
    // purchasability claim, and needs no real domain to express it.
    for (const c of set.cases) {
      const haystack = [c.inbound, c.premise, c.observed_claim, c.expected_behavior].join(' ')
      expect(/https?:\/\//.test(haystack), `${c.id} contains a URL`).toBe(false)
    }
  })
})
