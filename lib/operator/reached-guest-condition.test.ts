// TAC-395: one condition, written in three places, kept in step here.
//
//   1. lib/operator/thread.ts, as a PostgREST filter on the thread query.
//   2. db/migrations/043_operator_conversations_reached_guest.sql
//   3. db/migrations/044_operator_queue_context_reached_guest.sql
//
// The condition decides which messages "reached the guest":
//
//   direction = 'inbound'
//   or (review_state is distinct from 'pending'
//       and status in ('sending', 'sent', 'delivered'))
//
// It has to run in SQL, before the thread's 200-row cap and the card context's
// 3-response limit, so it can't be one shared TypeScript function. Every copy's
// status list must match DELIVERED_OUTBOUND_STATUSES, and that constant must
// agree with the Contract and with deriveDelivery (TAC-394).
//
// The migration checks pin exact statement fragments, not loose substrings. A
// first version only checked that each clause appeared somewhere in the file,
// and code review found five wrong migrations that passed it. One of them, 044
// with its parentheses dropped, would have filled every card's context with
// other guests' messages. Pinning the fragment each clause belongs to catches a
// clause that is dropped, moved to another CTE, or re-parenthesised. A
// semantically equivalent rewrite fails too; that is the safe direction, and
// the fix is to update the fragment here in the same change.
//
// Comments are stripped before matching (whole-line, trailing and block), so a
// clause that survives only in a comment fails.
//
// Migrations are append-only, so this reads 043 and 044 BY NAME. A later
// migration that replaces either function must repoint this test at itself.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { DELIVERED_OUTBOUND_STATUSES, deriveDelivery } from '@/lib/agent/group-responses'

const REPO_ROOT = join(__dirname, '../..')

// Transcribed from TAC-395's Contract. Literal on purpose: a list built from
// DELIVERED_OUTBOUND_STATUSES would agree with whatever the constant says.
const CONTRACT_STATUSES = ['sending', 'sent', 'delivered']

function contractCounts(direction: string, status: string, reviewState: string | null): boolean {
  return direction === 'inbound' || (reviewState !== 'pending' && CONTRACT_STATUSES.includes(status))
}

/**
 * Comments dropped, lowercased, whitespace collapsed, and no padding inside
 * parentheses, so a fragment matches however the SQL is line-wrapped.
 */
function normalizeSql(sql: string): string {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--[^\n]*/g, ' ')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/\(\s+/g, '(')
    .replace(/\s+\)/g, ')')
    .trim()
}

function readMigration(file: string): string {
  return normalizeSql(readFileSync(join(REPO_ROOT, 'db/migrations', file), 'utf8'))
}

/** Source only: `//` comment lines dropped. */
function readTsSource(file: string): string {
  return readFileSync(join(REPO_ROOT, file), 'utf8')
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('//'))
    .join('\n')
}

function statusLists(sql: string): string[][] {
  return [...sql.matchAll(/\bstatus in \(([^)]*)\)/g)].map((match) =>
    [...match[1]!.matchAll(/'([a-z_]+)'/g)].map((quoted) => quoted[1]!),
  )
}

// The status list in the SQL fragments below, in the constant's order.
const STATUS_IN = `status in (${[...DELIVERED_OUTBOUND_STATUSES].map((s) => `'${s}'`).join(', ')})`

// Every value the constraints permit, read from the migrations that define them
// (as group-responses.test.ts does for statuses), so the truth table below has
// to decide every combination.
const MESSAGE_STATUSES: string[] = (() => {
  const sql = readFileSync(join(REPO_ROOT, 'db/migrations/001_initial_schema.sql'), 'utf-8')
  const table = sql.slice(sql.indexOf('create table messages'))
  const check = table.slice(table.indexOf('check (status in ('))
  return [...check.slice(0, check.indexOf('))')).matchAll(/'([a-z_]+)'/g)].map((m) => m[1]!)
})()

const REVIEW_STATES: Array<string | null> = (() => {
  const sql = readFileSync(join(REPO_ROOT, 'db/migrations/018_operator_review_state.sql'), 'utf-8')
  const check = sql.slice(sql.indexOf('messages_review_state_check'))
  const values = [...check.slice(0, check.indexOf('))')).matchAll(/'([a-z_]+)'/g)].map((m) => m[1]!)
  return [null, ...values]
})()

const M043 = '043_operator_conversations_reached_guest.sql'
const M044 = '044_operator_queue_context_reached_guest.sql'

// Each fragment names the CTE or clause it belongs to. Written with the same
// line breaks as the migration only for readability; normalizeSql flattens both.
const FRAGMENTS_043: Array<[string, string]> = [
  [
    'scoped_messages flags each row with the condition',
    `(m.direction = 'inbound'
      or (m.review_state is distinct from 'pending' and m.${STATUS_IN})) as reached_guest`,
  ],
  ['scoped_messages keeps the non-empty-body filter', `where m.venue_id = any(venue_ids) and m.body <> ''`],
  [
    'guest_reach asks whether the guest has any row that reached them',
    'bool_or(sm.reached_guest) as any_reached from scoped_messages sm group by sm.guest_id, sm.venue_id',
  ],
  [
    'counted_messages keeps reached rows, or every row for a guest nothing reached',
    'from scoped_messages sm join guest_reach gr on gr.guest_id = sm.guest_id and gr.venue_id = sm.venue_id where sm.reached_guest or not gr.any_reached',
  ],
  [
    'last_message reads counted_messages',
    'guest_id, venue_id, direction, body, created_at, reached_guest from counted_messages order by guest_id, venue_id, created_at desc',
  ],
  [
    'conversation_days reads counted_messages',
    'from counted_messages cm join venues v on v.id = cm.venue_id group by cm.guest_id, cm.venue_id',
  ],
  [
    'membership comes from last_message, so no guest leaves the list',
    'from last_message lm join venues v on v.id = lm.venue_id join guests g on g.id = lm.guest_id join conversation_days cd on cd.guest_id = lm.guest_id and cd.venue_id = lm.venue_id',
  ],
  [
    'the preview is blank for a guest nothing reached',
    `case when lm.reached_guest then lm.body else '' end as last_message_body`,
  ],
]

describe('the reached-guest condition (TAC-395)', () => {
  it('DELIVERED_OUTBOUND_STATUSES is the Contract list', () => {
    expect([...DELIVERED_OUTBOUND_STATUSES].sort()).toEqual([...CONTRACT_STATUSES].sort())
  })

  it('agrees with deriveDelivery on every direction, status and review_state', () => {
    expect(MESSAGE_STATUSES.length).toBeGreaterThan(0)
    expect(REVIEW_STATES).toHaveLength(6)
    const disagreements: string[] = []
    for (const direction of ['inbound', 'outbound']) {
      for (const status of MESSAGE_STATUSES) {
        for (const reviewState of REVIEW_STATES) {
          const delivered = deriveDelivery({ direction, status, review_state: reviewState }) === 'delivered'
          if (delivered !== contractCounts(direction, status, reviewState)) {
            disagreements.push(`${direction}/${status}/${reviewState ?? 'null'}`)
          }
        }
      }
    }
    expect(disagreements).toEqual([])
  })

  it.each([M043, M044])('every status list in %s is DELIVERED_OUTBOUND_STATUSES', (file) => {
    const lists = statusLists(readMigration(file))
    expect(lists.length).toBeGreaterThan(0)
    for (const list of lists) {
      expect([...list].sort()).toEqual([...DELIVERED_OUTBOUND_STATUSES].sort())
    }
  })

  describe('migration 043 (conversations list)', () => {
    const sql = readMigration(M043)
    it.each(FRAGMENTS_043)('%s', (_label, fragment) => {
      expect(sql).toContain(normalizeSql(fragment))
    })
  })

  describe('migration 044 (queue recent_context)', () => {
    const sql = readMigration(M044)

    // The whole lateral WHERE, so dropped parentheses, `or` for `and`, or a
    // missing venue or guest scope all fail.
    it('the context subquery filters each row by guest, venue and the condition', () => {
      expect(sql).toContain(
        normalizeSql(`where guest_id = m.guest_id
          and venue_id = m.venue_id
          and id <> m.id
          and (direction = 'inbound'
            or (review_state is distinct from 'pending' and ${STATUS_IN}))
          group by coalesce(generation_id, id)`),
      )
    })

    // 22:08 ruling: recent_context has always returned empty-body entries (a
    // reaction, a photo-only text), and a photo the guest sent is context the
    // operator needs. Any spelling of a body filter here is a behaviour change.
    it('adds no body filter', () => {
      expect(sql).not.toMatch(/body\s*(<>|!=)\s*''|length\((btrim\()?body|body\s+is\s+distinct\s+from\s+''|nullif\(body/)
    })
  })

  it('thread.ts builds its status list from DELIVERED_OUTBOUND_STATUSES, not a literal', () => {
    const source = readTsSource('lib/operator/thread.ts')
    expect(source).toContain("import { DELIVERED_OUTBOUND_STATUSES } from '@/lib/agent/group-responses'")
    expect(source).toContain('...DELIVERED_OUTBOUND_STATUSES')
    for (const status of CONTRACT_STATUSES) {
      expect(source).not.toMatch(new RegExp(`\\b${status}\\b`))
    }
  })
})
