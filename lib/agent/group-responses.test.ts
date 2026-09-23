import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { type HistoryRow, deriveDelivery, groupIntoResponses } from './group-responses'

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
    // TAC-394: a sent message by default, so every case below that predates
    // delivery reads as it always did.
    status: direction === 'inbound' ? 'received' : 'sent',
    review_state: direction === 'inbound' ? null : 'auto_sent',
  }
}

const group = (rows: readonly HistoryRow[], max: number) => groupIntoResponses(rows, max)

const bodies = (rows: ReturnType<typeof groupIntoResponses>): string[] =>
  rows.map((r) => r.body)

describe('groupIntoResponses', () => {
  it('returns chronological order (oldest first) for the prompt', () => {
    const out = group(
      [row('c', 'outbound', 'third', 1), row('b', 'inbound', 'second', 2), row('a', 'outbound', 'first', 3)],
      30,
    )
    expect(bodies(out)).toEqual(['first', 'second', 'third'])
  })

  it('merges bubbles sharing a generation_id into ONE entry', () => {
    const out = group(
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
    const out = group(
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
    const out = group([row('b2', 'outbound', 'b', 3, 'gen-1'), first], 30)
    expect(out[0]!.createdAt.toISOString()).toBe(first.created_at)
  })

  it('carries the direction of the grouped rows', () => {
    const out = group(
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
    const out = group(
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
    const out = group(
      [row('c', 'outbound', 'c', 1), row('b', 'outbound', 'b', 2), row('a', 'outbound', 'a', 3)],
      30,
    )
    expect(out).toHaveLength(3)
    expect(bodies(out)).toEqual(['a', 'b', 'c'])
  })

  it('does not group two null-generation rows together', () => {
    // Guards against a coalesce mistake that keyed every legacy row to the
    // same bucket — which would collapse an entire history into one line.
    const out = group(
      [row('b', 'outbound', 'b', 1), row('a', 'outbound', 'a', 2)],
      30,
    )
    expect(out).toHaveLength(2)
  })

  it('handles a mix of legacy and split rows', () => {
    const out = group(
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
    const out = group(rows, 2)
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
    expect(bodies(group(newestFirst, 1))).toEqual(['newest'])
    expect(bodies(group([...newestFirst].reverse(), 1))).toEqual(['oldest'])
  })

  it('keeps the MOST RECENT responses when over the cap', () => {
    const out = group(
      [row('c', 'outbound', 'newest', 1), row('b', 'outbound', 'middle', 2), row('a', 'outbound', 'oldest', 3)],
      2,
    )
    expect(bodies(out)).toEqual(['middle', 'newest'])
  })

  it('returns an empty array for no rows', () => {
    expect(group([], 30)).toEqual([])
  })

  it('skips empty bodies when joining', () => {
    const out = group(
      [row('b2', 'outbound', 'real text', 1, 'gen-1'), row('b1', 'outbound', '', 2, 'gen-1')],
      30,
    )
    expect(bodies(out)).toEqual(['real text'])
  })
})

// ── TAC-394: delivery ─────────────────────────────────────────────────

// Read from migration 001 rather than retyped, so the table below has to decide
// every status the constraint permits. It reads 001 BY NAME because no later
// migration touches messages_status_check (checked 2026-09-14). Migrations are
// append-only, so a future one that widens the constraint must repoint this at
// itself, or its new status goes untested.
const MESSAGE_STATUSES: string[] = (() => {
  const sql = readFileSync(join(__dirname, '../../db/migrations/001_initial_schema.sql'), 'utf-8')
  const table = sql.slice(sql.indexOf('create table messages'))
  const check = table.slice(table.indexOf('check (status in ('))
  return [...check.slice(0, check.indexOf('))')).matchAll(/'([a-z_]+)'/g)].map((m) => m[1]!)
})()

type DeliveryRow = Parameters<typeof deriveDelivery>[0]
const outbound = (status: string, reviewState: string | null): DeliveryRow => ({
  direction: 'outbound',
  status,
  review_state: reviewState,
})

describe('deriveDelivery (TAC-394)', () => {
  // Literal, never derived from DELIVERED_OUTBOUND_STATUSES: a table built from
  // the constant would pass whatever the constant says.
  const OUTBOUND_BY_STATUS: Record<string, 'delivered' | 'never_sent'> = {
    received: 'never_sent',
    draft: 'never_sent',
    pending_review: 'never_sent',
    approved: 'never_sent',
    // Sendblue QUEUED maps here, and out-of-order callbacks can leave a
    // message the guest really received at 'sending'. Calling it NEVER SENT
    // would invite the model to say it again.
    sending: 'delivered',
    sent: 'delivered',
    delivered: 'delivered',
    failed: 'never_sent',
    rejected: 'never_sent',
  }

  it('has a decision for every status migration 001 permits', () => {
    expect(MESSAGE_STATUSES.length).toBeGreaterThan(0)
    expect(Object.keys(OUTBOUND_BY_STATUS).sort()).toEqual([...MESSAGE_STATUSES].sort())
  })

  it.each(Object.entries(OUTBOUND_BY_STATUS))('an outbound row at status %s reads %s', (status, expected) => {
    expect(deriveDelivery(outbound(status, 'auto_sent'))).toBe(expected)
  })

  // The incident: a pending draft rendered as sent. review_state is checked
  // before status, so no status value can make a pending row read delivered.
  it.each(MESSAGE_STATUSES)('a pending draft at status %s reads awaiting_review', (status) => {
    expect(deriveDelivery(outbound(status, 'pending'))).toBe('awaiting_review')
  })

  // A skip says why the line never arrived, which a failed send must not. A
  // delivered status still wins, because then the guest read it.
  it.each(MESSAGE_STATUSES)('a skipped draft at status %s reads skipped_by_operator unless delivered', (status) => {
    const expected = OUTBOUND_BY_STATUS[status] === 'delivered' ? 'delivered' : 'skipped_by_operator'
    expect(deriveDelivery(outbound(status, 'skipped'))).toBe(expected)
  })

  // TAC-473. A card answered from the Instagram app keeps `pending_review`, so
  // it reaches the catch-all unless named. Before this it read NEVER SENT, and
  // the prompt told the model a send had failed when staff had simply answered
  // in the app and the echo was sitting in the same history as delivered.
  it.each(MESSAGE_STATUSES)(
    'an externally resolved card at status %s reads answered_outside_app unless delivered',
    (status) => {
      const expected =
        OUTBOUND_BY_STATUS[status] === 'delivered' ? 'delivered' : 'answered_outside_app'
      expect(deriveDelivery(outbound(status, 'resolved_externally'))).toBe(expected)
    },
  )

  it('does NOT read an externally resolved card as never_sent', () => {
    // The whole point: nothing failed. Pinned separately so a fallthrough to
    // the catch-all fails here even if the it.each above were ever relaxed.
    expect(deriveDelivery(outbound('pending_review', 'resolved_externally'))).not.toBe('never_sent')
  })

  it('stranded and failed outbound rows read never_sent, not skipped', () => {
    // The v1 dispatch gap: approved or edited, Sendblue threw, row stranded.
    expect(deriveDelivery(outbound('pending_review', 'approved'))).toBe('never_sent')
    expect(deriveDelivery(outbound('pending_review', 'edited'))).toBe('never_sent')
    expect(deriveDelivery(outbound('failed', 'auto_sent'))).toBe('never_sent')
  })

  it('a status nobody mapped reads never_sent, never delivered', () => {
    expect(deriveDelivery(outbound('some_future_status', null))).toBe('never_sent')
  })

  it('an inbound row is delivered whatever its other columns say', () => {
    expect(deriveDelivery({ ...outbound('failed', 'pending'), direction: 'inbound' })).toBe('delivered')
    expect(deriveDelivery({ ...outbound('failed', 'skipped'), direction: 'inbound' })).toBe('delivered')
  })
})

describe('groupIntoResponses delivery (TAC-394)', () => {
  const at = (r: HistoryRow, status: string, reviewState: string | null): HistoryRow => ({
    ...r,
    status,
    review_state: reviewState,
  })

  it('carries each response its delivery, unsent drafts included rather than dropped', () => {
    const out = groupIntoResponses(
      [
        at(row('draft', 'outbound', "the next one's on us", 1), 'pending_review', 'pending'),
        at(row('skip', 'outbound', 'an earlier draft', 2), 'pending_review', 'skipped'),
        row('in', 'inbound', 'the cortado i got this morning was cold and bad', 3),
      ],
      30,
    )
    expect(out.map((r) => [r.body, r.delivery])).toEqual([
      ['the cortado i got this morning was cold and bad', 'delivered'],
      ['an earlier draft', 'skipped_by_operator'],
      ["the next one's on us", 'awaiting_review'],
    ])
  })

  // The OLDEST bubble is the failed one on purpose: with the delivered bubble
  // first, taking the first row's delivery would pass this too.
  it('a split response is delivered if any bubble was', () => {
    const out = groupIntoResponses(
      [
        at(row('b2', 'outbound', 'second', 1, 'gen-1'), 'delivered', 'auto_sent'),
        at(row('b1', 'outbound', 'first', 2, 'gen-1'), 'failed', 'auto_sent'),
      ],
      30,
    )
    expect(out[0]!.delivery).toBe('delivered')
  })

  it('a split response is never_sent when no bubble was delivered', () => {
    const out = groupIntoResponses(
      [
        at(row('b2', 'outbound', 'second', 1, 'gen-1'), 'failed', 'auto_sent'),
        at(row('b1', 'outbound', 'first', 2, 'gen-1'), 'failed', 'auto_sent'),
      ],
      30,
    )
    expect(out[0]!.delivery).toBe('never_sent')
  })
})
