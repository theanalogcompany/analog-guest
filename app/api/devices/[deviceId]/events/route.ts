// GET /api/devices/{deviceId}/events?since=<ISO>
// The eink device's event feed. Returns transactions for the device's venue
// newer than `since`, each with a tap_token the device writes into its NFC
// payload. Auth: Authorization: Bearer <device token> (sha256-compared to the
// stored hash). Served on the guest host (no /admin gate).
//
// Founder owns the firmware; this is the endpoint contract. Polling MVP —
// SSE/MQTT is a later upgrade.

import { createAdminClient } from '@/lib/db/admin'
import { buildDeviceEvents, deriveTapToken, verifyDeviceToken } from '@/lib/pos/devices'

type AdminClient = ReturnType<typeof createAdminClient>

const MAX_EVENTS = 50

function bearer(request: Request): string | null {
  const header = request.headers.get('authorization')
  if (!header) return null
  const [scheme, token] = header.split(' ')
  return scheme?.toLowerCase() === 'bearer' && token ? token : null
}

// Pre-create a pending tap_event per issued token so the SendBlue inbound can
// resolve the token → the linked transaction. Idempotent on the
// deterministic tap_token (UNIQUE) — re-polls don't duplicate.
async function ensureTapEvents(
  supabase: AdminClient,
  venueId: string,
  locationExternalId: string | null,
  deviceId: string,
  events: { txId: string; tapToken: string }[],
): Promise<void> {
  if (events.length === 0) return
  const rows = events.map((e) => ({
    tap_token: e.tapToken,
    venue_id: venueId,
    device_id: deviceId,
    location_external_id: locationExternalId,
    reconciled_transaction_id: e.txId,
    status: 'pending',
  }))
  const { error } = await supabase
    .from('pos_tap_events')
    .upsert(rows, { onConflict: 'tap_token', ignoreDuplicates: true })
  if (error) {
    console.error('eink feed: tap_event upsert failed', { deviceId, error: error.message })
  }
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ deviceId: string }> },
): Promise<Response> {
  try {
    const { deviceId } = await params
    const token = bearer(request)
    if (!token) {
      return Response.json({ error: 'unauthorized' }, { status: 401 })
    }

    const tapSecret = process.env.POS_TOKEN_ENC_KEY
    if (!tapSecret) {
      console.error('eink feed: POS_TOKEN_ENC_KEY not set')
      return Response.json({ error: 'internal_error' }, { status: 500 })
    }

    const supabase = createAdminClient()
    const { data: device, error: deviceError } = await supabase
      .from('pos_devices')
      .select('venue_id, location_external_id, device_token_hash')
      .eq('device_id', deviceId)
      .maybeSingle()
    if (deviceError) {
      console.error('eink feed: device lookup failed', { deviceId, error: deviceError.message })
      return Response.json({ error: 'internal_error' }, { status: 500 })
    }
    // Uniform 401 for unknown device or bad token — don't leak which devices exist.
    if (!device || !verifyDeviceToken(token, device.device_token_hash)) {
      return Response.json({ error: 'unauthorized' }, { status: 401 })
    }

    const since = new URL(request.url).searchParams.get('since')
    let query = supabase
      .from('transactions')
      .select('id, occurred_at, guest_id')
      .eq('venue_id', device.venue_id)
      .eq('source', 'square')
      .order('occurred_at', { ascending: true })
      .limit(MAX_EVENTS)
    if (since) query = query.gt('occurred_at', since)

    const { data: rows, error: txError } = await query
    if (txError) {
      console.error('eink feed: transaction query failed', { deviceId, error: txError.message })
      return Response.json({ error: 'internal_error' }, { status: 500 })
    }

    const events = buildDeviceEvents(rows ?? [], (txId) => deriveTapToken(txId, tapSecret))
    await ensureTapEvents(
      supabase,
      device.venue_id,
      device.location_external_id,
      deviceId,
      events.map((e) => ({ txId: e.txId, tapToken: e.tapToken })),
    )

    // Best-effort heartbeat; ignore failure.
    await supabase
      .from('pos_devices')
      .update({ last_seen_at: new Date().toISOString() })
      .eq('device_id', deviceId)

    // Cursor = the newest occurred_at returned; the device echoes it as ?since.
    const cursor = events.length > 0 ? events[events.length - 1].at : since
    return Response.json({ cursor, events })
  } catch (e) {
    console.error('eink feed: unexpected error', {
      error: e instanceof Error ? e.message : String(e),
    })
    return Response.json({ error: 'internal_error' }, { status: 500 })
  }
}
