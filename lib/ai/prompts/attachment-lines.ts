// TAC-582: how a guest's attachment reads in the conversation the model sees.
//
// The agent never sees an image, a voice note or a reel. It is told, in one
// bracketed line per attachment, that the guest sent one. This file is the
// only place that wording lives, and all three history renderers (the
// generator's chat turns, the trace transcript, the classifier's block) take
// it from here so they cannot describe the same message differently.
//
// THE WORDING IS THE OWNER'S, approved verbatim on 2026-10-11 (TAC-582). It
// was approved twice. The first wording was the bare marker, "[guest sent a
// photo]". Measured, it met its bar (no reply described a photo it had not
// seen) and did something nobody asked about: in 5 of 20 replies the model
// told the guest the photo "didn't come through", because it knew a photo
// existed, had nothing to look at, and was given no words for why. The
// second wording, the one here, says the three things the model needs inside
// the bracket: it arrived, you cannot see it, and what not to do about that.
// Changing any of it changes the composed prompt and is a PROMPT_VERSION bump.
//
// ONE SENTENCE SHAPE, ONE VERB PER KIND. mediaLine builds every line, here
// and on the turn being answered (serializers.ts), so the two cannot drift.
// The verb is what one does with that kind of thing: see a photo, hear a
// voice note, watch a video, open a share.
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
// TAC-584: ONCE AN ATTACHMENT HAS BEEN DESCRIBED, THE LINE SAYS WHAT IT SHOWS.
// A photo, video, GIF or story mention the describe step could make out
// (lib/messaging/attachments/describe.ts) stops being "you can't see it" and
// becomes its description. Two shapes, both approved verbatim on TAC-584's
// plan (2026-10-11):
//   in history    "[guest sent a photo: <description>]". The bare shape is
//                 safe here where the bare marker was not: the defect the
//                 second wording fixed was a model that knew a photo existed
//                 and had nothing to look at. Now it has the description.
//                 ONLY ON A HELD TURN: the history is built without
//                 descriptions, and lib/agent/media-history.ts swaps this
//                 wording in once the reply is known to be held.
//   on the turn   describedMediaLine, which also carries the three rules for
//   being         replying to a picture: which drinks may be named, nothing
//   answered      about any person, nothing the description does not say.
// An attachment with no description, or one too unclear to make out, keeps
// the line it has always had, so every conversation without described media
// renders byte for byte as it did.
//
// THE DESCRIPTION IS A MODEL'S SENTENCE ABOUT A GUEST'S PICTURE. It arrives
// here already flattened, stripped of brackets and quotes, and cut short
// (cleanDescription, lib/schemas/attachment-description.ts), for the reason a
// reel's caption is. This file does not clean it again and never builds a
// line from an uncleaned one: HistoryAttachment.description is documented as
// the cleaned form and both writers take it from usableDescription.
//
// A REEL'S CAPTION IS SOMEONE ELSE'S TEXT. It was written by whoever posted
// the reel, not by the guest and not by us, and it is about to sit inside the
// prompt. So it is flattened to one line, stripped of the characters that
// could close the bracket or the quote around it, and cut short. That is
// about keeping the line's shape, which is the only thing wording can do; it
// is not a claim that a caption cannot carry an instruction.

import type { DescribedMediaWord, RecentMessage } from '@/lib/ai/types'
import {
  type AttachmentKind,
  isReelProviderType,
} from '@/lib/messaging/attachments/kind'

/** For a message Meta flagged `is_unsupported`: there is a row and nothing in it. */
export const UNSUPPORTED_HISTORY_LINE =
  "[guest sent something that can't be shown]"

/** What the model cannot do with a thing it was only told about. */
export type MediaVerb =
  'see it' | 'hear it' | 'watch it' | 'open it' | 'see the story'

/**
 * The one sentence shape every media line has. `lead` is what happened
 * ("guest sent a photo"); `verb` is what the model cannot do with it.
 */
export function mediaLine(lead: string, verb: MediaVerb): string {
  return `[${lead}. It arrived fine, but you can't ${verb}. Don't describe it, guess what's in it, or say it didn't come through.]`
}

/** For media with no attachment row behind it: a row older than the table, or a failed write. */
export const UNKNOWN_ATTACHMENT_HISTORY_LINE = mediaLine(
  'guest sent an attachment',
  'open it',
)

/**
 * For a message that answers one of the venue's stories. Its own constant
 * because the turn being answered renders it too, above the guest's words.
 */
export const STORY_REPLY_HISTORY_LINE = mediaLine(
  'guest is replying to your story',
  'see the story',
)

const MAX_SHARE_TITLE_CHARS = 80

// `share` is absent on purpose: it is one kind and three lines (a reel with a
// caption, a reel without, a post), decided in attachmentHistoryLine.
//
// A file and an unknown attachment take "open it". The owner's ruling named
// a verb for the photo, voice note, video, GIF, share and the two story
// kinds; these two were not named, and "open" is the one of the approved
// verbs that is true of something whose type is not known.
const HISTORY_LINES = {
  image: mediaLine('guest sent a photo', 'see it'),
  audio: mediaLine('guest sent a voice note', 'hear it'),
  gif: mediaLine('guest sent a GIF', 'see it'),
  video: mediaLine('guest sent a video', 'watch it'),
  file: mediaLine('guest sent a file', 'open it'),
  story_mention: mediaLine(
    'guest mentioned you in their story',
    'see the story',
  ),
  story_reply: STORY_REPLY_HISTORY_LINE,
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
  /**
   * TAC-584: what the attachment shows, already cleaned for a prompt, when the
   * describe step produced something usable. Absent or null otherwise, and
   * the line is then the one this kind has always had.
   */
  description?: string | null
}

const DESCRIBED_WORD_BY_KIND = {
  image: 'photo',
  video: 'video',
  gif: 'gif',
  story_mention: 'story',
} as const satisfies Partial<Record<AttachmentKind, DescribedMediaWord>>

/** The kinds a description can exist for. Nothing else is ever described. */
function describedWordFor(kind: AttachmentKind): DescribedMediaWord | null {
  return kind in DESCRIBED_WORD_BY_KIND
    ? DESCRIBED_WORD_BY_KIND[kind as keyof typeof DESCRIBED_WORD_BY_KIND]
    : null
}

// "tagged", where the undescribed line says "mentioned": the ticket's wording
// for a story the agent has been told about.
const DESCRIBED_HISTORY_LEADS = {
  photo: 'guest sent a photo',
  video: 'guest sent a video',
  gif: 'guest sent a GIF',
  story: 'guest tagged you in their story',
} as const satisfies Record<DescribedMediaWord, string>

/** `[guest sent a photo: two iced drinks on a table]`. History only. */
export function describedHistoryLine(
  word: DescribedMediaWord,
  description: string,
): string {
  return `[${DESCRIBED_HISTORY_LEADS[word]}: ${description}]`
}

// What happened, on the turn that answers it. A story has one lead whether or
// not words came with it: a story tag carries none.
const DESCRIBED_TURN_LEADS = {
  photo: ['guest sent a photo with no text', 'guest also sent a photo'],
  video: ['guest sent a video with no text', 'guest also sent a video'],
  gif: ['guest sent a GIF with no text', 'guest also sent a GIF'],
  story: ['guest tagged you in their story', 'guest tagged you in their story'],
} as const satisfies Record<DescribedMediaWord, readonly [string, string]>

function describedTurnLead(word: DescribedMediaWord, hasText: boolean): string {
  return DESCRIBED_TURN_LEADS[word][hasText ? 1 : 0]
}

function namingClause(items: readonly string[]): string {
  return items.length > 0
    ? `You may name ${joinNames(items)} and no other menu item`
    : "You can't tell which menu items these are, so name none and keep to what it looks like"
}

// "A", "A and B", "A, B and C". Menu names carry their own punctuation
// ("SoFi – Classic"), so nothing here adds quotes around them.
function joinNames(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? ''
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`
}

export type DescribedTurnMedia = {
  word: DescribedMediaWord
  /** The turn has words from the guest as well as this. */
  hasText: boolean
  /** Cleaned for a prompt. */
  description: string
  /** The menu items the reply may name: nameableItems, and nothing else. */
  nameableItems: readonly string[]
}

/**
 * The line for a described attachment on the turn that answers it.
 *
 * ONE SENTENCE SHAPE, as mediaLine is, and for the same reason: the rules sit
 * inside the bracket with the thing they are about, in the last position
 * before the model writes (later beats earlier in the composed prompt). They
 * are here and not in the universal rules because they apply to a turn with a
 * described picture and to no other, and a universal rule would be read on
 * every turn.
 *
 * Every prohibition names what to do instead ("keep to what it looks like",
 * "reply only to the drinks, the food or the space").
 *
 * "Don't assume the day, time or occasion" was added by the owner on
 * 2026-10-11, after the smoke run: a draft answered a screenshot of a pizza
 * with "a good Friday night plan", on a Sunday. A picture says what is in it
 * and not when it was taken or why.
 */
export function describedMediaLine(media: DescribedTurnMedia): string {
  return `[${describedTurnLead(media.word, media.hasText)}. It shows: ${media.description}. ${namingClause(media.nameableItems)}. Reply only to the drinks, the food or the space in it. Say nothing about any person in it, and nothing the description does not say. Don't assume the day, time or occasion.]`
}

/**
 * For media sent with no text that the describe step looked at and could not
 * make out. The tail is mediaLine's own, so the three things the model must
 * not do about a picture it has nothing to say about are worded once.
 *
 * Only for a turn with no text. Beside text, an unclear picture keeps the
 * "[guest also sent a photo. ...you can't see it...]" line it always had.
 */
export function unclearMediaLine(word: DescribedMediaWord): string {
  return `[${describedTurnLead(word, false)}. It arrived fine, but it is too unclear to make out. Thank them for sending it. Don't describe it, guess what's in it, or say it didn't come through.]`
}

/** The one line for one attachment. */
export function attachmentHistoryLine(attachment: HistoryAttachment): string {
  // TAC-584: described, so the line is what it shows.
  const word = describedWordFor(attachment.kind)
  if (
    word !== null &&
    attachment.description !== undefined &&
    attachment.description !== null &&
    attachment.description !== ''
  ) {
    return describedHistoryLine(word, attachment.description)
  }
  if (attachment.kind !== 'share') return HISTORY_LINES[attachment.kind]
  if (!isReelProviderType(attachment.providerType)) {
    return mediaLine('guest shared a post', 'open it')
  }
  const title = cleanShareTitle(attachment.title)
  return mediaLine(
    title === null ? 'guest shared a reel' : `guest shared a reel: '${title}'`,
    'open it',
  )
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
