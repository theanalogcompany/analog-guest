// Fake a Square sale for a venue, end to end through the production ingest.
//
//   npm run square-fake-sale -- --venue <venueId> [--item "Oat Cortado"]
//
// Places a real SANDBOX order and payment and delivers it as Square's webhook
// would, so the transaction lands for the venue and the receipt printer's feed
// (GET /api/devices/{id}/print-jobs) serves it as a job. The row is kept: this
// is the thing you scan a printed receipt against. `npm run square-e2e` is the
// version that cleans up after itself.
//
// REFUSES unless the venue is the one Square's location resolves to, because
// ingest attributes a payment by location alone and a second active venue on
// the same sandbox location makes it attribute to nobody.

import { createAdminClient } from '@/lib/db/admin'
import { resolveVenueByLocation } from '@/lib/pos/resolve-venue'

import { createSandboxPayment, ingestViaWebhook } from './lib/square-sandbox'

function arg(name: string): string | null {
  const i = process.argv.indexOf(name)
  return i >= 0 ? (process.argv[i + 1] ?? null) : null
}

async function main(): Promise<void> {
  const venueId = arg('--venue')
  const item = arg('--item') ?? 'Oat Cortado'
  if (!venueId) {
    console.error(
      'usage: npm run square-fake-sale -- --venue <venueId> [--item "<name>"]',
    )
    process.exit(1)
  }
  const db = createAdminClient()

  const { data: cred, error } = await db
    .from('pos_credentials')
    .select('location_external_id, is_active')
    .eq('venue_id', venueId)
    .eq('provider', 'square')
    .maybeSingle()
  if (error) {
    console.error(`error: credential lookup failed: ${error.message}`)
    process.exit(1)
  }
  if (!cred?.location_external_id || !cred.is_active) {
    console.error(
      `error: venue ${venueId} has no active Square connection (pos_credentials).`,
    )
    process.exit(1)
  }
  const resolved = await resolveVenueByLocation(
    db,
    'square',
    cred.location_external_id,
  )
  if (resolved !== venueId) {
    console.error(
      `error: Square location ${cred.location_external_id} resolves to ` +
        `${resolved ?? 'no venue'}, not ${venueId}. Another active venue shares it.`,
    )
    process.exit(1)
  }

  const payment = await createSandboxPayment(item, cred.location_external_id)
  await ingestViaWebhook(payment)
  const { data: txn } = await db
    .from('transactions')
    .select('id, occurred_at')
    .eq('venue_id', venueId)
    .eq('external_id', payment.id)
    .maybeSingle()
  if (!txn) {
    console.error(`error: payment ${payment.id} did not land as a transaction`)
    process.exit(1)
  }
  console.log(`fake sale  ${item}`)
  console.log(`payment    ${payment.id}`)
  console.log(`txn        ${txn.id} at ${txn.occurred_at}`)
}

main().catch((e) => {
  console.error('error:', e instanceof Error ? e.message : e)
  process.exit(1)
})
