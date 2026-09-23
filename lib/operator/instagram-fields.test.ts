// TAC-473: the three Contract fields, at the unit level.
//
// Every expectation here is transcribed from the `## Contract` section of the
// TAC-473 description, never read back out of the implementation. A test
// written by reading the code can only confirm the code equals itself, which
// is how TAC-310 certified a live cross-repo defect on every green run.

import { afterEach, describe, expect, it, vi } from 'vitest'

import { INSTAGRAM_WINDOW_MS } from '@/lib/messaging/instagram/window'

import {
  conversationGuestChannel,
  instagramUsername,
  queueGuestChannel,
  replyWindowExpiresAt,
} from './instagram-fields'

afterEach(() => {
  vi.restoreAllMocks()
})

describe('replyWindowExpiresAt', () => {
  it('is the guest action plus exactly 24 hours, as ISO 8601 UTC', () => {
    // Transcribed from the Contract's JSON example: an action at 09:12:03 on
    // the 23rd expires at 09:12:03 on the 24th.
    expect(replyWindowExpiresAt('2026-09-23T09:12:03.000Z')).toBe('2026-09-24T09:12:03.000Z')
  })

  it('adds the window constant rather than a hardcoded 24 hours', () => {
    // Guards the one definition: if INSTAGRAM_WINDOW_MS ever moves, this
    // follows it. A literal expectation here would silently disagree.
    const at = '2026-09-23T09:12:03.000Z'
    expect(replyWindowExpiresAt(at)).toBe(
      new Date(new Date(at).getTime() + INSTAGRAM_WINDOW_MS).toISOString(),
    )
  })

  it('is null when there is no guest action, which the Contract calls UNKNOWN and not expired', () => {
    expect(replyWindowExpiresAt(null)).toBeNull()
  })

  it('is null when the stored timestamp cannot be parsed', () => {
    expect(replyWindowExpiresAt('not a timestamp')).toBeNull()
  })

  it('does NOT clamp a deadline already in the past', () => {
    // The Contract: "A value in the past means expired. The server does not
    // clamp it." Clamping to null would make an expired window
    // indistinguishable from an unknown one, which is the distinction the
    // client renders differently.
    expect(replyWindowExpiresAt('2020-01-01T00:00:00.000Z')).toBe('2020-01-02T00:00:00.000Z')
  })

  it('subtracts no display margin', () => {
    // The server sends Instagram's TRUE deadline; the client applies its own
    // margin. A server that pre-subtracted would double-count it.
    const at = '2026-09-23T09:12:03.000Z'
    const out = new Date(replyWindowExpiresAt(at) as string).getTime()
    expect(out - new Date(at).getTime()).toBe(INSTAGRAM_WINDOW_MS)
  })
})

describe('queueGuestChannel', () => {
  it('reads the draft row channel', () => {
    expect(queueGuestChannel('instagram', 'd1')).toBe('instagram')
    expect(queueGuestChannel('text', 'd1')).toBe('text')
  })

  it('degrades an unreadable channel to text and says so loudly', () => {
    // Never null: the Contract promises a bare enum the client parses without
    // a .catch(), so a null would fail the entire queue for that venue.
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(queueGuestChannel('carrier-pigeon', 'd1')).toBe('text')
    expect(queueGuestChannel(null, 'd1')).toBe('text')
    expect(error).toHaveBeenCalledTimes(2)
  })

  it('never logs the guest or the draft body when it degrades', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    queueGuestChannel('carrier-pigeon', 'd1')
    const logged = JSON.stringify(error.mock.calls)
    expect(logged).toContain('d1')
    expect(logged).not.toContain('guest')
  })
})

describe('conversationGuestChannel', () => {
  it('is instagram for a guest with only an Instagram id', () => {
    expect(
      conversationGuestChannel({ hasPhone: false, hasInstagramId: true }, 'g1'),
    ).toBe('instagram')
  })

  it('is text for a guest with only a phone number', () => {
    expect(conversationGuestChannel({ hasPhone: true, hasInstagramId: false }, 'g1')).toBe('text')
  })

  it('takes the last inbound channel for a guest with BOTH identifiers', () => {
    // TAC-469's rule: the conversation they are actually in.
    expect(
      conversationGuestChannel(
        { hasPhone: true, hasInstagramId: true, lastInboundChannel: 'instagram' },
        'g1',
      ),
    ).toBe('instagram')
  })

  it('falls back to the phone number for a both-identifier guest whose last inbound is unreadable', () => {
    expect(
      conversationGuestChannel(
        { hasPhone: true, hasInstagramId: true, lastInboundChannel: null },
        'g1',
      ),
    ).toBe('text')
  })

  it('degrades to text and says so loudly when the guest has neither identifier', () => {
    // Unreachable while guests_must_have_identity stands (migration 048).
    // Reaching it means that constraint is gone, which is worth an error line
    // rather than a null the client cannot parse.
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(conversationGuestChannel({ hasPhone: false, hasInstagramId: false }, 'g1')).toBe('text')
    expect(error).toHaveBeenCalledTimes(1)
  })

  it('does not consult an inbound message', () => {
    // A summary is not a turn. Passing an inboundChannel would select the
    // wrong branch of resolveConversationChannel, and the caller's Omit<> is
    // what stops it; this pins the behaviour that Omit protects.
    expect(
      conversationGuestChannel(
        { hasPhone: false, hasInstagramId: true, lastInboundChannel: 'text' },
        'g1',
      ),
    ).toBe('instagram')
  })
})

describe('instagramUsername', () => {
  it('passes a stored handle through without an @', () => {
    expect(instagramUsername('hana.brews')).toBe('hana.brews')
  })

  it('is null when not stored', () => {
    expect(instagramUsername(null)).toBeNull()
  })

  it('is null rather than empty, which the Contract promises', () => {
    // migration 049's non-blank CHECK already forbids '', so this guards the
    // Contract's guarantee rather than a case the column permits.
    expect(instagramUsername('')).toBeNull()
    expect(instagramUsername('   ')).toBeNull()
  })
})
