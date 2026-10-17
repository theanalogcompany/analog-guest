// Sandbox Square helpers shared by `square-e2e` and `square-fake-sale`: place a
// real sandbox order and payment, and deliver it through the production webhook
// parse -> map -> ingest path. One copy, so the fake sale a person runs by hand
// is the same one the e2e asserts on.

import { randomUUID } from 'node:crypto'

import { ingestTransaction } from '@/lib/pos/ingest-transaction'
import { squareClientFromEnv } from '@/lib/pos/square/client'
import { parseSquareWebhook } from '@/lib/pos/square/parse-webhook'

export type SnakePayment = {
  id: string
  created_at?: string
  status?: string
  location_id?: string
  order_id?: string
  amount_money: { amount: number; currency?: string }
  card_details: { card: { fingerprint?: string } }
}

export async function createSandboxPayment(
  itemName: string,
  locationId: string,
): Promise<SnakePayment> {
  const { client } = squareClientFromEnv()
  const order = await client.orders.create({
    idempotencyKey: randomUUID(),
    order: {
      locationId,
      lineItems: [
        {
          name: itemName,
          quantity: '1',
          basePriceMoney: { amount: BigInt(650), currency: 'USD' },
        },
      ],
    },
  })
  const pay = await client.payments.create({
    idempotencyKey: randomUUID(),
    sourceId: 'cnon:card-nonce-ok',
    amountMoney: { amount: BigInt(650), currency: 'USD' },
    orderId: order.order!.id!,
    locationId,
  })
  const p = pay.payment!
  // Re-serialize the SDK (camelCase) payment into the snake_case shape Square
  // delivers on a webhook, so parse + map run exactly as in production.
  return {
    id: p.id!,
    created_at: p.createdAt,
    status: p.status,
    location_id: p.locationId,
    order_id: p.orderId,
    amount_money: {
      amount: Number(p.amountMoney!.amount),
      currency: p.amountMoney!.currency ?? 'USD',
    },
    card_details: { card: { fingerprint: p.cardDetails?.card?.fingerprint } },
  }
}

export async function ingestViaWebhook(payment: SnakePayment): Promise<void> {
  const envelope = {
    merchant_id: 'TEST_MERCHANT',
    type: 'payment.created',
    event_id: 'evt_' + randomUUID(),
    data: { type: 'payment', object: { payment } },
  }
  const parsed = parseSquareWebhook(JSON.stringify(envelope))
  if (!parsed.ok) throw new Error('parse failed: ' + parsed.error)
  const ev = parsed.data[0]
  if (ev.kind !== 'transaction')
    throw new Error('expected transaction event, got ' + ev.kind)
  await ingestTransaction(ev.data)
}
