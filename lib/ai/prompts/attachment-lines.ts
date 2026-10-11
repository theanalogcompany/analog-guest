// TAC-582: how a guest's attachment reads in the conversation the model sees.
//
// The agent never sees an image, a voice note or a reel. It is told, in one
// bracketed line per attachment, that the guest sent one. This file is the
// only place that wording lives, and all three history renderers (the
// generator's chat turns, the trace transcript, the classifier's block) take
// it from here so they cannot describe the same message differently.
//
// THE WORDING IS THE OWNER'S, approved verbatim on 2026-10-11 (TAC-582, plan
// section 4). The first five lines are the ticket's own. Changing any of them
// changes the composed prompt and is a PROMPT_VERSION bump.
//
// GUEST LINES ONLY. A photo staff sent from the Instagram app is stored and
// shown to operators, and never rendered here: an assistant turn reading
// "[venue sent a photo]" teaches the model to write bracketed lines to guests.
//
// THE LINES ARE NOT PART OF THE BODY. They ride beside it on
// RecentMessage.attachmentLines and are joined in only at render time,
// because retrieval, the pending-question check and the answer-to-our-question
// check all read history bodies, and a bracketed line in one of those would
// become a search query or an "answer".
//
// A REEL'S CAPTION IS SOMEONE ELSE'S TEXT. It was written by whoever posted
// the reel, not by the guest and not by us, and it is about to sit inside the
// prompt. So it is flattened to one line, stripped of the characters that
// could close the bracket or the quote around it, and cut short. That is
// about keeping the line's shape, which is the only thing wording can do; it
// is not a claim that a caption cannot carry an instruction.

import type { RecentMessage } from '@/lib/ai/types'
import {
  type AttachmentKind,
  isReelProviderType,
} from '@/lib/messaging/attachments/kind'

/** For a message Meta flagged `is_unsupported`: there is a row and nothing in it. */
export const UNSUPPORTED_HISTORY_LINE =
  "[guest sent something that can't be shown]"

/** For media with no attachment row behind it: a row older than the table, or a failed write. */
export const UNKNOWN_ATTACHMENT_HISTORY_LINE = '[guest sent an attachment]'

const MAX_SHARE_TITLE_CHARS = 80

// `share` is absent on purpose: it is one kind and three lines (a reel with a
// caption, a reel without, a post), decided in attachmentHistoryLine.
const HISTORY_LINES = {
  image: '[guest sent a photo]',
  audio: '[guest sent a voice note]',
  gif: '[guest sent a GIF]',
  video: '[guest sent a video]',
  file: '[guest sent a file]',
  story_mention: '[guest mentioned you in their story]',
  story_reply: '[guest is replying to your story]',
  unknown: UNKNOWN_ATTACHMENT_HISTORY_LINE,
} as const satisfies Record<Exclude<AttachmentKind, 'share'>, string>

function cleanShareTitle(title: string | null): string | null {
  if (title === null) return null
  const flat = title
    .replace(/[[\]'"`]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  if (flat === '') return null
  // Counted and cut in CODE POINTS. `slice` counts UTF-16 units, and a caption
  // is mostly emoji: a cut that lands inside one leaves half a character in
  // the prompt, which the model API can refuse outright (found in review).
  const points = Array.from(flat)
  return points.length > MAX_SHARE_TITLE_CHARS
    ? `${points.slice(0, MAX_SHARE_TITLE_CHARS).join('').trimEnd()}…`
    : flat
}

export type HistoryAttachment = {
  kind: AttachmentKind
  providerType: string | null
  title: string | null
}

/** The one line for one attachment. */
export function attachmentHistoryLine(attachment: HistoryAttachment): string {
  if (attachment.kind !== 'share') return HISTORY_LINES[attachment.kind]
  if (!isReelProviderType(attachment.providerType))
    return '[guest shared a post]'
  const title = cleanShareTitle(attachment.title)
  return title === null
    ? '[guest shared a reel]'
    : `[guest shared a reel: '${title}']`
}

export type HistoryAttachmentInput = {
  /** `messages.unsupported_content`. */
  unsupported: boolean
  /** `messages.media_urls` is non-empty. */
  hasMedia: boolean
  /** The message's attachment rows, in position order. May be empty. */
  attachments: readonly HistoryAttachment[]
}

/**
 * Every line for one message, in the order they are rendered.
 *
 * A story the guest is replying to comes first, whatever its position, because
 * it is the context for the words that follow it.
 */
export function historyAttachmentLines(
  input: HistoryAttachmentInput,
): string[] {
  if (input.attachments.length > 0) {
    const replies = input.attachments.filter((a) => a.kind === 'story_reply')
    const rest = input.attachments.filter((a) => a.kind !== 'story_reply')
    return [...replies, ...rest].map(attachmentHistoryLine)
  }
  if (input.unsupported) return [UNSUPPORTED_HISTORY_LINE]
  return input.hasMedia ? [UNKNOWN_ATTACHMENT_HISTORY_LINE] : []
}

/**
 * A history message's text with its attachment lines above it.
 *
 * `body` is passed in rather than read off the message because each renderer
 * normalizes the body its own way first. A message with no lines comes back
 * as `body`, untouched, so every history that has no attachments renders
 * byte-for-byte as it did before this file existed.
 */
export function withAttachmentLines(
  body: string,
  message: Pick<RecentMessage, 'direction' | 'attachmentLines'>,
  separator: string,
): string {
  const lines = message.attachmentLines ?? []
  if (lines.length === 0 || message.direction !== 'inbound') return body
  return [...lines, body].filter((part) => part !== '').join(separator)
}
