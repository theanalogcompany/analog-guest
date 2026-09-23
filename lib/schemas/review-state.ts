// TAC-473: the review_state a card reaches when it was answered outside the
// operator app.
//
// Domain-free, on the `message-channel.ts` / `referral-source.ts` model, and
// for the reason that entry gives: it has callers that must AGREE and must not
// import each other.
//
//   - lib/messaging/instagram/resolve-external.ts writes it when an echo from
//     the Instagram app resolves a card.
//   - app/api/operator/messages/[id]/resolve-external/route.ts writes it when
//     an operator says they sent it by hand. That route is deliberately NOT
//     Instagram-specific, so importing the value out of a provider folder was
//     backwards.
//   - lib/agent/group-responses.ts READS it, to mark the line in the agent's
//     conversation history as answered outside the app rather than as a send
//     that failed.
//
// Three call sites holding the same string literal is the drift this repo
// keeps paying for. One definition, here.
//
// The value must match migration 056's `messages_review_state_check`, which is
// the only thing that can actually reject a wrong one. SQL cannot import this
// constant, so `review-state.test.ts` reads the migration and binds the two —
// the same technique `pending-slots.test.ts` uses on migration 054's index and
// `reached-guest-condition.test.ts` uses on migrations 043/044.

/**
 * A pending draft the guest was answered on, outside the operator app: either
 * an echo of a reply staff typed in Instagram, or an operator asserting by
 * hand that they sent it.
 *
 * NOT `'skipped'`, which means the operator chose to send nothing. Recording
 * one as the other would put a verdict nobody gave on the row and corrupt the
 * skip rate with cards that were in fact answered.
 */
export const RESOLVED_EXTERNALLY_REVIEW_STATE = 'resolved_externally'
