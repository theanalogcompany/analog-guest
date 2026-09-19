// TAC-469: send one Instagram text message through Meta's Send API.
//
//   POST /{instagram_account_id}/messages
//   { "recipient": { "id": "<IGSID>" }, "message": { "text": "..." } }
//   -> { "recipient_id": "...", "message_id": "<mid>" }
//
// The venue's own account ID goes in the path, not `me`. The token is the one
// theanalog.company token until per-venue tokens exist (TAC-460), so a token
// that belongs to another account must fail at Meta rather than send from the
// wrong one; naming the account makes Meta refuse it.
//
// Nothing here reads the phone-number provider's settings: an Instagram-only
// venue has no `messaging_phone_number`, and this never asks for one.
//
// THE 1000-BYTE CAP. Meta refuses a text over 1000 bytes of UTF-8, and the
// limit is bytes, not characters: an emoji is 4 bytes, so 250 of them fill it
// while `.length` says 500. This is the backstop every Instagram send passes
// through, and it REFUSES, never truncates. The callers keep a reply under it
// before calling: the agent path repacks whole sentences across messages
// (lib/agent/dispatch-instagram-reply.ts), the operator path refuses before
// the card leaves the queue.
//
// Pure apart from the fetch and the token, which are passed in. Never throws.
// Leak rules are graph.ts's: a failure carries Meta's codes, never its message.

import {
  GRAPH_CODE_TOKEN_REJECTED,
  graphRequest,
  isRecord,
  stringOrNull,
  type FetchLike,
  type GraphFailure,
} from './graph'

/** Meta's limit on a text message, in UTF-8 bytes. */
export const INSTAGRAM_MAX_TEXT_BYTES = 1000

/**
 * How long a send may take before it is abandoned. Longer than the 5-second
 * read timeout because a timed-out send is ambiguous: Meta may have delivered
 * it. Waiting longer makes that case rarer.
 */
export const INSTAGRAM_SEND_TIMEOUT_MS = 10_000

/** Meta's code and subcode for a send outside the 24-hour reply window. */
export const GRAPH_CODE_WINDOW_CLOSED = 10
export const GRAPH_SUBCODE_WINDOW_CLOSED = 2534022

/** Meta's throttling codes: app-level, user-level, custom and page-level. */
const GRAPH_RATE_LIMIT_CODES: ReadonlySet<number> = new Set([4, 17, 32, 613])

/** "This person isn't available right now": blocked the account, or gone. */
const GRAPH_CODE_RECIPIENT_UNAVAILABLE = 551

export function instagramTextBytes(text: string): number {
  return Buffer.byteLength(text, 'utf8')
}

export function fitsInstagramTextCap(text: string): boolean {
  return instagramTextBytes(text) <= INSTAGRAM_MAX_TEXT_BYTES
}

/**
 * Why a send did not go out. `timeout`, `network` and `malformed_response` are
 * the kinds where Meta may have delivered it anyway (a 200 whose body we could
 * not read is still a 200); every other kind means it did not.
 */
export type InstagramSendFailureKind =
  | 'empty_text'
  | 'over_byte_cap'
  | 'window_closed'
  | 'token_rejected'
  | 'rate_limited'
  | 'recipient_unavailable'
  | 'timeout'
  | 'network'
  | 'graph_error'
  | 'malformed_response'

export type InstagramSendResult =
  | { ok: true; mid: string }
  | { ok: false; kind: InstagramSendFailureKind; failure: GraphFailure | null }

/**
 * Whether Meta may have delivered a send that reported this failure. A Graph
 * error carrying a 5xx counts too: Meta's own side failed, and it may have
 * accepted the message before it did.
 */
export function sendOutcomeUnknown(kind: InstagramSendFailureKind, httpStatus: number | null = null): boolean {
  if (kind === 'timeout' || kind === 'network' || kind === 'malformed_response') return true
  return kind === 'graph_error' && httpStatus !== null && httpStatus >= 500
}

/** The same question, asked of a whole failure result. */
export function sendResultOutcomeUnknown(result: Extract<InstagramSendResult, { ok: false }>): boolean {
  const status = result.failure?.reason === 'graph_error' ? result.failure.httpStatus : null
  return sendOutcomeUnknown(result.kind, status)
}

export function classifySendFailure(failure: GraphFailure): InstagramSendFailureKind {
  switch (failure.reason) {
    case 'timeout':
      return 'timeout'
    case 'network':
      return 'network'
    case 'malformed_response':
      return 'malformed_response'
    case 'graph_error':
      if (failure.code === GRAPH_CODE_WINDOW_CLOSED && failure.subcode === GRAPH_SUBCODE_WINDOW_CLOSED) {
        return 'window_closed'
      }
      if (failure.code === GRAPH_CODE_TOKEN_REJECTED) return 'token_rejected'
      if (failure.code !== null && GRAPH_RATE_LIMIT_CODES.has(failure.code)) return 'rate_limited'
      if (failure.code === GRAPH_CODE_RECIPIENT_UNAVAILABLE) return 'recipient_unavailable'
      return 'graph_error'
  }
}

export async function sendInstagramText(input: {
  /** venues.instagram_account_id: the account the message is sent from. */
  accountId: string
  /** guests.instagram_scoped_id: the guest's IGSID for this account. */
  recipientId: string
  text: string
  token: string
  fetchImpl: FetchLike
}): Promise<InstagramSendResult> {
  if (input.text.trim() === '') return { ok: false, kind: 'empty_text', failure: null }
  if (!fitsInstagramTextCap(input.text)) return { ok: false, kind: 'over_byte_cap', failure: null }

  const result = await graphRequest(
    'POST',
    `/${encodeURIComponent(input.accountId)}/messages`,
    input.token,
    input.fetchImpl,
    {
      body: { recipient: { id: input.recipientId }, message: { text: input.text } },
      timeoutMs: INSTAGRAM_SEND_TIMEOUT_MS,
    },
  )
  if (!result.ok) return { ok: false, kind: classifySendFailure(result.failure), failure: result.failure }

  // The mid is what the echo carries and what messages.provider_message_id
  // holds. A 200 without one cannot be matched to anything, so it is treated
  // as a failure even though Meta may have sent the message.
  const mid = isRecord(result.value) ? stringOrNull(result.value.message_id) : null
  if (mid === null) {
    return { ok: false, kind: 'malformed_response', failure: { reason: 'malformed_response', httpStatus: 200 } }
  }
  return { ok: true, mid }
}
