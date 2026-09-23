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
// Migrations are append-only, so the migration that DEFINES each function is
// the highest-numbered one that creates it. This test DERIVES that rather than
// naming it, and the reason is a failure this file already had.
//
// It used to pin each file by name, with a header telling the next person to
// repoint it. Migration 056 (TAC-473) then recreated BOTH functions and
// repointed NEITHER, so from that day the queue half validated 054's frozen
// text and the conversations half validated 043's, while both live bodies went
// unchecked. Harmless only by luck, since 056 restates both clauses correctly.
// Found by TAC-534's audit. A header is not a mechanism: deriving the target
// makes the next migration fail, where a header only works if it is read.
//
// The assertions are scoped to one FUNCTION's text, not to the whole migration
// file, because a migration may define several. 056 defines both, and
// list_operator_conversations legitimately carries `m.body <> ''` — which
// would make a whole-file "no body filter" check fail for the queue. The old
// pin only worked because 054 happened to hold a single function.

import { readdirSync, readFileSync } from 'node:fs'
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
function stripComments(sql: string): string {
  return sql.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ')
}

function normalizeSql(sql: string): string {
  return stripComments(sql)
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/\(\s+/g, '(')
    .replace(/\s+\)/g, ')')
    .trim()
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

const MIGRATIONS_DIR = join(REPO_ROOT, 'db/migrations')

function createsFunction(sql: string, fnName: string): boolean {
  return new RegExp(`create\\s+(or\\s+replace\\s+)?function\\s+public\\.${fnName}\\b`, 'i').test(
    stripComments(sql),
  )
}

/**
 * The migration that currently DEFINES `fnName`: the highest-numbered one that
 * creates it. Derived, never pinned — see the header for what pinning cost.
 * Throws rather than returning nothing, so renaming the function fails here
 * instead of silently leaving every assertion below with nothing to check.
 */
function currentDefiner(fnName: string): string {
  const definers = readdirSync(MIGRATIONS_DIR)
    .filter((file) => /^\d+_.*\.sql$/.test(file))
    .filter((file) => createsFunction(readFileSync(join(MIGRATIONS_DIR, file), 'utf8'), fnName))
    .sort((a, b) => Number.parseInt(a, 10) - Number.parseInt(b, 10))
  const latest = definers.at(-1)
  if (latest === undefined) {
    throw new Error(`no migration creates public.${fnName} — renamed, or the scan is broken`)
  }
  return latest
}

/**
 * One function's definition out of a migration, `create function` to the
 * closing `$function$;`, normalized. Comments are stripped BEFORE the search so
 * a mention inside a rollback comment cannot be mistaken for the definition.
 */
function functionText(file: string, fnName: string): string {
  const sql = stripComments(readFileSync(join(MIGRATIONS_DIR, file), 'utf8'))
  const start = sql.search(new RegExp(`create\\s+(or\\s+replace\\s+)?function\\s+public\\.${fnName}\\b`, 'i'))
  if (start === -1) throw new Error(`${file} does not create public.${fnName}`)
  const end = sql.indexOf('$function$;', start)
  if (end === -1) throw new Error(`${file}: public.${fnName} never closes with $function$;`)
  return normalizeSql(sql.slice(start, end + '$function$;'.length))
}

const CONVERSATIONS_MIGRATION = currentDefiner('list_operator_conversations')
const QUEUE_MIGRATION = currentDefiner('list_operator_queue')

const CONVERSATIONS_SQL = functionText(CONVERSATIONS_MIGRATION, 'list_operator_conversations')
const QUEUE_SQL = functionText(QUEUE_MIGRATION, 'list_operator_queue')

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

  it.each([
    ['list_operator_conversations', CONVERSATIONS_SQL],
    ['list_operator_queue', QUEUE_SQL],
  ])('every status list in %s is DELIVERED_OUTBOUND_STATUSES', (_fn, sql) => {
    const lists = statusLists(sql)
    expect(lists.length).toBeGreaterThan(0)
    for (const list of lists) {
      expect([...list].sort()).toEqual([...DELIVERED_OUTBOUND_STATUSES].sort())
    }
  })

  describe('list_operator_conversations (the conversations list)', () => {
    const sql = CONVERSATIONS_SQL
    it.each(FRAGMENTS_043)('%s', (_label, fragment) => {
      expect(sql).toContain(normalizeSql(fragment))
    })
  })

  describe('list_operator_queue (the card context)', () => {
    const sql = QUEUE_SQL

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

  // Guard the guard (TAC-534). Every assertion above reads text this file
  // located for itself, so a derivation that quietly found the wrong thing —
  // or nothing — would leave them all vacuously green. That is the failure
  // mode the pinned version actually shipped for two migrations.
  describe('the derivation is not vacuous', () => {
    it('resolves each function to a real, numbered migration', () => {
      expect(QUEUE_MIGRATION).toMatch(/^\d+_.*\.sql$/)
      expect(CONVERSATIONS_MIGRATION).toMatch(/^\d+_.*\.sql$/)
    })

    it('picks the LAST migration that creates each function, not the first', () => {
      const definers = (fn: string) =>
        readdirSync(MIGRATIONS_DIR)
          .filter((file) => /^\d+_.*\.sql$/.test(file))
          .filter((file) => createsFunction(readFileSync(join(MIGRATIONS_DIR, file), 'utf8'), fn))
      // Both functions have been recreated several times, so "the last one" is
      // a real choice here rather than a list of one that happens to be right.
      const queue = definers('list_operator_queue')
      const conversations = definers('list_operator_conversations')
      expect(queue.length).toBeGreaterThan(1)
      expect(conversations.length).toBeGreaterThan(1)
      expect(QUEUE_MIGRATION).toBe(queue.at(-1))
      expect(CONVERSATIONS_MIGRATION).toBe(conversations.at(-1))
    })

    it('extracts ONE function, not the whole migration file', () => {
      expect(QUEUE_SQL).toContain('create function public.list_operator_queue')
      expect(CONVERSATIONS_SQL).toContain('create function public.list_operator_conversations')
      // 056 defines both. An extraction that returned the file would carry the
      // other function's create statement, so this bites on the real data.
      expect(QUEUE_SQL).not.toContain('create function public.list_operator_conversations')
      expect(CONVERSATIONS_SQL).not.toContain('create function public.list_operator_queue')
    })

    // The case that forced the scoping, asserted against the live files rather
    // than described in a comment: the conversations function carries the very
    // filter the queue function must never have. Checked whole-file, "adds no
    // body filter" fails the moment one migration defines both — which is
    // exactly what 056 does.
    it('separates the body filter the two functions disagree about', () => {
      expect(CONVERSATIONS_SQL).toMatch(/body <> ''/)
      expect(QUEUE_SQL).not.toMatch(/body <> ''/)
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
