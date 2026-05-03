import { describe, expect, it } from 'vitest'
import { extractLastVisit } from './extract-last-visit'

const NOW = new Date('2026-05-02T18:00:00Z')

function makeRow(
  occurredAt: string,
  rawData: unknown,
): { occurred_at: string; raw_data: unknown } {
  return { occurred_at: occurredAt, raw_data: rawData }
}

function makeRawData(items: Array<Partial<{ name: unknown; quantity: number; unit_price_cents: number }>>) {
  return {
    pos_provider: 'mock',
    ticket_id: 'TKT-1',
    line_items: items,
    subtotal_cents: 700,
  }
}

describe('extractLastVisit — null / missing inputs', () => {
  it('returns null when row is null', () => {
    expect(extractLastVisit(null, NOW)).toBeNull()
  })

  it('returns null when row is undefined', () => {
    expect(extractLastVisit(undefined, NOW)).toBeNull()
  })

  it('returns null when occurred_at is unparseable', () => {
    expect(extractLastVisit(makeRow('not-a-date', makeRawData([{ name: 'cappuccino' }])), NOW)).toBeNull()
  })
})

describe('extractLastVisit — freshness cutoff', () => {
  it('returns the visit when within the default 60-day cutoff', () => {
    const row = makeRow('2026-05-01T10:00:00Z', makeRawData([{ name: 'cappuccino' }]))
    const out = extractLastVisit(row, NOW)
    expect(out).not.toBeNull()
    expect(out?.items).toEqual(['cappuccino'])
  })

  it('returns null when the transaction is older than 60 days', () => {
    // 61 days before NOW
    const row = makeRow(
      new Date(NOW.getTime() - 61 * 24 * 60 * 60 * 1000).toISOString(),
      makeRawData([{ name: 'cappuccino' }]),
    )
    expect(extractLastVisit(row, NOW)).toBeNull()
  })

  it('respects an overridden cutoff', () => {
    // 10 days old; within 60, but outside a custom 7-day cutoff.
    const row = makeRow(
      new Date(NOW.getTime() - 10 * 24 * 60 * 60 * 1000).toISOString(),
      makeRawData([{ name: 'cappuccino' }]),
    )
    expect(extractLastVisit(row, NOW, 60)).not.toBeNull()
    expect(extractLastVisit(row, NOW, 7)).toBeNull()
  })

  it('treats the cutoff as inclusive', () => {
    // Exactly 60 days old → still within window
    const row = makeRow(
      new Date(NOW.getTime() - 60 * 24 * 60 * 60 * 1000).toISOString(),
      makeRawData([{ name: 'cappuccino' }]),
    )
    expect(extractLastVisit(row, NOW)).not.toBeNull()
  })
})

describe('extractLastVisit — raw_data shape', () => {
  it('returns null when raw_data is null', () => {
    const row = makeRow('2026-05-01T10:00:00Z', null)
    expect(extractLastVisit(row, NOW)).toBeNull()
  })

  it('returns null when raw_data has no line_items array', () => {
    const row = makeRow('2026-05-01T10:00:00Z', { pos_provider: 'mock', ticket_id: 'TKT-1' })
    expect(extractLastVisit(row, NOW)).toBeNull()
  })

  it('returns null when line_items is empty', () => {
    const row = makeRow('2026-05-01T10:00:00Z', makeRawData([]))
    expect(extractLastVisit(row, NOW)).toBeNull()
  })

  it('returns null when every line_item has a missing or non-string name', () => {
    const row = makeRow(
      '2026-05-01T10:00:00Z',
      makeRawData([{ name: 123 }, { name: null }, { name: undefined }, {}]),
    )
    expect(extractLastVisit(row, NOW)).toBeNull()
  })

  it('returns null when raw_data is a string (not an object)', () => {
    const row = makeRow('2026-05-01T10:00:00Z', 'oops not jsonb')
    expect(extractLastVisit(row, NOW)).toBeNull()
  })
})

describe('extractLastVisit — items extraction', () => {
  it('lowercases item names', () => {
    const row = makeRow(
      '2026-05-01T10:00:00Z',
      makeRawData([{ name: 'Cappuccino' }, { name: 'BLUEBERRY MUFFIN' }]),
    )
    expect(extractLastVisit(row, NOW)?.items).toEqual(['cappuccino', 'blueberry muffin'])
  })

  it('dedupes case-insensitively, preserving insertion order', () => {
    const row = makeRow(
      '2026-05-01T10:00:00Z',
      makeRawData([
        { name: 'Cappuccino' },
        { name: 'blueberry muffin' },
        { name: 'cappuccino' },
        { name: 'CAPPUCCINO' },
      ]),
    )
    expect(extractLastVisit(row, NOW)?.items).toEqual(['cappuccino', 'blueberry muffin'])
  })

  it('strips whitespace + drops empty / whitespace-only names', () => {
    const row = makeRow(
      '2026-05-01T10:00:00Z',
      makeRawData([{ name: '  Latte  ' }, { name: '' }, { name: '   ' }, { name: 'scone' }]),
    )
    expect(extractLastVisit(row, NOW)?.items).toEqual(['latte', 'scone'])
  })

  it('drops non-object line item entries silently', () => {
    // raw_data is typed as unknown upstream so a mixed-shape array passes
    // tsc; the helper must survive at runtime regardless.
    const row = makeRow(
      '2026-05-01T10:00:00Z',
      { line_items: ['cappuccino', null, 42, { name: 'scone' }] },
    )
    expect(extractLastVisit(row, NOW)?.items).toEqual(['scone'])
  })
})

describe('extractLastVisit — visitedAt', () => {
  it('returns visitedAt as a Date constructed from occurred_at', () => {
    const occurredAt = '2026-05-01T10:00:00Z'
    const row = makeRow(occurredAt, makeRawData([{ name: 'cappuccino' }]))
    const out = extractLastVisit(row, NOW)
    expect(out?.visitedAt).toBeInstanceOf(Date)
    expect(out?.visitedAt.toISOString()).toBe(occurredAt.replace('Z', '.000Z'))
  })
})
