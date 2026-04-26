import { sendblueSendMessage } from './sendblue-client'
import type { MessagingResult, SendMessageInput } from './types'
import { getVenueMessagingNumber } from './venue-lookup'

const E164_RE = /^\+[1-9]\d{1,14}$/

/**
 * Send an outbound message to a guest via the configured messaging provider.
 *
 * Server-only. Uses the admin DB client, which bypasses RLS. Do not import
 * this from client components, edge middleware, or any context that handles
 * untrusted input directly. The caller is responsible for persisting the
 * message to the messages table — this function only performs the send.
 */
export async function sendMessage(
  input: SendMessageInput,
): Promise<MessagingResult<{ providerMessageId: string; status: string }>> {
  const { venueId, to, body, mediaUrls } = input

  if (!E164_RE.test(to)) {
    return { ok: false, error: 'invalid_recipient_phone_number' }
  }

  const hasMedia = mediaUrls !== undefined && mediaUrls.length > 0
  if (body === '' && !hasMedia) {
    return { ok: false, error: 'message_must_have_content' }
  }
  if (mediaUrls !== undefined && mediaUrls.length > 1) {
    return { ok: false, error: 'multiple_media_not_supported' }
  }

  const lookup = await getVenueMessagingNumber(venueId)
  if (!lookup.ok) return lookup
  const fromNumber = lookup.data

  try {
    const resp = await sendblueSendMessage({
      from: fromNumber,
      to,
      content: body,
      mediaUrl: hasMedia ? mediaUrls![0] : undefined,
    })
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