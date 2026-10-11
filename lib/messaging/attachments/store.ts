// TAC-582: the reads and writes on `message_attachments`.
//
// One row per attachment, written by both webhooks straight after the message
// row and before the 200, so that the agent turn and the first thread read
// both find them. The copy into our own storage happens later (rehost.ts).
//
// EVERY WRITER NAMES `kind` AND `status`. The table gives neither a default on
// purpose (migration 080), so a row cannot be created in a state nobody chose.
//
// A FAILED INSERT DOES NOT COST THE MESSAGE. The message row is already saved
// and `media_urls` on it is unchanged, so the caller logs and carries on. The
// thread then shows that message with no attachments, which is the gap this
// file's error is logged for.

import type { SupabaseClient } from '@supabase/supabase-js'

import type { Database } from '@/db/types'

import {
  type AttachmentKind,
  type AttachmentStatus,
  type ParsedAttachment,
  initialStatusFor,
  isAttachmentKind,
  isAttachmentStatus,
} from './kind'

type AdminSupabaseClient = SupabaseClient<Database>

type AttachmentDbRow =
  Database['public']['Tables']['message_attachments']['Row']

export type AttachmentResult<T> =
  { ok: true; data: T } | { ok: false; error: string }

/** A `message_attachments` row with `kind` and `status` narrowed. */
export type MessageAttachment = {
  id: string
  messageId: string
  venueId: string
  guestId: string
  position: number
  kind: AttachmentKind
  status: AttachmentStatus
  providerType: string | null
  providerUrl: string | null
  storagePath: string | null
  mimeType: string | null
  title: string | null
  linkUrl: string | null
  createdAt: string
}

const ATTACHMENT_COLUMNS =
  'id, message_id, venue_id, guest_id, position, kind, status, provider_type, provider_url, storage_path, mime_type, title, link_url, created_at'

type AttachmentSelectRow = Pick<
  AttachmentDbRow,
  | 'id'
  | 'message_id'
  | 'venue_id'
  | 'guest_id'
  | 'position'
  | 'kind'
  | 'status'
  | 'provider_type'
  | 'provider_url'
  | 'storage_path'
  | 'mime_type'
  | 'title'
  | 'link_url'
  | 'created_at'
>

// A kind or status outside the CHECK cannot be stored, so the fallbacks are
// unreachable today. They are here because db/types.ts types both columns as
// `string`, and 'unknown' / 'failed' are the honest reading of a value this
// build does not recognise.
function toAttachment(row: AttachmentSelectRow): MessageAttachment {
  return {
    id: row.id,
    messageId: row.message_id,
    venueId: row.venue_id,
    guestId: row.guest_id,
    position: row.position,
    kind: isAttachmentKind(row.kind) ? row.kind : 'unknown',
    status: isAttachmentStatus(row.status) ? row.status : 'failed',
    providerType: row.provider_type,
    providerUrl: row.provider_url,
    storagePath: row.storage_path,
    mimeType: row.mime_type,
    title: row.title,
    linkUrl: row.link_url,
    createdAt: row.created_at,
  }
}

export type InsertMessageAttachmentsInput = {
  messageId: string
  venueId: string
  guestId: string
  attachments: readonly ParsedAttachment[]
}

/**
 * Write one row per attachment, in the order the provider sent them.
 *
 * Returns how many rows are `pending`, which is what tells the caller whether
 * there is anything to re-host. A redelivered message never reaches this (both
 * webhooks stop at the duplicate check on `provider_message_id`), and the
 * unique (message_id, position) constraint is the backstop if one ever does.
 */
export async function insertMessageAttachments(
  supabase: AdminSupabaseClient,
  input: InsertMessageAttachmentsInput,
): Promise<AttachmentResult<{ inserted: number; pending: number }>> {
  if (input.attachments.length === 0) {
    return { ok: true, data: { inserted: 0, pending: 0 } }
  }

  const rows = input.attachments.map((attachment, position) => {
    const status = initialStatusFor(attachment.kind, attachment.url)
    return {
      message_id: input.messageId,
      venue_id: input.venueId,
      guest_id: input.guestId,
      position,
      kind: attachment.kind,
      status,
      provider_type: attachment.providerType,
      provider_url: attachment.url,
      title: attachment.title,
      // A share's link is the thing the operator opens; nothing else has one.
      link_url: attachment.kind === 'share' ? attachment.url : null,
      mime_type: attachment.kind === 'gif' ? 'image/gif' : null,
      failure_reason: status === 'failed' ? 'no_link' : null,
    }
  })

  const { error } = await supabase.from('message_attachments').insert(rows)
  if (error) return { ok: false, error: error.message }

  return {
    ok: true,
    data: {
      inserted: rows.length,
      pending: rows.filter((row) => row.status === 'pending').length,
    },
  }
}

/**
 * Every attachment on the given messages, ordered by message then position.
 *
 * An empty id list is answered without a query: `.in('message_id', [])` is a
 * request PostgREST rejects, and "no messages" has an obvious answer.
 */
export async function loadAttachmentsForMessages(
  supabase: AdminSupabaseClient,
  messageIds: readonly string[],
): Promise<AttachmentResult<MessageAttachment[]>> {
  if (messageIds.length === 0) return { ok: true, data: [] }

  const { data, error } = await supabase
    .from('message_attachments')
    .select(ATTACHMENT_COLUMNS)
    .in('message_id', [...messageIds])
    .order('message_id', { ascending: true })
    .order('position', { ascending: true })
  if (error) return { ok: false, error: error.message }

  return { ok: true, data: (data ?? []).map(toAttachment) }
}

/** The same rows, grouped by the message they belong to. */
export function groupAttachmentsByMessage(
  attachments: readonly MessageAttachment[],
): Map<string, MessageAttachment[]> {
  const byMessage = new Map<string, MessageAttachment[]>()
  for (const attachment of attachments) {
    const list = byMessage.get(attachment.messageId)
    if (list) list.push(attachment)
    else byMessage.set(attachment.messageId, [attachment])
  }
  return byMessage
}

/** Rows still waiting to be copied, oldest first. For the re-host script. */
export async function loadPendingAttachments(
  supabase: AdminSupabaseClient,
  limit: number,
): Promise<AttachmentResult<MessageAttachment[]>> {
  const { data, error } = await supabase
    .from('message_attachments')
    .select(ATTACHMENT_COLUMNS)
    .eq('status', 'pending')
    .order('created_at', { ascending: true })
    .limit(limit)
  if (error) return { ok: false, error: error.message }
  return { ok: true, data: (data ?? []).map(toAttachment) }
}

/** One message's pending rows. What the webhook's re-host step works through. */
export async function loadPendingAttachmentsForMessage(
  supabase: AdminSupabaseClient,
  messageId: string,
): Promise<AttachmentResult<MessageAttachment[]>> {
  const { data, error } = await supabase
    .from('message_attachments')
    .select(ATTACHMENT_COLUMNS)
    .eq('message_id', messageId)
    .eq('status', 'pending')
    .order('position', { ascending: true })
  if (error) return { ok: false, error: error.message }
  return { ok: true, data: (data ?? []).map(toAttachment) }
}
