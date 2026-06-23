// Live end-to-end test for the Square integration. Exercises the real code path
// (parse webhook -> map -> ingest -> reconcile) against the Square SANDBOX and
// the live database, then cleans up after itself so it's safely re-runnable.
//
//   npm run square-e2e
//
// Requires .env.local with SQUARE_ENV=sandbox + SQUARE_SANDBOX_ACCESS_TOKEN +
// Supabase keys. Creates real sandbox orders/payments (free, sandbox) against
// the Mock Sextant venue + a dedicated test guest, asserts the outcomes, then
// deletes the rows it created.

import { randomUUID } from 'node:crypto'

import { createAdminClient } from '@/lib/db/admin'
import { ingestTransaction } from '@/lib/pos/ingest-transaction'
import { linkFingerprintToGuest } from '@/lib/pos/reconcile'
import { squareClientFromEnv } from '@/lib/pos/square/client'
import { parseSquareWebhook } from '@/lib/pos/square/parse-webhook'

const VENUE = '5cd8231f-6c54-4ac2-9c60-b75d2801f579' // Mock Sextant Coffee Roasters
const LOCATION = 'LAVV773570DWH' // sandbox default location
const TEST_PHONE = '+15550009999'

const db = createAdminClient()
const { client } = squareClientFromEnv()

let passed = 0
let failed = 0
function check(label: string, ok: boolean, detail?: string): void {
  console.log(`   ${ok ? 'PASS' : 'FAIL'} — ${label}${detail ? ` (${detail})` : ''}`)
  if (ok) passed++
  else failed++
}

type SnakePayment = {
  id: string
  created_at?: string
  status?: string
  location_id?: string
  order_id?: string
  amount_money: { amount: number; currency?: string }
  card_details: { card: { fingerprint?: string } }
}

async function createOrderAndPayment(itemName: string): Promise<SnakePayment> {
  const order = await client.orders.create({
    idempotencyKey: randomUUID(),
    order: {
      locationId: LOCATION,
      lineItems: [{ name: itemName, quantity: '1', basePriceMoney: { amount: BigInt(650), currency: 'USD' } }],
    },
  })
  const pay = await client.payments.create({
    idempotencyKey: randomUUID(),
    sourceId: 'cnon:card-nonce-ok',
    amountMoney: { amount: BigInt(650), currency: 'USD' },
    orderId: order.order!.id!,
    locationId: LOCATION,
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
    amount_money: { amount: Number(p.amountMoney!.amount), currency: p.amountMoney!.currency ?? 'USD' },
    card_details: { card: { fingerprint: p.cardDetails?.card?.fingerprint } },
  }
}

async function ingestViaWebhook(payment: SnakePayment): Promise<void> {
  const envelope = {
    merchant_id: 'TEST_MERCHANT',
    type: 'payment.created',
    event_id: 'evt_' + randomUUID(),
    data: { type: 'payment', object: { payment } },
  }
  const parsed = parseSquareWebhook(JSON.stringify(envelope))
  if (!parsed.ok) throw new Error('parse failed: ' + parsed.error)
  const ev = parsed.data[0]
  if (ev.kind !== 'transaction') throw new Error('expected transaction event, got ' + ev.kind)
  await ingestTransaction(ev.data)
}

async function main(): Promise<void> {
  const createdExternalIds: string[] = []

  // Setup: ensure the venue's Square connection + a test guest exist.
  await db
    .from('pos_credentials')
    .upsert({ venue_id: VENUE, provider: 'square', location_external_id: LOCATION, is_active: true }, { onConflict: 'venue_id,provider' })
  const { data: guest } = await db
    .from('guests')
    .upsert({ venue_id: VENUE, phone_number: TEST_PHONE, created_via: 'manual' }, { onConflict: 'venue_id,phone_number' })
    .select('id')
    .single()
  const guestId = guest!.id

  // The sandbox test card yields a DETERMINISTIC fingerprint, so a mapping left
  // by a prior run would auto-match TEST 1's payment. Clear it up front so the
  // "unmatched until mapped" assertion is meaningful.
  await db.from('guest_card_fingerprints').delete().eq('venue_id', VENUE).eq('guest_id', guestId)

  try {
    console.log('TEST 1 — ingest a sandbox payment (line items + fingerprint)')
    const pay1 = await createOrderAndPayment('Matcha Latte')
    createdExternalIds.push(pay1.id)
    await ingestViaWebhook(pay1)
    const { data: t1 } = await db
      .from('transactions')
      .select('amount_cents, card_fingerprint, guest_id, raw_data')
      .eq('external_id', pay1.id)
      .maybeSingle()
    const items1 = (t1?.raw_data as { line_items?: { name: string }[] } | null)?.line_items ?? []
    check('transaction landed', !!t1)
    check('amount correct', t1?.amount_cents === 650)
    check('card fingerprint captured', !!t1?.card_fingerprint, t1?.card_fingerprint ?? 'none')
    check('line items present', items1[0]?.name?.toLowerCase() === 'matcha latte', items1.map((i) => i.name).join(', '))
    check('unmatched before fingerprint is mapped', t1?.guest_id === null)

    console.log('\nTEST 2 — returning guest auto-matches by fingerprint (no tap)')
    const fp = pay1.card_details.card.fingerprint!
    await linkFingerprintToGuest({ venueId: VENUE, guestId, cardFingerprint: fp })
    const pay2 = await createOrderAndPayment('Almond Croissant')
    createdExternalIds.push(pay2.id)
    await ingestViaWebhook(pay2)
    const { data: t2 } = await db
      .from('transactions')
      .select('guest_id, match_method')
      .eq('external_id', pay2.id)
      .maybeSingle()
    check('2nd payment auto-attributed to the guest', t2?.guest_id === guestId)
    check("match_method is 'card_fingerprint'", t2?.match_method === 'card_fingerprint')

    console.log('\nTEST 3 — idempotency (re-deliver the same payment)')
    await ingestViaWebhook(pay1)
    const { count } = await db
      .from('transactions')
      .select('id', { count: 'exact', head: true })
      .eq('external_id', pay1.id)
    check('no duplicate transaction row', count === 1, `rows=${count}`)
  } finally {
    // Cleanup so the test is re-runnable and leaves no residue.
    if (createdExternalIds.length > 0) {
      await db.from('transactions').delete().in('external_id', createdExternalIds)
    }
    await db.from('guest_card_fingerprints').delete().eq('venue_id', VENUE).eq('guest_id', guestId)
  }

  console.log(`\n${failed === 0 ? '✅ ALL PASSED' : '❌ FAILURES'} — ${passed} passed, ${failed} failed`)
  if (failed > 0) process.exit(1)
}

main().catch((e) => {
  console.error('FAIL:', e instanceof Error ? e.message : e)
  process.exit(1)
})
