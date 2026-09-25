// POST /api/instagram/data-deletion — TAC-516. Meta's data-deletion
// callback, entered in the App Dashboard. A missing one is a common App
// Review rejection, and Meta tests this endpoint directly.
//
// IT ACTUALLY DELETES (ruled 2026-09-23, question 2). Recording the request
// was the option that ruling rejected. The redaction is in
// lib/messaging/instagram/delete-venue-data.ts, which documents exactly what
// is removed and what is kept; the row written here is the RECEIPT, alongside
// the work rather than instead of it.
//
// THE RESPONSE SHAPE IS META'S: { url, confirmation_code }. The url is a page
// a person can open to check the request.
//
// AN UNMATCHED ACCOUNT ALERTS. A deletion request for an account no venue
// owns is legitimate — a stale attempt, one already disconnected — and is
// answered normally. But it is ALSO what a wrong id-matching assumption looks
// like: whether signed_request's `user_id` equals the value we store in
// venues.instagram_account_id is a Meta-side fact this repo cannot verify
// (CLAUDE.md records that Meta distinguishes an app-scoped `id` from
// `user_id`). If it does not, every deletion request would match nothing,
// redact nothing, and still answer correctly — a silent failure of the one
// thing Meta tests. The alert converts that into a visible signal.
//
// 200 on every path but a bad signature, as the deauthorize route, and for
// the same reason: Meta disables a callback after repeated non-2xx.

import { captureInstagramDeletionUnmatchedAccount } from '@/lib/analytics/posthog'
import { createAdminClient } from '@/lib/db/admin'
import { findEarlierDelivery } from '@/lib/messaging/instagram/callback-receipts'
import { deleteInstagramVenueData } from '@/lib/messaging/instagram/delete-venue-data'
import {
  parseSignedRequest,
  signedRequestPayloadFingerprint,
} from '@/lib/messaging/instagram/signed-request'
import { writeCallbackReceipt } from '@/lib/messaging/instagram/write-callback-receipt'

export const dynamic = 'force-dynamic'

function statusUrl(request: Request, code: string): string {
  const base = process.env.INSTAGRAM_OAUTH_REDIRECT_URL
  // Derive the origin from the configured redirect when we have it, so the
  // URL matches the host Meta already knows, and fall back to this request's
  // own origin rather than inventing one.
  let origin: string
  try {
    origin = base ? new URL(base).origin : new URL(request.url).origin
  } catch {
    origin = new URL(request.url).origin
  }
  return `${origin}/api/instagram/data-deletion/status?id=${encodeURIComponent(code)}`
}

export async function POST(request: Request): Promise<Response> {
  const secret = process.env.INSTAGRAM_APP_SECRET ?? ''
  if (secret === '') {
    console.error('[instagram data-deletion] INSTAGRAM_APP_SECRET is not set; refusing every delivery', {
      event: 'instagram_data_deletion_misconfigured',
    })
    return new Response(null, { status: 403 })
  }

  let signed: string | null = null
  try {
    const form = await request.formData()
    const value = form.get('signed_request')
    signed = typeof value === 'string' ? value : null
  } catch {
    console.warn('[instagram data-deletion] body could not be read as a form', {
      event: 'instagram_data_deletion_unreadable_body',
    })
    return new Response(null, { status: 403 })
  }
  if (signed === null) return new Response(null, { status: 403 })

  const parsed = parseSignedRequest(signed, secret)
  if (!parsed.ok) {
    console.warn('[instagram data-deletion] signed request refused', {
      event: 'instagram_data_deletion_signature_rejected',
      reason: parsed.reason,
    })
    return new Response(null, { status: 403 })
  }

  const now = new Date()
  const supabase = createAdminClient()

  // Read BEFORE the redaction, so the answer describes the state this
  // delivery arrived into rather than the one it created.
  const fingerprint = signedRequestPayloadFingerprint(signed)
  const earlier = fingerprint === null ? null : await findEarlierDelivery(supabase, fingerprint)

  const result = await deleteInstagramVenueData(supabase, parsed.payload.userId)

  // The receipt is written whether or not the redaction succeeded, so a
  // failed one leaves a record with completed_at null rather than no trace.
  const recorded = await supabase.from('instagram_deletion_requests').insert({
    confirmation_code: result.confirmationCode,
    instagram_account_id: parsed.payload.userId,
    venue_id: result.ok ? result.venueId : null,
    guests_affected: result.ok ? result.guestsAffected : 0,
    requested_at: now.toISOString(),
    completed_at: result.ok ? now.toISOString() : null,
  })
  if (recorded.error) {
    console.error('[instagram data-deletion] could not record the request', {
      event: 'instagram_data_deletion_unrecorded',
      error: recorded.error.message,
    })
  }

  // Guarded, not merely awaited: the receipt is an audit row, and Meta
  // disables a callback after repeated non-2xx. A throw in here must never
  // be the reason a delivery fails.
  try {
    await writeCallbackReceipt(supabase, {
      callback: 'data_deletion',
      fingerprint,
      earlier,
      payload: parsed.payload,
      venueId: result.ok ? result.venueId : null,
      outcome: !result.ok ? 'failed' : result.venueId === null ? 'no_match' : 'applied',
      rowsAffected: result.ok ? result.guestsAffected : null,
      confirmationCode: result.confirmationCode,
      now,
      logPrefix: '[instagram data-deletion]',
    })
  } catch (err) {
    console.error('[instagram data-deletion] could not write the callback receipt', {
      event: 'instagram_callback_receipt_threw',
      error: err instanceof Error ? err.message : 'unknown error',
    })
  }

  if (!result.ok) {
    console.error('[instagram data-deletion] redaction failed', {
      event: 'instagram_data_deletion_failed',
      error: result.error,
    })
  } else if (result.venueId === null) {
    // See the header: legitimate, and also what a wrong id assumption looks
    // like. Loud rather than quiet.
    await captureInstagramDeletionUnmatchedAccount({ confirmationCode: result.confirmationCode })
  } else {
    console.log('[instagram data-deletion] completed', {
      event: 'instagram_data_deletion_completed',
      venueId: result.venueId,
      guestsAffected: result.guestsAffected,
    })
  }

  // Meta's required shape, on every path: a failed redaction still owes the
  // requester a confirmation code they can check.
  return Response.json({
    url: statusUrl(request, result.confirmationCode),
    confirmation_code: result.confirmationCode,
  })
}
