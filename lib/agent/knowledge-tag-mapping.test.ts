import { describe, expect, it } from 'vitest'
import {
  CATEGORY_TO_PRIMARY_TAG_PREFERENCE,
  getPrimaryTagPreference,
} from './knowledge-tag-mapping'

describe('getPrimaryTagPreference', () => {
  it('returns the mapped preference for mechanic_request', () => {
    expect(getPrimaryTagPreference('mechanic_request')).toEqual(['mechanic'])
  })

  it('returns the mapped preference for perk_inquiry', () => {
    expect(getPrimaryTagPreference('perk_inquiry')).toEqual(['mechanic'])
  })

  it('returns the multi-tag preference for recommendation_request', () => {
    expect(getPrimaryTagPreference('recommendation_request')).toEqual([
      'recommendations',
      'menu',
      'sourcing',
    ])
  })

  it('returns the mapped preference for event_question', () => {
    expect(getPrimaryTagPreference('event_question')).toEqual(['events'])
  })

  it('returns undefined for an unmapped category', () => {
    expect(getPrimaryTagPreference('reply')).toBeUndefined()
    expect(getPrimaryTagPreference('new_question')).toBeUndefined()
    expect(getPrimaryTagPreference('comp_complaint')).toBeUndefined()
    expect(getPrimaryTagPreference('personal_history_question')).toBeUndefined()
    expect(getPrimaryTagPreference('unknown')).toBeUndefined()
    expect(getPrimaryTagPreference('manual')).toBeUndefined()
    expect(getPrimaryTagPreference('acknowledgment')).toBeUndefined()
    expect(getPrimaryTagPreference('casual_chatter')).toBeUndefined()
    expect(getPrimaryTagPreference('opt_out')).toBeUndefined()
  })

  it('returns undefined when category is null', () => {
    expect(getPrimaryTagPreference(null)).toBeUndefined()
  })

  it('locks the mapping at exactly four categories', () => {
    // Adding a category here is a deliberate routing decision — bump this
    // count when intentionally extending the map. comp_complaint and
    // personal_history_question were considered and explicitly excluded
    // (see knowledge-tag-mapping.ts).
    expect(Object.keys(CATEGORY_TO_PRIMARY_TAG_PREFERENCE).length).toBe(4)
  })
})
