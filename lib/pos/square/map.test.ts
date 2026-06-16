import { describe, expect, it } from 'vitest'

import {
  mapSquareCatalogObjects,
  mapSquareInventoryCounts,
  mapSquareOrderLineItems,
  mapSquarePaymentToTransaction,
} from './map'

describe('mapSquarePaymentToTransaction', () => {
  const payment = {
    id: 'pay_123',
    created_at: '2026-06-15T10:00:00Z',
    status: 'COMPLETED',
    location_id: 'LOC_1',
    order_id: 'ord_1',
    amount_money: { amount: 650, currency: 'USD' },
    card_details: { card: { fingerprint: 'fp_abc' } },
  }

  it('maps core fields including the card fingerprint', () => {
    const t = mapSquarePaymentToTransaction(payment)
    expect(t).not.toBeNull()
    expect(t).toMatchObject({
      provider: 'square',
      externalId: 'pay_123',
      locationExternalId: 'LOC_1',
      orderExternalId: 'ord_1',
      amount: { amountCents: 650, currency: 'USD' },
      cardFingerprint: 'fp_abc',
      status: 'completed',
      occurredAt: '2026-06-15T10:00:00Z',
    })
    // Line items are hydrated separately from the order, not the payment.
    expect(t?.lineItems).toEqual([])
  })

  it('maps statuses; missing fields degrade safely', () => {
    expect(mapSquarePaymentToTransaction({ id: 'p', status: 'APPROVED' })?.status).toBe('authorized')
    expect(mapSquarePaymentToTransaction({ id: 'p', status: 'CANCELED' })?.status).toBe('voided')
    const bare = mapSquarePaymentToTransaction({ id: 'p' })
    expect(bare?.cardFingerprint).toBeNull()
    expect(bare?.amount).toEqual({ amountCents: 0, currency: 'USD' })
  })

  it('returns null when the object has no id', () => {
    expect(mapSquarePaymentToTransaction({ status: 'COMPLETED' })).toBeNull()
    expect(mapSquarePaymentToTransaction(null)).toBeNull()
  })
})

describe('mapSquareOrderLineItems', () => {
  it('extracts named items with parsed quantities', () => {
    const items = mapSquareOrderLineItems({
      line_items: [
        { name: 'Matcha Latte', quantity: '2' },
        { name: 'Croissant', quantity: '1' },
      ],
    })
    expect(items).toEqual([
      { name: 'Matcha Latte', quantity: 2 },
      { name: 'Croissant', quantity: 1 },
    ])
  })

  it('drops unnamed items and defaults bad quantities to 1', () => {
    const items = mapSquareOrderLineItems({
      line_items: [{ quantity: '3' }, { name: 'Drip', quantity: 'oops' }],
    })
    expect(items).toEqual([{ name: 'Drip', quantity: 1 }])
  })

  it('returns [] on an unparseable order', () => {
    expect(mapSquareOrderLineItems(null)).toEqual([])
    expect(mapSquareOrderLineItems({})).toEqual([])
  })
})

describe('mapSquareInventoryCounts', () => {
  it('maps counts, dropping rows without ids', () => {
    const counts = mapSquareInventoryCounts([
      { catalog_object_id: 'var_1', location_id: 'LOC_1', quantity: '5', state: 'IN_STOCK' },
      { location_id: 'LOC_1', quantity: '9' }, // no catalog id → dropped
    ])
    expect(counts).toEqual([
      { catalogExternalId: 'var_1', locationExternalId: 'LOC_1', quantity: 5, state: 'IN_STOCK' },
    ])
  })

  it('accepts the camelCase SDK shape (from batchGetCounts)', () => {
    expect(
      mapSquareInventoryCounts([
        { catalogObjectId: 'v1', locationId: 'L1', quantity: '7', state: 'IN_STOCK' },
      ]),
    ).toEqual([{ catalogExternalId: 'v1', locationExternalId: 'L1', quantity: 7, state: 'IN_STOCK' }])
  })

  it('returns [] on non-array input', () => {
    expect(mapSquareInventoryCounts(null)).toEqual([])
  })
})

describe('mapSquareCatalogObjects', () => {
  it('maps ITEM variations to MenuItems and ignores non-items', () => {
    const items = mapSquareCatalogObjects([
      {
        type: 'ITEM',
        id: 'item_1',
        version: 3,
        itemData: {
          name: 'Croissant',
          categoryId: 'cat_1',
          variations: [
            { id: 'var_1', itemVariationData: { name: 'Regular', priceMoney: { amount: 450, currency: 'USD' } } },
          ],
        },
      },
      { type: 'CATEGORY', id: 'cat_1' },
    ])
    expect(items).toEqual([
      {
        externalId: 'var_1',
        parentExternalId: 'item_1',
        name: 'Croissant',
        category: 'cat_1',
        price: { amountCents: 450, currency: 'USD' },
        isAvailable: true,
        version: 3,
      },
    ])
  })

  it('handles bigint amount/version and missing price', () => {
    const items = mapSquareCatalogObjects([
      {
        type: 'ITEM',
        id: 'i',
        version: BigInt(10),
        itemData: { name: 'Drip', variations: [{ id: 'v', itemVariationData: { name: 'L' } }] },
      },
    ])
    expect(items[0]).toMatchObject({ name: 'Drip', price: null, version: 10 })
  })

  it('marks deleted items unavailable and drops unnamed items', () => {
    const deleted = mapSquareCatalogObjects([
      { type: 'ITEM', id: 'i', isDeleted: true, itemData: { name: 'X', variations: [{ id: 'v' }] } },
    ])
    expect(deleted[0].isAvailable).toBe(false)
    expect(
      mapSquareCatalogObjects([{ type: 'ITEM', id: 'i', itemData: { variations: [{ id: 'v' }] } }]),
    ).toEqual([])
  })

  it('returns [] on non-array input', () => {
    expect(mapSquareCatalogObjects(null)).toEqual([])
  })
})
