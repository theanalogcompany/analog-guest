// Tests for the /admin/health TypeSafe (Jev) row. Synthetic env objects and an
// explicit flag argument, no mocking - the check-apns.test.ts pattern. Pins the
// three tones, the exact detail copy per state (the operator reads this row to
// know which model is live), and that no state ever renders key material.
import { describe, expect, it } from 'vitest'

import { checkTypesafe } from './check-typesafe'

const VALID_KEY = 'apikey_' + 'a'.repeat(60)

describe('checkTypesafe — not configured', () => {
  it('is neutral with no key, and says classification runs on Haiku', () => {
    const row = checkTypesafe({}, false)
    expect(row.tone).toBe('neutral')
    expect(row.detail).toBe('Not configured — classification runs on Haiku')
  })

  it('treats a whitespace-only key as not configured, not as misconfigured', () => {
    const row = checkTypesafe({ JEV_API_KEY: '   \n' }, false)
    expect(row.tone).toBe('neutral')
    expect(row.detail).toContain('Not configured')
  })
})

describe('checkTypesafe — misconfigured', () => {
  it('is bad on a malformed key and the detail starts with Misconfigured', () => {
    const row = checkTypesafe({ JEV_API_KEY: 'sk_wrong_vendor_prefix_but_long_enough_aaaa' }, false)
    expect(row.tone).toBe('bad')
    expect(row.detail).toMatch(/^Misconfigured/)
    // Names the var and the defect so the operator can act on it.
    expect(row.detail).toContain('JEV_API_KEY')
  })

  it('surfaces every problem at once, joined visibly', () => {
    // Wrong prefix AND too short.
    const row = checkTypesafe({ JEV_API_KEY: 'nope' }, false)
    expect(row.tone).toBe('bad')
    expect(row.detail).toContain('does not start with')
    expect(row.detail).toContain('shorter than')
  })
})

describe('checkTypesafe — key present, flag woven into the detail', () => {
  it('is good with the flag off and says Haiku is still the live classifier', () => {
    const row = checkTypesafe({ JEV_API_KEY: VALID_KEY }, false)
    expect(row.tone).toBe('good')
    expect(row.detail).toBe('Key present — flag off, classification runs on Haiku')
  })

  it('is good with the flag on, says Jev is ON, and is honest about what it cannot prove', () => {
    const row = checkTypesafe({ JEV_API_KEY: VALID_KEY }, true)
    expect(row.tone).toBe('good')
    expect(row.detail).toBe(
      'Key present — Jev classification ON, Haiku as fallback (key validity unconfirmed)',
    )
  })
})

describe('checkTypesafe — invariants across states', () => {
  it('labels the row TypeSafe (Jev) in every state', () => {
    for (const row of [
      checkTypesafe({}, false),
      checkTypesafe({ JEV_API_KEY: 'nope' }, false),
      checkTypesafe({ JEV_API_KEY: VALID_KEY }, false),
      checkTypesafe({ JEV_API_KEY: VALID_KEY }, true),
    ]) {
      expect(row.label).toBe('TypeSafe (Jev)')
    }
  })

  it('never renders key material in any state, unlike the Langfuse row not even a prefix', () => {
    // A distinctive fragment that could only appear if the detail echoed the
    // value. One malformed and one valid key, both flags for the valid one.
    const malformed = 'ZQXJVK_DISTINCTIVE_SECRET'
    const valid = 'apikey_ZQXJVKDISTINCTIVESECRET' + 'a'.repeat(40)
    for (const row of [
      checkTypesafe({ JEV_API_KEY: malformed }, false),
      checkTypesafe({ JEV_API_KEY: valid }, false),
      checkTypesafe({ JEV_API_KEY: valid }, true),
    ]) {
      expect(row.detail).not.toContain('ZQXJVK')
    }
  })
})
