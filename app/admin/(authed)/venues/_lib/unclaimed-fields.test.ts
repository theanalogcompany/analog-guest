import { describe, expect, it } from 'vitest'
import type { VenueInfo } from '@/lib/schemas'
import type { VenueDetailMechanicRow } from '../../_lib/load-venue-detail'
import {
  computeUnclaimedMechanicColumns,
  computeUnclaimedVenueInfoFields,
} from './unclaimed-fields'

function baseVenueInfo(overrides: Partial<VenueInfo> = {}): VenueInfo {
  return {
    address: { line1: '1 Main St', city: 'Someville', region: 'CA', postalCode: '00000' },
    contact: {},
    hours: {},
    menu: { highlights: [], items: [] },
    staff: [],
    currentContext: [],
    ...overrides,
  }
}

describe('computeUnclaimedVenueInfoFields', () => {
  it('returns nothing for a venue_info object with only claimed keys', () => {
    expect(computeUnclaimedVenueInfoFields(baseVenueInfo())).toEqual([])
  })

  // qrEnrollmentMessage → Venue facts (guest-facing operational copy, not
  // knowledge and not menu) and menu.highlights → The menu (alongside
  // menu.notes — the field TAC-331's always-on-advice bug lived in) are
  // both DECIDED placements as of plan review, not unclaimed anymore. Every
  // current venue_info field is claimed; these two assertions guard against
  // silently re-orphaning either one in a future edit.
  it('does not surface qrEnrollmentMessage — it is claimed by Venue facts', () => {
    const result = computeUnclaimedVenueInfoFields(
      baseVenueInfo({ qrEnrollmentMessage: 'Hi Sana!' }),
    )
    expect(result).toEqual([])
  })

  it('does not surface menu.highlights — it is claimed by The menu', () => {
    const result = computeUnclaimedVenueInfoFields(
      baseVenueInfo({ menu: { highlights: ['Try the cortado'], items: [] } }),
    )
    expect(result).toEqual([])
  })

  it('does not surface any claimed top-level key even when populated', () => {
    const result = computeUnclaimedVenueInfoFields(
      baseVenueInfo({
        contact: { publicPhone: '+15551234567' },
        amenities: { wifi: true },
        staff: ['Rayan', 'Kinani'],
        currentContext: [
          { id: 'a', content: 'x', source: 'text', addedAt: new Date() },
        ],
        qrEnrollmentMessage: 'Hi Sana!',
        menu: { highlights: ['Try the cortado'], items: [] },
      }),
    )
    expect(result).toEqual([])
  })

  it('still surfaces a genuinely future, unaccounted-for top-level field', () => {
    const withExtra = {
      ...baseVenueInfo(),
      someFutureField: 'x',
    } as unknown as VenueInfo
    expect(computeUnclaimedVenueInfoFields(withExtra)).toEqual([
      { key: 'someFutureField', value: 'x' },
    ])
  })
})

describe('computeUnclaimedMechanicColumns', () => {
  // Typed against the real VenueDetailMechanicRow — the loader's
  // camelCase-mapped shape, which is what every actual call site (page.tsx)
  // passes in. An earlier version of this fixture used raw snake_case DB
  // column names, which matched the (also-wrong) snake_case allowlist and
  // let a real shape-mismatch bug ship with 100% green tests: the function
  // was being called on the camelCase row in production while every test
  // exercised it on a snake_case object, so nothing caught the disagreement.
  // Typing this fixture against the loader's own exported interface makes
  // that class of drift a tsc error, not just a hopeful convention.
  const fullRow = (): VenueDetailMechanicRow => ({
    id: '1',
    type: 'perk',
    name: 'Free Drink',
    description: null,
    qualification: null,
    rewardDescription: null,
    minState: 'new',
    redemptionPolicy: 'one_time',
    redemptionWindowDays: null,
    requiresOperatorApproval: false,
    trigger: { type: 'guest_initiated_request' },
    expirationRule: null,
    redemption: { type: 'manual_owner_action_at_venue' },
    isActive: true,
    deactivatedAt: null,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    schemaVersion: 1,
    metadata: {},
  })

  // `metadata` is `{}` on all 6 live mechanics (verified by querying the
  // live table directly during plan review, not assumed) — an unclaimed
  // column whose value is empty everywhere is noise, not signal, per that
  // review. This returns [] rather than ['metadata'] as a result.
  it('returns nothing for a fully-parameterized, healthy mechanic row with empty metadata', () => {
    expect(computeUnclaimedMechanicColumns(fullRow())).toEqual([])
  })

  it('does not flag any of the fields already rendered by MechanicsSection', () => {
    const unclaimed = computeUnclaimedMechanicColumns(fullRow())
    const renderedElsewhere: Array<keyof VenueDetailMechanicRow> = [
      'id',
      'type',
      'name',
      'description',
      'qualification',
      'rewardDescription',
      'minState',
      'redemptionPolicy',
      'redemptionWindowDays',
      'requiresOperatorApproval',
      'trigger',
      'expirationRule',
      'redemption',
      'isActive',
      'deactivatedAt',
    ]
    for (const field of renderedElsewhere) {
      expect(unclaimed).not.toContain(field)
    }
  })

  it('flags metadata once it actually carries something', () => {
    const withMetadata = { ...fullRow(), metadata: { note: 'left by an operator' } }
    expect(computeUnclaimedMechanicColumns(withMetadata)).toEqual(['metadata'])
  })

  it('flags a field the loader adds later, structurally, not by a hardcoded name, when non-empty', () => {
    const withExtra = { ...fullRow(), someNewField: 'x' } as unknown as VenueDetailMechanicRow
    expect(computeUnclaimedMechanicColumns(withExtra)).toEqual(['someNewField'])
  })

  it('does not flag a future field whose value is empty', () => {
    const withEmptyExtra = { ...fullRow(), someNewField: [] } as unknown as VenueDetailMechanicRow
    expect(computeUnclaimedMechanicColumns(withEmptyExtra)).toEqual([])
  })
})
