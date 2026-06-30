import { describe, expect, it } from 'vitest'
import {
  isNavItemActive,
  NAV_GROUPS,
  NAV_ITEMS,
} from './nav-items'

// Guards the shared nav source (TAC-306). The sidebar and the ⌘K command
// palette both read NAV_GROUPS, so these invariants keep their targets valid
// and in lockstep. The interactive ⌘K/keyboard behavior itself needs E2E
// (blocked until TAC-239); this is the automatable slice.

describe('NAV source', () => {
  it('has at least one group with at least one item', () => {
    expect(NAV_GROUPS.length).toBeGreaterThan(0)
    expect(NAV_ITEMS.length).toBeGreaterThan(0)
  })

  it('every item has a non-empty label and an /admin href', () => {
    for (const item of NAV_ITEMS) {
      expect(item.label.trim().length).toBeGreaterThan(0)
      expect(item.href.startsWith('/admin')).toBe(true)
    }
  })

  it('hrefs are unique (no duplicate jump targets)', () => {
    const hrefs = NAV_ITEMS.map((i) => i.href)
    expect(new Set(hrefs).size).toBe(hrefs.length)
  })

  it('NAV_ITEMS is exactly the flattened groups in order (palette == sidebar)', () => {
    expect(NAV_ITEMS).toEqual(NAV_GROUPS.flatMap((g) => g.items))
  })
})

describe('isNavItemActive', () => {
  it('Home matches only the exact /admin path', () => {
    expect(isNavItemActive('/admin', '/admin')).toBe(true)
    expect(isNavItemActive('/admin', '/admin/conversations')).toBe(false)
    expect(isNavItemActive('/admin', '/admin/voices/foo')).toBe(false)
  })

  it('section roots match themselves and descendant routes', () => {
    expect(isNavItemActive('/admin/voices', '/admin/voices')).toBe(true)
    expect(isNavItemActive('/admin/voices', '/admin/voices/mock-cafe')).toBe(true)
    expect(isNavItemActive('/admin/conversations', '/admin/conversations')).toBe(true)
  })

  it('non-matching paths are inactive', () => {
    expect(isNavItemActive('/admin/voices', '/admin/tunables')).toBe(false)
    expect(isNavItemActive('/admin/tunables', '/admin/voices')).toBe(false)
    // a sibling whose path is a string-prefix but not a route boundary
    expect(isNavItemActive('/admin/voices', '/admin/voices-archive')).toBe(false)
  })
})
