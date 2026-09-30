import { describe, expect, it } from 'vitest'
import { seededFlip } from './seeded-flip'

describe('seededFlip', () => {
  it('is deterministic for a seed', () => {
    expect(seededFlip('s01')).toBe(seededFlip('s01'))
  })

  it('stays inside [0, 1)', () => {
    for (let i = 0; i < 200; i += 1) {
      const v = seededFlip(`scenario-${i}`)
      expect(v).toBeGreaterThanOrEqual(0)
      expect(v).toBeLessThan(1)
    }
  })

  // THE PROPERTY THE FINALIZER EXISTS FOR, and the reason this module has a test
  // at all. Bare FNV-1a over near-identical short ids collapses into two tight
  // bands, which cannot represent a 50/50 coin. Measured as spread rather than
  // as a mean: a clustered hash can still average 0.5 across two bands, so a
  // mean-only assertion would pass against exactly the instrument this rejects.
  it('spreads near-identical short ids across the range', () => {
    const ids = Array.from(
      { length: 24 },
      (_, i) => `s${String(i + 1).padStart(2, '0')}`,
    )
    const values = ids.map(seededFlip).sort((a, b) => a - b)

    // At least one value in each quarter. The clustered version put 18 of 18 in
    // two narrow bands and left two quarters empty.
    for (const [lo, hi] of [
      [0, 0.25],
      [0.25, 0.5],
      [0.5, 0.75],
      [0.75, 1],
    ]) {
      expect(
        values.filter((v) => v >= lo && v < hi).length,
        `quarter ${lo}-${hi}`,
      ).toBeGreaterThan(0)
    }

    // And no single gap swallowing half the range, which is what "two tight
    // bands" looks like when both happen to land in different quarters.
    const gaps = values.slice(1).map((v, i) => v - (values[i] as number))
    expect(Math.max(...gaps)).toBeLessThan(0.5)
  })
})
