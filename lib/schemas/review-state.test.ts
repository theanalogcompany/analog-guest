// TAC-473: the TS constant and migration 056's CHECK must agree.
//
// SQL cannot import the constant, so this reads the migration and binds the
// two — the technique `pending-slots.test.ts` uses on migration 054's index and
// `reached-guest-condition.test.ts` uses on migrations 043/044.
//
// Migrations are append-only, so this reads 056 BY NAME. A later migration that
// replaces `messages_review_state_check` has to update this test itself, which
// is the same caveat TAC-318's SQL/JS mirror test carries.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { RESOLVED_EXTERNALLY_REVIEW_STATE } from './review-state'

const MIGRATION = readFileSync(
  join(__dirname, '..', '..', 'db', 'migrations', '056_operator_instagram_fields.sql'),
  'utf8',
)

/** The CHECK this migration CREATES, not the one its rollback comment restores. */
function createdCheckValues(): string[] {
  // The rollback block is commented out, so take the last `add constraint`
  // that is NOT inside a comment.
  const statements = MIGRATION.split('\n')
    .filter((l) => !l.trimStart().startsWith('--'))
    .join('\n')
  const match = statements.match(
    /add constraint messages_review_state_check\s+check \(review_state is null or review_state in \(([^)]*)\)\)/,
  )
  if (!match) throw new Error('migration 056 no longer creates messages_review_state_check')
  return [...match[1]!.matchAll(/'([^']+)'/g)].map((m) => m[1]!)
}

describe('RESOLVED_EXTERNALLY_REVIEW_STATE', () => {
  it('is a value migration 056 actually permits', () => {
    // The only thing that can reject a wrong value is the CHECK. A constant
    // that disagrees with it writes a row Postgres refuses, on the live
    // webhook path, where the failure is a caught error and a lost resolution.
    expect(createdCheckValues()).toContain(RESOLVED_EXTERNALLY_REVIEW_STATE)
  })

  it('is NOT one of migration 018 five original values', () => {
    // It has to be a NEW value: reusing 'skipped' would record a verdict
    // nobody gave, which is the whole reason the CHECK was widened.
    expect(['pending', 'approved', 'edited', 'skipped', 'auto_sent']).not.toContain(
      RESOLVED_EXTERNALLY_REVIEW_STATE,
    )
  })

  it('leaves all five original values permitted, so the widening is additive', () => {
    // A CHECK recreate that dropped one would fail every existing row's
    // state on the next write to it.
    const values = createdCheckValues()
    for (const original of ['pending', 'approved', 'edited', 'skipped', 'auto_sent']) {
      expect(values, original).toContain(original)
    }
    expect(values).toHaveLength(6)
  })

  // Guards the guard: a parse that found nothing would pass the checks above
  // against any constant at all.
  it('actually parsed the migration', () => {
    expect(MIGRATION.length).toBeGreaterThan(1000)
    expect(createdCheckValues().length).toBeGreaterThan(0)
  })
})
