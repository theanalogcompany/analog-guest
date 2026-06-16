// Server-only route. Square calls this endpoint for payment / order / catalog /
// inventory events. Mirrors the Sendblue webhook discipline
// (app/api/webhooks/sendblue/route.ts):
//   - verify the HMAC signature (401 on mismatch)
//   - parse + normalize (400 on bad body)
//   - idempotency on the provider event_id (pos_webhook_events)
//   - fast 200 ack; heavy work runs in waitUntil after the response
//   - 200 for all known error paths; 5xx ONLY on unhandled throws / missing
//     config, because Square retries on 5xx and we only want retries on
//     transient infra failures.
//
// HIGH-STAKES per CLAUDE.md (payment-adjacent + webhook handler) — flagged for
// explicit human review on this PR.

import { waitUntil } from '@vercel/functions'

import { capturePostHogEvent } from '@/lib/analytics/posthog'
import { createAdminClient } from '@/lib/db/admin'
import { ingestTransaction } from '@/lib/pos/ingest-transaction'
import { getProvider } from '@/lib/pos/registry'
import { resolveVenueByLocation, resolveVenueByMerchant } from '@/lib/pos/resolve-venue'
import { syncCatalog } from '@/lib/pos/sync-catalog'
import { applyInventoryCounts } from '@/lib/pos/sync-inventory'
import type { InventoryCount, NormalizedEvent } from '@/lib/pos/types'

type AdminClient = ReturnType<typeof createAdminClient>

function eventTypeLabel(event: NormalizedEvent): string {
  return event.kind === 'unknown' ? `unknown:${event.type}` : event.kind
}

/**
 * Record the delivery for idempotency. Returns true if this is the first time
 * we've seen the provider event_id, false if it's a duplicate (UNIQUE violation
 * on (provider, event_id)) — in which case the caller skips processing.
 */
async function recordWebhookEvent(
  supabase: AdminClient,
  event: NormalizedEvent,
  payload: unknown,
): Promise<boolean> {
  const { error } = await supabase.from('pos_webhook_events').insert({
    provider: 'square',
    event_id: event.eventId,
    event_type: eventTypeLabel(event),
    signature_verified: true,
    payload: payload as never,
  })
  if (!error) return true
  if (error.code === '23505') return false // duplicate delivery — already handled
  // Unexpected DB error: treat as not-recorded and let processing proceed once.
  // Logged so a persistent failure is visible; the transaction upsert is itself
  // idempotent, so a missed idempotency row can't double-create a transaction.
  console.error('square webhook: idempotency insert failed', {
    eventId: event.eventId,
    error: error.message,
  })
  return true
}

async function markProcessed(supabase: AdminClient, eventId: string): Promise<void> {
  const { error } = await supabase
    .from('pos_webhook_events')
    .update({ processed_at: new Date().toISOString() })
    .eq('provider', 'square')
    .eq('event_id', eventId)
  if (error) {
    console.error('square webhook: mark-processed failed', { eventId, error: error.message })
  }
}

// Latency instrumentation: the empirical answer to "how long until
// a transaction reaches us" — the dataset that tunes tap↔transaction
// reconciliation. Keys on the merchant so it can be sliced per venue later.
function captureLatency(event: Extract<NormalizedEvent, { kind: 'transaction' }>): void {
  const occurredMs = Date.parse(event.data.occurredAt)
  if (Number.isNaN(occurredMs)) return
  const latencyMs = Date.now() - occurredMs
  void capturePostHogEvent('square_webhook_latency', event.data.merchantExternalId ?? 'square', {
    latencyMs,
    eventId: event.eventId,
    status: event.data.status,
  })
}

// Inventory counts can span locations; group by location, resolve each to its
// venue, and apply per venue. A location with no connected venue is skipped.
async function processInventory(supabase: AdminClient, counts: InventoryCount[]): Promise<void> {
  const byLocation = new Map<string, InventoryCount[]>()
  for (const c of counts) {
    const group = byLocation.get(c.locationExternalId) ?? []
    group.push(c)
    byLocation.set(c.locationExternalId, group)
  }
  for (const [location, group] of byLocation) {
    const venueId = await resolveVenueByLocation(supabase, 'square', location)
    if (venueId) await applyInventoryCounts({ venueId, counts: group, supabase })
  }
}

export async function POST(request: Request): Promise<Response> {
  try {
    const rawBody = await request.text()
    const provider = getProvider('square')

    const notificationUrl = process.env.SQUARE_WEBHOOK_URL
    if (!notificationUrl) {
      // Misconfiguration, not a bad request — 500 so it's loud (and Square
      // retries until the env var is set). Mirrors the missing-env posture.
      console.error('square webhook: SQUARE_WEBHOOK_URL not set')
      return new Response('Server misconfigured', { status: 500 })
    }

    if (!provider.verifyWebhook(rawBody, request.headers, notificationUrl)) {
      console.warn('square webhook: invalid signature', { url: request.url })
      return new Response('Invalid signature', { status: 401 })
    }

    const parsed = provider.parseWebhook(rawBody)
    if (!parsed.ok) {
      console.error('square webhook: parse failed', { url: request.url, error: parsed.error })
      return new Response('Invalid payload', { status: 400 })
    }

    // Already verified + parsed above, so this re-parse is for the audit payload
    // only and cannot throw.
    const payload: unknown = JSON.parse(rawBody)
    const supabase = createAdminClient()

    for (const event of parsed.data) {
      const isNew = await recordWebhookEvent(supabase, event, payload)
      if (!isNew) continue

      if (event.kind === 'transaction') {
        captureLatency(event)
        const { data, eventId } = event
        waitUntil(ingestTransaction(data).then(() => markProcessed(supabase, eventId)))
      } else if (event.kind === 'catalog_updated') {
        const { eventId, merchantExternalId } = event
        waitUntil(
          (async () => {
            const venueId = await resolveVenueByMerchant(supabase, 'square', merchantExternalId)
            if (venueId) await syncCatalog({ venueId, supabase })
            await markProcessed(supabase, eventId)
          })(),
        )
      } else if (event.kind === 'inventory_updated') {
        const { eventId, counts } = event
        waitUntil(processInventory(supabase, counts).then(() => markProcessed(supabase, eventId)))
      } else {
        // unknown — recorded above for idempotency/audit; nothing to do.
        waitUntil(markProcessed(supabase, event.eventId))
      }
    }

    return new Response('OK', { status: 200 })
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    const stack = e instanceof Error ? e.stack : undefined
    console.error('square webhook: unexpected error', { url: request.url, error: message, stack })
    return new Response('Internal error', { status: 500 })
  }
}
