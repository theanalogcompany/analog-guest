// TAC-516 follow-up: the one place a callback receipt is written and a replay
// is judged.
//
// Both callbacks need the identical sequence — link the repeat, write the row,
// decide whether this repeat is worth waking someone for — and the two must
// not drift on any of it. In particular they must agree on what counts as
// CONSEQUENTIAL, because that is the difference between a useful alert and one
// that fires on every idempotent redelivery until nobody reads it.
//
// IT FAILS SOFT, ALWAYS. Both routes answer 200 on everything but a bad
// signature, because Meta disables a callback after repeated non-2xx — so an
// audit row that cannot be written must never turn a delivery into a failure.
// Every path here logs and returns; none throws and none reports upward.

import { captureInstagramCallbackReplayed } from '@/lib/analytics/posthog'
import type { SupabaseClient } from '@supabase/supabase-js'

import type { Database } from '@/db/types'

import {
  isConsequentialRepeat,
  recordCallbackReceipt,
  type CallbackKind,
  type CallbackOutcome,
  type FindEarlierResult,
} from './callback-receipts'
import type { SignedRequestPayload } from './signed-request'

type AdminSupabaseClient = SupabaseClient<Database>

export type WriteCallbackReceiptInput = {
  callback: CallbackKind
  /** Null when the raw request was not the two-part shape. */
  fingerprint: string | null
  /** The pre-work lookup, or null when there was no fingerprint to look up. */
  earlier: FindEarlierResult | null
  payload: SignedRequestPayload
  venueId: string | null
  outcome: CallbackOutcome
  rowsAffected: number | null
  confirmationCode: string | null
  now: Date
  logPrefix: string
}

export async function writeCallbackReceipt(
  supabase: AdminSupabaseClient,
  input: WriteCallbackReceiptInput,
): Promise<void> {
  const { fingerprint, earlier, logPrefix } = input

  // Verification has already passed by the time this runs, so a null
  // fingerprint means the raw string was not the two-part shape — which the
  // parser would have refused. Unreachable rather than tolerated; logged as
  // such so it is not read as an ordinary skip.
  if (fingerprint === null) {
    console.error(`${logPrefix} a verified request had no fingerprintable payload; no receipt written`, {
      event: 'instagram_callback_receipt_skipped',
      callback: input.callback,
    })
    return
  }

  // A FAILED LOOKUP IS NOT "NO EARLIER DELIVERY", and conflating the two is
  // the trap here: it would record a replay as a first delivery, which is
  // exactly the invisibility this table exists to remove.
  //
  // Saying so IN THE ROW is the part that took a surviving mutant to find.
  // `repeat_of_receipt_id` is null for a first delivery AND for a failed
  // check, so the log alone left the two identical in the database forever
  // after. `repeat_checked` is what separates them.
  let repeatOfReceiptId: string | null = null
  let repeatUnknown = false
  if (earlier === null) {
    repeatUnknown = true
  } else if (!earlier.ok) {
    repeatUnknown = true
    console.error(`${logPrefix} could not check whether this delivery is a repeat`, {
      event: 'instagram_callback_repeat_check_failed',
      callback: input.callback,
      error: earlier.error,
    })
  } else if (earlier.earlier !== null) {
    repeatOfReceiptId = earlier.earlier.receiptId
  }

  const recorded = await recordCallbackReceipt(supabase, {
    callback: input.callback,
    instagramAccountId: input.payload.userId,
    fingerprint,
    // Meta's own clock, when the payload carries one. Its ABSENCE is why an
    // age check could not be made to fail closed safely, which is why this is
    // a trail rather than a gate.
    payloadIssuedAt: input.payload.issuedAt === null ? null : new Date(input.payload.issuedAt * 1000),
    venueId: input.venueId,
    outcome: input.outcome,
    repeatOfReceiptId,
    repeatChecked: !repeatUnknown,
    rowsAffected: input.rowsAffected,
    confirmationCode: input.confirmationCode,
    now: input.now,
  })

  if (!recorded.ok) {
    console.error(`${logPrefix} could not write the callback receipt`, {
      event: 'instagram_callback_receipt_unrecorded',
      callback: input.callback,
      error: recorded.error,
    })
    return
  }

  if (repeatUnknown || repeatOfReceiptId === null) return

  const earlierDelivery = earlier !== null && earlier.ok ? earlier.earlier : null
  if (earlierDelivery === null) return

  await captureInstagramCallbackReplayed(
    {
      callback: input.callback,
      instagramAccountId: input.payload.userId,
      earlierReceiptId: earlierDelivery.receiptId,
      earlierReceivedAt: earlierDelivery.receivedAt.toISOString(),
      rowsAffected: input.rowsAffected,
      confirmationCode: input.confirmationCode,
    },
    {
      // Every repeat is RECORDED; only the consequential one is relayed. A
      // repeated deauthorize is idempotent and a deletion replay that redacted
      // nothing found nothing left — relaying those would train whoever is on
      // call to ignore the one that matters.
      relayToSlack: isConsequentialRepeat({
        callback: input.callback,
        isRepeat: true,
        rowsAffected: input.rowsAffected,
      }),
    },
  )
}
