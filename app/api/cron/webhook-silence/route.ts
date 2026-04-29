// Daily cron route. Vercel invokes this on the schedule defined in
// vercel.json (currently "0 9 * * *" = 09:00 UTC). Vercel attaches
// `Authorization: Bearer ${env.CRON_SECRET}` automatically when CRON_SECRET
// is set in the project's environment variables.
//
// CRON_SECRET must be added to Vercel env vars before the first scheduled
// run. In dev, the auth check is skipped so `curl localhost:3000/api/cron/...`
// works without the header.
//
// Per the THE-187 webhook-silence event spec:
//   - Filter to non-test venues (venues.is_test = false).
//   - Only fire when at least one prior inbound exists (lastInboundAt IS NOT
//     NULL); initial-state silence is not actionable.
//   - Threshold: 24 hours since the most recent inbound across non-test
//     venues. Below threshold, return 200 with no event. Above threshold,
//     emit `webhook_silence` and still return 200 (the event itself is the
//     signal — Vercel cron doesn't retry).

import {
  captureWebhookSilence,
  WEBHOOK_SILENCE_THRESHOLD_HOURS,
} from '@/lib/analytics/posthog'
import { createAdminClient } from '@/lib/db/admin'

const HOUR_MS = 60 * 60 * 1000

function isAuthorized(request: Request): boolean {
  if (process.env.NODE_ENV !== 'production') return true
  const expected = process.env.CRON_SECRET
  if (!expected) return false
  return request.headers.get('authorization') === `Bearer ${expected}`
}

export async function GET(request: Request): Promise<Response> {
  if (!isAuthorized(request)) {
    return new Response('Unauthorized', { status: 401 })
  }

  const supabase = createAdminClient()

  const { data: venueRows, error: venuesError } = await supabase
    .from('venues')
    .select('id')
    .eq('is_test', false)
  if (venuesError) {
    console.error('cron webhook-silence: venues lookup failed', {
      error: venuesError.message,
    })
    return new Response('Internal error', { status: 500 })
  }
  const venueIds = (venueRows ?? []).map((v) => v.id)
  if (venueIds.length === 0) {
    return Response.json({
      ok: true,
      hoursWithoutWebhook: null,
      reason: 'no production venues',
    })
  }

  const { data: lastInbound, error: msgError } = await supabase
    .from('messages')
    .select('created_at')
    .eq('direction', 'inbound')
    .in('venue_id', venueIds)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (msgError) {
    console.error('cron webhook-silence: messages lookup failed', {
      error: msgError.message,
    })
    return new Response('Internal error', { status: 500 })
  }
  if (!lastInbound) {
    // No inbound history yet for any production venue — initial state, not
    // actionable silence. Per spec: don't emit.
    return Response.json({
      ok: true,
      hoursWithoutWebhook: null,
      reason: 'no inbound history',
    })
  }

  const lastWebhookAt = lastInbound.created_at
  const elapsedMs = Date.now() - new Date(lastWebhookAt).getTime()
  const hoursWithoutWebhook = Math.floor(elapsedMs / HOUR_MS)

  if (hoursWithoutWebhook > WEBHOOK_SILENCE_THRESHOLD_HOURS) {
    await captureWebhookSilence({ hoursWithoutWebhook, lastWebhookAt })
  }

  return Response.json({ ok: true, hoursWithoutWebhook, lastWebhookAt })
}