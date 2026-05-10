import { describe, expect, it } from 'vitest'
import { extractRecentVisits } from './extract-recent-visits'

const NOW = new Date('2026-05-02T18:00:00Z')

function makeRow(
  occurredAt: string,
  rawData: unknown,
): { occurred_at: string; raw_data: unknown } {
  return { occurred_at: occurredAt, raw_data: rawData }
}

function makeRawData(items: Array<Partial<{ name: unknown }>>) {
  return {
    pos_provider: 'mock',
    ticket_id: 'TKT-1',
    line_items: items,
    subtotal_cents: 700,
  }
}

function daysAgo(n: number): string {
  return new Date(NOW.getTime() - n * 24 * 60 * 60 * 1000).toISOString()
}

describe('extractRecentVisits — null / empty inputs', () => {
  it('returns [] when rows is null', () => {
    expect(extractRecentVisits(null, NOW)).toEqual([])
  })

  it('returns [] when rows is undefined', () => {
    expect(extractRecentVisits(undefined, NOW)).toEqual([])
  })

  it('returns [] when rows is an empty array', () => {
    expect(extractRecentVisits([], NOW)).toEqual([])
  })
})

describe('extractRecentVisits — order preservation', () => {
  it('preserves the input order (caller is expected to pass DESC)', () => {
    const rows = [
      makeRow(daysAgo(1), makeRawData([{ name: 'latte' }])),
      makeRow(daysAgo(7), makeRawData([{ name: 'cappuccino' }])),
      makeRow(daysAgo(30), makeRawData([{ name: 'cortado' }])),
    ]
    const out = extractRecentVisits(rows, NOW)
    expect(out).toHaveLength(3)
    expect(out[0].items).toEqual(['latte'])
    expect(out[1].items).toEqual(['cappuccino'])
    expect(out[2].items).toEqual(['cortado'])
  })
})

describe('extractRecentVisits — per-row freshness cutoff', () => {
  it('includes rows within the default 90-day cutoff', () => {
    const rows = [makeRow(daysAgo(89), makeRawData([{ name: 'latte' }]))]
    expect(extractRecentVisits(rows, NOW)).toHaveLength(1)
  })

  it('drops rows older than 90 days, keeps fresher ones', () => {
    const rows = [
      makeRow(daysAgo(1), makeRawData([{ name: 'latte' }])),
      makeRow(daysAgo(91), makeRawData([{ name: 'too old' }])),
    ]
    const out = extractRecentVisits(rows, NOW)
    expect(out).toHaveLength(1)
    expect(out[0].items).toEqual(['latte'])
  })

  it('respects an overridden cutoff', () => {
    const rows = [
      makeRow(daysAgo(5), makeRawData([{ name: 'latte' }])),
      makeRow(daysAgo(10), makeRawData([{ name: 'cappuccino' }])),
    ]
    expect(extractRecentVisits(rows, NOW, 90)).toHaveLength(2)
    expect(extractRecentVisits(rows, NOW, 7)).toHaveLength(1)
  })

  it('treats the cutoff as inclusive', () => {
    const rows = [makeRow(daysAgo(90), makeRawData([{ name: 'latte' }]))]
    expect(extractRecentVisits(rows, NOW)).toHaveLength(1)
  })

  it('drops rows with unparseable occurred_at silently', () => {
    const rows = [
      makeRow(daysAgo(1), makeRawData([{ name: 'good' }])),
      makeRow('not-a-date', makeRawData([{ name: 'bad' }])),
    ]
    const out = extractRecentVisits(rows, NOW)
    expect(out).toHaveLength(1)
    expect(out[0].items).toEqual(['good'])
  })
})

describe('extractRecentVisits — per-row raw_data shape', () => {
  it('drops rows whose raw_data is null', () => {
    const rows = [
      makeRow(daysAgo(1), null),
      makeRow(daysAgo(2), makeRawData([{ name: 'good' }])),
    ]
    const out = extractRecentVisits(rows, NOW)
    expect(out).toHaveLength(1)
  })

  it('drops rows with no line_items array', () => {
    const rows = [
      makeRow(daysAgo(1), { pos_provider: 'mock', ticket_id: 'TKT-1' }),
    ]
    expect(extractRecentVisits(rows, NOW)).toEqual([])
  })

  it('drops rows with empty line_items', () => {
    const rows = [makeRow(daysAgo(1), makeRawData([]))]
    expect(extractRecentVisits(rows, NOW)).toEqual([])
  })

  it('drops rows where every line_item has a missing or non-string name', () => {
    const rows = [
      makeRow(
        daysAgo(1),
        makeRawData([{ name: 123 }, { name: null }, { name: undefined }, {}]),
      ),
    ]
    expect(extractRecentVisits(rows, NOW)).toEqual([])
  })

  it('drops rows where raw_data is a string (not an object)', () => {
    const rows = [makeRow(daysAgo(1), 'oops not jsonb')]
    expect(extractRecentVisits(rows, NOW)).toEqual([])
  })
})

describe('extractRecentVisits — items extraction (per row)', () => {
  it('lowercases item names', () => {
    const rows = [
      makeRow(
        daysAgo(1),
        makeRawData([{ name: 'Cappuccino' }, { name: 'BLUEBERRY MUFFIN' }]),
      ),
    ]
    expect(extractRecentVisits(rows, NOW)[0].items).toEqual([
      'cappuccino',
      'blueberry muffin',
    ])
  })

  it('dedupes case-insensitively, preserving insertion order', () => {
    const rows = [
      makeRow(
        daysAgo(1),
        makeRawData([
          { name: 'Cappuccino' },
          { name: 'blueberry muffin' },
          { name: 'cappuccino' },
          { name: 'CAPPUCCINO' },
        ]),
      ),
    ]
    expect(extractRecentVisits(rows, NOW)[0].items).toEqual([
      'cappuccino',
      'blueberry muffin',
    ])
  })

  it('strips whitespace + drops empty / whitespace-only names', () => {
    const rows = [
      makeRow(
        daysAgo(1),
        makeRawData([{ name: '  Latte  ' }, { name: '' }, { name: '   ' }, { name: 'scone' }]),
      ),
    ]
    expect(extractRecentVisits(rows, NOW)[0].items).toEqual(['latte', 'scone'])
  })

  it('drops non-object line item entries silently', () => {
    const rows = [
      makeRow(
        daysAgo(1),
        { line_items: ['cappuccino', null, 42, { name: 'scone' }] },
      ),
    ]
    expect(extractRecentVisits(rows, NOW)[0].items).toEqual(['scone'])
  })
})

describe('extractRecentVisits — visitedAt', () => {
  it('returns visitedAt as a Date constructed from occurred_at on each Visit', () => {
    const occurredAt = '2026-05-01T10:00:00Z'
    const rows = [makeRow(occurredAt, makeRawData([{ name: 'cappuccino' }]))]
    const out = extractRecentVisits(rows, NOW)
    expect(out[0].visitedAt).toBeInstanceOf(Date)
    expect(out[0].visitedAt.toISOString()).toBe(occurredAt.replace('Z', '.000Z'))
  })
})

describe('extractRecentVisits — mixed input', () => {
  it('returns only rows that survive both freshness and items filters', () => {
    const rows = [
      makeRow(daysAgo(1), makeRawData([{ name: 'latte' }])), // keep
      makeRow(daysAgo(91), makeRawData([{ name: 'too old' }])), // drop: old
      makeRow(daysAgo(5), { line_items: [] }), // drop: no items
      makeRow(daysAgo(10), makeRawData([{ name: 'cappuccino' }])), // keep
    ]
    const out = extractRecentVisits(rows, NOW)
    expect(out.map((v) => v.items[0])).toEqual(['latte', 'cappuccino'])
  })
})
