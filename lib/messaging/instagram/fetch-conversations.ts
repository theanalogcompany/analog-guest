// TAC-515: the Graph API reads behind the one-off history import
// (scripts/backfill-instagram-contacts.ts), on the Instagram Login path.
//
//   fetchConversationPage   GET /me/conversations?platform=instagram
//                           One page of the account's conversations, each with
//                           its participants and its most recent messages.
//   fetchMessageDetail      GET /{message-id}?fields=id,created_time,from,message
//                           One message, for a conversation whose nested
//                           messages came back as bare ids.
//
// Both take `withMedia` (TAC-582), which adds `attachments`, `shares`, `story`
// and `is_unsupported` to the message fields. The import never asks for them;
// its --attachments-only mode does. META DOES NOT DOCUMENT THESE FOUR on the
// Instagram Login path. The shapes read below are the Messenger Platform's
// Message node, so every message also reports the KEY NAMES it carried
// (`media.keyPaths`, names only, never a value), and the mode's dry run prints
// them. That list is what can disagree with this parser.
//
// GET ONLY. Nothing here can send, and nothing here imports the send modules:
// the import's rule is that it never writes to Instagram, and the cheapest way
// to keep that true is for its only Graph module to have no POST in it.
//
// WHAT META DOCUMENTS, and what it does not. It documents the endpoint, the
// two permissions, and that only the 20 most recent messages of a conversation
// carry details. It does NOT say whether a nested `messages{...}` expansion
// returns those details in one call, so both shapes are parsed: a message that
// arrives with only its id is reported as `needsDetail` and the caller fetches
// it on its own. It also does not say that a message `id` here is the webhook's
// `mid`; the import's dry run establishes that against rows we already hold.
//
// PAGING IS BY CURSOR, never by following `paging.next`. That URL carries the
// access token in its query string, and a URL ends up in error messages; the
// cursor is an opaque string that is safe to hold.
//
// The leak rules are graph.ts's: the token goes in a header, and a failure
// never carries Meta's message. Nothing here logs anything at all.

import {
  graphRequest,
  isRecord,
  stringOrNull,
  type FetchLike,
  type GraphFailure,
  type GraphResult,
} from './graph'

/** Nested expansion makes a page heavy; the 5 s default is for one profile. */
export const INSTAGRAM_CONVERSATIONS_TIMEOUT_MS = 30_000

export const INSTAGRAM_CONVERSATIONS_PAGE_SIZE = 20

const MESSAGE_FIELDS = 'id,created_time,from,message'
const MESSAGE_MEDIA_FIELDS = `${MESSAGE_FIELDS},attachments,shares,story,is_unsupported`

/**
 * Meta's throttling codes: 4 (app), 17 (user), 32 (page), 613 (custom), and
 * 80006 (the messaging family's own bucket). A 429 with none of them counts.
 */
const RATE_LIMIT_CODES: ReadonlySet<number> = new Set([4, 17, 32, 613, 80006])

export function isGraphRateLimited(failure: GraphFailure): boolean {
  if (failure.reason !== 'graph_error') return false
  if (failure.httpStatus === 429) return true
  return failure.code !== null && RATE_LIMIT_CODES.has(failure.code)
}

export type ConversationParticipant = {
  id: string
  username: string | null
}

/** One file on a message: a photo, a video, a voice note, a document. */
export type GraphMediaFile = {
  /**
   * Which of Meta's three places the link was read from. `generic_template`
   * is a card the venue's own tooling sent (a title and buttons, no file);
   * null is a shape this parser does not know.
   */
  source: 'image_data' | 'video_data' | 'file_url' | 'generic_template' | null
  /** A signed CDN link. Held in memory and stored; never printed. */
  url: string | null
  mimeType: string | null
}

export type GraphMediaShare = { link: string | null; name: string | null }

/**
 * What a message carried besides text, as Meta's conversation API shapes it.
 * This is NOT the webhook's shape (`attachments[].type` + `payload.url`), so
 * nothing here names a kind: scripts/lib/backfill-instagram-attachments.ts
 * decides that.
 */
export type GraphMessageMedia = {
  files: GraphMediaFile[]
  shares: GraphMediaShare[]
  /** `story.mention.link`: the guest's own story, mentioning the venue. */
  storyMention: { link: string | null } | null
  /** `story.reply_to.link`: the venue's story this message answers. */
  storyReply: { link: string | null } | null
  unsupported: boolean
  /** Key names under the four media fields, e.g. `attachments[].image_data.url`. */
  keyPaths: string[]
}

export type ConversationMessage = {
  id: string
  /** Meta's own time for the message, or null when it could not be read. */
  createdAt: Date | null
  fromId: string | null
  fromUsername: string | null
  /** The message text, or null when it has none (an attachment, a share). */
  text: string | null
  /** True when only the id came back and the rest has to be fetched by id. */
  needsDetail: boolean
  /** Empty unless the request asked for the media fields (`withMedia`). */
  media: GraphMessageMedia
}

export type InstagramConversation = {
  id: string
  participants: ConversationParticipant[]
  /** Participants Meta listed that could not be read (no string id). */
  unreadableParticipants: number
  messages: ConversationMessage[]
  /** Messages Meta listed that could not be read (no string id). */
  unreadableMessages: number
  /** Meta says the thread has more messages than it returned here. */
  hasMoreMessages: boolean
}

export type ConversationPage = {
  conversations: InstagramConversation[]
  /**
   * How many items Meta's page held, readable or not. The caller reconciles
   * against THIS, so an item this module could not parse is a counted loss
   * rather than a silent one.
   */
  rawCount: number
  /** The cursor for the next page, or null on the last one. */
  nextCursor: string | null
}

function listOf(value: unknown): unknown[] {
  if (!isRecord(value)) return []
  return Array.isArray(value.data) ? value.data : []
}

function parseDate(value: unknown): Date | null {
  if (typeof value !== 'string') return null
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? null : date
}

function parseParticipant(value: unknown): ConversationParticipant | null {
  if (!isRecord(value)) return null
  const id = stringOrNull(value.id)
  if (id === null) return null
  return { id, username: stringOrNull(value.username) }
}

// The same bounds parse-events.ts puts on a key name it reports: a name comes
// from Meta's JSON, so it is only ever printed when it looks like a field name.
const KEY_NAME = /^[a-z][a-z0-9_]{0,39}$/
const KEY_PATH_DEPTH = 3

function collectKeyPaths(
  value: unknown,
  prefix: string,
  depth: number,
  into: Set<string>,
): void {
  if (Array.isArray(value)) {
    for (const item of value) collectKeyPaths(item, `${prefix}[]`, depth, into)
    return
  }
  if (!isRecord(value)) {
    into.add(prefix)
    return
  }
  if (depth === 0) {
    into.add(`${prefix}.{…}`)
    return
  }
  for (const key of Object.keys(value)) {
    const name = KEY_NAME.test(key) ? key : '(unprintable)'
    collectKeyPaths(value[key], `${prefix}.${name}`, depth - 1, into)
  }
}

function linkOf(value: unknown): { link: string | null } | null {
  return isRecord(value) ? { link: stringOrNull(value.link) } : null
}

function parseMediaFile(value: unknown): GraphMediaFile | null {
  if (!isRecord(value)) return null
  const mimeType = stringOrNull(value.mime_type)
  for (const source of ['image_data', 'video_data'] as const) {
    const data = value[source]
    if (isRecord(data)) return { source, url: stringOrNull(data.url), mimeType }
  }
  if (isRecord(value.generic_template))
    return { source: 'generic_template', url: null, mimeType }
  const fileUrl = stringOrNull(value.file_url)
  return {
    source: fileUrl === null ? null : 'file_url',
    url: fileUrl,
    mimeType,
  }
}

/** Exported for the mode's own checks. Reads nothing but the four media fields. */
export function parseMessageMedia(
  value: Record<string, unknown>,
): GraphMessageMedia {
  const keyPaths = new Set<string>()
  for (const field of ['attachments', 'shares', 'story'] as const) {
    if (value[field] !== undefined)
      collectKeyPaths(value[field], field, KEY_PATH_DEPTH, keyPaths)
  }
  if (value.is_unsupported !== undefined) keyPaths.add('is_unsupported')

  const files: GraphMediaFile[] = []
  for (const raw of listOf(value.attachments)) {
    const file = parseMediaFile(raw)
    if (file !== null) files.push(file)
  }
  const shares: GraphMediaShare[] = []
  for (const raw of listOf(value.shares)) {
    if (isRecord(raw))
      shares.push({
        link: stringOrNull(raw.link),
        name: stringOrNull(raw.name),
      })
  }
  const story = isRecord(value.story) ? value.story : null
  return {
    files,
    shares,
    storyMention: story ? linkOf(story.mention) : null,
    storyReply: story ? linkOf(story.reply_to) : null,
    unsupported: value.is_unsupported === true,
    keyPaths: [...keyPaths].sort(),
  }
}

export function parseConversationMessage(
  value: unknown,
): ConversationMessage | null {
  if (!isRecord(value)) return null
  const id = stringOrNull(value.id)
  if (id === null) return null
  const from = isRecord(value.from) ? value.from : null
  const createdAt = parseDate(value.created_time)
  const fromId = from ? stringOrNull(from.id) : null
  const text =
    typeof value.message === 'string' && value.message.trim() !== ''
      ? value.message
      : null
  return {
    id,
    createdAt,
    fromId,
    fromUsername: from ? stringOrNull(from.username) : null,
    text,
    // A bare `{ id }` is the shape an unexpanded edge returns. A message that
    // has a time or a sender was expanded, whatever else it lacks.
    needsDetail: createdAt === null && fromId === null,
    media: parseMessageMedia(value),
  }
}

function parseConversation(value: unknown): InstagramConversation | null {
  if (!isRecord(value)) return null
  const id = stringOrNull(value.id)
  if (id === null) return null
  // An id that arrives as a JSON number has already lost precision by the time
  // it is parsed (scoped ids run to 17 digits), so it is counted as unreadable
  // rather than stored wrong.
  const rawParticipants = listOf(value.participants)
  const participants: ConversationParticipant[] = []
  for (const raw of rawParticipants) {
    const participant = parseParticipant(raw)
    if (participant !== null) participants.push(participant)
  }
  const rawMessages = listOf(value.messages)
  const messages: ConversationMessage[] = []
  for (const raw of rawMessages) {
    const message = parseConversationMessage(raw)
    if (message !== null) messages.push(message)
  }
  const messagePaging =
    isRecord(value.messages) && isRecord(value.messages.paging)
      ? value.messages.paging
      : null
  return {
    id,
    participants,
    unreadableParticipants: rawParticipants.length - participants.length,
    messages,
    unreadableMessages: rawMessages.length - messages.length,
    hasMoreMessages:
      messagePaging !== null && typeof messagePaging.next === 'string',
  }
}

/**
 * One page of the token's own conversations, newest first as Meta orders them.
 * `after` is the previous page's `nextCursor`.
 */
export async function fetchConversationPage(
  token: string,
  fetchImpl: FetchLike,
  after: string | null,
  withMedia = false,
): Promise<GraphResult<ConversationPage>> {
  const fields = `id,updated_time,participants,messages{${withMedia ? MESSAGE_MEDIA_FIELDS : MESSAGE_FIELDS}}`
  const query = [
    'platform=instagram',
    `limit=${INSTAGRAM_CONVERSATIONS_PAGE_SIZE}`,
    `fields=${encodeURIComponent(fields)}`,
    ...(after !== null ? [`after=${encodeURIComponent(after)}`] : []),
  ].join('&')
  const result = await graphRequest(
    'GET',
    `/me/conversations?${query}`,
    token,
    fetchImpl,
    { timeoutMs: INSTAGRAM_CONVERSATIONS_TIMEOUT_MS },
  )
  if (!result.ok) return result
  if (!isRecord(result.value) || !Array.isArray(result.value.data))
    return {
      ok: false,
      failure: { reason: 'malformed_response', httpStatus: 200 },
    }

  const conversations: InstagramConversation[] = []
  for (const raw of result.value.data) {
    const conversation = parseConversation(raw)
    if (conversation !== null) conversations.push(conversation)
  }
  const paging = isRecord(result.value.paging) ? result.value.paging : null
  const cursors = paging && isRecord(paging.cursors) ? paging.cursors : null
  // `next` is read only as a flag. Meta returns an `after` cursor on the last
  // page too, and following it would loop on an empty page.
  const hasNext = paging !== null && typeof paging.next === 'string'
  const nextCursor = hasNext && cursors ? stringOrNull(cursors.after) : null
  // More pages and no cursor to reach them with. Ending here would read as
  // the last page, and a short import would print as a whole one.
  if (hasNext && nextCursor === null)
    return {
      ok: false,
      failure: { reason: 'malformed_response', httpStatus: 200 },
    }
  return {
    ok: true,
    value: {
      conversations,
      rawCount: result.value.data.length,
      nextCursor,
    },
  }
}

/**
 * One message by id. Meta answers an id older than the conversation's 20 most
 * recent with an error saying it was deleted, which comes back as a failure.
 */
export async function fetchMessageDetail(
  messageId: string,
  token: string,
  fetchImpl: FetchLike,
  withMedia = false,
): Promise<GraphResult<ConversationMessage>> {
  const result = await graphRequest(
    'GET',
    `/${encodeURIComponent(messageId)}?fields=${encodeURIComponent(withMedia ? MESSAGE_MEDIA_FIELDS : MESSAGE_FIELDS)}`,
    token,
    fetchImpl,
    { timeoutMs: INSTAGRAM_CONVERSATIONS_TIMEOUT_MS },
  )
  if (!result.ok) return result
  const message = parseConversationMessage(result.value)
  if (message === null)
    return {
      ok: false,
      failure: { reason: 'malformed_response', httpStatus: 200 },
    }
  return { ok: true, value: message }
}
