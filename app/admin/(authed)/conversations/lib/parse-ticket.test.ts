import { describe, expect, it } from 'vitest'
import { buildItemsPreview, formatPosProvider, parseTicket } from './parse-ticket'

const FIXTURE = {
  pos_provider: 'mock',
  ticket_id: 'TKT-786-0003',
  line_items: [
    { name: 'Mocha', quantity: 1, unit_price_cents: 300, category: 'drinks-coffee' },
    { name: 'Bagel + cream cheese', quantity: 1, unit_price_cents: 300 },
    { name: 'Banana bread', quantity: 1, unit_price_cents: 250 },
  ],
  subtotal_cents: 850,
  tax_cents: 0,
  tip_cents: 150,
  payment_method: 'card',
  card_last_four: '0786',
}

describe('parseTicket', () => {
  it('parses the mock-central-perk fixture cleanly', () => {
    const ticket = parseTicket(FIXTURE)
    expect(ticket).not.toBeNull()
    expect(ticket?.posProvider).toBe('mock')
    expect(ticket?.ticketId).toBe('TKT-786-0003')
    expect(ticket?.lineItems).toHaveLength(3)
    expect(ticket?.lineItems[0]).toEqual({
      name: 'Mocha',
      quantity: 1,
      unitPriceCents: 300,
    })
    expect(ticket?.subtotalCents).toBe(850)
    expect(ticket?.tipCents).toBe(150)
    expect(ticket?.cardLastFour).toBe('0786')
  })

  it('returns null when raw_data is null', () => {
    expect(parseTicket(null)).toBeNull()
  })

  it('returns null when line_items is missing', () => {
    expect(parseTicket({ pos_provider: 'mock', ticket_id: 'X' })).toBeNull()
  })

  it('returns null when no line items are parsable', () => {
    expect(
      parseTicket({
        line_items: [{ name: 'no quantity' }, { quantity: 1 }, 'string'],
      }),
    ).toBeNull()
  })

  it('drops malformed line items but keeps the parsable ones', () => {
    const ticket = parseTicket({
      line_items: [
        { name: 'Good', quantity: 1, unit_price_cents: 100 },
        { name: 'Missing price', quantity: 1 },
        null,
        { name: 'Also good', quantity: 2, unit_price_cents: 50 },
      ],
    })
    expect(ticket?.lineItems).toHaveLength(2)
    expect(ticket?.lineItems.map((l) => l.name)).toEqual(['Good', 'Also good'])
  })
})

describe('buildItemsPreview', () => {
  it('joins names with commas', () => {
    const items = [
      { name: 'Mocha', quantity: 1, unitPriceCents: 300 },
      { name: 'Bagel', quantity: 1, unitPriceCents: 200 },
    ]
    expect(buildItemsPreview(items)).toBe('Mocha, Bagel')
  })

  it('caps at maxNames + appends ellipsis when items were dropped', () => {
    const items = Array.from({ length: 6 }, (_, i) => ({
      name: `Item${i}`,
      quantity: 1,
      unitPriceCents: 100,
    }))
    const preview = buildItemsPreview(items, 3, 100)
    expect(preview).toBe('Item0, Item1, Item2…')
  })

  it('caps at maxChars by item-name boundary, no mid-word truncation', () => {
    const items = [
      { name: 'Cappuccino', quantity: 1, unitPriceCents: 100 },
      { name: 'Banana bread', quantity: 1, unitPriceCents: 100 },
      { name: 'A very long pastry name that exceeds the cap', quantity: 1, unitPriceCents: 100 },
    ]
    const preview = buildItemsPreview(items, 4, 30)
    // Cappuccino (10) + ", " (2) + Banana bread (12) = 24 chars. Adding the
    // long pastry would exceed 30; it gets dropped + ellipsis appended.
    expect(preview).toBe('Cappuccino, Banana bread…')
  })

  it('returns empty string for empty input', () => {
    expect(buildItemsPreview([])).toBe('')
  })

  it('keeps the first item even when it alone exceeds maxChars', () => {
    // Edge case: don't return empty if the first item is too long; just
    // return that one item unchanged. Better than empty preview.
    const items = [
      { name: 'A very long pastry name that exceeds the cap', quantity: 1, unitPriceCents: 100 },
    ]
    const preview = buildItemsPreview(items, 4, 10)
    expect(preview).toBe('A very long pastry name that exceeds the cap')
  })
})

describe('formatPosProvider', () => {
  it('maps known providers to display labels', () => {
    expect(formatPosProvider('mock')).toBe('mock POS')
    expect(formatPosProvider('square')).toBe('Square')
    expect(formatPosProvider('toast')).toBe('Toast')
  })

  it('returns the raw string for unknown providers', () => {
    expect(formatPosProvider('clover')).toBe('clover')
  })

  it('returns empty string for null', () => {
    expect(formatPosProvider(null)).toBe('')
  })
})
