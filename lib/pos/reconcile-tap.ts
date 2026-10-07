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
import { logger } from '@/lib/observability/logger'
import type { RAGResult } from '@/lib/rag/types'

import { linkFingerprintToGuest } from './reconcile'

type AdminClient = ReturnType<typeof createAdminClient>

// Tokens are `tt_` + 32 base64url chars (see deriveTapToken). The device embeds
// one in the prefilled iMessage; we tolerate surrounding text/markup.
const TAP_TOKEN_RE = /tt_[A-Za-z0-9_-]{16,64}/

export function extractTapToken(
  body: string | null | undefined,
): string | null {
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
    return {
      ok: false,
      error: claimError.message,
      errorCode: 'tap_claim_failed',
    }
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
    return {
      ok: false,
      error: txnLoadError.message,
      errorCode: 'tap_txn_load_failed',
    }
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
    return {
      ok: false,
      error: linkError.message,
      errorCode: 'tap_txn_link_failed',
    }
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
      logger.warn('tap reconcile: fingerprint link failed', {
        transactionId,
        error: linked.error,
      })
    }
  }

  if (txn?.occurred_at) {
    // TAC-377: precision moves with the timestamp — see reconcile.ts for why
    // writing one without the other permanently suppresses post_visit_* for
    // a guest who self-reported before their first tap.
    await supabase
      .from('guests')
      .update({
        last_visit_at: txn.occurred_at,
        last_visit_precision: 'pinned',
      })
      .eq('id', opts.guestId)
      .or(`last_visit_at.is.null,last_visit_at.lt.${txn.occurred_at}`)
  }

  return { ok: true, data: { status: 'matched', transactionId } }
}

// ---------------------------------------------------------------------------
// The Instagram arm: a scan code returned in a referral (TAC-pending)
// ---------------------------------------------------------------------------
//
// Same table, same lifecycle, a different transport and a different key.
//
// WHY NOT `extractTapToken`. The NFC path reads a token out of message PROSE,
// because an iMessage prefilled body arrives as text the guest may have typed
// around. A scan code arrives in `referral.ref`, a STRUCTURED field Meta
// delivers verbatim, which `handle-events.ts` persists to
// `messages.referral_ref` on both referral paths. Running a prose regex over a
// structured field is the wrong instrument: it would quietly accept a code
// embedded in guest text, which is a path no QR can produce.
//
// WHY THE CLAIM COMES LAST, unlike `reconcileTapFromInbound` which claims
// first. That function's token already names one of OUR transaction rows, so
// claiming up front is safe. A scan code names a SQUARE PAYMENT, and the
// `transactions` row for it may not exist yet -- the guest can scan before
// Square's webhook lands. Claiming first would burn the code on that race and
// no retry could ever use it, so the transaction is resolved BEFORE the claim
// and `payment_not_ingested` leaves the row pending. Concurrency is still safe
// because the claim is a CAS on `status`, so of two racing inbounds exactly
// one wins and the other reads `claim_lost`.
//
// ORDERING AGAINST THE SCAN GREETING. The greeting for a bare scan is sent
// after SCAN_GREETING_DELAY_MS (20s), and this bind runs in its own
// `waitUntil` alongside the scheduling, so in practice it finishes four orders
// of magnitude before the greeting generates. That is a RACE THIS CODE WINS,
// not an ordering this code guarantees. It does not matter yet: nothing in the
// greeting reads the bound transaction today. The moment a greeting is
// supposed to name what the guest just bought, the ordering has to become
// explicit -- chained ahead of `scheduleScanArrival` rather than inherited
// from a sleep.
//
// Fails OPEN at the call site, like the SendBlue arm: a reconciliation failure
// must never cost the 200 or break inbound handling. A guest whose purchase
// goes unattributed is recoverable; a lost message is not.

/**
 * Did the bind also map the card, and if not, why not?
 *
 * Three states, not a boolean. `no_fingerprint` is a payment Square gave us no
 * card fingerprint for (cash, or a method that carries none), which means the
 * guest is attributed for THIS visit and will need to scan again next time.
 * `link_failed` is the mapping write failing, which is the same guest-visible
 * outcome from a completely different cause. Collapsing them would make
 * "why is this guest not auto-matching" unanswerable, and auto-matching is the
 * entire payoff.
 */
export type FingerprintLinkResult = 'linked' | 'no_fingerprint' | 'link_failed'

/** What became of a referral that carried one of our scan codes. */
export type ScanCodeBindOutcome =
  /** Found, and the payment's transaction row is now attributed to the guest. */
  | {
      status: 'bound'
      transactionId: string
      codeAgeMs: number | null
      fingerprint: FingerprintLinkResult
    }
  /** Unknown code, wrong venue, or already matched by an earlier scan. */
  | { status: 'code_not_found' }
  /**
   * The code is ours and pending, but no `transactions` row exists for its
   * payment yet. The row is left PENDING deliberately so a later retry can
   * still bind it. Not a defect: this is the guest scanning before Square's
   * webhook landed.
   */
  | { status: 'payment_not_ingested'; providerPaymentId: string }
  /** A concurrent inbound claimed the same code first. */
  | { status: 'claim_lost' }

/**
 * Bind a Square payment to the guest who scanned its code.
 *
 * Non-throwing (RAGResult). On success also writes the fingerprint -> guest
 * mapping, which is the whole point: every later visit on that card
 * auto-matches through `reconcileTransactionByFingerprint` with no scan at all.
 */
export async function reconcileScanCodeFromReferral(opts: {
  venueId: string
  guestId: string
  code: string
  supabase?: AdminClient
}): Promise<RAGResult<ScanCodeBindOutcome>> {
  const supabase = opts.supabase ?? createAdminClient()

  // 1. The code, read without claiming it.
  const { data: tap, error: tapError } = await supabase
    .from('pos_tap_events')
    .select('id, provider_payment_id, received_at')
    .eq('tap_token', opts.code)
    .eq('venue_id', opts.venueId)
    .eq('status', 'pending')
    .maybeSingle()
  if (tapError) {
    return {
      ok: false,
      error: tapError.message,
      errorCode: 'scan_code_lookup_failed',
    }
  }
  if (!tap) return { ok: true, data: { status: 'code_not_found' } }

  if (!tap.provider_payment_id) {
    // A code with no payment behind it cannot be bound by this path. Issued
    // only by `issueScanCode`, which always sets one, so this is unreachable
    // today and reported rather than silently treated as not-found.
    return { ok: true, data: { status: 'code_not_found' } }
  }

  // 2. The transaction for that payment. `external_id` is Square's payment id
  //    (see ingest-transaction.ts), and the lookup is scoped by venue and
  //    source so it cannot reach another venue's row.
  const { data: txn, error: txnError } = await supabase
    .from('transactions')
    .select('id, card_fingerprint, occurred_at')
    .eq('venue_id', opts.venueId)
    .eq('source', 'square')
    .eq('external_id', tap.provider_payment_id)
    .maybeSingle()
  if (txnError) {
    return {
      ok: false,
      error: txnError.message,
      errorCode: 'scan_code_txn_lookup_failed',
    }
  }
  if (!txn) {
    return {
      ok: true,
      data: {
        status: 'payment_not_ingested',
        providerPaymentId: tap.provider_payment_id,
      },
    }
  }

  // 3. Claim, now that the bind can actually complete. CAS on status, scoped
  //    on venue AND id: an id is enough here because it came from our own read
  //    above, but the venue predicate costs nothing and keeps the shape of
  //    every other claim in this file.
  const { data: claimed, error: claimError } = await supabase
    .from('pos_tap_events')
    .update({
      status: 'matched',
      reconciled_transaction_id: txn.id,
    })
    .eq('id', tap.id)
    .eq('venue_id', opts.venueId)
    .eq('status', 'pending')
    .select('id')
    .maybeSingle()
  if (claimError) {
    return {
      ok: false,
      error: claimError.message,
      errorCode: 'scan_code_claim_failed',
    }
  }
  if (!claimed) return { ok: true, data: { status: 'claim_lost' } }

  // 4. Attribute the purchase.
  const nowIso = new Date().toISOString()
  const { error: linkError } = await supabase
    .from('transactions')
    .update({
      guest_id: opts.guestId,
      match_method: 'scan_code',
      match_confidence: 1,
      matched_at: nowIso,
    })
    .eq('id', txn.id)
  if (linkError) {
    return {
      ok: false,
      error: linkError.message,
      errorCode: 'scan_code_txn_link_failed',
    }
  }

  // 5. The payoff: map the fingerprint so future visits need no scan.
  //    Reported rather than assumed — see FingerprintLinkResult.
  let fingerprint: FingerprintLinkResult = 'no_fingerprint'
  if (txn.card_fingerprint) {
    const linked = await linkFingerprintToGuest({
      venueId: opts.venueId,
      guestId: opts.guestId,
      cardFingerprint: txn.card_fingerprint,
      supabase,
    })
    fingerprint = linked.ok ? 'linked' : 'link_failed'
    if (!linked.ok) {
      logger.warn('scan code bind: fingerprint link failed', {
        transactionId: txn.id,
        error: linked.error,
      })
    }
  }

  if (txn.occurred_at) {
    // TAC-377, exactly as the tap path does it: the precision moves WITH the
    // timestamp. Writing one without the other leaves a stale 'approximate'
    // beside a real receipt and permanently suppresses post_visit_* for a
    // guest who self-reported before their first scan. See reconcile.ts.
    await supabase
      .from('guests')
      .update({
        last_visit_at: txn.occurred_at,
        last_visit_precision: 'pinned',
      })
      .eq('id', opts.guestId)
      .or(`last_visit_at.is.null,last_visit_at.lt.${txn.occurred_at}`)
  }

  const issuedMs = Date.parse(tap.received_at)
  return {
    ok: true,
    data: {
      status: 'bound',
      transactionId: txn.id,
      codeAgeMs: Number.isNaN(issuedMs) ? null : Date.now() - issuedMs,
      fingerprint,
    },
  }
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
  const cutoff = new Date(
    opts.now.getTime() - opts.ttlMinutes * 60_000,
  ).toISOString()
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
