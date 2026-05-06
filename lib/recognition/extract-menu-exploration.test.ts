import { describe, expect, it } from 'vitest'
import { extractMenuExploration } from './extract-menu-exploration'

// Helpers for terse fixture construction. Tests focus on the pure
// computation; load-signals (DB-touching wrapper) stays uncovered per the
// codebase convention.

function tx(...itemNames: string[]) {
  return { raw_data: { line_items: itemNames.map((name) => ({ name })) } }
}

function menu(...names: string[]) {
  return names.map((name) => ({ name }))
}

describe('extractMenuExploration', () => {
  it('case-insensitive normalization: "cortado" / "Cortado" / "CORTADO" count as 1 unique', () => {
    const result = extractMenuExploration(
      [tx('cortado', 'Cortado', 'CORTADO')],
      menu('Cortado'),
    )
    expect(result.uniqueMenuItemsOrdered).toBe(1)
    expect(result.totalMenuItems).toBe(1)
  })

  it('items ordered but NOT on the venue menu do NOT count toward unique (option B intersect)', () => {
    const result = extractMenuExploration(
      [tx('cortado', 'secret menu rachel')],
      menu('Cortado', 'Latte', 'Espresso'),
    )
    // Only "cortado" intersects the menu; "secret menu rachel" is dropped.
    expect(result.uniqueMenuItemsOrdered).toBe(1)
    expect(result.totalMenuItems).toBe(3)
  })

  it('venue with no menu → totalMenuItems=0 and uniqueMenuItemsOrdered=0', () => {
    const result = extractMenuExploration([tx('cortado', 'latte')], [])
    expect(result.uniqueMenuItemsOrdered).toBe(0)
    expect(result.totalMenuItems).toBe(0)
  })

  it('10 menu items, guest ordered 4 unique on-menu items → unique=4, total=10', () => {
    const result = extractMenuExploration(
      [
        tx('Cortado', 'Latte'),
        tx('Espresso'),
        tx('Cappuccino', 'Cortado'), // duplicate Cortado
      ],
      menu(
        'Cortado',
        'Latte',
        'Espresso',
        'Cappuccino',
        'Macchiato',
        'Mocha',
        'Americano',
        'Pour Over',
        'Cold Brew',
        'Drip',
      ),
    )
    expect(result.uniqueMenuItemsOrdered).toBe(4)
    expect(result.totalMenuItems).toBe(10)
  })

  it('guest with no transactions → unique=0 and total reflects menu size', () => {
    const result = extractMenuExploration([], menu('Cortado', 'Latte'))
    expect(result.uniqueMenuItemsOrdered).toBe(0)
    expect(result.totalMenuItems).toBe(2)
  })

  it('handles malformed raw_data shapes defensively', () => {
    const transactions = [
      // raw_data is null
      { raw_data: null },
      // raw_data is not an object
      { raw_data: 'not an object' },
      // line_items is missing
      { raw_data: { other_field: 'x' } },
      // line_items is not an array
      { raw_data: { line_items: 'not an array' } },
      // item is null
      { raw_data: { line_items: [null] } },
      // item has no name
      { raw_data: { line_items: [{ price: 5 }] } },
      // item.name is not a string
      { raw_data: { line_items: [{ name: 12345 }] } },
      // item.name is whitespace
      { raw_data: { line_items: [{ name: '   ' }] } },
      // item.name is empty
      { raw_data: { line_items: [{ name: '' }] } },
      // valid item — should still come through
      tx('Cortado'),
    ]
    const result = extractMenuExploration(transactions, menu('Cortado'))
    expect(result.uniqueMenuItemsOrdered).toBe(1)
    expect(result.totalMenuItems).toBe(1)
  })

  it('dedupes the menu universe (defensive against duplicate menu rows)', () => {
    // Two rows for "Cortado" (e.g., different sizes seeded as separate rows
    // with the same display name). Universe should still be 1.
    const result = extractMenuExploration(
      [tx('Cortado')],
      menu('Cortado', 'cortado'),
    )
    expect(result.uniqueMenuItemsOrdered).toBe(1)
    expect(result.totalMenuItems).toBe(1)
  })
})
