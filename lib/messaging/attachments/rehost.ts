// TAC-582: copy a guest's attachment into storage we control.
//
// Instagram's media links are signed CDN links that expire, and nobody at
// analog can open a venue's Instagram to see what a guest sent. So each
// `pending` attachment is downloaded once and uploaded to the private
// `guest-media` bucket, and the app serves it from there for as long as the
// conversation exists.
//
// IT RUNS AFTER THE 200. Both webhooks hand this to waitUntil, never await it.
// A download is seconds at best, and neither Meta's delivery deadline nor
// Sendblue's should wait on someone else's CDN.
//
// WHAT COUNTS AS DONE, per row, exactly one of:
//   'ready'   the bytes are in the bucket and `storage_path` names them.
//   'failed'  with a `failure_reason` from the fixed list below. `provider_url`
//             is kept, so a later run can try again while the link still works.
// Every status write is guarded on `status = 'pending'`, so two runs over the
// same row (the webhook and scripts/rehost-pending-attachments.ts) cannot both
// settle it: the second finds no row to update and stops.
//
// A FUNCTION THAT DIES MID-DOWNLOAD LEAVES THE ROW 'pending'. Nothing sweeps
// it. serve.ts reports a pending row older than PENDING_STALE_MS as 'failed'
// to the app, so the operator never watches a spinner that cannot finish, and
// the row itself stays pending so the script can still recover the file.
//
// WHAT IS REFUSED BEFORE ANY REQUEST IS MADE. The link comes from a verified
// webhook, but it is still a URL this server is about to fetch:
//   - anything not https
//   - a host that is an IP literal or a bare name (no dot): no internal address
//     is reachable by a public hostname, and nothing a guest sends lives on one
//   - on Instagram, any host outside Meta's CDNs. An unfamiliar host fails
//     with `host_not_allowed` and the host is logged, which is how a CDN Meta
//     adds later shows up as one clear log line, not as a mystery failure.
//
// THE LINK ITSELF IS NEVER LOGGED. Its query string is the signature that
// makes it work. Logs carry the host and the attachment id.
//
// THE PARENT MESSAGE IS TOUCHED WHEN A MESSAGE'S ROWS SETTLE. `messages` is in
// the realtime publication and this table is not, so an UPDATE on the parent
// row is how the operator app learns a photo stopped being 'pending' (the
// Contract's sixth amendment). The trigger sets `updated_at`; nothing else on
// the row changes.

import type { SupabaseClient } from '@supabase/supabase-js'

import type { Database } from '@/db/types'

import {
  type AttachmentKind,
  SENDBLUE_PROVIDER_TYPE,
  kindFromMimeType,
} from './kind'
import {
  type MessageAttachment,
  loadPendingAttachmentsForMessage,
} from './store'

type AdminSupabaseClient = SupabaseClient<Database>

export const GUEST_MEDIA_BUCKET = 'guest-media'

/** 25 MB. The bucket's own `file_size_limit` is the same number (migration 080). */
export const MAX_ATTACHMENT_BYTES = 26_214_400

const DOWNLOAD_TIMEOUT_MS = 60_000

export type RehostFailureReason =
  | 'no_link'
  | 'bad_link'
  | 'host_not_allowed'
  | 'download_failed'
  | 'download_status'
  | 'too_large'
  | 'empty_file'
  | 'upload_failed'

export type RehostOutcome =
  | {
      status: 'ready'
      attachmentId: string
      kind: AttachmentKind
      bytes: number
    }
  | { status: 'failed'; attachmentId: string; reason: RehostFailureReason }
  /** Another run settled the row first. Nothing was written by this one. */
  | { status: 'skipped'; attachmentId: string }

// lookaside.fbsbx.com is where every photo and voice note captured on
// 2026-10-11 lived; the other two are the CDNs Meta serves Instagram media
// from and where a lookaside link can redirect.
const META_CDN_SUFFIXES: readonly string[] = [
  '.fbsbx.com',
  '.fbcdn.net',
  '.cdninstagram.com',
]

const IPV4_LITERAL = /^\d{1,3}(\.\d{1,3}){3}$/

function isPublicHostname(host: string): boolean {
  if (!host.includes('.')) return false
  if (host.includes(':') || host.startsWith('[')) return false
  if (IPV4_LITERAL.test(host)) return false
  return !host.endsWith('.local') && !host.endsWith('.internal')
}

function isMetaCdnHost(host: string): boolean {
  return META_CDN_SUFFIXES.some((suffix) => host.endsWith(suffix))
}

export type DownloadTarget =
  | { ok: true; url: URL }
  | { ok: false; reason: 'bad_link' | 'host_not_allowed'; host: string | null }

/**
 * Whether this link may be fetched at all. Pure, and exported for the harness.
 *
 * A Sendblue link may be on any public host: Sendblue does not publish where
 * its media lives. Everything else is Instagram and must be on Meta's CDNs.
 */
export function downloadTargetFor(
  rawUrl: string,
  providerType: string | null,
): DownloadTarget {
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    return { ok: false, reason: 'bad_link', host: null }
  }
  const host = url.hostname.toLowerCase()
  if (url.protocol !== 'https:') return { ok: false, reason: 'bad_link', host }
  if (!isPublicHostname(host)) {
    return { ok: false, reason: 'host_not_allowed', host }
  }
  if (providerType !== SENDBLUE_PROVIDER_TYPE && !isMetaCdnHost(host)) {
    return { ok: false, reason: 'host_not_allowed', host }
  }
  return { ok: true, url }
}

/** `{venue_id}/{guest_id}/{message_id}/{attachment_id}`, as the ticket pins it. */
export function storagePathFor(attachment: {
  venueId: string
  guestId: string
  messageId: string
  id: string
}): string {
  return `${attachment.venueId}/${attachment.guestId}/${attachment.messageId}/${attachment.id}`
}

type Downloaded =
  | { ok: true; bytes: Uint8Array; mimeType: string | null }
  | { ok: false; reason: RehostFailureReason }

function mimeTypeOf(response: Response): string | null {
  const header = response.headers.get('content-type')
  if (header === null) return null
  const type = header.split(';')[0]?.trim().toLowerCase() ?? ''
  return type === '' ? null : type
}

// Reads the body in chunks so a file with no Content-Length (or a wrong one)
// still stops at the cap; it is never buffered whole first and measured after.
async function readCapped(response: Response): Promise<Uint8Array | null> {
  if (response.body === null) return new Uint8Array(0)
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > MAX_ATTACHMENT_BYTES) {
      await reader.cancel()
      return null
    }
    chunks.push(value)
  }
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return bytes
}

async function download(
  url: URL,
  providerType: string | null,
  fetchImpl: typeof fetch,
): Promise<Downloaded> {
  let response: Response
  try {
    response = await fetchImpl(url, {
      redirect: 'follow',
      signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
    })
  } catch {
    return { ok: false, reason: 'download_failed' }
  }
  // Where the redirects ended is held to the same rule as where they began.
  if (response.url !== '') {
    const landed = downloadTargetFor(response.url, providerType)
    if (!landed.ok) return { ok: false, reason: landed.reason }
  }
  if (!response.ok) return { ok: false, reason: 'download_status' }

  const declared = Number(response.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > MAX_ATTACHMENT_BYTES) {
    return { ok: false, reason: 'too_large' }
  }

  let bytes: Uint8Array | null
  try {
    bytes = await readCapped(response)
  } catch {
    return { ok: false, reason: 'download_failed' }
  }
  if (bytes === null) return { ok: false, reason: 'too_large' }
  if (bytes.byteLength === 0) return { ok: false, reason: 'empty_file' }
  return { ok: true, bytes, mimeType: mimeTypeOf(response) }
}

async function markFailed(
  supabase: AdminSupabaseClient,
  attachment: MessageAttachment,
  reason: RehostFailureReason,
  host: string | null,
): Promise<RehostOutcome> {
  const { error } = await supabase
    .from('message_attachments')
    .update({ status: 'failed', failure_reason: reason })
    .eq('id', attachment.id)
    .eq('status', 'pending')
  console.warn('guest media: re-host failed', {
    event: 'guest_media_rehost_failed',
    attachmentId: attachment.id,
    messageId: attachment.messageId,
    venueId: attachment.venueId,
    reason,
    host,
    ...(error ? { writeError: error.message } : {}),
  })
  return { status: 'failed', attachmentId: attachment.id, reason }
}

/**
 * Copy one pending attachment into the bucket and settle its row.
 *
 * Never throws: every failure is a `failed` outcome with a reason, and the row
 * says the same thing.
 */
export async function rehostAttachment(
  supabase: AdminSupabaseClient,
  attachment: MessageAttachment,
  fetchImpl: typeof fetch = fetch,
): Promise<RehostOutcome> {
  if (attachment.providerUrl === null) {
    return markFailed(supabase, attachment, 'no_link', null)
  }
  const target = downloadTargetFor(
    attachment.providerUrl,
    attachment.providerType,
  )
  if (!target.ok) {
    return markFailed(supabase, attachment, target.reason, target.host)
  }
  const host = target.url.hostname

  const downloaded = await download(
    target.url,
    attachment.providerType,
    fetchImpl,
  )
  if (!downloaded.ok) {
    return markFailed(supabase, attachment, downloaded.reason, host)
  }

  const path = storagePathFor(attachment)
  const { error: uploadError } = await supabase.storage
    .from(GUEST_MEDIA_BUCKET)
    .upload(path, downloaded.bytes, {
      contentType: downloaded.mimeType ?? 'application/octet-stream',
      // A second run over the same row writes the same bytes to the same path.
      upsert: true,
    })
  if (uploadError) {
    console.error('guest media: upload failed', {
      event: 'guest_media_upload_failed',
      attachmentId: attachment.id,
      error: uploadError.message,
    })
    return markFailed(supabase, attachment, 'upload_failed', host)
  }

  // The download is better evidence than a file extension or a backfill's
  // guess, so it settles 'unknown'. A kind Meta named is left as Meta named it.
  const kind =
    attachment.kind === 'unknown'
      ? kindFromMimeType(downloaded.mimeType)
      : attachment.kind

  const { data: updated, error: updateError } = await supabase
    .from('message_attachments')
    .update({
      status: 'ready',
      kind,
      storage_path: path,
      mime_type: downloaded.mimeType,
      byte_size: downloaded.bytes.byteLength,
      failure_reason: null,
    })
    .eq('id', attachment.id)
    .eq('status', 'pending')
    .select('id')
  if (updateError) {
    console.error('guest media: row update failed after upload', {
      event: 'guest_media_row_update_failed',
      attachmentId: attachment.id,
      error: updateError.message,
    })
    return {
      status: 'failed',
      attachmentId: attachment.id,
      reason: 'upload_failed',
    }
  }
  if ((updated ?? []).length === 0) {
    return { status: 'skipped', attachmentId: attachment.id }
  }

  console.log('guest media: re-hosted', {
    event: 'guest_media_rehosted',
    attachmentId: attachment.id,
    messageId: attachment.messageId,
    venueId: attachment.venueId,
    kind,
    bytes: downloaded.bytes.byteLength,
    host,
  })
  return {
    status: 'ready',
    attachmentId: attachment.id,
    kind,
    bytes: downloaded.bytes.byteLength,
  }
}

/**
 * Tell the operator app this message's attachments changed. See the header:
 * an UPDATE on the parent row is the only signal the live channel carries.
 */
export async function touchParentMessage(
  supabase: AdminSupabaseClient,
  messageId: string,
): Promise<void> {
  const { error } = await supabase
    .from('messages')
    .update({ updated_at: new Date().toISOString() })
    .eq('id', messageId)
  if (error) {
    console.warn('guest media: could not touch the parent message', {
      event: 'guest_media_touch_failed',
      messageId,
      error: error.message,
    })
  }
}

/**
 * Re-host every pending attachment on one message, then touch the message.
 *
 * What both webhooks hand to waitUntil. Never throws, because nothing awaits
 * it and an unhandled rejection there is a crashed function with no log line.
 */
export async function rehostMessageAttachments(
  supabase: AdminSupabaseClient,
  messageId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<RehostOutcome[]> {
  try {
    const pending = await loadPendingAttachmentsForMessage(supabase, messageId)
    if (!pending.ok) {
      console.error('guest media: could not load pending attachments', {
        event: 'guest_media_load_failed',
        messageId,
        error: pending.error,
      })
      return []
    }
    if (pending.data.length === 0) return []

    const outcomes: RehostOutcome[] = []
    for (const attachment of pending.data) {
      outcomes.push(await rehostAttachment(supabase, attachment, fetchImpl))
    }
    if (outcomes.some((outcome) => outcome.status !== 'skipped')) {
      await touchParentMessage(supabase, messageId)
    }
    return outcomes
  } catch (e) {
    console.error('guest media: unexpected error; attachments left pending', {
      event: 'guest_media_rehost_threw',
      messageId,
      error: e instanceof Error ? e.message : String(e),
    })
    return []
  }
}
