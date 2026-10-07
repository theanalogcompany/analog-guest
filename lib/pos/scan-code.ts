// Issue and look up the scan code a guest's QR carries.
//
// One code per Square payment, ruled 2026-10-07. A code is a row in
// `pos_tap_events` (see migration 076's header for why that table rather than
// a new one), carrying the Square payment id it was issued against and
// `channel: 'instagram'`.
//
// WHY THE CODE IS RANDOM AND STORED, not an HMAC over the payment id like
// `deriveTapToken`. Two reasons, and the first is the load-bearing one:
//
//   1. It must not depend on knowing the payment. Square's webhook SLA is
//      "well under 60 seconds", measured by others at seconds in the median
//      and ~60s around p90, so a counter-facing flow cannot wait for it. If
//      the live `ListPayments` read turns out to be too slow as well, the
//      fallback is to print a code FIRST and bind it to a payment afterwards
//      by location and nearest timestamp -- `match_method = 'tap_time_window'`,
//      which migration 030 already permits. A code derived from the payment id
//      cannot exist before the payment is known, so deriving it would foreclose
//      that fallback at the moment the printed paper makes it expensive.
//
//   2. A deterministic token over a provider id is weaker than a random one.
//      `deriveTapToken` HMACs OUR uuid, which is unguessable to begin with;
//      a Square payment id is not a secret in the same way.
//
// The `sc_` prefix, against the NFC path's `tt_`, means a code says which
// reconciler owns it. `extractTapToken`'s regex is anchored on `tt_` and
// cannot match one of these, which is deliberate: the NFC path reads a token
// out of message PROSE, and this path reads a code out of a structured
// `referral.ref` field. One instrument each.
//
// Errors-as-values throughout; the only throw is from `randomBytes`, which
// does not fail in practice. Direction on the issuer is **closed**: a code we
// cannot persist must not be handed to a printer, because a QR nobody can
// resolve is worse than no QR -- the guest scans, gets a thread with no
// context, and we have recorded nothing to explain why.

import { randomBytes } from 'node:crypto'

import { createAdminClient } from '@/lib/db/admin'

import type { PosResult } from './types'

type AdminClient = ReturnType<typeof createAdminClient>

const UNIQUE_VIOLATION = '23505'

/**
 * `sc_` + 32 base64url chars (24 random bytes). base64url so the code is
 * URL-safe by construction, which `buildScanLink` relies on rather than
 * percent-encoding.
 *
 * 24 bytes is 192 bits. The length is not about brute force -- a guessed code
 * only binds a payment the guesser would have to already know about -- it is
 * about the code surviving being printed small and scanned in bad light, so
 * shorter is genuinely better and this is already past the point where
 * guessing matters.
 */
export function generateScanCode(): string {
  return `sc_${randomBytes(24).toString('base64url')}`
}

/** A code's prefix is the only thing that says which reconciler owns it. */
export const SCAN_CODE_PREFIX = 'sc_'

/**
 * Is this `referral.ref` one of our scan codes?
 *
 * Prefix-only, no length or alphabet check. The row lookup is the real
 * validation, and a stricter predicate here would silently reclassify a
 * legitimate code as "not ours" the day the generator changed -- a failure that
 * looks exactly like a guest scanning a stale QR. A `ref` that is not ours is
 * not an error: the venue's counter QR carries hand-set values like
 * `LEMILS-COUNTER`, and Meta documents other referral sources entirely.
 */
export function looksLikeScanCode(
  ref: string | null | undefined,
): ref is string {
  return typeof ref === 'string' && ref.startsWith(SCAN_CODE_PREFIX)
}

export type IssuedScanCode = {
  code: string
  /** False when a code already existed for this payment and was returned. */
  created: boolean
}

/**
 * Issue the code for a Square payment, or return the one already issued.
 *
 * Check-then-act with the partial unique index from migration 076 as the
 * storage-layer backstop: two concurrent polls both find no code, both
 * insert, and the loser takes 23505 and re-reads the winner's row. Handled as
 * an OUTCOME, not an error, per .claude/rules/errors-as-values.md -- which is
 * what makes "one code per payment" true rather than merely intended.
 *
 * Idempotent, so a caller may call it on every poll of the same payment.
 */
export async function issueScanCode(opts: {
  venueId: string
  providerPaymentId: string
  locationExternalId: string | null
  supabase?: AdminClient
}): Promise<PosResult<IssuedScanCode>> {
  const supabase = opts.supabase ?? createAdminClient()

  const existing = await findCodeForPayment(supabase, {
    venueId: opts.venueId,
    providerPaymentId: opts.providerPaymentId,
  })
  if (!existing.ok) return existing
  if (existing.data !== null) {
    return { ok: true, data: { code: existing.data, created: false } }
  }

  const code = generateScanCode()
  const { error } = await supabase.from('pos_tap_events').insert({
    tap_token: code,
    venue_id: opts.venueId,
    provider_payment_id: opts.providerPaymentId,
    location_external_id: opts.locationExternalId,
    channel: 'instagram',
    status: 'pending',
  })

  if (error) {
    if (error.code === UNIQUE_VIOLATION) {
      // Lost the race on (venue_id, provider_payment_id). The winner's code is
      // the one that will have been printed, so re-read rather than retrying.
      const won = await findCodeForPayment(supabase, {
        venueId: opts.venueId,
        providerPaymentId: opts.providerPaymentId,
      })
      if (!won.ok) return won
      if (won.data !== null) {
        return { ok: true, data: { code: won.data, created: false } }
      }
      // A 23505 with no row behind it means the conflict was on `tap_token`
      // instead, i.e. a 192-bit collision. Reported rather than retried: if
      // this is ever seen, the generator is broken and a retry would hide it.
      return {
        ok: false,
        error: 'scan code conflicted with no row behind it',
        errorCode: 'scan_code_collision',
      }
    }
    return {
      ok: false,
      error: error.message,
      errorCode: 'scan_code_insert_failed',
    }
  }

  return { ok: true, data: { code, created: true } }
}

async function findCodeForPayment(
  supabase: AdminClient,
  opts: { venueId: string; providerPaymentId: string },
): Promise<PosResult<string | null>> {
  const { data, error } = await supabase
    .from('pos_tap_events')
    .select('tap_token')
    .eq('venue_id', opts.venueId)
    .eq('provider_payment_id', opts.providerPaymentId)
    .maybeSingle()
  if (error) {
    return {
      ok: false,
      error: error.message,
      errorCode: 'scan_code_lookup_failed',
    }
  }
  return { ok: true, data: data?.tap_token ?? null }
}
