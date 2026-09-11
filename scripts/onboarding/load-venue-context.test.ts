import { describe, expect, it } from 'vitest'
import { assertVenueGuard, type VenueContext } from './load-venue-context'

const baseCtx = (overrides: Partial<VenueContext> = {}): VenueContext => ({
  venueId: 'v1',
  slug: 'le-mils-coffee',
  isTest: true,
  status: 'pending',
  venueInfo: {
    address: { line1: '1 Main St', city: 'Town', region: 'ST', postalCode: '00000' },
    contact: {},
    hours: {},
    menu: { highlights: [], items: [] },
    staff: [],
    currentContext: [],
  },
  knowledgeRows: [],
  mechanics: [],
  ...overrides,
})

describe('assertVenueGuard', () => {
  it('passes for is_test=true, status=pending', () => {
    expect(() => assertVenueGuard(baseCtx())).not.toThrow()
  })

  it('passes for is_test=true, status=anything-not-active', () => {
    expect(() => assertVenueGuard(baseCtx({ status: 'archived' }))).not.toThrow()
  })

  it('throws when is_test is false', () => {
    expect(() => assertVenueGuard(baseCtx({ isTest: false }))).toThrow(/is_test is false/)
  })

  it('throws when status is active, even if is_test is true', () => {
    expect(() => assertVenueGuard(baseCtx({ status: 'active' }))).toThrow(/status is "active"/)
  })

  it('throws when both conditions fail (is_test check fires first)', () => {
    expect(() => assertVenueGuard(baseCtx({ isTest: false, status: 'active' }))).toThrow(
      /is_test is false/,
    )
  })
})
