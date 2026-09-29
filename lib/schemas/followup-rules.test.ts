import { describe, expect, it } from 'vitest'
import {
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
      expect(FOLLOWUP_RULES_DEFAULT[key as keyof typeof FOLLOWUP_RULES_DEFAULT], key).toEqual(value)
    }
  })

  it('adds exactly the post-028 keys, and no others, by accident', () => {
    // The exact key set, so a twelfth key cannot arrive silently. TAC-560's
    // `warm_close_pause_minutes` is the only one so far.
    expect(Object.keys(FOLLOWUP_RULES_DEFAULT).sort()).toEqual(
      [...Object.keys(MIGRATION_028_LITERAL), 'warm_close_pause_minutes'].sort(),
    )
    expect(FOLLOWUP_RULES_DEFAULT.warm_close_pause_minutes).toBe(10)
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
