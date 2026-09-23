// TAC-473: the three Instagram fields the operator API adds to every queue
// draft and every conversation summary, projected from their RPC columns.
//
// Both operator reads need the identical rules, so they live here once rather
// than twice. That also keeps the widening of
// lib/messaging/instagram/window-import-guard.test.ts to a SINGLE entry: this
// module imports INSTAGRAM_WINDOW_MS, and queue.ts and conversations.ts import
// this module. Splitting the constant into an unguarded module to avoid the
// guard entirely would be gaming it; adding one deliberate importer with a
// reason is the guard working as designed.
//
// Nothing here sends anything. The guard exists so Instagram's send-time
// constraints never reach the shared or SMS send path, and a read projection
// is not that path — it computes a deadline for display and routes nothing.

import { INSTAGRAM_WINDOW_MS } from '@/lib/messaging/instagram/window'
import { parseMessageChannel, type MessageChannel } from '@/lib/schemas/message-channel'
import {
  resolveConversationChannel,
  type ConversationChannelInput,
} from '@/lib/agent/conversation-channel'

/**
 * What a channel degrades to when it cannot be resolved.
 *
 * The Contract promises `guestChannel` is NEVER null, so the client can parse
 * it as a bare `z.enum(['text','instagram'])`. A null on the wire would fail
 * the whole list — the TAC-467 incident — so an unresolvable channel becomes
 * 'text' and is logged at error level rather than sent as null.
 *
 * 'text' rather than 'instagram' because it is the pre-Instagram behaviour:
 * every guest was a text guest, so degrading this way changes nothing for the
 * population that has always worked.
 */
const GUEST_CHANNEL_FALLBACK: MessageChannel = 'text'

/**
 * A QUEUE DRAFT's channel is the DRAFT ROW's own `messages.channel`.
 *
 * Not re-derived from the guest, and that is the only correct answer here:
 * dispatchOperatorOutbound switches on the card's channel, so this field is
 * exactly "what approving this card will do". A value re-derived from the
 * guest could disagree with the routing and tell the operator the wrong thing
 * about their own tap.
 *
 * The column is `not null default 'text'` with a CHECK constraint since
 * migration 048, so an unparseable value means the database holds something
 * the CHECK forbids. Loud, then 'text'.
 */
export function queueGuestChannel(rawChannel: string | null, draftId: string): MessageChannel {
  const parsed = parseMessageChannel(rawChannel)
  if (parsed !== null) return parsed
  console.error('[operator] queue draft has an unreadable channel; falling back to text', {
    draftId,
    // The raw value, not the guest or the body: this says what the column
    // holds, and nothing about who the guest is.
    rawChannel,
  })
  return GUEST_CHANNEL_FALLBACK
}

/**
 * A CONVERSATION SUMMARY's channel, resolved from the guest.
 *
 * There is no draft to read it from, so this defers to
 * resolveConversationChannel (TAC-495) — the server's single rule for which
 * channel a conversation is on. Writing that rule again here, or in SQL, is
 * the drift this repo keeps paying for: the guest-with-both-identifiers case
 * is subtle and two copies would agree until the day one changed.
 *
 * `inboundChannel: undefined` is deliberate and is what selects the no-inbound
 * branch of that resolver: a conversation summary is not a turn, so there is
 * no single inbound message whose channel decides it.
 *
 * Null is unreachable in practice — `guests_must_have_identity` (migration
 * 048) requires a phone number or an Instagram ID — so reaching the fallback
 * means the constraint is gone.
 */
export function conversationGuestChannel(
  input: Omit<ConversationChannelInput, 'inboundChannel'>,
  guestId: string,
): MessageChannel {
  const { channel, unresolvedReason } = resolveConversationChannel({
    ...input,
    inboundChannel: undefined,
  })
  if (channel !== null) return channel
  console.error('[operator] conversation channel unresolved; falling back to text', {
    guestId,
    unresolvedReason,
    hasPhone: input.hasPhone,
    hasInstagramId: input.hasInstagramId,
  })
  return GUEST_CHANNEL_FALLBACK
}

/**
 * When Instagram's 24-hour reply window closes, as the Contract's ISO 8601
 * string, or null.
 *
 * `lastGuestActionAt` is Meta's own time for the guest's newest Instagram
 * inbound (`provider_sent_at`), which is what Instagram measures against —
 * never `created_at`, which is when our webhook received the event.
 *
 * THE TRUE DEADLINE. No margin is subtracted: the server sends when Instagram
 * actually closes and the client applies its own display margin. The server's
 * own send gate closes INSTAGRAM_WINDOW_MARGIN_MS earlier, so a client that
 * renders this raw will show a few minutes this server would already refuse to
 * send in; that is TAC-486's to subtract, and is why the Contract says so.
 *
 * Null has two causes and the Contract makes the client tell them apart with
 * `guestChannel`: a text conversation has no window at all, while an Instagram
 * conversation with a null here has an UNKNOWN window, not an expired one.
 * A value in the past means expired; it is not clamped.
 */
export function replyWindowExpiresAt(lastGuestActionAt: string | null): string | null {
  if (lastGuestActionAt === null) return null
  const at = new Date(lastGuestActionAt)
  if (Number.isNaN(at.getTime())) return null
  return new Date(at.getTime() + INSTAGRAM_WINDOW_MS).toISOString()
}

/**
 * The guest's Instagram handle, without the `@`, or null.
 *
 * `guests.instagram_username` carries a non-blank CHECK (migration 049), so an
 * absent handle is already NULL rather than ''. The trim-to-null here is for
 * the Contract's guarantee rather than for a case the column permits.
 */
export function instagramUsername(raw: string | null): string | null {
  if (typeof raw !== 'string') return null
  const trimmed = raw.trim()
  return trimmed.length > 0 ? trimmed : null
}
