import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'
import {
  FOLLOWUP_LOG_REASONS,
  FOLLOWUP_REASONS,
  FOLLOWUP_RULES_DEFAULT,
  FollowupRulesSchema,
  parseFollowupRules,
} from './followup-rules'

// The eleven values migration 028's jsonb_build_object backfilled into every
// existing venue_configs row. Frozen: a later default belongs beside this, not
// inside it. See the assertion below.
const MIGRATION_028_LITERAL = {
  post_visit_enabled: true,
  cold_lapsed_enabled: true,
  perk_unlock_enabled: true,
  absence_window_days: 21,
  lapsed_eligible_states: ['regular', 'raving_fan'],
  cold_dedup_days: 30,
  weekly_cap: 1,
  recent_conversation_hours: 48,
  quiet_hours_start_local: '21:00',
  quiet_hours_end_local: '08:00',
  cron_hour_local: 10,
} as const

describe('FOLLOWUP_RULES_DEFAULT', () => {
  it('round-trips through the Zod schema unchanged', () => {
    // Source-of-truth invariant: the constant the migration backfill
    // mirrors MUST be parseable by the runtime schema. If a defaults
    // diff slips between the constant and the schema, this catches it.
    const parsed = FollowupRulesSchema.parse(FOLLOWUP_RULES_DEFAULT)
    expect(parsed).toEqual(FOLLOWUP_RULES_DEFAULT)
  })

  it('matches the literal jsonb_build_object written by migration 028', () => {
    // This is the cross-check against db/migrations/028. Update both in
    // lockstep if any default changes.
    //
    // TAC-560 split this in two rather than adding a key to the object above.
    // `warm_close_pause_minutes` POSTDATES migration 028, so it is not in that
    // backfill literal and never will be: rows written before it existed do not
    // carry it and take the Zod default. Folding it into this assertion would
    // have quietly redefined what the test's own name claims — that these are
    // the values 028 wrote — and the guard's real property is that those eleven
    // are unchanged.
    //
    // A key added to FOLLOWUP_RULES_DEFAULT now fails the exact-key-set
    // assertion below until someone states which side of the 028 line it falls
    // on, which is the decision worth forcing.
    expect(MIGRATION_028_LITERAL).toEqual({
      post_visit_enabled: true,
      cold_lapsed_enabled: true,
      perk_unlock_enabled: true,
      absence_window_days: 21,
      lapsed_eligible_states: ['regular', 'raving_fan'],
      cold_dedup_days: 30,
      weekly_cap: 1,
      recent_conversation_hours: 48,
      quiet_hours_start_local: '21:00',
      quiet_hours_end_local: '08:00',
      cron_hour_local: 10,
    })
    for (const [key, value] of Object.entries(MIGRATION_028_LITERAL)) {
      expect(
        FOLLOWUP_RULES_DEFAULT[key as keyof typeof FOLLOWUP_RULES_DEFAULT],
        key,
      ).toEqual(value)
    }
  })

  it('adds exactly the post-028 keys, and no others, by accident', () => {
    // The exact key set, so a twelfth key cannot arrive silently. TAC-560's
    // `warm_close_pause_minutes` (TAC-560) and `inquiry_followup_enabled`
    // (TAC-386) are the two so far. This assertion is what forced each of them
    // to be declared post-028 deliberately rather than folded into the backfill
    // literal, which is the whole reason it is written as an exact key set.
    expect(Object.keys(FOLLOWUP_RULES_DEFAULT).sort()).toEqual(
      [
        ...Object.keys(MIGRATION_028_LITERAL),
        'warm_close_pause_minutes',
        'inquiry_followup_enabled',
      ].sort(),
    )
    expect(FOLLOWUP_RULES_DEFAULT.warm_close_pause_minutes).toBe(10)
    // TAC-386: on by default, so the mechanism is live at a venue nobody has
    // configured. The kill switch is for turning it OFF.
    expect(FOLLOWUP_RULES_DEFAULT.inquiry_followup_enabled).toBe(true)
  })
})

describe('FollowupRulesSchema', () => {
  it('rejects malformed HH:MM strings', () => {
    expect(
      FollowupRulesSchema.safeParse({
        ...FOLLOWUP_RULES_DEFAULT,
        quiet_hours_start_local: '9:30',
      }).success,
    ).toBe(false)
    expect(
      FollowupRulesSchema.safeParse({
        ...FOLLOWUP_RULES_DEFAULT,
        quiet_hours_end_local: '24:00',
      }).success,
    ).toBe(false)
  })

  it('accepts well-formed HH:MM strings at the day boundaries', () => {
    expect(
      FollowupRulesSchema.parse({
        ...FOLLOWUP_RULES_DEFAULT,
        quiet_hours_start_local: '00:00',
        quiet_hours_end_local: '23:59',
      }).quiet_hours_start_local,
    ).toBe('00:00')
  })

  it('rejects out-of-range cron_hour_local', () => {
    expect(
      FollowupRulesSchema.safeParse({
        ...FOLLOWUP_RULES_DEFAULT,
        cron_hour_local: -1,
      }).success,
    ).toBe(false)
    expect(
      FollowupRulesSchema.safeParse({
        ...FOLLOWUP_RULES_DEFAULT,
        cron_hour_local: 24,
      }).success,
    ).toBe(false)
  })

  it('rejects non-positive weekly_cap', () => {
    expect(
      FollowupRulesSchema.safeParse({
        ...FOLLOWUP_RULES_DEFAULT,
        weekly_cap: 0,
      }).success,
    ).toBe(false)
  })

  it('rejects invalid lapsed_eligible_states', () => {
    expect(
      FollowupRulesSchema.safeParse({
        ...FOLLOWUP_RULES_DEFAULT,
        // 'lapsed' is not a recognized GuestState.
        lapsed_eligible_states: ['lapsed'],
      }).success,
    ).toBe(false)
  })

  it('fills defaults on missing fields', () => {
    // Defaults exercise — passing an empty object still parses because every
    // field has a default. Mirrors the "fresh venue, row predates migration
    // backfill" path that parseFollowupRules guards against.
    const parsed = FollowupRulesSchema.parse({})
    expect(parsed).toEqual(FOLLOWUP_RULES_DEFAULT)
  })
})

describe('parseFollowupRules', () => {
  it('returns defaults on null', () => {
    expect(parseFollowupRules(null)).toEqual(FOLLOWUP_RULES_DEFAULT)
  })

  it('returns defaults on undefined', () => {
    expect(parseFollowupRules(undefined)).toEqual(FOLLOWUP_RULES_DEFAULT)
  })

  it('returns defaults on malformed payload (fail-OPEN with warn)', () => {
    // Malformed jsonb (e.g. a string in cron_hour_local) drops to defaults
    // rather than crashing the engine — same fail-open posture as
    // filterActiveLifeContext / venue_info malformed entries.
    const warn = console.warn
    console.warn = () => {}
    try {
      expect(
        parseFollowupRules({
          ...FOLLOWUP_RULES_DEFAULT,
          cron_hour_local: 'noon',
        }),
      ).toEqual(FOLLOWUP_RULES_DEFAULT)
    } finally {
      console.warn = warn
    }
  })

  it('returns the parsed shape on a valid payload', () => {
    const overridden = { ...FOLLOWUP_RULES_DEFAULT, weekly_cap: 3 }
    expect(parseFollowupRules(overridden).weekly_cap).toBe(3)
  })
})

describe('FOLLOWUP_REASONS', () => {
  it('matches the migration 029 CHECK constraint values', () => {
    // The CHECK constraint in 029_create_followup_log.sql enumerates the
    // same six reasons. Drift between them = a migration applied with stale
    // reason values would silently allow rows the schema rejects.
    expect([...FOLLOWUP_REASONS]).toEqual([
      'post_visit_day_1',
      'post_visit_day_3',
      'post_visit_day_7',
      'post_visit_day_14',
      'cold_lapsed',
      'perk_unlock',
    ])
  })
})

// TAC-386: FOLLOWUP_LOG_REASONS and migration 066's CHECK list are two
// statements of the same set, in two languages, and nothing in the type system
// connects them. So the test reads the migration and compares, rather than a
// comment asking the next person to remember.
//
// This is the same posture as the MIGRATION_028_LITERAL cross-check above, with
// one difference that matters: this one parses the real file, so it fails if the
// SQL changes, where 028's is a transcription that would not.
describe('FOLLOWUP_LOG_REASONS matches the followup_log CHECK (TAC-386)', () => {
  const migration = readFileSync(
    join(
      __dirname,
      '..',
      '..',
      'db',
      'migrations',
      '066_inquiry_followups.sql',
    ),
    'utf8',
  )

  /** The reason list out of the `add constraint ... check (reason in (...))`. */
  function reasonsInMigration(): string[] {
    const block = migration.match(
      /add constraint followup_log_reason_check\s*\n\s*check \(reason in \(([\s\S]*?)\)\)/,
    )
    expect(
      block,
      'the CHECK block should be findable in migration 066',
    ).toBeTruthy()
    return Array.from((block?.[1] ?? '').matchAll(/'([a-z_0-9]+)'/g)).map(
      (m) => m[1],
    )
  }

  it('finds the CHECK block at all', () => {
    // Guards the guard: a regex that stopped matching would make every
    // assertion below vacuously pass against an empty list.
    expect(reasonsInMigration().length).toBeGreaterThan(1)
  })

  it('lists exactly the same reasons, in the same order', () => {
    expect(reasonsInMigration()).toEqual([...FOLLOWUP_LOG_REASONS])
  })

  it('is a strict superset of what the engine detects', () => {
    // The distinction the two constants exist to hold. If these ever became
    // equal, the four exhaustive switches over EngineFollowupReason would have
    // silently acquired a branch they have nothing to say about.
    for (const reason of FOLLOWUP_REASONS) {
      expect(FOLLOWUP_LOG_REASONS).toContain(reason)
    }
    expect(FOLLOWUP_LOG_REASONS.length).toBeGreaterThan(FOLLOWUP_REASONS.length)
    expect(FOLLOWUP_REASONS as readonly string[]).not.toContain(
      'inquiry_followup',
    )
  })
})
