// Single source of truth for Command Center navigation (TAC-306). Consumed by
// BOTH the sidebar (sidebar.tsx) and the ⌘K command palette
// (command-palette.tsx) so the two can never drift — the palette's jump
// targets are exactly the sidebar's links. Pure data + a pure active-state
// helper; no React, no icons (those live in the sidebar's React layer keyed by
// href) so this module stays trivially unit-testable.

export interface NavItem {
  href: string
  label: string
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
    ],
  },
  {
    section: 'System',
    items: [
      { href: '/admin/tunables', label: 'Tunables' },
      { href: '/admin/health', label: 'Health' },
    ],
  },
]

// Flat list of every nav item, display order preserved. The command palette
// renders by group, but this is handy for completeness checks.
export const NAV_ITEMS: readonly NavItem[] = NAV_GROUPS.flatMap((g) => g.items)

// Active-state predicate shared by sidebar + palette. Mirrors the original
// inline sidebar logic exactly: Home (/admin) matches only its exact path;
// every other entry also matches its descendant routes (e.g.
// /admin/voices/[slug]).
export function isNavItemActive(href: string, pathname: string): boolean {
  if (href === '/admin') return pathname === '/admin'
  return pathname === href || pathname.startsWith(`${href}/`)
}
