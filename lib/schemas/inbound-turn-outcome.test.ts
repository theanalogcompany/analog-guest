import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { MESSAGE_CHANNELS } from './message-channel'
import {
  INBOUND_TURN_LAYERS,
  INBOUND_TURN_OUTCOMES,
  INBOUND_TURN_REASONS,
} from './inbound-turn-outcome'

/**
 * TAC-523: bind the TS vocabulary to the CHECK constraints that are LIVE.
 *
 * The constants and the CHECKs are two statements of one list. If they drift,
 * the writer's inserts fail in production and nothing here fails first — the
 * table exists precisely because that class of silence is expensive.
 *
 * TWO MIGRATIONS NOW, and which one owns which column is the point. Migrations
 * are append-only, and widening a CHECK means dropping and recreating it, so
 * TAC-526's migration 057 now owns `reason` while 055 still owns `outcome`,
 * `layer` and `channel`. Reading 055 for `reason` would bind the constants to
 * a constraint the database no longer has — green here, failing inserts in
 * production, which is the exact silence this table exists to remove.
 *
 * A later migration that replaces any of these has to update this test itself;
 * that is the same limitation `pending-slots.test.ts` records for 041 and
 * `reached-guest-condition.test.ts` for 043/044.
 */

const MIGRATION = readFileSync(
  join(__dirname, '..', '..', 'db', 'migrations', '055_inbound_turn_outcomes.sql'),
  'utf8',
)

/**
 * The `reason` CHECK has been dropped and recreated three times: TAC-526's
 * 057, TAC-529's 059, and TAC-536's 064, which is the live one. Migrations are
 * append-only, so this points at a migration BY NAME and the next one to widen
 * this CHECK has to move it — which is the intended cost, because binding to a
 * superseded migration would silently compare the constants against a narrower
 * list.
 *
 * 059 was itself not 058: TAC-534 took 058 for an unrelated RPC while TAC-529
 * was open, and because the two touch different objects git merged them
 * cleanly into two files numbered 058. This path is one of the few things that
 * fails loudly on that, which is why it is worth keeping by name.
 */
const REASON_MIGRATION = readFileSync(
  join(__dirname, '..', '..', 'db', 'migrations', '064_instagram_scan_arrivals.sql'),
  'utf8',
)

/**
 * SQL line comments are stripped FIRST and that is load-bearing, not tidiness:
 * the comments inside these CHECK lists quote values (`-- layer 'webhook'`),
 * so extracting quoted strings from the raw text would pick up words that are
 * not in the constraint at all.
 */
function stripComments(sql: string): string {
  return sql
    .split('\n')
    .map((line) => line.replace(/--.*$/, ''))
    .join('\n')
}

const SQL_WITHOUT_COMMENTS = stripComments(MIGRATION)

/**
 * 057's rollback is written as a COMMENTED block holding the old, narrower
 * list. Stripping comments first is what keeps it out of the extraction — and
 * is why the guard below asserts the live list contains the new value while
 * the raw file still contains the old one.
 */
const REASON_SQL_WITHOUT_COMMENTS = stripComments(REASON_MIGRATION)

function checkListIn(sql: string, column: string): string[] {
  const opener = `check (${column} in (`
  const start = sql.indexOf(opener)
  if (start === -1) throw new Error(`no CHECK list found for column ${column}`)
  const body = sql.slice(start + opener.length)
  const end = body.indexOf('))')
  if (end === -1) throw new Error(`unterminated CHECK list for column ${column}`)
  return [...body.slice(0, end).matchAll(/'([^']*)'/g)].map((m) => m[1])
}

function checkListFor(column: string): string[] {
  // `reason` moved to 057; everything else is still 055's.
  return column === 'reason'
    ? checkListIn(REASON_SQL_WITHOUT_COMMENTS, column)
    : checkListIn(SQL_WITHOUT_COMMENTS, column)
}

describe('migration 055 CHECK constraints match the TS vocabulary', () => {
  it('guards itself: both migrations are readable and the extractor finds values', () => {
    // Without this, a rename or a failed read would make every assertion below
    // pass vacuously against empty arrays.
    expect(MIGRATION.length).toBeGreaterThan(0)
    expect(REASON_MIGRATION.length).toBeGreaterThan(0)
    expect(checkListFor('outcome').length).toBeGreaterThan(0)
    expect(checkListFor('reason').length).toBeGreaterThan(0)
    expect(checkListFor('layer').length).toBeGreaterThan(0)
    expect(checkListFor('channel').length).toBeGreaterThan(0)
  })

  it('strips SQL comments before extracting, so quoted words in comments are ignored', () => {
    // The raw file contains `-- layer 'webhook', Instagram (TAC-523 PR 1)`
    // INSIDE the reason list. A naive extractor would report 'webhook' as a
    // permitted reason, which it is not.
    expect(MIGRATION).toContain("-- layer 'webhook', Instagram")
    expect(checkListFor('reason')).not.toContain('webhook')
  })

  /**
   * TAC-526. The reason list is read from 057, and 057's ROLLBACK block is a
   * commented copy of the narrower 055 list. If comment-stripping ever stopped
   * running for this file the extractor would find the rollback's list first
   * (it is the second `check (reason in (` in the file, but a future edit
   * could reorder them) and bind the constants to the list this ticket
   * replaced — passing here while every coalesced insert failed in production.
   *
   * So: assert the LIVE list carries the new value, and assert the raw file
   * still carries the old one. Together those say the stripping is doing work.
   */
  it('reads the LIVE reason list from 064, not the rollback block', () => {
    // One of TAC-536's own values, not `venue_paused`: 064's rollback block
    // restores 059's list, which CONTAINS `venue_paused`, so that value no
    // longer discriminates the live list from the rollback one. The newest
    // values are the only ones that appear in the live list alone, and one of
    // them has to be named here with every widening for this assertion to keep
    // working.
    expect(checkListFor('reason')).toContain('already_greeted_today')
    // The rollback block is still in the file, and must not be what we read.
    expect(REASON_MIGRATION).toContain('-- rollback:')
    expect(REASON_SQL_WITHOUT_COMMENTS).not.toContain('rollback')
  })

  it('outcome matches INBOUND_TURN_OUTCOMES exactly, in order', () => {
    expect(checkListFor('outcome')).toEqual([...INBOUND_TURN_OUTCOMES])
  })

  it('reason matches INBOUND_TURN_REASONS exactly, in order', () => {
    expect(checkListFor('reason')).toEqual([...INBOUND_TURN_REASONS])
  })

  it('layer matches INBOUND_TURN_LAYERS exactly, in order', () => {
    expect(checkListFor('layer')).toEqual([...INBOUND_TURN_LAYERS])
  })

  it('channel matches MESSAGE_CHANNELS, so a third channel cannot drift from 048', () => {
    expect(checkListFor('channel')).toEqual([...MESSAGE_CHANNELS])
  })
})

describe('vocabulary shape', () => {
  it('has no duplicate values in any list', () => {
    for (const [name, list] of [
      ['outcomes', INBOUND_TURN_OUTCOMES],
      ['reasons', INBOUND_TURN_REASONS],
      ['layers', INBOUND_TURN_LAYERS],
    ] as const) {
      expect(new Set(list).size, `${name} has a duplicate`).toBe(list.length)
    }
  })

  it('carries the Sendblue reasons PR 2 will write, so PR 2 needs no migration', () => {
    // Listed in 055 deliberately: PR 2 edits a Sendblue webhook handler, which
    // is hard-stop work, and keeping it code-only keeps that PR as small as
    // the rule deserves.
    for (const reason of [
      'venue_number_missing',
      'venue_lookup_failed',
      'venue_not_found',
      'guest_lookup_failed',
      'guest_insert_failed',
      'idempotency_lookup_failed',
      'duplicate_provider_message',
      'empty_inbound_content',
      'message_insert_failed',
    ]) {
      expect(INBOUND_TURN_REASONS).toContain(reason)
    }
  })

  it('records the incident reason, which is the one this ticket was opened for', () => {
    expect(INBOUND_TURN_REASONS).toContain('gate_shut')
  })
})
