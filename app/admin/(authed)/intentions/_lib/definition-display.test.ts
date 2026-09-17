import { describe, expect, it } from 'vitest'
import { INTENTION_DEFINITIONS } from '@/lib/agent/intentions/definitions'
import {
  formatArmsOn,
  formatExpiryWindow,
  formatGate,
  formatPromptedAt,
  resolveDefinition,
} from './definition-display'

describe('resolveDefinition', () => {
  it('resolves every live definition key', () => {
    for (const def of INTENTION_DEFINITIONS) {
      const resolved = resolveDefinition(def.key)
      expect(resolved.known, def.key).toBe(true)
      // Returns the definition object itself, not a copy — the viewer reads
      // promptLine off this, and a copy could drift from what the model sees.
      if (resolved.known) expect(resolved.definition).toBe(def)
    }
  })

  it('reports an unrecognized key rather than throwing or inventing one', () => {
    expect(resolveDefinition('retired_intention_v0')).toEqual({ known: false })
    expect(resolveDefinition('')).toEqual({ known: false })
  })
})

describe('formatExpiryWindow', () => {
  const DAY = 24 * 60 * 60 * 1000

  it('renders whole days', () => {
    expect(formatExpiryWindow(3 * DAY)).toBe('3 days')
    expect(formatExpiryWindow(14 * DAY)).toBe('14 days')
  })

  it('singularizes one day and one hour', () => {
    expect(formatExpiryWindow(DAY)).toBe('1 day')
    expect(formatExpiryWindow(60 * 60 * 1000)).toBe('1 hour')
  })

  it('falls back to hours when the window is not a whole number of days', () => {
    expect(formatExpiryWindow(36 * 60 * 60 * 1000)).toBe('36 hours')
  })

  // Deliberately NOT rounded. A window rendered as "3 days" while the code
  // means 3 days minus a minute is a quiet misreport, which is the whole
  // failure mode this read-only surface exists to avoid.
  it('falls back to raw milliseconds rather than rounding an odd window', () => {
    expect(formatExpiryWindow(90 * 1000)).toBe('90000 ms')
    expect(formatExpiryWindow(0)).toBe('0 ms')
  })

  it('renders every live definition window as days', () => {
    for (const def of INTENTION_DEFINITIONS) {
      expect(formatExpiryWindow(def.expiresAfterMs), def.key).toMatch(/^\d+ days?$/)
    }
  })
})

describe('formatPromptedAt', () => {
  it('renders an absolute UTC timestamp', () => {
    expect(formatPromptedAt('2026-09-13T10:04:00.000Z')).toBe('2026-09-13 10:04 UTC')
  })

  it('normalizes a non-UTC offset to UTC rather than rendering it as-is', () => {
    expect(formatPromptedAt('2026-09-13T10:04:00+02:00')).toBe('2026-09-13 08:04 UTC')
  })

  // Never "Invalid Date" — an unreadable value should show what was stored.
  it('returns the raw value when it cannot be parsed', () => {
    expect(formatPromptedAt('not-a-date')).toBe('not-a-date')
  })
})

describe('formatArmsOn (TAC-380)', () => {
  it('describes every arming kind distinctly', () => {
    const rendered = [
      formatArmsOn({ kind: 'visit_confirmed' }),
      formatArmsOn({ kind: 'first_contact' }),
      formatArmsOn({ kind: 'open_recommendation' }),
      formatArmsOn({ kind: 'recorded_order' }),
    ]
    for (const text of rendered) expect(text.trim().length).toBeGreaterThan(0)
    expect(new Set(rendered).size).toBe(rendered.length)
  })

  it('renders every live definition', () => {
    for (const def of INTENTION_DEFINITIONS) {
      expect(formatArmsOn(def.armsOn).trim().length, def.key).toBeGreaterThan(0)
    }
  })
})

describe('formatGate (TAC-380)', () => {
  it('says None for an ungated intention', () => {
    expect(formatGate({ kind: 'none' })).toBe('None')
  })

  // The reply count shown is the DEFAULT, and a venue can override it. The copy
  // saying so is what stops the page presenting a default as the value in force.
  it('names the default reply count and that a venue can override it', () => {
    const text = formatGate({ kind: 'conversational', defaultMinReplies: 5 })
    expect(text).toContain('at least 5 replies')
    expect(text).toContain('venue can override')
  })

  it('singularizes one reply', () => {
    expect(formatGate({ kind: 'conversational', defaultMinReplies: 1 })).toContain('at least 1 reply ')
  })
})
