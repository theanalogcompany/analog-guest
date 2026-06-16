// NFC tap reconciliation — the first-time opt-in path.
//
// Flow: the eink device wrote a tap_token into its NFC payload (issued by the
// device feed, pre-linked to a transaction). The guest taps → iMessage opens
// prefilled with that token → they send → SendBlue inbound fires. Here we:
//   1. extract the token from the inbound body,
//   2. find its pending pos_tap_events row (which carries the linked txn),
//   3. attach the now-known guest (by phone) to that transaction, and
//   4. write the fingerprint→guest mapping so EVERY future visit auto-matches
//      with no tap (the whole point of the opt-in).
//
// Token-direct, not time-windowed: the token identifies the exact transaction,
// so this is precise (match_method='tap_token'). The cron handles expiry of
// taps that never received a send.

import { createAdminClient } from '@/lib/db/admin'
import type { RAGResult } from '@/lib/rag/types'

import { linkFingerprintToGuest } from './reconcile'

type AdminClient = ReturnType<typeof createAdminClient>

// Tokens are `tt_` + 32 base64url chars (see deriveTapToken). The device embeds
// one in the prefilled iMessage; we tolerate surrounding text/markup.
const TAP_TOKEN_RE = /tt_[A-Za-z0-9_-]{16,64}/

export function extractTapToken(body: string | null | undefined): string | null {
  if (!body) return null
  const m = body.match(TAP_TOKEN_RE)
  return m ? m[0] : null
}

export type TapReconcileOutcome =
  | { status: 'no_token' }
  | { status: 'tap_not_found' }
  | { status: 'matched'; transactionId: string | null }

/**
 * Reconcile a SendBlue inbound against a pending tap. Idempotent: a tap already
 * matched (status != 'pending') is treated as tap_not_found for this inbound.
 * Non-throwing (RAGResult) — a failure here must not break inbound handling.
 */
export async function reconcileTapFromInbound(opts: {
  venueId: string
  guestId: string
  phoneNumber: string
  body: string | null
  supabase?: AdminClient
}): Promise<RAGResult<TapReconcileOutcome>> {
  const token = extractTapToken(opts.body)
  if (!token) return { ok: true, data: { status: 'no_token' } }

  const supabase = opts.supabase ?? createAdminClient()

  // Claim the pending tap (CAS on status) so concurrent inbounds can't
  // double-process the same token.
  const { data: tap, error: claimError } = await supabase
    .from('pos_tap_events')
    .update({ status: 'matched', phone_number: opts.phoneNumber })
    .eq('tap_token', token)
    .eq('venue_id', opts.venueId)
    .eq('status', 'pending')
    .select('reconciled_transaction_id')
    .maybeSingle()

  if (claimError) {
    return { ok: false, error: claimError.message, errorCode: 'tap_claim_failed' }
  }
  if (!tap) {
    // Unknown token, wrong venue, or already matched — nothing to do.
    return { ok: true, data: { status: 'tap_not_found' } }
  }

  const transactionId = tap.reconciled_transaction_id
  if (!transactionId) {
    // Tap had no linked transaction (shouldn't happen via the device feed, but
    // tolerate it): the guest is identified, just no purchase to attribute.
    return { ok: true, data: { status: 'matched', transactionId: null } }
  }

  // Load the transaction to attribute it and harvest its fingerprint.
  const { data: txn, error: txnLoadError } = await supabase
    .from('transactions')
    .select('card_fingerprint, occurred_at')
    .eq('id', transactionId)
    .maybeSingle()
  if (txnLoadError) {
    return { ok: false, error: txnLoadError.message, errorCode: 'tap_txn_load_failed' }
  }

  const nowIso = new Date().toISOString()
  const { error: linkError } = await supabase
    .from('transactions')
    .update({
      guest_id: opts.guestId,
      match_method: 'tap_token',
      match_confidence: 1,
      matched_at: nowIso,
    })
    .eq('id', transactionId)
  if (linkError) {
    return { ok: false, error: linkError.message, errorCode: 'tap_txn_link_failed' }
  }

  // The payoff: map the fingerprint to the guest so future visits auto-match
  // (reconcileTransactionByFingerprint) with no further taps.
  if (txn?.card_fingerprint) {
    const linked = await linkFingerprintToGuest({
      venueId: opts.venueId,
      guestId: opts.guestId,
      cardFingerprint: txn.card_fingerprint,
      supabase,
    })
    if (!linked.ok) {
      console.warn('tap reconcile: fingerprint link failed', {
        transactionId,
        error: linked.error,
      })
    }
  }

  if (txn?.occurred_at) {
    await supabase
      .from('guests')
      .update({ last_visit_at: txn.occurred_at })
      .eq('id', opts.guestId)
      .or(`last_visit_at.is.null,last_visit_at.lt.${txn.occurred_at}`)
  }

  return { ok: true, data: { status: 'matched', transactionId } }
}

/**
 * Cron helper: expire pending taps that never received a send within the TTL
 * (the guest tapped but didn't text, or texted without the token). Keeps the
 * pending index sparse and prevents a stale tap from matching a much-later
 * inbound. Returns the number expired.
 */
export async function expireStalePendingTaps(opts: {
  now: Date
  ttlMinutes: number
  supabase?: AdminClient
}): Promise<RAGResult<{ expired: number }>> {
  const supabase = opts.supabase ?? createAdminClient()
  const cutoff = new Date(opts.now.getTime() - opts.ttlMinutes * 60_000).toISOString()
  const { data, error } = await supabase
    .from('pos_tap_events')
    .update({ status: 'expired' })
    .eq('status', 'pending')
    .lt('received_at', cutoff)
    .select('id')
  if (error) {
    return { ok: false, error: error.message, errorCode: 'tap_expiry_failed' }
  }
  return { ok: true, data: { expired: data?.length ?? 0 } }
}
