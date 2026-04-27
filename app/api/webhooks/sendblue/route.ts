// Server-only route. Sendblue calls this endpoint for both inbound messages
// and outbound message status updates. We never call ourselves.
//
// All known error paths return 200 with a structured log. 5xx is reserved
// strictly for unhandled throws (e.g. missing env var, lost DB connection),
// because Sendblue retries on 5xx and we only want retries on transient
// infra failures, not on "venue not found" / "schema mismatch" / etc.

import { createAdminClient } from '@/lib/db/admin'
import {
  SendblueWebhookPayloadSchema,
  type SendblueWebhookPayload,
  verifyWebhookSignature,
} from '@/lib/messaging'

type AdminSupabaseClient = ReturnType<typeof createAdminClient>

type InternalMessageStatus = 'sending' | 'sent' | 'delivered' | 'failed'

// 'RECEIVED' is excluded here because it only appears on inbound webhooks
// (is_outbound=false); the status-update path guards it out before calling.
function mapSendblueStatus(
  status: Exclude<SendblueWebhookPayload['status'], 'RECEIVED'>,
): InternalMessageStatus {
  switch (status) {
    case 'QUEUED':
      return 'sending'
    case 'SENT':
      return 'sent'
    case 'DELIVERED':
      return 'delivered'
    case 'ERROR':
      return 'failed'
  }
}

async function handleInbound(
  payload: SendblueWebhookPayload,
  supabase: AdminSupabaseClient,
): Promise<Response> {
  // Sendblue convention: payload.number is always the recipient,
  // payload.from_number is always the sender. On inbound the venue is the
  // recipient and the guest is the sender.
  const venueNumber = payload.number
  const guestNumber = payload.from_number

  const { data: venue, error: venueError } = await supabase
    .from('venues')
    .select('id')
    .eq('messaging_phone_number', venueNumber)
    .maybeSingle()
  if (venueError) {
    console.error('webhook inbound: venue lookup failed', {
      venueNumber,
      error: venueError.message,
    })
    return new Response('OK', { status: 200 })
  }
  if (!venue) {
    console.warn('webhook inbound: venue not found for to-number', {
      from: guestNumber,
      to: venueNumber,
    })
    return new Response('OK', { status: 200 })
  }

  const { data: existingGuest, error: guestLookupError } = await supabase
    .from('guests')
    .select('id')
    .eq('venue_id', venue.id)
    .eq('phone_number', guestNumber)
    .maybeSingle()
  if (guestLookupError) {
    console.error('webhook inbound: guest lookup failed', {
      venueId: venue.id,
      guestNumber,
      error: guestLookupError.message,
    })
    return new Response('OK', { status: 200 })
  }

  let guestId: string
  if (existingGuest) {
    guestId = existingGuest.id
  } else {
    const nowIso = new Date().toISOString()
    const { data: newGuest, error: insertGuestError } = await supabase
      .from('guests')
      .insert({
        venue_id: venue.id,
        phone_number: guestNumber,
        // TODO: add 'inbound_message' to guests.created_via check constraint in
        // a future migration; switch this value at the same time. May also
        // want 'nfc_inbound' when THE-34 ships.
        created_via: 'manual',
        first_contacted_at: nowIso,
        last_inbound_at: nowIso,
        last_interaction_at: nowIso,
      })
      .select('id')
      .single()
    if (insertGuestError || !newGuest) {
      console.error('webhook inbound: guest insert failed', {
        venueId: venue.id,
        guestNumber,
        error: insertGuestError?.message,
      })
      return new Response('OK', { status: 200 })
    }
    guestId = newGuest.id
  }

  // TODO: switch to ON CONFLICT DO NOTHING after provider_message_id gets a
  // unique constraint.
  const { data: existingMessage, error: idempotencyError } = await supabase
    .from('messages')
    .select('id')
    .eq('provider_message_id', payload.message_handle)
    .maybeSingle()
  if (idempotencyError) {
    console.error('webhook inbound: idempotency lookup failed', {
      messageHandle: payload.message_handle,
      error: idempotencyError.message,
    })
    return new Response('OK', { status: 200 })
  }
  if (existingMessage) {
    return new Response('OK', { status: 200 })
  }

  const mediaUrl = payload.media_url ?? null
  const hasContent = Boolean(payload.content && payload.content.length > 0)
  const mediaUrls: string[] = mediaUrl !== null && mediaUrl.length > 0 ? [mediaUrl] : []
  const hasMedia = mediaUrls.length > 0
  if (!hasContent && !hasMedia) {
    console.warn('webhook inbound: empty content (no body, no media); skipping insert', {
      messageHandle: payload.message_handle,
      venueId: venue.id,
      guestId,
    })
    return new Response('OK', { status: 200 })
  }

  const { error: insertMessageError } = await supabase.from('messages').insert({
    venue_id: venue.id,
    guest_id: guestId,
    direction: 'inbound',
    status: 'received',
    body: payload.content ?? '',
    media_urls: mediaUrls,
    provider_message_id: payload.message_handle,
  })
  if (insertMessageError) {
    console.error('webhook inbound: message insert failed', {
      messageHandle: payload.message_handle,
      venueId: venue.id,
      guestId,
      error: insertMessageError.message,
    })
    return new Response('OK', { status: 200 })
  }

  // TODO(THE-122): call lib/agent's handleInbound here, wrapped in waitUntil()
  // for async execution.

  return new Response('OK', { status: 200 })
}

async function handleStatusUpdate(
  payload: SendblueWebhookPayload,
  supabase: AdminSupabaseClient,
): Promise<Response> {
  if (payload.status === 'RECEIVED') {
    // Shouldn't happen — RECEIVED is for inbound messages, but Sendblue's
    // schema doesn't formally couple status to is_outbound, so guard it.
    console.warn('webhook status: RECEIVED status on outbound webhook path; ignoring', {
      messageHandle: payload.message_handle,
    })
    return new Response('OK', { status: 200 })
  }

  const { data: message, error: lookupError } = await supabase
    .from('messages')
    .select('id, status')
    .eq('provider_message_id', payload.message_handle)
    .maybeSingle()
  if (lookupError) {
    console.error('webhook status: message lookup failed', {
      messageHandle: payload.message_handle,
      error: lookupError.message,
    })
    return new Response('OK', { status: 200 })
  }
  if (!message) {
    console.warn('webhook status: message not found for handle', {
      messageHandle: payload.message_handle,
      sendblueStatus: payload.status,
    })
    return new Response('OK', { status: 200 })
  }

  const newStatus = mapSendblueStatus(payload.status)
  // TODO: rank statuses to prevent downgrade on out-of-order webhook delivery
  // (sending=1, sent=2, delivered=3, failed=3 — only update if new rank >= current).
  // Also: clear delivered_at when transitioning away from 'delivered' (rare).
  const update: {
    status: InternalMessageStatus
    delivered_at?: string
    failure_reason?: string
  } = { status: newStatus }
  if (newStatus === 'delivered') {
    update.delivered_at = new Date().toISOString()
  }
  if (newStatus === 'failed') {
    // error_code can be string or number per Sendblue docs; coerce to string.
    update.failure_reason = String(payload.error_message ?? payload.error_code ?? 'unknown')
  }

  const { error: updateError } = await supabase
    .from('messages')
    .update(update)
    .eq('id', message.id)
  if (updateError) {
    console.error('webhook status: message update failed', {
      messageId: message.id,
      messageHandle: payload.message_handle,
      newStatus,
      error: updateError.message,
    })
    return new Response('OK', { status: 200 })
  }

  return new Response('OK', { status: 200 })
}

/**
 * Sendblue webhook handler.
 *
 * Server-only. Verifies the request signature against SENDBLUE_SIGNING_SECRET,
 * parses the payload via SendblueWebhookPayloadSchema (Zod), and branches on
 * is_outbound: inbound webhooks persist a new messages row (looking up the
 * venue and looking up or creating the guest); outbound webhooks update the
 * status of an existing messages row. Idempotent on retries via
 * provider_message_id (inbound) and by-id update (status).
 *
 * Returns 200 for all known error paths (logging structured payloads), 401
 * on signature failure, 400 on payload parse failure, and 500 only for
 * unhandled throws so Sendblue retries only on true server errors.
 */
export async function POST(request: Request): Promise<Response> {
  try {
    const rawBody = await request.text()

    if (!verifyWebhookSignature(request.headers)) {
      console.warn('webhook: invalid signature', { url: request.url })
      return new Response('Invalid signature', { status: 401 })
    }

    let parsedJson: unknown
    try {
      parsedJson = JSON.parse(rawBody)
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      console.error('webhook: invalid JSON', { url: request.url, error: message })
      return new Response('Invalid payload', { status: 400 })
    }

    const result = SendblueWebhookPayloadSchema.safeParse(parsedJson)
    if (!result.success) {
      console.error('webhook: schema validation failed', {
        url: request.url,
        issues: JSON.stringify(result.error.issues, null, 2),
      })
      return new Response('Invalid payload', { status: 400 })
    }

    const payload = result.data
    const supabase = createAdminClient()
    return payload.is_outbound
      ? await handleStatusUpdate(payload, supabase)
      : await handleInbound(payload, supabase)
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    const stack = e instanceof Error ? e.stack : undefined
    console.error('webhook: unexpected error', { url: request.url, error: message, stack })
    return new Response('Internal error', { status: 500 })
  }
}