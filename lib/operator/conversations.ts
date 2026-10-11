// lib/operator/conversations.ts
// Powers GET /api/operator/conversations. Projects list_operator_conversations
// RPC rows (migration 080 holds the current definition) into the wire shape locked by the Contract in
// analog-operator's docs/superpowers/specs/2026-09-05-conversations-tab-design.md.

import { createAdminClient } from '@/lib/db/admin'
import {
  UNSUPPORTED_PREVIEW_LABEL,
  previewLabelFor,
} from '@/lib/messaging/attachments/labels'
import { loadAttachmentsForMessages } from '@/lib/messaging/attachments/store'
import {
  parseMessageChannel,
  type MessageChannel,
} from '@/lib/schemas/message-channel'
import {
  conversationGuestChannel,
  instagramUsername,
  replyWindowExpiresAt,
} from './instagram-fields'
import { normalizeRecognitionState } from './recognition-state'
import type { GuestRecognitionState } from './recognition-state'
import type { ThreadOptions } from './thread'
import {
  venueFilterIds,
  venueScopeDeniesAll,
  type VenueScope,
} from '@/lib/auth/venue-scope'

export type { GuestRecognitionState } from './recognition-state'

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
  // TAC-582, Contract-locked, ALWAYS PRESENT. What to show in place of the
  // preview when the last message has no text: "Photo", "Voice note", ...
  // Null when the last message has text, and always null unless the request
  // passed `?attachments=1`. Flat, beside lastMessagePreview: there is no
  // nested last-message object on this wire.
  previewLabel: string | null
  conversationCount: number
  firstConversationAt: string
  // TAC-473, Contract-locked. All three ALWAYS PRESENT — the client never
  // branches on presence.
  //
  // Resolved from the GUEST by resolveConversationChannel (TAC-495), because a
  // summary has no draft to read a channel off. Never null: an unresolvable
  // channel degrades to 'text' loudly rather than failing the client's parse.
  guestChannel: MessageChannel
  // When Instagram's 24-hour window closes, ISO 8601, on Meta's clock. The
  // true deadline; the client applies its own display margin. Null means no
  // window (a text conversation) or an unknown one — `guestChannel` says which.
  replyWindowExpiresAt: string | null
  // The guest's handle, without the '@'. Null when not stored.
  instagramUsername: string | null
}

export type ListOperatorConversationsResult =
  | { ok: true; conversations: ConversationSummary[] }
  | { ok: false; error: string }

function composeName(first: string | null, last: string | null): string | null {
  const parts = [first, last].filter(
    (p): p is string => !!p && p.trim().length > 0,
  )
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
  // TAC-467: null for an Instagram guest. See the projection below.
  guest_phone: string | null
  recognition_state: string | null
  last_message_at: string
  last_message_direction: string
  last_message_body: string
  conversation_count: number
  first_conversation_at: string
  // TAC-473. A BOOLEAN, not the scoped ID: resolveConversationChannel needs
  // only presence, and an IGSID carried into this projection would be one
  // typo away from the wire, where the Contract does not put it.
  guest_has_instagram_id: boolean | null
  instagram_username: string | null
  last_inbound_channel: string | null
  last_guest_action_at: string | null
  // TAC-582 (migration 080). NULL for a guest no message has reached, the
  // same rows whose body the RPC blanks. db/types.ts types both as non-null;
  // they are not, and `tsc` cannot see that.
  last_message_id: string | null
  last_message_unsupported: boolean | null
}

type AdminSupabaseClient = ReturnType<typeof createAdminClient>

/**
 * `previewLabel` for every row whose last message has no text, keyed by that
 * message's id.
 *
 * One query for all of them: only the media-only last messages are looked up,
 * which is a handful of a 200-row list.
 *
 * FAILS SOFT, to no label. The list is how an operator finds a conversation at
 * all, and the client parses it all-or-nothing, so a failed attachment read
 * must not fail it. The cost is a blank preview on those rows, and the read is
 * logged.
 */
async function loadPreviewLabels(
  supabase: AdminSupabaseClient,
  rows: readonly RawConversationRow[],
): Promise<Map<string, string>> {
  const labels = new Map<string, string>()
  const mediaOnlyIds: string[] = []
  for (const row of rows) {
    if (row.last_message_body !== '' || row.last_message_id === null) continue
    if (row.last_message_unsupported === true) {
      labels.set(row.last_message_id, UNSUPPORTED_PREVIEW_LABEL)
    } else {
      mediaOnlyIds.push(row.last_message_id)
    }
  }

  const loaded = await loadAttachmentsForMessages(supabase, mediaOnlyIds)
  if (!loaded.ok) {
    console.error('operator conversations: preview labels not loaded', {
      event: 'conversations_preview_labels_failed',
      count: mediaOnlyIds.length,
      error: loaded.error,
    })
    return labels
  }
  // Rows come back ordered by message then position, so the first one seen
  // for a message is its first attachment.
  for (const attachment of loaded.data) {
    if (!labels.has(attachment.messageId)) {
      labels.set(attachment.messageId, previewLabelFor(attachment))
    }
  }
  return labels
}

export async function listOperatorConversations(
  venueScope: VenueScope,
  options: ThreadOptions,
): Promise<ListOperatorConversationsResult> {
  if (venueScopeDeniesAll(venueScope)) {
    return { ok: true, conversations: [] }
  }

  const venueIds = venueFilterIds(venueScope)
  if (venueIds === null) {
    // TAC-530: a fleet-wide scope is produced only by the analog-admin cookie
    // path, and this helper is reached only from app/api/operator/* on the
    // bearer path. Refuse rather than silently widen the query -- making this
    // path fleet-wide is a decision, not a fallthrough. Deliberately NOT
    // "skip the filter": that idiom is what this ticket removed.
    return {
      ok: false,
      error:
        'fleet-wide venue scope is not supported by list_operator_conversations',
    }
  }

  const supabase = createAdminClient()
  // TAC-582: `include_media` is what lets a message with no text be a
  // conversation's last message, count toward its days, or be the only reason
  // the guest is listed at all. It follows the same `?attachments=1` the
  // thread endpoints read, so the list and the thread it opens agree. Off, the
  // RPC returns exactly what it did before the parameter existed.
  const { data, error } = await supabase.rpc('list_operator_conversations', {
    venue_ids: venueIds,
    include_media: options.includeAttachments,
  })

  if (error) {
    return { ok: false, error: error.message }
  }

  const rows = (data ?? []) as RawConversationRow[]
  const previewLabels = options.includeAttachments
    ? await loadPreviewLabels(supabase, rows)
    : new Map<string, string>()

  const conversations: ConversationSummary[] = []
  for (const row of rows) {
    if (
      row.last_message_direction !== 'inbound' &&
      row.last_message_direction !== 'outbound'
    ) {
      continue
    }
    conversations.push({
      guestId: row.guest_id,
      venueId: row.venue_id,
      venueSlug: row.venue_slug,
      venueTimezone: row.venue_timezone,
      agentName: row.agent_name,
      name: composeName(row.guest_first_name, row.guest_last_name),
      // TAC-467: '' for a guest with no phone (an Instagram guest), never
      // null. analog-operator parses this list all-or-nothing with
      // `phoneFallback: z.string()`, so one null fails the whole list: every
      // operator who can see that venue gets an error instead of
      // conversations. '' keeps the Contract's type; the guest shows with a
      // blank name until the operator app can label an Instagram guest.
      phoneFallback: row.guest_phone ?? '',
      recognitionState: normalizeRecognitionState(row.recognition_state),
      lastMessageAt: row.last_message_at,
      lastMessageDirection: row.last_message_direction,
      lastMessagePreview: row.last_message_body,
      previewLabel:
        row.last_message_id === null
          ? null
          : (previewLabels.get(row.last_message_id) ?? null),
      conversationCount: row.conversation_count,
      firstConversationAt: row.first_conversation_at,
      // TAC-473. `hasPhone` is a typeof check, not `!== null`: an undefined
      // from a row shape that predates this column must not read as a phone
      // number. Same reasoning conversation-channel.ts documents.
      guestChannel: conversationGuestChannel(
        {
          hasPhone:
            typeof row.guest_phone === 'string' && row.guest_phone.length > 0,
          hasInstagramId: row.guest_has_instagram_id === true,
          lastInboundChannel: parseMessageChannel(row.last_inbound_channel),
        },
        row.guest_id,
      ),
      replyWindowExpiresAt: replyWindowExpiresAt(row.last_guest_action_at),
      instagramUsername: instagramUsername(row.instagram_username),
    })
  }

  return { ok: true, conversations }
}
