import { describe, expect, it } from 'vitest'
import { resolveConversationChannel } from './conversation-channel'

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

    // Every send path with no inbound message sends to a phone number today,
    // so the reply is a text. TAC-469 revisits this when it routes by channel.
    it('a guest with both identifiers is text', () => {
      expect(
        resolveConversationChannel({ inboundChannel: undefined, hasPhone: true, hasInstagramId: true }),
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
