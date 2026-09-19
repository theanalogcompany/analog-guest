// TAC-469: the Instagram arm of an operator's approve or edit.
//
// dispatchOperatorOutbound switches on the card's own channel; this is what it
// calls for an Instagram card. The text arm is untouched and knows nothing of
// this file. Kept apart so the window, the byte cap and the Send API are
// imported by an Instagram arm only (window-import-guard.test.ts).
//
// An approved card is a reply the agent wrote to something the guest said, so
// it is allowed on Instagram while the window is open. The card may have sat
// in the queue for hours, which is exactly the case the window gate exists
// for: checked BEFORE the card leaves the queue, like the empty-body refusal,
// so a refused card stays where the operator can see it. Until TAC-486, a card
// whose window has closed can only be finished by typing it in the Instagram
// app by hand.
//
// Operator text is sent VERBATIM (TAC-319 ruling 3), so an over-cap card is
// refused rather than split: an operator who wrote or approved exact text
// should never find it arrived as three messages.
//
// Two differences from the text arm after the card has left the queue:
//   - A send Meta DEFINITELY refused puts the card back in the queue, since
//     nothing reached the guest (rule 4: a failed send stays a card). A send
//     whose outcome is unknown (a timeout, a lost connection) is left out of
//     the queue, as on Sendblue: putting it back invites a second send of a
//     message that may already be in the thread.
//   - The echo can land before our write of the mid (rule 6). The card row
//     already exists and its id is already referenced (the commitment it
//     creates, the intention prompts it records, the operator's review), so
//     the card is the row that stays: the echo's provider_sent_at is copied
//     onto the card FIRST (ruled 2026-09-19, so the delete loses nothing the
//     reply check reads), then the echo row is deleted, then the card gets
//     the mid. The first code path that deletes a messages row, guarded to
//     that one echo.

import type { SupabaseClient } from '@supabase/supabase-js'

import type { Database } from '@/db/types'
import {
  fitsInstagramTextCap,
  INSTAGRAM_MAX_TEXT_BYTES,
  sendInstagramText,
  sendOutcomeUnknown,
  type InstagramSendFailureKind,
  type InstagramSendResult,
} from '@/lib/messaging/instagram/send'
import { loadInstagramSendTarget, type InstagramSendTarget } from '@/lib/messaging/instagram/send-target'
import { instagramWindowState, loadLastGuestActionAt } from '@/lib/messaging/instagram/window'

type AdminSupabaseClient = SupabaseClient<Database>

/** Migration 006's unique constraint on messages.provider_message_id. */
const PROVIDER_MESSAGE_ID_UNIQUE_CONSTRAINT = 'messages_provider_message_id_unique'

export type InstagramOperatorRefusal = {
  errorCode: 'no_instagram_id' | 'over_byte_cap' | 'instagram_window_closed' | 'venue_misconfigured' | 'db_error'
  error: string
}

/**
 * Everything checked before the card leaves the queue. Never throws. A window
 * that can't be read is not a refusal: Meta enforces it anyway, and refusing
 * on a failed read would strand every Instagram card during a database blip.
 */
export async function prepareInstagramOperatorSend(
  supabase: AdminSupabaseClient,
  input: { venueId: string; guestId: string; body: string; now: Date },
  readToken?: () => string | null,
): Promise<{ ok: true; target: InstagramSendTarget } | ({ ok: false } & InstagramOperatorRefusal)> {
  if (!fitsInstagramTextCap(input.body)) {
    return {
      ok: false,
      errorCode: 'over_byte_cap',
      error: `This message is over Instagram's ${INSTAGRAM_MAX_TEXT_BYTES}-byte limit. Shorten it and send again.`,
    }
  }

  const target = await loadInstagramSendTarget(supabase, { venueId: input.venueId, guestId: input.guestId }, readToken)
  if (!target.ok) {
    switch (target.problem) {
      case 'guest_has_no_instagram_id':
        return { ok: false, errorCode: 'no_instagram_id', error: 'This guest has no Instagram account on file.' }
      case 'venue_has_no_instagram_account':
        return { ok: false, errorCode: 'venue_misconfigured', error: 'This venue has no Instagram account connected.' }
      case 'token_missing':
        return { ok: false, errorCode: 'venue_misconfigured', error: 'The Instagram access token is not set.' }
      case 'lookup_failed':
        return { ok: false, errorCode: 'db_error', error: target.error ?? 'Instagram send target lookup failed' }
    }
  }

  const lastAction = await loadLastGuestActionAt(supabase, input.venueId, input.guestId)
  if (lastAction.ok && !instagramWindowState(lastAction.value, input.now).open) {
    return {
      ok: false,
      errorCode: 'instagram_window_closed',
      error:
        "Instagram only allows a reply within 24 hours of the guest's last message. Send this one from the Instagram app.",
    }
  }
  if (!lastAction.ok) {
    console.warn('[operator] instagram window unreadable; sending and letting Meta decide', { error: lastAction.error })
  }
  return { ok: true, target: target.target }
}

export function sendInstagramOperatorText(target: InstagramSendTarget, text: string): Promise<InstagramSendResult> {
  return sendInstagramText({ ...target, text, fetchImpl: fetch })
}

/**
 * Put a card back in the queue after Meta definitely refused its send. Only if
 * it is still the way the dispatch left it (flipped, never sent), so a card an
 * operator has since undone or re-dispatched is left alone. Never throws.
 */
export async function restoreCardAfterRefusedSend(
  supabase: AdminSupabaseClient,
  input: { messageId: string; flippedTo: string },
): Promise<boolean> {
  const { data, error } = await supabase
    .from('messages')
    .update({ review_state: 'pending', previous_review_state: null })
    .eq('id', input.messageId)
    .eq('review_state', input.flippedTo)
    .is('provider_message_id', null)
    .select('id')
  if (error || !data || data.length !== 1) {
    console.error('[operator] could not put the Instagram card back in the queue after a refused send', {
      messageId: input.messageId,
      error: error?.message ?? `matched ${data?.length ?? 0}`,
    })
    return false
  }
  return true
}

/**
 * After Meta refused or didn't answer: put the card back in the queue when
 * Meta DEFINITELY refused (nothing reached the guest), leave it out when the
 * outcome is unknown (it may already be in the thread), and say which in
 * plain words for the operator. Never throws.
 */
export async function settleFailedInstagramOperatorSend(
  supabase: AdminSupabaseClient,
  input: { messageId: string; flippedTo: string; kind: InstagramSendFailureKind },
): Promise<string> {
  if (sendOutcomeUnknown(input.kind)) {
    return `Instagram didn't confirm this send (${input.kind}). Check the thread before sending again.`
  }
  const restored = await restoreCardAfterRefusedSend(supabase, { messageId: input.messageId, flippedTo: input.flippedTo })
  return `Instagram refused this send (${input.kind}).${restored ? ' The card is back in the queue.' : ''}`
}

/**
 * Write the mid onto the card. When the echo got there first (a collision on
 * provider_message_id), fold it in: copy its provider_sent_at onto the card,
 * delete it, then write the mid. Never throws.
 */
export async function stampInstagramOperatorSend(
  supabase: AdminSupabaseClient,
  input: { messageId: string; venueId: string; guestId: string; mid: string; sentAt: string },
): Promise<{ ok: true; folded: boolean } | { ok: false; error: string }> {
  const stamp = () =>
    supabase
      .from('messages')
      .update({ status: 'sent', sent_at: input.sentAt, provider_message_id: input.mid })
      .eq('id', input.messageId)

  const first = await stamp()
  if (!first.error) return { ok: true, folded: false }
  if (first.error.code !== '23505' || !first.error.message.includes(PROVIDER_MESSAGE_ID_UNIQUE_CONSTRAINT)) {
    return { ok: false, error: first.error.message }
  }

  const { data: echo, error: echoError } = await supabase
    .from('messages')
    .select('id, provider_sent_at')
    .eq('provider_message_id', input.mid)
    .eq('venue_id', input.venueId)
    .eq('guest_id', input.guestId)
    .eq('direction', 'outbound')
    .is('generated_by', null)
    .neq('id', input.messageId)
    .maybeSingle()
  if (echoError) return { ok: false, error: echoError.message }
  if (!echo) return { ok: false, error: 'provider_message_id collided with no echo row to fold in' }

  // Copy first, so the delete loses nothing the reply check reads.
  if (echo.provider_sent_at !== null) {
    const { error: copyError } = await supabase
      .from('messages')
      .update({ provider_sent_at: echo.provider_sent_at })
      .eq('id', input.messageId)
    if (copyError) return { ok: false, error: `copying the echo's provider_sent_at failed: ${copyError.message}` }
  }
  const { error: deleteError } = await supabase
    .from('messages')
    .delete()
    .eq('id', echo.id)
    .eq('provider_message_id', input.mid)
    .is('generated_by', null)
  if (deleteError) return { ok: false, error: `deleting the echo row failed: ${deleteError.message}` }

  const second = await stamp()
  if (second.error) return { ok: false, error: second.error.message }
  return { ok: true, folded: true }
}
