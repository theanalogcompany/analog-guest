import { describe, expect, it } from 'vitest'

import { type HistoryRow, groupIntoResponses } from './group-responses'

// Rows arrive from the query ordered created_at DESC, so fixtures are written
// newest-first to match what the projection actually receives.
function row(
  id: string,
  direction: 'inbound' | 'outbound',
  body: string,
  minutesAgo: number,
  generationId: string | null = null,
): HistoryRow {
  return {
    id,
    direction,
    body,
    created_at: new Date(Date.UTC(2026, 7, 8, 12, 0, 0) - minutesAgo * 60_000).toISOString(),
    generation_id: generationId,
  }
}

const bodies = (rows: ReturnType<typeof groupIntoResponses>): string[] =>
  rows.map((r) => r.body)

describe('groupIntoResponses', () => {
  it('returns chronological order (oldest first) for the prompt', () => {
    const out = groupIntoResponses(
      [row('c', 'outbound', 'third', 1), row('b', 'inbound', 'second', 2), row('a', 'outbound', 'first', 3)],
      30,
    )
    expect(bodies(out)).toEqual(['first', 'second', 'third'])
  })

  it('merges bubbles sharing a generation_id into ONE entry', () => {
    const out = groupIntoResponses(
      [
        row('b2', 'outbound', 'espresso, chai, peppermint', 1, 'gen-1'),
        row('b1', 'outbound', "I'd go for the Frosty Gandhi", 2, 'gen-1'),
        row('in', 'inbound', 'what should I get', 3),
      ],
      30,
    )
    expect(out).toHaveLength(2)
    expect(bodies(out)).toEqual([
      'what should I get',
      "I'd go for the Frosty Gandhi espresso, chai, peppermint",
    ])
  })

  it('orders bubbles within a response oldest-first regardless of input order', () => {
    const out = groupIntoResponses(
      [
        row('b1', 'outbound', 'first beat', 5, 'gen-1'),
        row('b3', 'outbound', 'third beat', 3, 'gen-1'),
        row('b2', 'outbound', 'second beat', 4, 'gen-1'),
      ],
      30,
    )
    expect(bodies(out)).toEqual(['first beat second beat third beat'])
  })

  it('dates a merged response by its FIRST bubble', () => {
    // The delta the prompt renders should describe the response, not its last
    // fragment.
    const first = row('b1', 'outbound', 'a', 5, 'gen-1')
    const out = groupIntoResponses([row('b2', 'outbound', 'b', 3, 'gen-1'), first], 30)
    expect(out[0]!.createdAt.toISOString()).toBe(first.created_at)
  })

  it('carries the direction of the grouped rows', () => {
    const out = groupIntoResponses(
      [row('b2', 'outbound', 'b', 1, 'gen-1'), row('b1', 'outbound', 'a', 2, 'gen-1')],
      30,
    )
    expect(out[0]!.direction).toBe('outbound')
  })

  // ── the keyed-not-adjacent property ───────────────────────────────────

  it('groups a response whose bubbles are NOT contiguous', () => {
    // A guest can text inside the inter-bubble gap, which puts an inbound row
    // between two bubbles of one response. An adjacency-based merge would read
    // this as three turns and would pass every contiguous fixture.
    const out = groupIntoResponses(
      [
        row('b2', 'outbound', 'second beat', 1, 'gen-1'),
        row('interrupt', 'inbound', 'wait actually', 2),
        row('b1', 'outbound', 'first beat', 3, 'gen-1'),
      ],
      30,
    )
    expect(out).toHaveLength(2)
    expect(bodies(out)).toContain('first beat second beat')
    expect(bodies(out)).toContain('wait actually')
  })

  // ── legacy / no-backfill behavior ─────────────────────────────────────

  it('treats null generation_id rows as their own responses', () => {
    // This is what makes migration 032 need no backfill.
    const out = groupIntoResponses(
      [row('c', 'outbound', 'c', 1), row('b', 'outbound', 'b', 2), row('a', 'outbound', 'a', 3)],
      30,
    )
    expect(out).toHaveLength(3)
    expect(bodies(out)).toEqual(['a', 'b', 'c'])
  })

  it('does not group two null-generation rows together', () => {
    // Guards against a coalesce mistake that keyed every legacy row to the
    // same bucket — which would collapse an entire history into one line.
    const out = groupIntoResponses(
      [row('b', 'outbound', 'b', 1), row('a', 'outbound', 'a', 2)],
      30,
    )
    expect(out).toHaveLength(2)
  })

  it('handles a mix of legacy and split rows', () => {
    const out = groupIntoResponses(
      [
        row('n2', 'outbound', 'new second', 1, 'gen-1'),
        row('n1', 'outbound', 'new first', 2, 'gen-1'),
        row('old', 'outbound', 'legacy row', 3),
      ],
      30,
    )
    expect(bodies(out)).toEqual(['legacy row', 'new first new second'])
  })

  // ── the cap ───────────────────────────────────────────────────────────

  it('caps on RESPONSES, not rows', () => {
    // Three responses of three bubbles each = 9 rows, built newest-first to
    // match the query's DESC order: gen-3 is the most recent response, gen-1
    // the oldest. A row cap of 2 would return two fragments of gen-3; a
    // response cap returns two whole responses.
    const rows: HistoryRow[] = []
    for (let g = 3; g >= 1; g -= 1) {
      for (let b = 3; b >= 1; b -= 1) {
        rows.push(
          row(`g${g}b${b}`, 'outbound', `g${g}b${b}`, (4 - g) * 10 + (4 - b), `gen-${g}`),
        )
      }
    }
    const out = groupIntoResponses(rows, 2)
    expect(out).toHaveLength(2)
    // Chronological output, and every bubble of each kept response survives.
    expect(bodies(out)).toEqual(['g2b1 g2b2 g2b3', 'g3b1 g3b2 g3b3'])
  })

  it('selects by input order, which the caller must supply as created_at DESC', () => {
    // Pinning the precondition rather than trusting the docstring. The
    // function selects the first N groups it encounters; feeding it
    // oldest-first would silently keep the OLDEST responses and drop the
    // newest, with no error and no type change to catch it. The live caller
    // orders DESC in the query.
    const newestFirst = [
      row('c', 'outbound', 'newest', 1),
      row('b', 'outbound', 'middle', 2),
      row('a', 'outbound', 'oldest', 3),
    ]
    expect(bodies(groupIntoResponses(newestFirst, 1))).toEqual(['newest'])
    expect(bodies(groupIntoResponses([...newestFirst].reverse(), 1))).toEqual(['oldest'])
  })

  it('keeps the MOST RECENT responses when over the cap', () => {
    const out = groupIntoResponses(
      [row('c', 'outbound', 'newest', 1), row('b', 'outbound', 'middle', 2), row('a', 'outbound', 'oldest', 3)],
      2,
    )
    expect(bodies(out)).toEqual(['middle', 'newest'])
  })

  it('returns an empty array for no rows', () => {
    expect(groupIntoResponses([], 30)).toEqual([])
  })

  it('skips empty bodies when joining', () => {
    const out = groupIntoResponses(
      [row('b2', 'outbound', 'real text', 1, 'gen-1'), row('b1', 'outbound', '', 2, 'gen-1')],
      30,
    )
    expect(bodies(out)).toEqual(['real text'])
  })
})
