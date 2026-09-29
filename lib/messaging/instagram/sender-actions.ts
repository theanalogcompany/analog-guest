// TAC-540: tell the guest we are here. Meta's three sender actions.
//
//   POST /{instagram_account_id}/messages
//   { "recipient": { "id": "<IGSID>" }, "sender_action": "mark_seen" }
//
// THE BODY CARRIES NOTHING ELSE, and that is Meta's rule rather than ours:
//
//   "Requests to display sender actions for typing indicators and mark_seen
//    indicators should only include the sender_action parameter and the
//    recipient object. All other Send API properties, such as text and
//    templates, should be sent in a separate request."
//   -- developers.facebook.com/docs/instagram-platform/
//      instagram-api-with-instagram-login/messaging-api/sender-actions
//
// So a sender action is never merged into a send, and `sendInstagramText`
// never carries one. Two calls, always.
//
// THE 20-SECOND TIMEOUT, and where it is actually written down. The Instagram
// sender-actions page above states NO timeout; its only timing wording is
// "Do not allow an unnatural amount of time (too long or too short) to pass
// between typing_on and typing_off". The number lives one page away, in the
// Page Messages reference that the Instagram page itself points at for the
// complete list of sender actions:
//
//   "TYPING_ON - Indicates that you are typing a response to the customer's
//    message. Automatically turns off after 20 seconds or after a response
//    is sent"
//   -- developers.facebook.com/docs/graph-api/reference/page/messages/
//
// Both halves of that sentence are load-bearing. The 20 seconds is why
// handle-inbound sends typing_on a SECOND time after generation returns:
// generation alone runs to ~11s at p90, so one typing_on would expire before
// the reply landed. And "or after a response is sent" is why nothing sends
// typing_off after a successful reply — Meta clears it.
//
// It is a Messenger-surface statement reached by the Instagram page's own
// pointer, not an Instagram-specific one, so TAC-540's device QA confirms it
// on a real thread. Nothing here breaks if it is wrong in either direction:
// a shorter timeout costs a gap in the dots, a longer one is bounded by the
// typing_off this repo sends on every non-send exit.
//
// HOST AND PATH ARE send.ts's, not the doc's. The sender-actions page curls
// `graph.facebook.com/.../me/messages`, but the messaging-api page states
// "All endpoints can be accessed via the graph.instagram.com host" and
// "Endpoints /<IG_ID>/messages or /me/messages". So this goes through exactly
// the request path a text send already uses in production, and `/me` is only
// the self-reference spelling of the account id we already pass.
//
// ONE MORE LIMITATION WORTH KNOWING, because it is invisible from here: "The
// recipient must be signed in for sender actions to be displayed." We cannot
// detect that, which is part of why nothing on the reply path reads a result.
//
// Pure apart from the fetch and the token, which are passed in. Never throws.
// Leak rules are graph.ts's: a failure carries Meta's codes, never its
// message, and nothing here logs the scoped ID, the account ID or the token.

import { graphRequest, type FetchLike, type GraphFailure } from './graph'
import { classifySendFailure, type InstagramSendFailureKind } from './send'

/**
 * The three actions this repo sends.
 *
 * `react` / `unreact` are the other two Meta accepts on the same field and are
 * deliberately absent: they carry a `payload` and a `message_id`, which is a
 * different request shape with a different reason to exist. Adding one means
 * widening `SenderActionBody` too, which is the point of leaving them out.
 */
export const INSTAGRAM_SENDER_ACTIONS = [
  'mark_seen',
  'typing_on',
  'typing_off',
] as const

export type InstagramSenderAction = (typeof INSTAGRAM_SENDER_ACTIONS)[number]

/**
 * How long a sender action may take before it is abandoned.
 *
 * SHORTER THAN THE SEND'S 10s, deliberately. A send's longer timeout buys
 * certainty about an ambiguous outcome, because Meta may have delivered it.
 * There is no such ambiguity here: nothing reads the result, nothing retries,
 * and a cosmetic call must never be the slowest thing on a turn. Matches the
 * Graph read timeout, which is the other call in this repo nobody waits on.
 */
export const INSTAGRAM_SENDER_ACTION_TIMEOUT_MS = 5_000

export type InstagramSenderActionResult =
  | { ok: true }
  | { ok: false; kind: InstagramSendFailureKind; failure: GraphFailure }

/**
 * Send one sender action.
 *
 * Reuses `classifySendFailure` rather than declaring its own vocabulary: the
 * failures are Meta's and they are the same failures a send meets (a rejected
 * token, a closed window, throttling). A second copy of that mapping would
 * drift from the one the send path reads, and the whole reason a sender
 * action is worth logging at all is that its failure kind tells you which of
 * those is happening.
 */
export async function sendInstagramSenderAction(input: {
  /** venues.instagram_account_id: the account the action is sent from. */
  accountId: string
  /** guests.instagram_scoped_id: the guest's IGSID for this account. */
  recipientId: string
  action: InstagramSenderAction
  token: string
  fetchImpl: FetchLike
}): Promise<InstagramSenderActionResult> {
  const result = await graphRequest(
    'POST',
    `/${encodeURIComponent(input.accountId)}/messages`,
    input.token,
    input.fetchImpl,
    {
      // Exactly these two keys. See the Limitations quote in the header.
      body: {
        recipient: { id: input.recipientId },
        sender_action: input.action,
      },
      timeoutMs: INSTAGRAM_SENDER_ACTION_TIMEOUT_MS,
    },
  )
  if (!result.ok) {
    return {
      ok: false,
      kind: classifySendFailure(result.failure),
      failure: result.failure,
    }
  }
  // Deliberately no body check, where sendInstagramText treats a 200 without a
  // `message_id` as a failure. A send needs the mid to save a row and to
  // reconcile the echo; an action has nothing to match to anything, so a 200
  // is the whole result and reading further would invent a failure mode.
  return { ok: true }
}
