// Pure helper: given a guest's transactions and the venue's menu, compute
// how many distinct menu items they've ordered ("uniqueMenuItemsOrdered")
// and the size of the menu universe ("totalMenuItems").
//
// Lives next to load-signals.ts because that's the only consumer today.
// If a third call site appears (e.g. a guest-detail surface that wants the
// same projection), promote to a shared module.
//
// Defensive parsing: any field missing or wrong-typed is dropped silently.
// `raw_data` shape is owned by POS integrations (mock / Square / Toast); we
// don't want a malformed line item to crash the recognition computation.
// Same defensive style as lib/agent/extract-last-visit.ts.
//
// Matching is exact-after-normalization (lowercase + trim) on item names.
// POS line item names will get noisier as real venues onboard; fuzzy
// matching (or a name-mapping table) is the next iteration when that
// becomes a problem in practice.
//
// Filtering decisions for v1:
//   - `availability` is freeform string (operator-typed via CSV). No safe
//     way to filter "archived" / "unavailable" entries without parsing
//     prose. Counted; revisit if/when the schema gains an enum or boolean
//     active flag. TODO.
//   - `isOffMenu=true` items ARE counted in the universe. A guest who
//     orders an off-menu item demonstrates genuine exploration — often
//     more so than ordering off the standard menu. Excluding them would
//     under-credit that signal.

interface TransactionRow {
  raw_data: unknown
}

interface MenuItemLike {
  name: string
}

export interface MenuExploration {
  uniqueMenuItemsOrdered: number
  totalMenuItems: number
}

/**
 * Compute menu-exploration counts: how many menu items this guest has
 * ordered (intersected with the venue menu) and the size of the menu
 * universe. Both numbers feed the percentMenuExplored signal in
 * normalize-signals.ts via the formula `unique / total * 100`.
 *
 * Intersection (option B): line items that don't match the menu are NOT
 * counted toward `uniqueMenuItemsOrdered`. The signal is "% of menu
 * explored", so non-menu items can't contribute. Off-menu specials,
 * modifier line items, and POS-side noise drop out cleanly.
 *
 * Returns `{0, 0}` on any of:
 *   - empty transactions list
 *   - empty menu list
 *   - all transactions have malformed raw_data
 *   - all menu items have malformed name fields
 */
export function extractMenuExploration(
  transactions: readonly TransactionRow[],
  menuItems: readonly MenuItemLike[],
): MenuExploration {
  const menuNameSet = buildMenuNameSet(menuItems)
  const totalMenuItems = menuNameSet.size

  if (totalMenuItems === 0) {
    return { uniqueMenuItemsOrdered: 0, totalMenuItems: 0 }
  }

  const orderedMenuNames = new Set<string>()
  for (const transaction of transactions) {
    for (const lineName of extractLineItemNames(transaction.raw_data)) {
      if (menuNameSet.has(lineName)) {
        orderedMenuNames.add(lineName)
      }
    }
  }

  return {
    uniqueMenuItemsOrdered: orderedMenuNames.size,
    totalMenuItems,
  }
}

function buildMenuNameSet(menuItems: readonly MenuItemLike[]): Set<string> {
  // Caller (load-signals.ts) already runs defensive shape extraction on the
  // venue_configs JSONB before passing items here, so the static `name: string`
  // contract holds at runtime. We still trim + lowercase + drop empties for
  // case-insensitive matching against POS line item names.
  const set = new Set<string>()
  for (const item of menuItems) {
    const normalized = item.name.trim().toLowerCase()
    if (normalized.length === 0) continue
    set.add(normalized)
  }
  return set
}

function extractLineItemNames(rawData: unknown): string[] {
  if (typeof rawData !== 'object' || rawData === null) return []
  const r = rawData as Record<string, unknown>
  const lineItems = r.line_items
  if (!Array.isArray(lineItems)) return []

  const names: string[] = []
  for (const item of lineItems) {
    if (typeof item !== 'object' || item === null) continue
    const name = (item as Record<string, unknown>).name
    if (typeof name !== 'string') continue
    const normalized = name.trim().toLowerCase()
    if (normalized.length === 0) continue
    names.push(normalized)
  }
  return names
}
