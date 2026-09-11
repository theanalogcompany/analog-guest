import { describe, expect, it } from 'vitest'
import {
  assignSampleIds,
  normalizeName,
  parseFixtureCategoryOrder,
  type RawScenario,
  validateUniversalCategories,
} from './extract-test-scenarios'

const baseScenario = (overrides: Partial<RawScenario> = {}): RawScenario => ({
  category: 'greeting',
  guest_state: 'new',
  scenario: 'test scenario',
  inbound_message: 'hi',
  expected_failure: null,
  ...overrides,
})

describe('normalizeName', () => {
  it('maps mixed-case multi-word to snake_case', () => {
    expect(normalizeName('Couch Hold for Regulars')).toBe('couch_hold_for_regulars')
  })

  it('passes already-lowercase snake_case through unchanged', () => {
    expect(normalizeName('menu_fact')).toBe('menu_fact')
  })

  it('collapses runs of spaces and punctuation into a single underscore', () => {
    expect(normalizeName('busy   /  wait times')).toBe('busy_wait_times')
    expect(normalizeName('event / mechanic-specific')).toBe('event_mechanic_specific')
  })

  it('trims leading and trailing non-alphanumerics', () => {
    expect(normalizeName('  -hello-  ')).toBe('hello')
    expect(normalizeName('___out of scope___')).toBe('out_of_scope')
  })

  it('strips straight ASCII apostrophes (no orphan letter)', () => {
    expect(normalizeName("Friend's First Drink")).toBe('friends_first_drink')
  })

  it('strips curly apostrophes (U+2019)', () => {
    expect(normalizeName('Phoebe’s')).toBe('phoebes')
  })

  it('handles apostrophes alongside em-dashes and multiple words', () => {
    expect(normalizeName("Phoebe's Open Mic — Regular Slot Priority")).toBe(
      'phoebes_open_mic_regular_slot_priority',
    )
  })

  it('collapses parens without leaving orphan underscores', () => {
    expect(normalizeName('Test (Welcome Back)')).toBe('test_welcome_back')
  })
})

describe('parseFixtureCategoryOrder', () => {
  it('returns category names in fixture order, snake-cased', () => {
    const md = `
### Category 1: greeting
### Category 2: hours
### Category 3: menu fact
### Category 4: out of scope
`
    expect(parseFixtureCategoryOrder(md)).toEqual([
      'greeting',
      'hours',
      'menu_fact',
      'out_of_scope',
    ])
  })

  it('returns an empty array when no category headers are present', () => {
    expect(parseFixtureCategoryOrder('# nothing here')).toEqual([])
  })
})

describe('validateUniversalCategories', () => {
  const valid = new Set(['greeting', 'hours', 'menu_fact'])

  it('passes when every scenario uses a known category', () => {
    expect(() =>
      validateUniversalCategories({
        scenarios: [baseScenario({ category: 'greeting' }), baseScenario({ category: 'hours' })],
        validCategories: valid,
      }),
    ).not.toThrow()
  })

  it('throws with the unknown category name and the valid set', () => {
    try {
      validateUniversalCategories({
        scenarios: [baseScenario({ category: 'made_up' })],
        validCategories: valid,
      })
      throw new Error('expected throw')
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      expect(msg).toContain('unknown universal category "made_up"')
      expect(msg).toContain('greeting')
      expect(msg).toContain('hours')
      expect(msg).toContain('menu_fact')
    }
  })
})

describe('assignSampleIds', () => {
  const order = ['greeting', 'hours', 'menu_fact']

  it('produces zero-padded {slug}-NNN ids in sorted order', () => {
    const scenarios = [
      baseScenario({ category: 'menu_fact', inbound_message: 'do you have iced tea?' }),
      baseScenario({ category: 'greeting', inbound_message: 'hi' }),
      baseScenario({ category: 'hours', inbound_message: 'are you open?' }),
    ]
    const out = assignSampleIds(scenarios, 'mock-cp', order)
    expect(out.map((s) => s.sample_id)).toEqual(['mock-cp-001', 'mock-cp-002', 'mock-cp-003'])
    // Sorted by fixture-category index. category is prefixed behavior_ per
    // the unified Scenario shape (scenario-schema.ts).
    expect(out.map((s) => s.category)).toEqual(['behavior_greeting', 'behavior_hours', 'behavior_menu_fact'])
  })

  it('is idempotent — the same input twice produces the same output mapping', () => {
    const scenarios = [
      baseScenario({ category: 'menu_fact', inbound_message: 'tea?' }),
      baseScenario({ category: 'greeting', inbound_message: 'hi' }),
      baseScenario({ category: 'hours', inbound_message: 'open?' }),
    ]
    const a = assignSampleIds(scenarios, 'foo', order)
    // Reverse the input to prove sort stability is what's driving determinism.
    const b = assignSampleIds(scenarios.slice().reverse(), 'foo', order)
    expect(a).toEqual(b)
  })

  it('stamps the unified Scenario fixed fields (behavior source, unknown route)', () => {
    const out = assignSampleIds([baseScenario()], 'foo', order)
    expect(out[0]).toMatchObject({
      scenario_source: 'behavior',
      expected_facts: [],
      forbidden_claims: [],
      source_row_ids: [],
      expected_route: 'unknown',
    })
  })

  it('sorts within a category by inbound_message lexicographically', () => {
    const scenarios = [
      baseScenario({ category: 'greeting', inbound_message: 'sup' }),
      baseScenario({ category: 'greeting', inbound_message: 'hi' }),
      baseScenario({ category: 'greeting', inbound_message: 'hey' }),
    ]
    const out = assignSampleIds(scenarios, 'foo', order)
    expect(out.map((s) => s.inbound_message)).toEqual(['hey', 'hi', 'sup'])
  })

  it('orders states within a category by GUEST_STATES order, not alphabetical', () => {
    const scenarios = [
      baseScenario({ category: 'greeting', guest_state: 'regular', inbound_message: 'a' }),
      baseScenario({ category: 'greeting', guest_state: 'new', inbound_message: 'a' }),
      baseScenario({ category: 'greeting', guest_state: 'returning', inbound_message: 'a' }),
    ]
    const out = assignSampleIds(scenarios, 'foo', order)
    expect(out.map((s) => s.guest_state)).toEqual(['new', 'returning', 'regular'])
  })
})
