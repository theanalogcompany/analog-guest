import { describe, expect, it } from 'vitest'
import { resolveConversationChannel, venueMessagingNumberRequired } from './conversation-channel'

// TAC-495: the full truth table, one row per case, written out rather than
// derived so a changed rule has to change a row someone can read.
describe('resolveConversationChannel', () => {
  describe('with an inbound message, the message decides', () => {
    it('a text from a guest with a phone number is text', () => {
      expect(
        resolveConversationChannel({ inboundChannel: 'text', hasPhone: true, hasInstagramId: false }),
      ).toEqual({ channel: 'text' })
    })

    it('an Instagram message from a guest with an Instagram ID is instagram', () => {
      expect(
        resolveConversationChannel({ inboundChannel: 'instagram', hasPhone: false, hasInstagramId: true }),
      ).toEqual({ channel: 'instagram' })
    })

    // Both identifiers: only the message can say which conversation this is.
    it('a guest with both identifiers follows the message, either way', () => {
      expect(
        resolveConversationChannel({ inboundChannel: 'text', hasPhone: true, hasInstagramId: true }),
      ).toEqual({ channel: 'text' })
      expect(
        resolveConversationChannel({ inboundChannel: 'instagram', hasPhone: true, hasInstagramId: true }),
      ).toEqual({ channel: 'instagram' })
    })

    // Migration 048's hazard: an Instagram insert that omitted channel is
    // stored as 'text'. A text from a guest with no phone number can only be
    // that, so the message is not trusted.
    it('a text from a guest with no phone number is unresolved, not text', () => {
      expect(
        resolveConversationChannel({ inboundChannel: 'text', hasPhone: false, hasInstagramId: true }),
      ).toEqual({ channel: null, unresolvedReason: 'inbound_channel_without_identifier' })
    })

    it('an Instagram message from a guest with no Instagram ID is unresolved', () => {
      expect(
        resolveConversationChannel({ inboundChannel: 'instagram', hasPhone: true, hasInstagramId: false }),
      ).toEqual({ channel: null, unresolvedReason: 'inbound_channel_without_identifier' })
    })

    it('an unparseable inbound channel is unresolved, whatever the guest has', () => {
      expect(
        resolveConversationChannel({ inboundChannel: null, hasPhone: true, hasInstagramId: false }),
      ).toEqual({ channel: null, unresolvedReason: 'inbound_channel_unparseable' })
    })

    it('a guest with no identifier at all is unresolved even with an inbound message', () => {
      expect(
        resolveConversationChannel({ inboundChannel: 'text', hasPhone: false, hasInstagramId: false }),
      ).toEqual({ channel: null, unresolvedReason: 'inbound_channel_without_identifier' })
    })
  })

  describe('with no inbound message, the identifiers decide', () => {
    it('a guest with a phone number is text', () => {
      expect(
        resolveConversationChannel({ inboundChannel: undefined, hasPhone: true, hasInstagramId: false }),
      ).toEqual({ channel: 'text' })
    })

    // TAC-469: a guest with both identifiers is on the channel they last
    // messaged us on, because routing now follows this answer too.
    it('a guest with both identifiers follows their last inbound message', () => {
      expect(
        resolveConversationChannel({
          inboundChannel: undefined,
          hasPhone: true,
          hasInstagramId: true,
          lastInboundChannel: 'instagram',
        }),
      ).toEqual({ channel: 'instagram' })
      expect(
        resolveConversationChannel({
          inboundChannel: undefined,
          hasPhone: true,
          hasInstagramId: true,
          lastInboundChannel: 'text',
        }),
      ).toEqual({ channel: 'text' })
    })

    // Not read, or unreadable: the phone number decides, as before TAC-469.
    it('a guest with both identifiers and no readable last inbound is text', () => {
      expect(
        resolveConversationChannel({ inboundChannel: undefined, hasPhone: true, hasInstagramId: true }),
      ).toEqual({ channel: 'text' })
      expect(
        resolveConversationChannel({
          inboundChannel: undefined,
          hasPhone: true,
          hasInstagramId: true,
          lastInboundChannel: null,
        }),
      ).toEqual({ channel: 'text' })
    })

    // The last inbound decides only between identifiers the guest has. With
    // one identifier, that identifier decides whatever the history says.
    it('a guest with one identifier ignores the last inbound channel', () => {
      expect(
        resolveConversationChannel({
          inboundChannel: undefined,
          hasPhone: true,
          hasInstagramId: false,
          lastInboundChannel: 'instagram',
        }),
      ).toEqual({ channel: 'text' })
      expect(
        resolveConversationChannel({
          inboundChannel: undefined,
          hasPhone: false,
          hasInstagramId: true,
          lastInboundChannel: 'text',
        }),
      ).toEqual({ channel: 'instagram' })
    })

    // With an inbound message, the message decides; the history is not read.
    it('an inbound message outranks the last inbound channel', () => {
      expect(
        resolveConversationChannel({
          inboundChannel: 'text',
          hasPhone: true,
          hasInstagramId: true,
          lastInboundChannel: 'instagram',
        }),
      ).toEqual({ channel: 'text' })
    })

    it('a guest with only an Instagram ID is instagram', () => {
      expect(
        resolveConversationChannel({ inboundChannel: undefined, hasPhone: false, hasInstagramId: true }),
      ).toEqual({ channel: 'instagram' })
    })

    // guests_must_have_identity forbids this row; it still gets an answer.
    it('a guest with neither is unresolved', () => {
      expect(
        resolveConversationChannel({ inboundChannel: undefined, hasPhone: false, hasInstagramId: false }),
      ).toEqual({ channel: null, unresolvedReason: 'guest_has_no_identifier' })
    })
  })
})

describe('venueMessagingNumberRequired (TAC-495)', () => {
  // An Instagram-only venue (Le Mil's, once its number is deleted) has no
  // messaging number, and an Instagram conversation doesn't need one.
  it('does not require a number for an Instagram conversation', () => {
    expect(venueMessagingNumberRequired('instagram')).toBe(false)
  })

  it('requires one for a text conversation', () => {
    expect(venueMessagingNumberRequired('text')).toBe(true)
  })

  // Unknown is a data problem; failing loudly at context build is right.
  it('requires one when the channel is unknown', () => {
    expect(venueMessagingNumberRequired(null)).toBe(true)
  })
})
