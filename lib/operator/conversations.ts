// lib/operator/conversations.ts
// Powers GET /api/operator/conversations. Projects list_operator_conversations
// RPC rows (migration 033) into the wire shape locked by the Contract in
// analog-operator's docs/superpowers/specs/2026-09-05-conversations-tab-design.md.

import { createAdminClient } from '@/lib/db/admin'

export type GuestRecognitionState = 'new' | 'returning' | 'regular' | 'raving_fan'

export interface ConversationSummary {
  guestId: string
  venueId: string
  venueSlug: string
  venueTimezone: string | null
  agentName: string
  name: string | null
  phoneFallback: string
  recognitionState: GuestRecognitionState | null
  lastMessageAt: string
  lastMessageDirection: 'inbound' | 'outbound'
  lastMessagePreview: string
  conversationCount: number
  firstConversationAt: string
}

export type ListOperatorConversationsResult =
  | { ok: true; conversations: ConversationSummary[] }
  | { ok: false; error: string }

const RECOGNITION_STATE_VALUES: ReadonlySet<string> = new Set([
  'new',
  'returning',
  'regular',
  'raving_fan',
])

function normalizeRecognitionState(s: string | null): GuestRecognitionState | null {
  if (s === null) return null
  return RECOGNITION_STATE_VALUES.has(s) ? (s as GuestRecognitionState) : null
}

function composeName(first: string | null, last: string | null): string | null {
  const parts = [first, last].filter((p): p is string => !!p && p.trim().length > 0)
  return parts.length > 0 ? parts.join(' ') : null
}

interface RawConversationRow {
  guest_id: string
  venue_id: string
  venue_slug: string
  venue_timezone: string | null
  agent_name: string
  guest_first_name: string | null
  guest_last_name: string | null
  guest_phone: string
  recognition_state: string | null
  last_message_at: string
  last_message_direction: string
  last_message_body: string
  conversation_count: number
  first_conversation_at: string
}

export async function listOperatorConversations(
  allowedVenueIds: string[],
): Promise<ListOperatorConversationsResult> {
  if (allowedVenueIds.length === 0) {
    return { ok: true, conversations: [] }
  }

  const supabase = createAdminClient()
  const { data, error } = await supabase.rpc('list_operator_conversations', {
    venue_ids: allowedVenueIds,
  })

  if (error) {
    return { ok: false, error: error.message }
  }

  const conversations: ConversationSummary[] = []
  for (const row of (data ?? []) as RawConversationRow[]) {
    if (row.last_message_direction !== 'inbound' && row.last_message_direction !== 'outbound') {
      continue
    }
    conversations.push({
      guestId: row.guest_id,
      venueId: row.venue_id,
      venueSlug: row.venue_slug,
      venueTimezone: row.venue_timezone,
      agentName: row.agent_name,
      name: composeName(row.guest_first_name, row.guest_last_name),
      phoneFallback: row.guest_phone,
      recognitionState: normalizeRecognitionState(row.recognition_state),
      lastMessageAt: row.last_message_at,
      lastMessageDirection: row.last_message_direction,
      lastMessagePreview: row.last_message_body,
      conversationCount: row.conversation_count,
      firstConversationAt: row.first_conversation_at,
    })
  }

  return { ok: true, conversations }
}
