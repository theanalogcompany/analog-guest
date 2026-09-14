import { afterEach, describe, expect, it, vi } from 'vitest'
import { INTENTION_RULES_DEFAULT, IntentionRulesSchema, parseIntentionRules } from './intention-rules'

afterEach(() => {
  vi.restoreAllMocks()
})

describe('INTENTION_RULES_DEFAULT', () => {
  // Placeholders, not calibrations — pinned so moving one is a deliberate,
  // visible change rather than a drive-by.
  it('pins the placeholder defaults', () => {
    expect(INTENTION_RULES_DEFAULT).toEqual({
      response_rate_floor: 50,
      unanswered_streak: 2,
      min_replies: {},
    })
  })

  it('matches what the schema produces from an empty object', () => {
    expect(IntentionRulesSchema.parse({})).toEqual(INTENTION_RULES_DEFAULT)
  })
})

describe('parseIntentionRules', () => {
  // venue_configs.intention_rules is NULL for every venue until someone writes
  // one. That must mean "defaults", never a crash.
  it('returns the defaults for null and undefined', () => {
    expect(parseIntentionRules(null)).toEqual(INTENTION_RULES_DEFAULT)
    expect(parseIntentionRules(undefined)).toEqual(INTENTION_RULES_DEFAULT)
  })

  it('fills missing fields from the defaults', () => {
    expect(parseIntentionRules({ response_rate_floor: 70 })).toEqual({
      ...INTENTION_RULES_DEFAULT,
      response_rate_floor: 70,
    })
  })

  it('keeps per-intention min_replies overrides', () => {
    expect(parseIntentionRules({ min_replies: { learn_name: 6 } }).min_replies).toEqual({ learn_name: 6 })
  })

  // Loose keys at the live boundary: a retired intention key left in a stored
  // row must not fail the whole parse and drop the venue's other settings.
  it('tolerates a min_replies key that matches no intention', () => {
    expect(
      parseIntentionRules({ response_rate_floor: 60, min_replies: { invite_contact_save: 2 } }),
    ).toEqual({ ...INTENTION_RULES_DEFAULT, response_rate_floor: 60, min_replies: { invite_contact_save: 2 } })
  })

  it.each([
    ['a floor above 100', { response_rate_floor: 150 }],
    ['a negative floor', { response_rate_floor: -1 }],
    ['a zero streak', { unanswered_streak: 0 }],
    ['a fractional reply count', { min_replies: { learn_name: 2.5 } }],
    ['a non-object', 'nope'],
  ])('falls back to the defaults, with a warning, on %s', (_label, value) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(parseIntentionRules(value)).toEqual(INTENTION_RULES_DEFAULT)
    expect(warn).toHaveBeenCalled()
  })
})
