// lib/operator/conversations.test.ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { listOperatorConversations } from './conversations'
import { grantedVenues } from '@/lib/auth/venue-scope'

const rpcMock = vi.fn()
vi.mock('@/lib/db/admin', () => ({
  createAdminClient: () => ({ rpc: rpcMock }),
}))

beforeEach(() => {
  rpcMock.mockReset()
})

afterEach(() => {
  vi.clearAllMocks()
})

const RAW_ROW = {
  guest_id: '00000000-0000-0000-0000-000000000001',
  venue_id: '00000000-0000-0000-0000-00000000000a',
  venue_slug: 'mock-sextant',
  venue_timezone: 'America/Los_Angeles',
  agent_name: 'Sana',
  guest_first_name: 'Maya',
  guest_last_name: 'R.',
  guest_phone: '+15551110001',
  recognition_state: 'returning',
  last_message_at: '2026-09-05T21:39:00.000Z',
  last_message_direction: 'outbound',
  last_message_body: 'Done — got you down for two at 7:30.',
  conversation_count: 4,
  first_conversation_at: '2026-06-10T18:00:00.000Z',
  // TAC-473
  guest_has_instagram_id: false,
  instagram_username: null,
  last_inbound_channel: 'text',
  last_guest_action_at: null,
}

// TAC-473: an Instagram guest — no phone, a scoped id, a handle, and a window.
const RAW_INSTAGRAM_ROW = {
  ...RAW_ROW,
  guest_id: '00000000-0000-0000-0000-000000000002',
  guest_first_name: null,
  guest_last_name: null,
  guest_phone: null,
  guest_has_instagram_id: true,
  instagram_username: 'hana.brews',
  last_inbound_channel: 'instagram',
  last_guest_action_at: '2026-09-23T09:12:03.000Z',
}

describe('listOperatorConversations', () => {
  it('returns ok:true with an empty array and skips the RPC when the scope grants no venues', async () => {
    const result = await listOperatorConversations(grantedVenues([]))
    expect(result).toEqual({ ok: true, conversations: [] })
    expect(rpcMock).not.toHaveBeenCalled()
  })

  it('calls the RPC with venue_ids and projects rows to camelCase', async () => {
    rpcMock.mockResolvedValueOnce({ data: [RAW_ROW], error: null })
    const result = await listOperatorConversations(grantedVenues(['00000000-0000-0000-0000-00000000000a']))
    expect(rpcMock).toHaveBeenCalledWith('list_operator_conversations', {
      venue_ids: ['00000000-0000-0000-0000-00000000000a'],
    })
    expect(result).toEqual({
      ok: true,
      conversations: [
        {
          guestId: '00000000-0000-0000-0000-000000000001',
          venueId: '00000000-0000-0000-0000-00000000000a',
          venueSlug: 'mock-sextant',
          venueTimezone: 'America/Los_Angeles',
          agentName: 'Sana',
          name: 'Maya R.',
          phoneFallback: '+15551110001',
          recognitionState: 'returning',
          lastMessageAt: '2026-09-05T21:39:00.000Z',
          lastMessageDirection: 'outbound',
          lastMessagePreview: 'Done — got you down for two at 7:30.',
          conversationCount: 4,
          firstConversationAt: '2026-06-10T18:00:00.000Z',
          guestChannel: 'text',
          replyWindowExpiresAt: null,
          instagramUsername: null,
        },
      ],
    })
  })

  // TAC-473 ------------------------------------------------------------------
  // Transcribed from the `## Contract` section of the ticket, not read back out
  // of conversations.ts.

  it('projects an Instagram guest with the exact Contract field set', async () => {
    rpcMock.mockResolvedValueOnce({ data: [RAW_INSTAGRAM_ROW], error: null })
    const result = await listOperatorConversations(grantedVenues(['00000000-0000-0000-0000-00000000000a']))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    // toEqual, not toMatchObject: "always present" is only enforceable if a
    // missing field fails. A partial match passes while a Contract field
    // silently vanishes, which is the defect shape this guards.
    expect(result.conversations[0]).toEqual({
      guestId: '00000000-0000-0000-0000-000000000002',
      venueId: '00000000-0000-0000-0000-00000000000a',
      venueSlug: 'mock-sextant',
      venueTimezone: 'America/Los_Angeles',
      agentName: 'Sana',
      name: null,
      phoneFallback: '',
      recognitionState: 'returning',
      lastMessageAt: '2026-09-05T21:39:00.000Z',
      lastMessageDirection: 'outbound',
      lastMessagePreview: 'Done — got you down for two at 7:30.',
      conversationCount: 4,
      firstConversationAt: '2026-06-10T18:00:00.000Z',
      guestChannel: 'instagram',
      replyWindowExpiresAt: '2026-09-24T09:12:03.000Z',
      instagramUsername: 'hana.brews',
    })
  })

  it("keeps phoneFallback as '' for a phoneless guest, never null", async () => {
    // RULED 2026-09-23. analog-operator parses this list all-or-nothing with
    // `phoneFallback: z.string()` and no .catch(), so one null empties the
    // conversations tab for every operator at that venue.
    rpcMock.mockResolvedValueOnce({ data: [RAW_INSTAGRAM_ROW], error: null })
    const result = await listOperatorConversations(grantedVenues(['00000000-0000-0000-0000-00000000000a']))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.conversations[0].phoneFallback).toBe('')
    expect(result.conversations[0].phoneFallback).not.toBeNull()
  })

  it('takes the last inbound channel for a guest who has BOTH identifiers', async () => {
    // THE ONLY FIXTURE SHAPE THAT CAN FAIL. A guest with a phone AND an
    // Instagram id whose last inbound was INSTAGRAM: with the wiring the
    // answer is 'instagram', without it resolveConversationChannel falls
    // through to `if (hasPhone) return 'text'` and the answer is 'text'.
    //
    // The first version of this test used last_inbound_channel: 'text' and
    // expected 'text', which is what BOTH readings return, so passing
    // `lastInboundChannel: undefined` survived the whole 5993-test suite. The
    // rule was covered at the unit level and its WIRING was not, which is the
    // TAC-476 shape CLAUDE.md records.
    rpcMock.mockResolvedValueOnce({
      data: [
        {
          ...RAW_INSTAGRAM_ROW,
          guest_phone: '+15551110002',
          guest_has_instagram_id: true,
          last_inbound_channel: 'instagram',
        },
      ],
      error: null,
    })
    const result = await listOperatorConversations(grantedVenues(['00000000-0000-0000-0000-00000000000a']))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.conversations[0].guestChannel).toBe('instagram')
  })

  it('falls back to the phone for a both-identifier guest whose last inbound is unreadable', async () => {
    // Documents the fallback. Deliberately NOT the wiring test: both readings
    // answer 'text' here, so it cannot fail if the wiring is dropped.
    rpcMock.mockResolvedValueOnce({
      data: [
        {
          ...RAW_INSTAGRAM_ROW,
          guest_phone: '+15551110002',
          guest_has_instagram_id: true,
          last_inbound_channel: null,
        },
      ],
      error: null,
    })
    const result = await listOperatorConversations(grantedVenues(['00000000-0000-0000-0000-00000000000a']))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.conversations[0].guestChannel).toBe('text')
  })

  it('reports an UNKNOWN window as null on an Instagram guest, not as expired', async () => {
    rpcMock.mockResolvedValueOnce({
      data: [{ ...RAW_INSTAGRAM_ROW, last_guest_action_at: null }],
      error: null,
    })
    const result = await listOperatorConversations(grantedVenues(['00000000-0000-0000-0000-00000000000a']))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.conversations[0].guestChannel).toBe('instagram')
    expect(result.conversations[0].replyWindowExpiresAt).toBeNull()
  })

  it('composes name from first+last, null when both are absent', async () => {
    rpcMock.mockResolvedValueOnce({
      data: [{ ...RAW_ROW, guest_first_name: null, guest_last_name: null }],
      error: null,
    })
    const result = await listOperatorConversations(grantedVenues(['v1']))
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.conversations[0].name).toBeNull()
  })

  // TAC-467. The Contract types phoneFallback as a string, and analog-operator
  // parses the whole list with `phoneFallback: z.string()`: one null in one
  // row fails the parse, and the operator gets an error instead of a list.
  // A guest who came in on Instagram has no phone, so the projection must
  // send ''.
  it('sends an empty string, never null, for a guest with no phone, and keeps every other row', async () => {
    const phoneless = {
      ...RAW_ROW,
      guest_id: '00000000-0000-0000-0000-000000000002',
      guest_first_name: null,
      guest_last_name: null,
      guest_phone: null,
    }
    rpcMock.mockResolvedValueOnce({ data: [phoneless, RAW_ROW], error: null })
    const result = await listOperatorConversations(grantedVenues(['v1']))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.conversations).toHaveLength(2)
    expect(result.conversations[0].phoneFallback).toBe('')
    expect(result.conversations[1].phoneFallback).toBe('+15551110001')
    for (const c of result.conversations) expect(typeof c.phoneFallback).toBe('string')
  })

  it('normalizes an unrecognized recognition_state to null', async () => {
    rpcMock.mockResolvedValueOnce({
      data: [{ ...RAW_ROW, recognition_state: 'something_unexpected' }],
      error: null,
    })
    const result = await listOperatorConversations(grantedVenues(['v1']))
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.conversations[0].recognitionState).toBeNull()
  })

  it('drops a row with an invalid last_message_direction', async () => {
    rpcMock.mockResolvedValueOnce({
      data: [{ ...RAW_ROW, last_message_direction: 'sideways' }],
      error: null,
    })
    const result = await listOperatorConversations(grantedVenues(['v1']))
    expect(result).toEqual({ ok: true, conversations: [] })
  })

  it('returns ok:false on RPC error', async () => {
    rpcMock.mockResolvedValueOnce({ data: null, error: { message: 'connection lost' } })
    const result = await listOperatorConversations(grantedVenues(['v1']))
    expect(result).toEqual({ ok: false, error: 'connection lost' })
  })
})
