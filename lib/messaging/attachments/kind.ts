// TAC-582: what a guest's attachment IS.
//
// Pure. Both webhooks hand whatever the provider sent to this file and get
// back one of nine kinds, and the re-host step asks it what a downloaded file
// turned out to be. Kept apart so the mapping needs no database and no
// network, which is what lets scripts/harness/inbound-attachments/ run it over
// the real payloads.
//
// THE KINDS ARE THE CONTRACT'S, plus nothing. `message_attachments.kind`
// carries a CHECK with the same nine values (migration 080), so a kind added
// here without a migration fails the insert rather than reaching the app.
//
// WHY GIPHY IS ITS OWN KIND. Instagram sends a GIF and a sticker as
// `type: "image"` with a giphy.com link, exactly like a photo except for the
// host. The link is permanent and public, so it is stored as it arrives and
// never copied; a photo's link is Meta's CDN and expires.
//
// WHY 'unknown' EXISTS. A Sendblue link with no file extension, and every row
// backfilled from `messages.media_urls`, says nothing about what it is. The
// download does: kindFromMimeType settles it once the bytes arrive.

export const ATTACHMENT_KINDS = [
  'image',
  'gif',
  'video',
  'audio',
  'file',
  'share',
  'story_mention',
  'story_reply',
  'unknown',
] as const

export type AttachmentKind = (typeof ATTACHMENT_KINDS)[number]

export const ATTACHMENT_STATUSES = [
  'pending',
  'ready',
  'link_only',
  'expired',
  'failed',
] as const

export type AttachmentStatus = (typeof ATTACHMENT_STATUSES)[number]

/** `provider_type` on a row that came in over Sendblue, which names no type. */
export const SENDBLUE_PROVIDER_TYPE = 'sendblue'

/** `provider_type` on the row that records the story a guest replied to. */
export const STORY_REPLY_PROVIDER_TYPE = 'reply_to_story'

/** One attachment as a webhook parsed it, before it has a row. */
export type ParsedAttachment = {
  kind: AttachmentKind
  /** The provider's own name for it (`image`, `ig_reel`, ...), kept verbatim. */
  providerType: string | null
  /** The link as it arrived. Null when the provider sent none. */
  url: string | null
  /** A share's caption. Null for everything else. */
  title: string | null
}

export function isAttachmentKind(value: unknown): value is AttachmentKind {
  return (
    typeof value === 'string' &&
    (ATTACHMENT_KINDS as readonly string[]).includes(value)
  )
}

export function isAttachmentStatus(value: unknown): value is AttachmentStatus {
  return (
    typeof value === 'string' &&
    (ATTACHMENT_STATUSES as readonly string[]).includes(value)
  )
}

export const GIF_EXTENSIONS: readonly string[] = ['gif']
export const PHOTO_EXTENSIONS: readonly string[] = [
  'jpg',
  'jpeg',
  'png',
  'heic',
  'heif',
  'webp',
]
export const VIDEO_EXTENSIONS: readonly string[] = ['mp4', 'mov', 'm4v', 'webm']
// A voice memo over iMessage is a .caf; the rest are what a phone attaches.
export const AUDIO_EXTENSIONS: readonly string[] = [
  'caf',
  'm4a',
  'mp3',
  'amr',
  'wav',
  'aac',
  'ogg',
  'opus',
]

export function extensionOf(url: string): string | null {
  try {
    const path = new URL(url).pathname
    const dot = path.lastIndexOf('.')
    if (dot === -1 || path.indexOf('/', dot) !== -1) return null
    return path.slice(dot + 1).toLowerCase()
  } catch {
    return null
  }
}

function hostOf(url: string | null): string | null {
  if (url === null) return null
  try {
    return new URL(url).hostname.toLowerCase()
  } catch {
    return null
  }
}

/** giphy.com or any subdomain of it (media3.giphy.com, i.giphy.com). */
export function isGiphyUrl(url: string | null): boolean {
  const host = hostOf(url)
  return host !== null && (host === 'giphy.com' || host.endsWith('.giphy.com'))
}

// Meta's four names for "the guest forwarded something from Instagram". A
// reel arrived as `ig_reel` in the payload captured on 2026-10-11; the other
// three are Meta's documented spellings and none has been seen here.
const SHARE_TYPES: ReadonlySet<string> = new Set([
  'ig_reel',
  'reel',
  'share',
  'ig_post',
])

const REEL_TYPES: ReadonlySet<string> = new Set(['ig_reel', 'reel'])

/** True when a share row is a reel rather than a post, by Meta's own type. */
export function isReelProviderType(providerType: string | null): boolean {
  return providerType !== null && REEL_TYPES.has(providerType)
}

/**
 * Meta's attachment `type`, plus the link's host, to a kind.
 *
 * A type this does not recognise is 'unknown' rather than a guess: the row is
 * still written and still shown, and `provider_type` keeps what Meta called it
 * so a new type is readable in the table the day it first arrives.
 */
export function kindFromInstagramType(
  type: string | null,
  url: string | null,
): AttachmentKind {
  switch (type) {
    case 'image':
      return isGiphyUrl(url) ? 'gif' : 'image'
    case 'video':
      return 'video'
    case 'audio':
      return 'audio'
    case 'file':
      return 'file'
    case 'story_mention':
      return 'story_mention'
    default:
      return type !== null && SHARE_TYPES.has(type) ? 'share' : 'unknown'
  }
}

/**
 * A Sendblue media link to a kind, by its file extension. Sendblue names no
 * type, so the extension is all there is until the file is downloaded.
 */
export function kindFromUrlExtension(url: string): AttachmentKind {
  if (isGiphyUrl(url)) return 'gif'
  const extension = extensionOf(url)
  if (extension === null) return 'unknown'
  if (GIF_EXTENSIONS.includes(extension)) return 'gif'
  if (PHOTO_EXTENSIONS.includes(extension)) return 'image'
  if (VIDEO_EXTENSIONS.includes(extension)) return 'video'
  if (AUDIO_EXTENSIONS.includes(extension)) return 'audio'
  return 'file'
}

/** What a downloaded file is, by the content type its server declared. */
export function kindFromMimeType(mimeType: string | null): AttachmentKind {
  if (mimeType === null) return 'unknown'
  const type = mimeType.split(';')[0]?.trim().toLowerCase() ?? ''
  if (type === 'image/gif') return 'gif'
  if (type.startsWith('image/')) return 'image'
  if (type.startsWith('video/')) return 'video'
  if (type.startsWith('audio/')) return 'audio'
  if (type === '' || type === 'application/octet-stream') return 'unknown'
  return 'file'
}

const STORY_KINDS: ReadonlySet<AttachmentKind> = new Set([
  'story_mention',
  'story_reply',
])

/** A story, the guest's or the venue's. Never copied: Meta forbids storing one. */
export function isStoryKind(kind: AttachmentKind): boolean {
  return STORY_KINDS.has(kind)
}

/**
 * The status a new row is written with.
 *
 *   giphy gif      'ready'      the giphy link is permanent and is what is served
 *   share, story   'link_only'  there is no file of ours to make
 *   anything else  'pending'    until the re-host step has copied it. That
 *                               includes a GIF that is not on giphy (one sent
 *                               over text): its link's lifetime is unknown.
 *   no link at all 'failed'     nothing to copy and nothing to link to
 */
export function initialStatusFor(
  kind: AttachmentKind,
  url: string | null,
): AttachmentStatus {
  if (url === null) return 'failed'
  if (kind === 'gif' && isGiphyUrl(url)) return 'ready'
  if (kind === 'share' || isStoryKind(kind)) return 'link_only'
  return 'pending'
}
