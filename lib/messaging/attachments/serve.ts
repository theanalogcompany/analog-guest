// TAC-582: attachment rows to what the operator app is sent.
//
// The table says where a file IS. This says what the app may be shown right
// now, which is not the same thing, in three ways:
//
//   A SIGNED LINK IS MINTED PER READ. The bucket is private, so a stored path
//   is useless to the app; each thread read signs every ready file for one
//   hour and says when that hour ends (`urlExpiresAt`). The app refetches the
//   thread when a link has expired; nothing here is cached.
//
//   'expired' IS DERIVED, never stored. Meta forbids keeping a story, so a
//   story row only ever holds Meta's own link, and that link is offered for
//   24 hours from when the row was written and then withheld.
//
//   A 'pending' ROW THAT HAS WAITED TOO LONG IS REPORTED AS 'failed'. The
//   re-host step runs after the webhook's 200 and nothing sweeps a row whose
//   function died, so without this the app would show a spinner that cannot
//   finish. The ROW stays pending, which is what lets
//   scripts/rehost-pending-attachments.ts still recover the file.
//
// SIGNING FAILS SOFT. A thread is a list of messages first; one file that
// cannot be signed is reported as 'failed' with no link, and the thread still
// loads. A failure of the whole signing call does the same for every file and
// is logged once.

import type { SupabaseClient } from '@supabase/supabase-js'

import type { Database } from '@/db/types'
import type {
  THREAD_ATTACHMENT_KINDS,
  THREAD_ATTACHMENT_STATUSES,
  ThreadAttachment,
} from '@/lib/schemas'

import { type AttachmentKind, type AttachmentStatus, isStoryKind } from './kind'
import { GUEST_MEDIA_BUCKET } from './rehost'
import type { MessageAttachment } from './store'

type AdminSupabaseClient = SupabaseClient<Database>

// The wire's enums and the table's are restated in two files on purpose (see
// lib/schemas/thread-message.ts). These two lines are what make that safe: a
// kind or status added to the table and not to the wire stops compiling here.
type WireKind = (typeof THREAD_ATTACHMENT_KINDS)[number]
type WireStatus = (typeof THREAD_ATTACHMENT_STATUSES)[number]
const wireKind = (kind: AttachmentKind) => kind satisfies WireKind
const wireStatus = (status: AttachmentStatus) => status satisfies WireStatus

/** How long a signed link works. The Contract says one hour. */
export const SIGNED_URL_TTL_SECONDS = 3600

/** How long Meta's link to a story is offered before it is withheld. */
export const STORY_LINK_TTL_MS = 24 * 60 * 60 * 1000

/** A copy that has not finished after this long is not going to. */
export const PENDING_STALE_MS = 15 * 60 * 1000

function withheld(
  attachment: MessageAttachment,
  status: AttachmentStatus,
): ThreadAttachment {
  return {
    id: attachment.id,
    kind: wireKind(attachment.kind),
    status: wireStatus(status),
    url: null,
    urlExpiresAt: null,
    mimeType: attachment.mimeType,
    title: attachment.title,
    linkUrl: attachment.linkUrl,
  }
}

/**
 * One row to its wire shape. Pure: `signedUrls` is whatever the signing call
 * returned, keyed by storage path, and `now` is passed in.
 */
export function toThreadAttachment(
  attachment: MessageAttachment,
  signedUrls: ReadonlyMap<string, string>,
  now: Date,
): ThreadAttachment {
  const createdAt = new Date(attachment.createdAt).getTime()

  if (isStoryKind(attachment.kind)) {
    const expiresAt = createdAt + STORY_LINK_TTL_MS
    if (attachment.providerUrl === null || now.getTime() >= expiresAt) {
      return withheld(attachment, 'expired')
    }
    return {
      ...withheld(attachment, 'link_only'),
      url: attachment.providerUrl,
      urlExpiresAt: new Date(expiresAt).toISOString(),
      linkUrl: null,
    }
  }

  switch (attachment.status) {
    case 'ready': {
      // Our own copy when there is one; otherwise the link that was stored as
      // it arrived, which is only ever giphy's and does not expire.
      if (attachment.storagePath === null) {
        return attachment.providerUrl === null
          ? withheld(attachment, 'failed')
          : { ...withheld(attachment, 'ready'), url: attachment.providerUrl }
      }
      const signed = signedUrls.get(attachment.storagePath)
      if (signed === undefined) return withheld(attachment, 'failed')
      return {
        ...withheld(attachment, 'ready'),
        url: signed,
        urlExpiresAt: new Date(
          now.getTime() + SIGNED_URL_TTL_SECONDS * 1000,
        ).toISOString(),
      }
    }
    case 'pending':
      return withheld(
        attachment,
        now.getTime() - createdAt > PENDING_STALE_MS ? 'failed' : 'pending',
      )
    case 'link_only':
    case 'expired':
    case 'failed':
      return withheld(attachment, attachment.status)
  }
}

/**
 * Sign every ready file in one call. Returns path to signed link; a path that
 * could not be signed is simply absent, which toThreadAttachment reads as
 * 'failed'.
 */
async function signStoragePaths(
  supabase: AdminSupabaseClient,
  paths: readonly string[],
): Promise<Map<string, string>> {
  const signed = new Map<string, string>()
  if (paths.length === 0) return signed

  const { data, error } = await supabase.storage
    .from(GUEST_MEDIA_BUCKET)
    .createSignedUrls([...paths], SIGNED_URL_TTL_SECONDS)
  if (error) {
    console.error('guest media: signing failed; files reported as failed', {
      event: 'guest_media_sign_failed',
      count: paths.length,
      error: error.message,
    })
    return signed
  }
  for (const entry of data ?? []) {
    if (entry.path && entry.signedUrl && !entry.error) {
      signed.set(entry.path, entry.signedUrl)
    }
  }
  return signed
}

/**
 * The wire attachments for a set of rows, grouped by message id, each list in
 * position order (the order `loadAttachmentsForMessages` returns).
 */
export async function serveAttachments(
  supabase: AdminSupabaseClient,
  attachments: readonly MessageAttachment[],
  now: Date = new Date(),
): Promise<Map<string, ThreadAttachment[]>> {
  const paths = attachments
    .filter((a) => a.status === 'ready' && a.storagePath !== null)
    .map((a) => a.storagePath)
    .filter((path): path is string => path !== null)
  const signedUrls = await signStoragePaths(supabase, paths)

  const byMessage = new Map<string, ThreadAttachment[]>()
  for (const attachment of attachments) {
    const served = toThreadAttachment(attachment, signedUrls, now)
    const list = byMessage.get(attachment.messageId)
    if (list) list.push(served)
    else byMessage.set(attachment.messageId, [served])
  }
  return byMessage
}
