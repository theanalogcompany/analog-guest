// TAC-495: which channel this conversation is on, for choosing prompt copy.
//
// Read from the conversation, never from a venue setting: the guest row holds
// a phone number, an Instagram-scoped ID or both, and an inbound message
// records the channel it arrived on. A venue-level field could say anything;
// these can only say what happened. The Sendblue copy must stay correct for a
// guest who texted a phone number (the mock venues, and any future venue on a
// number), and the Instagram copy must never tell an Instagram guest they
// texted one.
//
// Prompt copy and routing read the same answer (TAC-469), so the two can never
// disagree about which channel a guest is on. Null means "unknown", never
// Instagram: it gets the Instagram WORDING because that wording is false on
// neither channel (a text is also a message), which is a property of the copy,
// not of the guest. Nothing routes a send on null: lib/agent/dispatch-reply.ts
// refuses it, and handle-inbound stops before generating.
//
//   inbound message   guest has            last inbound   result
//   text              a phone number       -              text
//   instagram         an Instagram ID      -              instagram
//   either            no ID for it         -              null (warned)
//   none              only a phone number  -              text
//   none              only an Instagram ID -              instagram
//   none              both                 text/instagram that channel (TAC-469)
//   none              both                 unknown        text
//   none              neither              -              null (warned)
//
// With an inbound message, the message decides, as long as the guest has the
// identifier that channel needs. A text from a guest with no phone number is
// the signature of migration 048's hazard: an Instagram insert that forgot to
// set channel is stored as 'text'. That, and its mirror image, come back null
// rather than trusting either side.
//
// With no inbound message (followups, the knowledge-gap holding message, an
// operator decline), a guest with ONE identifier is on that channel. A guest
// with BOTH is on the channel they last messaged us on (TAC-469): that is the
// conversation they are actually in, and the one a reply belongs in. When that
// can't be read, a phone number decides, as it did before TAC-469. No guest has
// both as of 2026-09-19; the rule exists so the first one is routed and worded
// for the conversation they chose.
//
// Neither identifier cannot happen: migration 048's guests_must_have_identity
// requires at least one. It still gets a defined answer rather than a throw,
// because a throw would add a failure to every agent path for a row the
// database refuses to store, and a send to such a guest fails closed anyway.
import type { MessageChannel } from '@/lib/schemas/message-channel'

export type ConversationChannelInput = {
  /** The inbound message's channel; undefined when there is no inbound message; null when it could not be parsed. */
  inboundChannel: MessageChannel | null | undefined
  hasPhone: boolean
  hasInstagramId: boolean
  /**
   * TAC-469: the channel of the guest's most recent inbound message, read only
   * when there is no inbound message and the guest has both identifiers.
   * Undefined or null (not read, or unreadable) falls back to the phone.
   */
  lastInboundChannel?: MessageChannel | null
}

export type ConversationChannelResolution = {
  channel: MessageChannel | null
  /** Why the answer is null, for the warning. Absent when the channel resolved. */
  unresolvedReason?:
    | 'inbound_channel_unparseable'
    | 'inbound_channel_without_identifier'
    | 'guest_has_no_identifier'
}

function guestHasIdentifierFor(channel: MessageChannel, input: ConversationChannelInput): boolean {
  switch (channel) {
    case 'text':
      return input.hasPhone
    case 'instagram':
      return input.hasInstagramId
  }
}

export function resolveConversationChannel(input: ConversationChannelInput): ConversationChannelResolution {
  if (input.inboundChannel !== undefined) {
    if (input.inboundChannel === null) {
      return { channel: null, unresolvedReason: 'inbound_channel_unparseable' }
    }
    if (!guestHasIdentifierFor(input.inboundChannel, input)) {
      return { channel: null, unresolvedReason: 'inbound_channel_without_identifier' }
    }
    return { channel: input.inboundChannel }
  }
  if (
    input.hasPhone &&
    input.hasInstagramId &&
    input.lastInboundChannel !== undefined &&
    input.lastInboundChannel !== null
  ) {
    return { channel: input.lastInboundChannel }
  }
  if (input.hasPhone) return { channel: 'text' }
  if (input.hasInstagramId) return { channel: 'instagram' }
  return { channel: null, unresolvedReason: 'guest_has_no_identifier' }
}

/**
 * Whether building the agent context needs the venue's messaging phone number.
 * Not for an Instagram conversation: an Instagram-only venue has no number, and
 * Le Mil's becomes one when its number is deleted. Unknown (null) and text
 * still need it. This decides only buildRuntimeContext's precondition; every
 * send path looks the number up itself (lib/messaging/venue-lookup.ts).
 */
export function venueMessagingNumberRequired(channel: MessageChannel | null): boolean {
  return channel !== 'instagram'
}
