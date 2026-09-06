// lib/operator/conversations.test.ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { listOperatorConversations } from './conversations'

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
}

describe('listOperatorConversations', () => {
  it('returns ok:true with an empty array and skips the RPC when allowedVenueIds is empty', async () => {
    const result = await listOperatorConversations([])
    expect(result).toEqual({ ok: true, conversations: [] })
    expect(rpcMock).not.toHaveBeenCalled()
  })

  it('calls the RPC with venue_ids and projects rows to camelCase', async () => {
    rpcMock.mockResolvedValueOnce({ data: [RAW_ROW], error: null })
    const result = await listOperatorConversations(['00000000-0000-0000-0000-00000000000a'])
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
        },
      ],
    })
  })

  it('composes name from first+last, null when both are absent', async () => {
    rpcMock.mockResolvedValueOnce({
      data: [{ ...RAW_ROW, guest_first_name: null, guest_last_name: null }],
      error: null,
    })
    const result = await listOperatorConversations(['v1'])
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.conversations[0].name).toBeNull()
  })

  it('normalizes an unrecognized recognition_state to null', async () => {
    rpcMock.mockResolvedValueOnce({
      data: [{ ...RAW_ROW, recognition_state: 'something_unexpected' }],
      error: null,
    })
    const result = await listOperatorConversations(['v1'])
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.conversations[0].recognitionState).toBeNull()
  })

  it('drops a row with an invalid last_message_direction', async () => {
    rpcMock.mockResolvedValueOnce({
      data: [{ ...RAW_ROW, last_message_direction: 'sideways' }],
      error: null,
    })
    const result = await listOperatorConversations(['v1'])
    expect(result).toEqual({ ok: true, conversations: [] })
  })

  it('returns ok:false on RPC error', async () => {
    rpcMock.mockResolvedValueOnce({ data: null, error: { message: 'connection lost' } })
    const result = await listOperatorConversations(['v1'])
    expect(result).toEqual({ ok: false, error: 'connection lost' })
  })
})
