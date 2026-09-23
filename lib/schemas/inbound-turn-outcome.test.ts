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
 * TAC-523: bind the TS vocabulary to migration 055's CHECK constraints.
 *
 * The constants and the CHECKs are two statements of one list. If they drift,
 * the writer's inserts fail in production and nothing here fails first — the
 * table exists precisely because that class of silence is expensive.
 *
 * Migrations are append-only, so this reads 055 BY NAME. A later migration
 * that replaces any of these constraints has to update this test itself;
 * that is the same limitation `pending-slots.test.ts` records for 041 and
 * `reached-guest-condition.test.ts` for 043/044.
 */

const MIGRATION = readFileSync(
  join(__dirname, '..', '..', 'db', 'migrations', '055_inbound_turn_outcomes.sql'),
  'utf8',
)

/**
 * SQL line comments are stripped FIRST and that is load-bearing, not tidiness:
 * the comments inside these CHECK lists quote values (`-- layer 'webhook'`),
 * so extracting quoted strings from the raw text would pick up words that are
 * not in the constraint at all.
 */
const SQL_WITHOUT_COMMENTS = MIGRATION.split('\n')
  .map((line) => line.replace(/--.*$/, ''))
  .join('\n')

function checkListFor(column: string): string[] {
  const opener = `check (${column} in (`
  const start = SQL_WITHOUT_COMMENTS.indexOf(opener)
  if (start === -1) throw new Error(`no CHECK list found for column ${column}`)
  const body = SQL_WITHOUT_COMMENTS.slice(start + opener.length)
  const end = body.indexOf('))')
  if (end === -1) throw new Error(`unterminated CHECK list for column ${column}`)
  return [...body.slice(0, end).matchAll(/'([^']*)'/g)].map((m) => m[1])
}

describe('migration 055 CHECK constraints match the TS vocabulary', () => {
  it('guards itself: the migration is readable and the extractor finds values', () => {
    // Without this, a rename or a failed read would make every assertion below
    // pass vacuously against empty arrays.
    expect(MIGRATION.length).toBeGreaterThan(0)
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
