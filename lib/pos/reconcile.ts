// Identity reconciliation: attach a guest to a transaction.
//
// The FINGERPRINT path: a returning guest whose card is already mapped
// (guest_card_fingerprints) is matched automatically, with no tap. The TAP path
// (first-time opt-in, time-windowed match to a pos_tap_events row, which then
// WRITES the fingerprint mapping) lives in reconcile-tap.ts.
//
// RAGResult-shaped, never throws into the caller — mirrors lib/guests/*. The
// supabase client is injectable so the policy is unit-testable without a live
// DB.

import { createAdminClient } from '@/lib/db/admin'
import type { RAGResult } from '@/lib/rag/types'

type AdminClient = ReturnType<typeof createAdminClient>

export type ReconcileOutcome =
  | { status: 'matched'; guestId: string; method: 'card_fingerprint' }
  | { status: 'unmatched'; reason: 'no_fingerprint' | 'no_mapping' }

/**
 * Try to attach a guest to a just-ingested transaction by card fingerprint.
 * On a hit: stamps guest_id + match_method='card_fingerprint' + confidence=1 on
 * the transaction, and advances guests.last_visit_at if this visit is newer.
 * On a miss: leaves the transaction unmatched (the tap path may reconcile it
 * later, or it stays unattributed if the guest never opted in).
 */
export async function reconcileTransactionByFingerprint(opts: {
  transactionId: string
  venueId: string
  cardFingerprint: string | null
  occurredAt: string
  supabase?: AdminClient
}): Promise<RAGResult<ReconcileOutcome>> {
  const supabase = opts.supabase ?? createAdminClient()

  if (!opts.cardFingerprint) {
    return { ok: true, data: { status: 'unmatched', reason: 'no_fingerprint' } }
  }

  const { data: mapping, error: lookupError } = await supabase
    .from('guest_card_fingerprints')
    .select('guest_id')
    .eq('venue_id', opts.venueId)
    .eq('card_fingerprint', opts.cardFingerprint)
    .maybeSingle()

  if (lookupError) {
    return { ok: false, error: lookupError.message, errorCode: 'fingerprint_lookup_failed' }
  }
  if (!mapping) {
    return { ok: true, data: { status: 'unmatched', reason: 'no_mapping' } }
  }

  const guestId = mapping.guest_id
  const nowIso = new Date().toISOString()

  const { error: txnError } = await supabase
    .from('transactions')
    .update({
      guest_id: guestId,
      match_method: 'card_fingerprint',
      match_confidence: 1,
      matched_at: nowIso,
    })
    .eq('id', opts.transactionId)

  if (txnError) {
    return { ok: false, error: txnError.message, errorCode: 'transaction_update_failed' }
  }

  // Advance last_visit_at only when this visit is newer (re-delivered or
  // backfilled older transactions must not move it backwards). The filter does
  // the comparison in SQL so there's no read-modify-write race.
  const { error: guestError } = await supabase
    .from('guests')
    .update({ last_visit_at: opts.occurredAt })
    .eq('id', guestId)
    .or(`last_visit_at.is.null,last_visit_at.lt.${opts.occurredAt}`)

  if (guestError) {
    // The match itself succeeded; a failed last_visit_at bump is non-fatal
    // (recognition recomputes from transactions regardless). Log, don't fail.
    console.warn('pos reconcile: last_visit_at update failed', {
      guestId,
      error: guestError.message,
    })
  }

  return { ok: true, data: { status: 'matched', guestId, method: 'card_fingerprint' } }
}

/**
 * Map a card fingerprint to a guest (per-venue). Idempotent on the
 * UNIQUE(venue_id, card_fingerprint) constraint. Called by the tap opt-in flow
 * once a phone is linked, and usable for seeding test data. After this
 * mapping exists, every future transaction with the same fingerprint
 * auto-matches via reconcileTransactionByFingerprint — no further taps needed.
 */
export async function linkFingerprintToGuest(opts: {
  venueId: string
  guestId: string
  cardFingerprint: string
  supabase?: AdminClient
}): Promise<RAGResult<{ linked: true }>> {
  const supabase = opts.supabase ?? createAdminClient()
  const { error } = await supabase.from('guest_card_fingerprints').upsert(
    {
      venue_id: opts.venueId,
      guest_id: opts.guestId,
      card_fingerprint: opts.cardFingerprint,
    },
    { onConflict: 'venue_id,card_fingerprint' },
  )
  if (error) {
    return { ok: false, error: error.message, errorCode: 'fingerprint_link_failed' }
  }
  return { ok: true, data: { linked: true } }
}
