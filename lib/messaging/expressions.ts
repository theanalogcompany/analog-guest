import { createAdminClient } from '@/lib/db/admin'
import {
  sendblueMarkAsRead,
  sendblueSendReaction,
  sendblueSendTypingIndicator,
} from './sendblue-client'
import type {
  MarkAsReadInput,
  MessagingResult,
  SendReactionInput,
  SendTypingIndicatorInput,
} from './types'
import { getVenueMessagingNumber } from './venue-lookup'

const E164_RE = /^\+[1-9]\d{1,14}$/

/**
 * Send a tapback reaction to an inbound message and persist it to the
 * messages table.
 *
 * Server-only. Uses the admin DB client, which bypasses RLS. Do not import
 * this from client components, edge middleware, or any context that handles
 * untrusted input directly.
 */
export async function sendReaction(
  input: SendReactionInput,
): Promise<MessagingResult<{ providerMessageId: string; status: string }>> {
  const { venueId, to, reaction, messageHandle, replyToMessageId, guestId } = input

  if (!E164_RE.test(to)) {
    return { ok: false, error: 'invalid_recipient_phone_number' }
  }

  const lookup = await getVenueMessagingNumber(venueId)
  if (!lookup.ok) return lookup
  const fromNumber = lookup.data

  try {
    const resp = await sendblueSendReaction({
      from: fromNumber,
      to,
      reaction,
      messageHandle,
    })

    // TODO: monitor for orphaned reactions where Sendblue succeeded but DB write failed
    try {
      const supabase = createAdminClient()
      const { error: insertError } = await supabase.from('messages').insert({
        venue_id: venueId,
        guest_id: guestId, // TODO: resolve guest_id from to-phone + venue_id
        direction: 'outbound',
        category: 'reaction',
        reaction_type: reaction,
        body: '',
        reply_to_message_id: replyToMessageId,
        status: 'sent',
        provider_message_id: resp.message_handle,
        sent_at: new Date().toISOString(),
      })
      if (insertError) {
        console.error('orphaned reaction: db insert failed after sendblue success', {
          venueId,
          guestId,
          providerMessageId: resp.message_handle,
          error: insertError.message,
        })
      }
    } catch (e) {
      console.error('orphaned reaction: db insert threw after sendblue success', {
        venueId,
        guestId,
        providerMessageId: resp.message_handle,
        error: e instanceof Error ? e.message : String(e),
      })
    }

    return {
      ok: true,
      data: {
        providerMessageId: resp.message_handle,
        status: resp.status,
      },
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    return { ok: false, error: message, errorCode: 'sendblue_api_error' }
  }
}

/**
 * Send a typing indicator to a guest.
 *
 * Server-only. Uses the admin DB client to look up the venue's messaging
 * number; bypasses RLS. Pure transport — no DB writes.
 */
export async function sendTypingIndicator(
  input: SendTypingIndicatorInput,
): Promise<MessagingResult> {
  const { venueId, to } = input

  if (!E164_RE.test(to)) {
    return { ok: false, error: 'invalid_recipient_phone_number' }
  }

  const lookup = await getVenueMessagingNumber(venueId)
  if (!lookup.ok) return lookup
  const fromNumber = lookup.data

  try {
    await sendblueSendTypingIndicator({ from: fromNumber, to })
    return { ok: true, data: undefined }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    return { ok: false, error: message, errorCode: 'sendblue_api_error' }
  }
}

/**
 * Mark an inbound message as read on the guest's device.
 *
 * Server-only. Uses the admin DB client to look up the venue's messaging
 * number; bypasses RLS. Pure transport — no DB writes.
 */
export async function markAsRead(
  input: MarkAsReadInput,
): Promise<MessagingResult> {
  const { venueId, to, messageHandle } = input

  if (!E164_RE.test(to)) {
    return { ok: false, error: 'invalid_recipient_phone_number' }
  }

  const lookup = await getVenueMessagingNumber(venueId)
  if (!lookup.ok) return lookup
  const fromNumber = lookup.data

  try {
    await sendblueMarkAsRead({ from: fromNumber, to, messageHandle })
    return { ok: true, data: undefined }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    return { ok: false, error: message, errorCode: 'sendblue_api_error' }
  }
}