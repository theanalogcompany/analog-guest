import { describe, expect, it } from 'vitest'
import {
  decodeTokPerSec,
  formatReport,
  median,
  summarizeCells,
  type ProbeUnit,
} from './generation-latency-score'

function unit(overrides: Partial<ProbeUnit>): ProbeUnit {
  return {
    model: 'claude-sonnet-4-6',
    schemaArm: 'full',
    cacheArm: 'warm',
    ok: true,
    error: null,
    ttftMs: 2000,
    totalMs: 6000,
    outputTokens: 200,
    cacheReadTokens: 16000,
    cacheWriteTokens: 0,
    uncachedInputTokens: 3400,
    ...overrides,
  }
}

describe('median', () => {
  it('returns null on empty input', () => {
    expect(median([])).toBeNull()
  })

  it('picks the middle element of an odd-length list', () => {
    expect(median([9, 1, 5])).toBe(5)
  })

  it('averages the two middle elements of an even-length list', () => {
    expect(median([1, 2, 10, 20])).toBe(6)
  })

  it('does not mutate its input', () => {
    const xs = [3, 1, 2]
    median(xs)
    expect(xs).toEqual([3, 1, 2])
  })
})

describe('decodeTokPerSec', () => {
  it('rates output tokens over the post-TTFT window', () => {
    // 200 tokens over 4 seconds of decode = 50 tok/s.
    expect(decodeTokPerSec(unit({ ttftMs: 2000, totalMs: 6000 }))).toBe(50)
  })

  it('returns null when TTFT consumed the whole call', () => {
    expect(decodeTokPerSec(unit({ ttftMs: 6000, totalMs: 6000 }))).toBeNull()
  })

  it('returns null when any component is missing', () => {
    expect(decodeTokPerSec(unit({ ttftMs: null }))).toBeNull()
    expect(decodeTokPerSec(unit({ outputTokens: null }))).toBeNull()
  })
})

describe('summarizeCells', () => {
  it('groups by model, schema arm and cache arm', () => {
    const cells = summarizeCells([
      unit({}),
      unit({ schemaArm: 'slim' }),
      unit({ cacheArm: 'cold', cacheReadTokens: 0 }),
    ])
    expect(cells.map((c) => c.cell).sort()).toEqual([
      'claude-sonnet-4-6 full cold',
      'claude-sonnet-4-6 full warm',
      'claude-sonnet-4-6 slim warm',
    ])
  })

  it('computes medians from ok units', () => {
    const [cell] = summarizeCells([
      unit({ ttftMs: 1000, totalMs: 5000, outputTokens: 200 }),
      unit({ ttftMs: 3000, totalMs: 7000, outputTokens: 100 }),
    ])
    expect(cell!.medianTtftMs).toBe(2000)
    expect(cell!.medianTotalMs).toBe(6000)
    expect(cell!.medianOutputTokens).toBe(150)
  })

  it('takes the median of per-unit decode rates, not a rate of medians', () => {
    // Unit A: 100 tok over 1s = 100 tok/s. Unit B: 300 tok over 10s = 30
    // tok/s. Median of rates is 65; the rate of medians (200 tok over
    // 5.5s ≈ 36.4) would be wrong.
    const [cell] = summarizeCells([
      unit({ ttftMs: 1000, totalMs: 2000, outputTokens: 100 }),
      unit({ ttftMs: 1000, totalMs: 11000, outputTokens: 300 }),
    ])
    expect(cell!.medianDecodeTokPerSec).toBe(65)
  })

  it('disqualifies a cell on any failed call, whatever the survivors read', () => {
    const [cell] = summarizeCells([
      unit({}),
      unit({ ok: false, error: 'boom', ttftMs: null, totalMs: null }),
    ])
    expect(cell!.valid).toBe(false)
    expect(cell!.invalidReason).toContain('failed call')
    expect(cell!.failures).toBe(1)
  })

  it('invalidates a warm cell whose calls never read cache', () => {
    const [cell] = summarizeCells([
      unit({ cacheArm: 'warm', cacheReadTokens: 0 }),
    ])
    expect(cell!.valid).toBe(false)
    expect(cell!.invalidReason).toContain('warm call read no cache')
  })

  it('invalidates a cold cell whose calls read cache', () => {
    const [cell] = summarizeCells([
      unit({ cacheArm: 'cold', cacheReadTokens: 12000 }),
    ])
    expect(cell!.valid).toBe(false)
    expect(cell!.invalidReason).toContain('cold call read cache')
  })

  it('keeps a clean warm cell valid', () => {
    const [cell] = summarizeCells([unit({}), unit({})])
    expect(cell!.valid).toBe(true)
    expect(cell!.invalidReason).toBeNull()
  })
})

describe('formatReport', () => {
  it('marks invalid cells inline so a reader cannot quote them as results', () => {
    const report = formatReport(
      summarizeCells([
        unit({}),
        unit({ cacheArm: 'cold', cacheReadTokens: 9000 }),
      ]),
    )
    expect(report).toContain('INVALID: a cold call read cache')
    // The valid warm row must NOT carry the marker.
    const warmLine = report.split('\n').find((l) => l.includes('full warm'))
    expect(warmLine).toBeDefined()
    expect(warmLine).not.toContain('INVALID')
  })
})
