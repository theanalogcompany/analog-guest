// The surfaces under /admin/tests. One definition, read by the tests layout's
// sub-nav bar AND by nav-items.ts (the sidebar + command palette source), so
// the two cannot list different things - the same reason nav-items.ts exists
// at all.
//
// Pure data, no React, importable from the pure nav module.
//
// REGRESSION STILL POINTS AT ITS OLD PATH. The regression surface moves under
// tests/ in its own commit, once the branch currently rewriting its loader and
// routes has merged - moving files another branch is editing turns a rename
// into a delete/modify conflict on every one of them. Flipping this href is
// the last step of that move.

export interface TestsSubnavItem {
  href: string
  label: string
}

export const TESTS_SUBNAV: readonly TestsSubnavItem[] = [
  { href: '/admin/tests/golden', label: 'Golden set' },
  { href: '/admin/regression', label: 'Regression' },
]
