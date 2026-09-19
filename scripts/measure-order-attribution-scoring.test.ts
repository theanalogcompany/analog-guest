import { describe, expect, it } from 'vitest'
import { isConflationShapedClaim, scoreConflationClaims } from './measure-order-attribution-scoring'

describe('isConflationShapedClaim', () => {
  it('matches the exact TAC-483 incident phrasing', () => {
    const claim =
      'the Pink Panther two days in a row — the guest ordered a blossom tonic today (Friday) and had the Pink Panther yesterday (Thursday), not the Pink Panther on consecutive days'
    expect(isConflationShapedClaim(claim)).toBe(true)
  })

  it('matches other repeat/streak phrasings', () => {
    expect(isConflationShapedClaim('claims the guest ordered it again')).toBe(true)
    expect(isConflationShapedClaim('says it happened twice')).toBe(true)
    expect(isConflationShapedClaim('describes both days as the same drink')).toBe(true)
    expect(isConflationShapedClaim('calls it a repeat order')).toBe(true)
    expect(isConflationShapedClaim('says it was back-to-back visits')).toBe(true)
  })

  it('does not match an unrelated ungrounded claim', () => {
    expect(isConflationShapedClaim('claims the wifi password is "cafe123"')).toBe(false)
    expect(isConflationShapedClaim('states the croissant is gluten-free')).toBe(false)
    expect(isConflationShapedClaim('asserts the venue takes reservations')).toBe(false)
  })

  it('is case-insensitive', () => {
    expect(isConflationShapedClaim('TWO DAYS IN A ROW')).toBe(true)
  })
})

describe('scoreConflationClaims', () => {
  it('flags the conflation-shaped claim among a set that mixes in an unrelated flag', () => {
    const claims = ['invents a wifi password', 'the Pink Panther two days in a row']
    const score = scoreConflationClaims(claims)
    expect(score.isConflationShaped).toBe(true)
    expect(score.matchedClaims).toEqual(['the Pink Panther two days in a row'])
  })

  it('returns isConflationShaped=false when nothing matches', () => {
    const score = scoreConflationClaims(['invents a wifi password'])
    expect(score.isConflationShaped).toBe(false)
    expect(score.matchedClaims).toEqual([])
  })

  it('returns isConflationShaped=false for an empty claims array', () => {
    const score = scoreConflationClaims([])
    expect(score.isConflationShaped).toBe(false)
    expect(score.matchedClaims).toEqual([])
  })

  it('collects every matching claim, not just the first', () => {
    const claims = ['says it twice', 'unrelated wifi claim', 'calls it two days in a row']
    const score = scoreConflationClaims(claims)
    expect(score.matchedClaims).toEqual(['says it twice', 'calls it two days in a row'])
  })
})
