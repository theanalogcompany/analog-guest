import { describe, expect, it } from 'vitest'

import { parseSquareWebhook } from './parse-webhook'

function body(obj: unknown): string {
  return JSON.stringify(obj)
}

describe('parseSquareWebhook', () => {
  it('parses a payment.created into a transaction event with merchant id from the envelope', () => {
    const res = parseSquareWebhook(
      body({
        merchant_id: 'MERCH_1',
        type: 'payment.created',
        event_id: 'evt_1',
        data: { type: 'payment', object: { payment: { id: 'pay_1', status: 'COMPLETED' } } },
      }),
    )
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.data).toHaveLength(1)
    const ev = res.data[0]
    expect(ev.kind).toBe('transaction')
    if (ev.kind !== 'transaction') return
    expect(ev.eventId).toBe('evt_1')
    expect(ev.data.externalId).toBe('pay_1')
    expect(ev.data.merchantExternalId).toBe('MERCH_1')
  })

  it('maps catalog + inventory event types', () => {
    const cat = parseSquareWebhook(
      body({ type: 'catalog.version.updated', event_id: 'evt_c' }),
    )
    expect(cat.ok && cat.data[0].kind).toBe('catalog_updated')

    const inv = parseSquareWebhook(
      body({
        type: 'inventory.count.updated',
        event_id: 'evt_i',
        data: { object: { inventory_counts: [{ catalog_object_id: 'v1', location_id: 'L1', quantity: '3' }] } },
      }),
    )
    expect(inv.ok).toBe(true)
    if (!inv.ok) return
    const ev = inv.data[0]
    expect(ev.kind).toBe('inventory_updated')
    if (ev.kind !== 'inventory_updated') return
    expect(ev.counts).toHaveLength(1)
  })

  it('surfaces unknown event types without erroring', () => {
    const res = parseSquareWebhook(body({ type: 'refund.created', event_id: 'evt_r' }))
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.data[0].kind).toBe('unknown')
  })

  it('errors on invalid JSON and missing envelope fields', () => {
    expect(parseSquareWebhook('not json').ok).toBe(false)
    expect(parseSquareWebhook(body({ type: 'payment.created' })).ok).toBe(false) // no event_id
  })

  it('degrades a payment event with an unmappable payment to unknown', () => {
    const res = parseSquareWebhook(
      body({ type: 'payment.created', event_id: 'evt_x', data: { object: { payment: {} } } }),
    )
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.data[0].kind).toBe('unknown')
  })
})
