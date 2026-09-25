// TAC-516 follow-up: the replay trail for Meta's two callbacks.
//
// `signed_request` carries no nonce, so a captured genuine callback stays
// valid until INSTAGRAM_APP_SECRET rotates. That window is deliberately left
// OPEN (ruled 2026-09-24) — the only check the scheme allows is an age
// window, and refusing a genuine deauthorize keeps a token the venue revoked
// while refusing a genuine deletion is a compliance failure with a deadline,
// both reachable by ordinary clock skew. Accepting the replay is the lesser
// harm; the replay being INVISIBLE is not part of that bargain.
//
// So this records every verified delivery and links a repeat to the delivery
// it repeats. See migration 062's header for why it is its own table rather
// than `inbound_turn_outcomes` or columns on `instagram_deletion_requests`.
//
// EVERY FUNCTION HERE FAILS SOFT, and that is the whole posture. Both routes
// answer 200 on all but a bad signature, because Meta disables a callback
// after repeated non-2xx — so an audit row that cannot be written must never
// turn a delivery into a failure. A failed write is logged loudly and the
// callback carries on doing its actual job.

import type { SupabaseClient } from '@supabase/supabase-js'

import type { Database } from '@/db/types'

type AdminSupabaseClient = SupabaseClient<Database>

/** Which callback produced a receipt. Bound to migration 062's CHECK. */
export const CALLBACK_KINDS = ['deauthorize', 'data_deletion'] as const
export type CallbackKind = (typeof CALLBACK_KINDS)[number]

/**
 * What we did with a verified delivery. Bound to migration 062's CHECK.
 *
 * `no_match` is NOT a failure: Meta legitimately sends both callbacks for an
 * account no venue owns — a stale attempt, one already disconnected, one that
 * never finished connecting. Recording it as `failed` would make the one
 * genuinely diagnostic signal (an id-matching assumption gone wrong, which
 * looks exactly like this) indistinguishable from a database problem.
 */
export const CALLBACK_OUTCOMES = ['applied', 'no_match', 'failed'] as const
export type CallbackOutcome = (typeof CALLBACK_OUTCOMES)[number]

export type EarlierDelivery = {
  receiptId: string
  receivedAt: Date
  outcome: CallbackOutcome
}

export type FindEarlierResult =
  | { ok: true; earlier: EarlierDelivery | null }
  | { ok: false; error: string }

/**
 * Has this exact payload arrived before?
 *
 * Read BEFORE the callback does its work, so the answer describes the state
 * the delivery arrived into rather than the one it created. Running it after
 * the insert would match the row just written.
 */
export async function findEarlierDelivery(
  supabase: AdminSupabaseClient,
  fingerprint: string,
): Promise<FindEarlierResult> {
  const { data, error } = await supabase
    .from('instagram_callback_receipts')
    .select('id, received_at, outcome')
    .eq('signed_request_fingerprint', fingerprint)
    .order('received_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (error) return { ok: false, error: error.message }
  if (!data) return { ok: true, earlier: null }

  return {
    ok: true,
    earlier: {
      receiptId: data.id,
      receivedAt: new Date(data.received_at),
      outcome: data.outcome as CallbackOutcome,
    },
  }
}

export type RecordReceiptInput = {
  callback: CallbackKind
  instagramAccountId: string
  fingerprint: string
  payloadIssuedAt: Date | null
  venueId: string | null
  outcome: CallbackOutcome
  repeatOfReceiptId: string | null
  /**
   * False when the repeat lookup failed. The row then means "unknown", never
   * "first delivery" — see migration 062's column comment.
   */
  repeatChecked: boolean
  /** Guest rows redacted by THIS delivery. Null for deauthorize. */
  rowsAffected: number | null
  confirmationCode: string | null
  now: Date
}

export type RecordReceiptResult = { ok: true; receiptId: string } | { ok: false; error: string }

/** Write the receipt. Fails soft: see this file's header. */
export async function recordCallbackReceipt(
  supabase: AdminSupabaseClient,
  input: RecordReceiptInput,
): Promise<RecordReceiptResult> {
  const { data, error } = await supabase
    .from('instagram_callback_receipts')
    .insert({
      callback: input.callback,
      instagram_account_id: input.instagramAccountId,
      signed_request_fingerprint: input.fingerprint,
      payload_issued_at: input.payloadIssuedAt ? input.payloadIssuedAt.toISOString() : null,
      received_at: input.now.toISOString(),
      venue_id: input.venueId,
      outcome: input.outcome,
      repeat_of_receipt_id: input.repeatOfReceiptId,
      repeat_checked: input.repeatChecked,
      rows_affected: input.rowsAffected,
      confirmation_code: input.confirmationCode,
    })
    .select('id')
    .maybeSingle()

  if (error) return { ok: false, error: error.message }
  if (!data) return { ok: false, error: 'the receipt insert returned no row' }
  return { ok: true, receiptId: data.id }
}

/**
 * Is this repeat the exposure the ruling named, rather than a harmless one?
 *
 * A repeated DEAUTHORIZE is idempotent — the venue is already disconnected —
 * and a repeated deletion that redacted nothing found nothing left to redact,
 * which is what idempotent looks like. The case worth waking someone for is
 * narrow and specific: a deletion replay that DID redact rows, because those
 * rows can only have been created after the original request was honoured.
 *
 * Pure, so the routes cannot disagree about what counts.
 */
export function isConsequentialRepeat(input: {
  callback: CallbackKind
  isRepeat: boolean
  rowsAffected: number | null
}): boolean {
  if (!input.isRepeat) return false
  if (input.callback !== 'data_deletion') return false
  return (input.rowsAffected ?? 0) > 0
}
