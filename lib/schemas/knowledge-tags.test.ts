import { describe, expect, it } from 'vitest'
import {
  isCanonicalPrimaryTag,
  KNOWLEDGE_PRIMARY_TAGS,
} from './knowledge-tags'

describe('isCanonicalPrimaryTag', () => {
  it('returns the tag itself for an exact canonical match', () => {
    for (const tag of KNOWLEDGE_PRIMARY_TAGS) {
      expect(isCanonicalPrimaryTag(tag)).toBe(tag)
    }
  })

  it('returns the canonical prefix for a namespaced tag', () => {
    expect(isCanonicalPrimaryTag('staff_phoebe')).toBe('staff')
    expect(isCanonicalPrimaryTag('mechanic_perk_card')).toBe('mechanic')
    expect(isCanonicalPrimaryTag('sourcing_ethiopia')).toBe('sourcing')
  })

  it('returns the prefix when the suffix itself contains underscores', () => {
    // Only the first underscore separates prefix from suffix.
    expect(isCanonicalPrimaryTag('mechanic_first_drink_free')).toBe('mechanic')
  })

  it('returns null for a non-canonical bare tag', () => {
    expect(isCanonicalPrimaryTag('personality')).toBeNull()
    expect(isCanonicalPrimaryTag('craft')).toBeNull()
    expect(isCanonicalPrimaryTag('philly')).toBeNull()
  })

  it('returns null for a non-canonical namespaced tag', () => {
    expect(isCanonicalPrimaryTag('personality_warm')).toBeNull()
  })

  it('returns null for the empty string', () => {
    expect(isCanonicalPrimaryTag('')).toBeNull()
  })

  it('returns null when the underscore is at position 0', () => {
    // '_staff' → no canonical prefix before the underscore.
    expect(isCanonicalPrimaryTag('_staff')).toBeNull()
  })

  it('returns null for a bare underscore', () => {
    expect(isCanonicalPrimaryTag('_')).toBeNull()
  })

  it('locks the canonical set at exactly 12 entries', () => {
    // Adding a primary tag is a deliberate code change. This count guards
    // against accidental drift; bump it (and the spec's tag taxonomy) when
    // intentionally adding a tag.
    expect(KNOWLEDGE_PRIMARY_TAGS.length).toBe(12)
  })
})
