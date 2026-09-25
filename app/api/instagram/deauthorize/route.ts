// POST /api/instagram/deauthorize — TAC-516. Meta's deauthorize callback,
// entered in the App Dashboard under App Settings.
//
// Fires when a venue removes our app from their Instagram account. The
// connection is marked disconnected and `venues.instagram_account_id` is
// cleared, which frees that account to be connected again.
//
// NOTHING ABOUT GUESTS OR MESSAGES IS TOUCHED. Revocation stops future
// traffic and says nothing about past data; that is the DELETION callback,
// which has its own ruling and its own route. The Contract's "What this
// doesn't settle" states this, so that a reader does not assume disconnect
// implies erasure.
//
// 200 ON EVERY PATH EXCEPT A BAD SIGNATURE, deliberately, and for the same
// reason the webhook route does it: Meta disables a callback after repeated
// non-2xx, and a failure that is not transient would keep failing until the
// callback was switched off with no alert. A failed write is logged loudly
// instead. 403 for an unverified request is the one non-2xx, and it carries
// an empty body and nothing from the request.
//
// An UNMATCHED account is a 200 and not an error: Meta can send this for an
// account we never finished connecting, or one already disconnected.

import { findEarlierDelivery } from '@/lib/messaging/instagram/callback-receipts'
import {
  deauthorizeInstagramCredential,
} from '@/lib/messaging/instagram/credentials-store'
import {
  parseSignedRequest,
  signedRequestPayloadFingerprint,
} from '@/lib/messaging/instagram/signed-request'
import { createAdminClient } from '@/lib/db/admin'
import { writeCallbackReceipt } from '@/lib/messaging/instagram/write-callback-receipt'

export const dynamic = 'force-dynamic'

export async function POST(request: Request): Promise<Response> {
  const secret = process.env.INSTAGRAM_APP_SECRET ?? ''
  if (secret === '') {
    // Every genuine delivery fails this way until the secret is set, which is
    // why it is an error rather than a warning.
    console.error('[instagram deauthorize] INSTAGRAM_APP_SECRET is not set; refusing every delivery', {
      event: 'instagram_deauthorize_misconfigured',
    })
    return new Response(null, { status: 403 })
  }

  let signed: string | null = null
  try {
    const form = await request.formData()
    const value = form.get('signed_request')
    signed = typeof value === 'string' ? value : null
  } catch {
    // Nothing from the body is logged: an unverified body is untrusted, and
    // a parse error's message can quote it.
    console.warn('[instagram deauthorize] body could not be read as a form', {
      event: 'instagram_deauthorize_unreadable_body',
    })
    return new Response(null, { status: 403 })
  }
  if (signed === null) return new Response(null, { status: 403 })

  const parsed = parseSignedRequest(signed, secret)
  if (!parsed.ok) {
    console.warn('[instagram deauthorize] signed request refused', {
      event: 'instagram_deauthorize_signature_rejected',
      // The category only. Never the payload, the signature or our digest.
      reason: parsed.reason,
    })
    return new Response(null, { status: 403 })
  }

  const now = new Date()
  const supabase = createAdminClient()

  // Read BEFORE the work, so the answer describes the state this delivery
  // arrived into rather than the one it created.
  const fingerprint = signedRequestPayloadFingerprint(signed)
  const earlier = fingerprint === null ? null : await findEarlierDelivery(supabase, fingerprint)

  const result = await deauthorizeInstagramCredential(supabase, parsed.payload.userId, now)

  // Guarded, not merely awaited: the receipt is an audit row, and Meta
  // disables a callback after repeated non-2xx. A throw in here must never
  // be the reason a delivery fails.
  try {
    await writeCallbackReceipt(supabase, {
      callback: 'deauthorize',
      fingerprint,
      earlier,
      payload: parsed.payload,
      venueId: result.ok ? result.venueId : null,
      outcome: !result.ok ? 'failed' : result.venueId === null ? 'no_match' : 'applied',
      // Deauthorize touches no guest data at all, by design: revocation stops
      // future traffic and says nothing about past data.
      rowsAffected: null,
      confirmationCode: null,
      now,
      logPrefix: '[instagram deauthorize]',
    })
  } catch (err) {
    console.error('[instagram deauthorize] could not write the callback receipt', {
      event: 'instagram_callback_receipt_threw',
      error: err instanceof Error ? err.message : 'unknown error',
    })
  }

  if (!result.ok) {
    console.error('[instagram deauthorize] could not mark the venue disconnected', {
      event: 'instagram_deauthorize_failed',
      error: result.error,
    })
    // Still 200. See the header: a non-2xx here eventually costs us the
    // callback itself, and the failure is already logged at error level.
    return Response.json({ ok: false })
  }

  console.log('[instagram deauthorize] processed', {
    event: 'instagram_deauthorize_processed',
    venueId: result.venueId,
    matched: result.venueId !== null,
  })
  return Response.json({ ok: true })
}
