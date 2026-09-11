import { describe, expect, it } from 'vitest'
import {
  containsLongDash,
  sanitizeScenarioText,
  sanitizeScenarios,
  stripLongDashes,
} from './sanitize-scenario-text'

describe('stripLongDashes', () => {
  it('replaces a spaced em dash with a comma', () => {
    expect(stripLongDashes('Hi! Quick question — what are your hours?')).toBe(
      'Hi! Quick question, what are your hours?',
    )
  })

  it('replaces a spaced en dash with a comma', () => {
    expect(stripLongDashes('open 9am – 5pm most days')).toBe('open 9am, 5pm most days')
  })

  it('replaces a tight em dash (no surrounding spaces) with a hyphen', () => {
    expect(stripLongDashes('9am—5pm')).toBe('9am-5pm')
  })

  it('leaves text with no dashes unchanged', () => {
    expect(stripLongDashes('what are your hours today')).toBe('what are your hours today')
  })

  it('handles multiple dashes in one string', () => {
    expect(stripLongDashes('a — b — c')).toBe('a, b, c')
  })
})

describe('sanitizeScenarioText', () => {
  it('strips dashes and trims surrounding whitespace', () => {
    expect(sanitizeScenarioText('  hey — what times are you open?  ')).toBe(
      'hey, what times are you open?',
    )
  })
})

describe('sanitizeScenarios', () => {
  it('sanitizes all three text fields and counts hits', () => {
    const scenarios = [
      {
        inbound_message: 'hey — what are your hours',
        scenario: 'guest asks about hours',
        expected_facts: ['open 9am – 5pm'],
      },
      {
        inbound_message: 'no dashes here',
        scenario: 'plain',
        expected_facts: ['also plain'],
      },
    ]
    const { scenarios: out, dashHitCount } = sanitizeScenarios(scenarios)
    expect(out[0].inbound_message).toBe('hey, what are your hours')
    expect(out[0].expected_facts[0]).toBe('open 9am, 5pm')
    expect(out[1]).toEqual(scenarios[1])
    expect(dashHitCount).toBe(1)
  })
})

describe('containsLongDash', () => {
  it('detects an em dash', () => {
    expect(containsLongDash('a — b')).toBe(true)
  })

  it('detects an en dash', () => {
    expect(containsLongDash('a – b')).toBe(true)
  })

  it('returns false for plain text', () => {
    expect(containsLongDash('a - b')).toBe(false)
  })
})
