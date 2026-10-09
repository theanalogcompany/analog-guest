// Single source of truth for Command Center navigation (TAC-306). Consumed by
// BOTH the sidebar (sidebar.tsx) and the ⌘K command palette
// (command-palette.tsx) so the two can never drift — the palette's jump
// targets are exactly the sidebar's links. Pure data + a pure active-state
// helper; no React, no icons (those live in the sidebar's React layer keyed by
// href) so this module stays pure.

import { TESTS_SUBNAV } from '../(authed)/tests/_lib/subnav'

export interface NavItem {
  href: string
  label: string
  /**
   * Sub-surfaces of this item. The sidebar renders them indented; the command
   * palette FLATTENS them into their own jump targets, so ⌘K can reach a
   * child directly. Both consumers were updated with this field - the whole
   * premise of this module is that the sidebar and the palette cannot drift.
   */
  children?: readonly NavItem[]
}

export interface NavGroup {
  section: string
  items: readonly NavItem[]
}

export const NAV_GROUPS: readonly NavGroup[] = [
  {
    section: 'Surfaces',
    items: [
      { href: '/admin', label: 'Home' },
      { href: '/admin/conversations', label: 'Conversations' },
      { href: '/admin/voices', label: 'Voices' },
      { href: '/admin/venues', label: 'Venues' },
    ],
  },
  {
    section: 'System',
    items: [
      { href: '/admin/playground', label: 'Playground' },
      // Children come from TESTS_SUBNAV, which the tests layout's own sub-nav
      // bar also reads, so the sidebar and the page cannot list different
      // surfaces.
      { href: '/admin/tests', label: 'Tests', children: TESTS_SUBNAV },
      { href: '/admin/tunables', label: 'Tunables' },
      { href: '/admin/intentions', label: 'Intentions' },
      { href: '/admin/health', label: 'Health' },
    ],
  },
]

// Flat list of every nav item, display order preserved, CHILDREN INCLUDED and
// each following its parent. The command palette renders by group, but a
// child that only existed nested would be unreachable by ⌘K - and this is
// also what completeness checks count.
export const NAV_ITEMS: readonly NavItem[] = NAV_GROUPS.flatMap((g) =>
  g.items.flatMap((item) => [item, ...(item.children ?? [])]),
)

/**
 * The groups with every child flattened in beside its parent, for consumers
 * that render a flat list - the command palette. Built from NAV_GROUPS rather
 * than declared, so a new child appears in the palette without a second edit.
 */
export const NAV_GROUPS_FLAT: readonly NavGroup[] = NAV_GROUPS.map((group) => ({
  section: group.section,
  items: group.items.flatMap((item) => [item, ...(item.children ?? [])]),
}))

// Active-state predicate shared by sidebar + palette. Mirrors the original
// inline sidebar logic exactly: Home (/admin) matches only its exact path;
// every other entry also matches its descendant routes (e.g.
// /admin/voices/[slug]).
export function isNavItemActive(href: string, pathname: string): boolean {
  if (href === '/admin') return pathname === '/admin'
  return pathname === href || pathname.startsWith(`${href}/`)
}
