import { describe, expect, it } from 'vitest'
import { dedupeVisitsByLocalDate } from './visit-dedupe'

describe('dedupeVisitsByLocalDate', () => {
  it('dedupes two same-PT-day transactions that straddle UTC midnight', () => {
    // 2026-01-15 09:00 PT (PST = UTC-8) → 2026-01-15 17:00 UTC
    // 2026-01-15 23:00 PT (PST = UTC-8) → 2026-01-16 07:00 UTC
    // UTC dedupe would say 2 days; America/Los_Angeles dedupe says 1.
    const occurredAtIso = [
      '2026-01-15T17:00:00.000Z',
      '2026-01-16T07:00:00.000Z',
    ]
    const result = dedupeVisitsByLocalDate(occurredAtIso, 'America/Los_Angeles')
    expect(result).toHaveLength(1)
    expect(result[0].toISOString()).toBe('2026-01-15T00:00:00.000Z')
  })
})