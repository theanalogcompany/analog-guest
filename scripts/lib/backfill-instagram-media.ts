// TAC-582: the pure half of `backfill-instagram-contacts --media-only`.
//
// The history import (TAC-515) skipped every message with no text. This mode
// imports the ones that were a photo, a video or a reel share, as new message
// rows with attachment rows, FOR GUESTS WE ALREADY HOLD.
//
// WHAT IS IN SCOPE, as ruled 2026-10-11, and nothing else:
//   image, gif, video   copied into our storage where Meta still serves the
//                       link, and left `failed` with the link where it does not
//   a reel share        kept as a link, never copied
//
// WHAT IS LEFT OUT AND COUNTED, each for a reason:
//   story mentions and story replies
//                       Not imported at all. A story row would count as a reply
//                       and move a guest's derived activity for something that
//                       is often not the guest writing to us. Counted per
//                       person instead, for a later recognition signal.
//   people with no guest row
//                       Creating a guest from a photo gives them an old
//                       `first_contacted_at`, and their first real text would
//                       then not be a first conversation (isFirstConversation).
//   the last 14 days    The agent's history window and the media hold's
//                       lookback (lib/agent/media-history.ts, media-context.ts)
//                       both read media-only guest rows that recent. Staying
//                       outside it is what makes "no card, no change to what
//                       the model reads" true by construction, not by review.
//                       It also covers the import's own 24-hour rule.
//   after_live          The import's second rule, unchanged: nothing dated at
//                       or after a guest's oldest live message.
//   a message with text The import's business, not this mode's: it has a body,
//                       so the import's own rules decide it, and
//                       --attachments-only then adds its media.
//   generic_template, bare is_unsupported, group threads, other kinds
//
// WHAT AN IMPORTED ROW STILL CHANGES, accepted (ruling C): it is an inbound
// or outbound row, so the guest's lifetime reply count and response rate move
// (lib/recognition/load-signals.ts has no text filter), and so does their
// derived last activity (`venue_guest_activity`). Those are the only paths
// from a row here to the follow-up engine, both through the guest's
// recognition STATE, which is why the entry script refuses to write while any
// guest's state could move (stateCouldMove below).
//
// No `@/` import that constructs a client: types and pure helpers only.

import type {
  AttachmentKind,
  ParsedAttachment,
} from '@/lib/messaging/attachments/kind'
import { isReelProviderType } from '@/lib/messaging/attachments/kind'
import type { ConversationMessage } from '@/lib/messaging/instagram/fetch-conversations'

import { attachmentsFromGraphMedia } from './backfill-instagram-attachments'
import type {
  MessageDirection,
  PlannedMessage,
} from './backfill-instagram-contacts'

/** The agent's history window and the media hold's lookback, in days. */
export const MEDIA_ONLY_HOLD_BACK_DAYS = 14
const MS_PER_DAY = 24 * 60 * 60 * 1000

const IN_SCOPE_FILE_KINDS: ReadonlySet<AttachmentKind> = new Set([
  'image',
  'gif',
  'video',
])

/** Why a message Meta listed is not imported by this mode. One per message. */
export type MediaSkipReason =
  /** We already hold a row under this Meta id. */
  | 'already_stored'
  /** Only the id came back, and Meta refused the fetch by id. */
  | 'detail_unavailable'
  /** Text and nothing else: never this mode's. */
  | 'text_only'
  /** Text AND media: the import's to decide, then --attachments-only's. */
  | 'has_text'
  | 'story_mention'
  | 'story_reply'
  /** A card with a title and buttons, sent by tooling. Not a guest's media. */
  | 'generic_template'
  /** Flagged `is_unsupported` and carrying nothing else. */
  | 'unsupported_only'
  /** A file in a shape the parser read no link from. */
  | 'unread_shape'
  /** A voice note, a document, or a file whose type nothing named. */
  | 'other_kind'
  /** A share whose link is not a reel's. */
  | 'share_not_reel'
  /** A photo, video or share that came back with no link to store. */
  | 'no_link'
  | 'no_timestamp'
  /** Sent by neither the venue nor the conversation's guest. */
  | 'unknown_sender'
  /** The other participant is not a guest of ours. */
  | 'no_guest_row'
  | 'inside_14_days'
  | 'after_live'

export function emptyMediaSkips(): Record<MediaSkipReason, number> {
  return {
    already_stored: 0,
    detail_unavailable: 0,
    text_only: 0,
    has_text: 0,
    story_mention: 0,
    story_reply: 0,
    generic_template: 0,
    unsupported_only: 0,
    unread_shape: 0,
    other_kind: 0,
    share_not_reel: 0,
    no_link: 0,
    no_timestamp: 0,
    unknown_sender: 0,
    no_guest_row: 0,
    inside_14_days: 0,
    after_live: 0,
  } satisfies Record<MediaSkipReason, number>
}

export type PlannedMediaMessage = PlannedMessage & {
  attachments: ParsedAttachment[]
}

export type MediaMessageDecision =
  | { import: true; message: PlannedMediaMessage }
  | {
      import: false
      reason: MediaSkipReason
      /**
       * True when the message was in scope (a photo, video or reel share with
       * a link) and only a rule about the guest or the date kept it out. Its
       * attachments are then counted as "in scope, held back".
       */
      inScope: boolean
      attachments: ParsedAttachment[]
    }

export type MediaMessageInput = {
  message: ConversationMessage
  direction: MessageDirection | null
  alreadyStored: boolean
  /** The conversation's other participant is a guest of ours, not erased. */
  hasGuest: boolean
  /** This guest's oldest message the import did not write, or null. */
  oldestLiveMessageAt: Date | null
  now: Date
}

/**
 * Pure. What this mode does with one message Meta listed.
 *
 * WHAT THE MESSAGE IS comes first, before anything about the guest or the
 * date, so that the counts of what was left out (story mentions above all)
 * cover every conversation and not only the guests we hold.
 */
export function decideMediaMessage(
  input: MediaMessageInput,
): MediaMessageDecision {
  const { message } = input
  const attachments = attachmentsFromGraphMedia(message.media)
  const skip = (
    reason: MediaSkipReason,
    inScope = false,
  ): MediaMessageDecision => ({ import: false, reason, inScope, attachments })

  if (input.alreadyStored) return skip('already_stored')
  if (message.needsDetail) return skip('detail_unavailable')
  if (attachments.length === 0)
    return skip(message.media.unsupported ? 'unsupported_only' : 'text_only')
  if (message.text !== null) return skip('has_text')
  // A story anywhere on the message takes the whole message out: importing
  // the photo beside it would file half of what the guest sent.
  if (message.media.storyMention !== null) return skip('story_mention')
  if (message.media.storyReply !== null) return skip('story_reply')
  if (message.media.files.some((file) => file.source === 'generic_template'))
    return skip('generic_template')
  if (message.media.files.some((file) => file.source === null))
    return skip('unread_shape')
  for (const attachment of attachments) {
    if (attachment.kind === 'share') {
      if (!isReelProviderType(attachment.providerType))
        return skip('share_not_reel')
    } else if (!IN_SCOPE_FILE_KINDS.has(attachment.kind))
      return skip('other_kind')
  }
  // A row with no link has nothing in `media_urls`, and a message row with no
  // text and no media is one no reader shows (MESSAGE_HAS_CONTENT_FILTER).
  const mediaUrls: string[] = []
  for (const attachment of attachments) {
    if (attachment.url === null) return skip('no_link')
    mediaUrls.push(attachment.url)
  }

  if (message.createdAt === null) return skip('no_timestamp', true)
  if (input.direction === null) return skip('unknown_sender', true)
  if (!input.hasGuest) return skip('no_guest_row', true)
  if (
    input.now.getTime() - message.createdAt.getTime() <
    MEDIA_ONLY_HOLD_BACK_DAYS * MS_PER_DAY
  )
    return skip('inside_14_days', true)
  if (
    input.oldestLiveMessageAt !== null &&
    message.createdAt.getTime() >= input.oldestLiveMessageAt.getTime()
  )
    return skip('after_live', true)

  return {
    import: true,
    message: {
      mid: message.id,
      direction: input.direction,
      body: '',
      at: message.createdAt,
      mediaUrls,
      attachments,
    },
  }
}

export type StateBand = { state: string; atMin: string; atMax: string }

/**
 * Pure. Could importing rows for this guest move their recognition state?
 *
 * The import adds inbound and outbound rows, and the ONLY signal either
 * feeds is the response rate (replied / sent). Whatever the counts become,
 * that signal's contribution to the score stays between 0 and
 * `100 * weight`. So the score after the import lies between `scoreAtMin` and
 * `scoreAtMax`, and if both ends evaluate to the state the guest is in now,
 * no import of any size can move them.
 *
 * This is deliberately a bound and not the new score: it needs no second
 * implementation of the response-rate arithmetic to agree with the real one.
 * It over-refuses (a guest near a threshold is reported even if the real
 * change is tiny) and cannot under-refuse.
 */
export function scoreBounds(input: {
  /** Every signal's contribution except the response rate's, summed. */
  sumWithoutResponseRate: number
  responseRateWeight: number
}): { scoreAtMin: number; scoreAtMax: number } {
  return {
    scoreAtMin: Math.round(input.sumWithoutResponseRate),
    scoreAtMax: Math.round(
      input.sumWithoutResponseRate + 100 * input.responseRateWeight,
    ),
  }
}

export function stateCouldMove(band: StateBand): boolean {
  return band.atMin !== band.state || band.atMax !== band.state
}

/** Top `limit` counts, largest first, with no identity attached. */
export function topCounts(
  counts: ReadonlyMap<string, { count: number; hasGuest: boolean }>,
  limit: number,
): { count: number; hasGuest: boolean }[] {
  return [...counts.values()].sort((a, b) => b.count - a.count).slice(0, limit)
}
