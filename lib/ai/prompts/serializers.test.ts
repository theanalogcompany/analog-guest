import { describe, expect, it } from 'vitest'
// Relative import: vitest doesn't pick up Next's `@/*` path alias by default
// without a vitest.config.ts. Other tests in this repo use relative imports too.
import { type MenuItem, type VenueInfo, VenueInfoSchema } from '../../schemas'
import { venueInfoToProse } from './serializers'

function makeVenueInfo(overrides: Partial<VenueInfo> = {}): VenueInfo {
  // VenueInfoSchema.parse fills defaults (contact:{}, hours:{}, menu:{...},
  // staff:[], currentContext:[]). Only `address` is required.
  return VenueInfoSchema.parse({
    address: { line1: '1 Test St', city: 'Test', region: 'CA', postalCode: '94000' },
    ...overrides,
  })
}

const item = (overrides: Partial<MenuItem> = {}): MenuItem => ({
  name: 'Espresso',
  category: 'drinks-coffee',
  price: 2.0,
  modifiers: [],
  dietary: [],
  isOffMenu: false,
  ...overrides,
})

describe('venueInfoToProse — menu items', () => {
  it('renders items section with name and price', () => {
    const info = makeVenueInfo({
      menu: {
        highlights: [],
        items: [item({ name: 'Espresso', price: 1.75 })],
      },
    })
    const out = venueInfoToProse(info)
    expect(out).toContain('## Menu (structured)')
    expect(out).toContain('On-menu:')
    expect(out).toContain('- Espresso — $1.75')
  })

  it('splits on-menu vs off-menu sections', () => {
    const info = makeVenueInfo({
      menu: {
        highlights: [],
        items: [
          item({ name: 'Espresso', isOffMenu: false }),
          item({
            name: 'The Rachel',
            category: 'off-menu',
            price: undefined,
            priceNote: 'by request',
            isOffMenu: true,
          }),
        ],
      },
    })
    const out = venueInfoToProse(info)
    expect(out).toContain('On-menu:')
    expect(out).toContain('Off-menu (by request):')
    // priceNote replaces price when price is undefined.
    expect(out).toContain('- The Rachel — by request')
    // On-menu section comes before off-menu section.
    expect(out.indexOf('On-menu:')).toBeLessThan(out.indexOf('Off-menu (by request):'))
  })

  it('renders modifiers conditionally', () => {
    const info = makeVenueInfo({
      menu: {
        highlights: [],
        items: [
          item({ name: 'Espresso', modifiers: [] }),
          item({ name: 'Cappuccino', price: 2.25, modifiers: ['oat milk', 'almond milk'] }),
        ],
      },
    })
    const out = venueInfoToProse(info)
    // Empty modifiers — line ends after price (then newline or section break).
    expect(out).toMatch(/- Espresso — \$2\.00(?!\s*— modifiers)/)
    // Non-empty modifiers — joined with comma+space.
    expect(out).toContain('- Cappuccino — $2.25 — modifiers: oat milk, almond milk')
  })

  it('omits the entire structured menu section when items is empty', () => {
    const info = makeVenueInfo({
      menu: { highlights: ['One', 'Two'], items: [] },
    })
    const out = venueInfoToProse(info)
    expect(out).not.toContain('## Menu (structured)')
    expect(out).not.toContain('On-menu:')
    expect(out).not.toContain('Off-menu')
    // Highlights still render as before.
    expect(out).toContain('Menu highlights: One, Two')
  })
})

describe('venueInfoToProse — hours notes multiline fix', () => {
  it('nests multi-line notes as sub-bullets so they stay inside the Hours block', () => {
    const info = makeVenueInfo({
      hours: {
        monday: '7am–3pm',
        notes:
          'Annual closures: Christmas Day, July 4\nNotes: Gunther off Tuesdays — Maya covers',
      },
    })
    const out = venueInfoToProse(info)
    // Header + nested sub-bullets.
    expect(out).toContain('  - Notes:\n    - Annual closures: Christmas Day, July 4\n    - Notes: Gunther off Tuesdays — Maya covers')
    // The bug we're fixing: the second line should NOT escape the indentation
    // (used to render as `Notes: Gunther...` at column 0).
    expect(out).not.toMatch(/^Notes: Gunther/m)
  })
})