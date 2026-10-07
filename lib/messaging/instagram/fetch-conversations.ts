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
): Promise<GraphResult<ConversationPage>> {
  const fields = `id,updated_time,participants,messages{${MESSAGE_FIELDS}}`
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
): Promise<GraphResult<ConversationMessage>> {
  const result = await graphRequest(
    'GET',
    `/${encodeURIComponent(messageId)}?fields=${encodeURIComponent(MESSAGE_FIELDS)}`,
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
