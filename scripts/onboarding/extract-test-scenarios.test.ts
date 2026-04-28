import { describe, expect, it } from 'vitest'
import {
  assignSampleIds,
  extractMechanicNames,
  normalizeName,
  parseFixtureCategoryOrder,
  type RawScenario,
  validateMechanicsCategoriesAreReal,
  validateMechanicsCoverage,
  validateUniversalCategories,
} from './extract-test-scenarios'

const baseScenario = (overrides: Partial<RawScenario> = {}): RawScenario => ({
  category: 'greeting',
  guest_state: 'new',
  scenario: 'test scenario',
  inbound_message: 'hi',
  expected_failure: null,
  is_mechanic_derived: false,
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
})

describe('extractMechanicNames', () => {
  it('extracts mechanic names from section 5 headers, normalized', () => {
    const md = `
## 5. mechanics

### Mechanic 1: Couch Hold for Regulars

stuff

### Mechanic 2: First Visit Perk

more stuff
`
    expect(extractMechanicNames(md)).toEqual(
      new Set(['couch_hold_for_regulars', 'first_visit_perk']),
    )
  })

  it('returns an empty Set when no mechanic headers are present', () => {
    const md = `
## 4. venue_info

### staff
- Alice
`
    expect(extractMechanicNames(md)).toEqual(new Set())
  })

  it('deduplicates when the same mechanic name appears twice', () => {
    const md = `
### Mechanic 1: Free Drink
### Mechanic 2: Free Drink
`
    const result = extractMechanicNames(md)
    expect(result.size).toBe(1)
    expect(result.has('free_drink')).toBe(true)
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

  it('passes when every universal scenario uses a known category', () => {
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

  it('ignores mechanic-derived scenarios', () => {
    expect(() =>
      validateUniversalCategories({
        scenarios: [
          baseScenario({ category: 'mechanic_anything', is_mechanic_derived: true }),
        ],
        validCategories: valid,
      }),
    ).not.toThrow()
  })
})

describe('validateMechanicsCoverage (forward)', () => {
  it('passes when every expected mechanic has at least one scenario', () => {
    expect(() =>
      validateMechanicsCoverage({
        scenarios: [
          baseScenario({ category: 'mechanic_couch_hold', is_mechanic_derived: true }),
          baseScenario({ category: 'mechanic_free_drink', is_mechanic_derived: true }),
        ],
        expectedMechanics: new Set(['couch_hold', 'free_drink']),
      }),
    ).not.toThrow()
  })

  it('throws with the missing mechanic names when one is uncovered', () => {
    try {
      validateMechanicsCoverage({
        scenarios: [
          baseScenario({ category: 'mechanic_couch_hold', is_mechanic_derived: true }),
        ],
        expectedMechanics: new Set(['couch_hold', 'free_drink']),
      })
      throw new Error('expected throw')
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      expect(msg).toContain('mechanics coverage validation failed')
      expect(msg).toContain('free_drink')
    }
  })

  it('passes trivially when expected set is empty', () => {
    expect(() =>
      validateMechanicsCoverage({
        scenarios: [baseScenario({ category: 'greeting' })],
        expectedMechanics: new Set(),
      }),
    ).not.toThrow()
  })
})

describe('validateMechanicsCategoriesAreReal (reverse)', () => {
  it('passes when every derived category is in the expected set', () => {
    expect(() =>
      validateMechanicsCategoriesAreReal({
        scenarios: [
          baseScenario({ category: 'mechanic_couch_hold', is_mechanic_derived: true }),
        ],
        expectedMechanics: new Set(['couch_hold']),
      }),
    ).not.toThrow()
  })

  it('throws with the bad category and the valid mechanic set', () => {
    try {
      validateMechanicsCategoriesAreReal({
        scenarios: [
          baseScenario({ category: 'mechanic_secret_menu', is_mechanic_derived: true }),
        ],
        expectedMechanics: new Set(['couch_hold', 'free_drink']),
      })
      throw new Error('expected throw')
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      expect(msg).toContain('unknown mechanic category "mechanic_secret_menu"')
      expect(msg).toContain('couch_hold')
      expect(msg).toContain('free_drink')
    }
  })

  it('throws when is_mechanic_derived is true but category lacks the mechanic_ prefix', () => {
    expect(() =>
      validateMechanicsCategoriesAreReal({
        scenarios: [
          baseScenario({ category: 'greeting', is_mechanic_derived: true }),
        ],
        expectedMechanics: new Set(['couch_hold']),
      }),
    ).toThrow(/unknown mechanic category "greeting"/)
  })

  it('passes trivially when there are zero is_mechanic_derived scenarios', () => {
    expect(() =>
      validateMechanicsCategoriesAreReal({
        scenarios: [baseScenario({ category: 'greeting' })],
        expectedMechanics: new Set(),
      }),
    ).not.toThrow()
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
    // Sorted by fixture-category index.
    expect(out.map((s) => s.category)).toEqual(['greeting', 'hours', 'menu_fact'])
  })

  it('is idempotent — the same input twice produces the same output mapping', () => {
    const scenarios = [
      baseScenario({ category: 'menu_fact', inbound_message: 'tea?' }),
      baseScenario({ category: 'greeting', inbound_message: 'hi' }),
      baseScenario({
        category: 'mechanic_couch_hold',
        is_mechanic_derived: true,
        inbound_message: 'save me a couch',
      }),
    ]
    const a = assignSampleIds(scenarios, 'foo', order)
    // Reverse the input to prove sort stability is what's driving determinism.
    const b = assignSampleIds(scenarios.slice().reverse(), 'foo', order)
    expect(a).toEqual(b)
  })

  it('places mechanic-derived scenarios after universal ones', () => {
    const scenarios = [
      baseScenario({
        category: 'mechanic_couch_hold',
        is_mechanic_derived: true,
        inbound_message: 'save me a couch',
      }),
      baseScenario({ category: 'greeting', inbound_message: 'hi' }),
    ]
    const out = assignSampleIds(scenarios, 'foo', order)
    expect(out[0].is_mechanic_derived).toBe(false)
    expect(out[1].is_mechanic_derived).toBe(true)
  })

  it('sorts within a (category, state) by inbound_message lexicographically', () => {
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