// Phone test 2026-10-07: a guest asked for help buying beans and every reply
// in the thread ended with an offer of more help. It read as a script.
//
// ONE OFFER PER CONVERSATION, DECIDED IN CODE (ruled 2026-10-07; it replaced a
// same-day rule that only barred two in a row). Once a message of ours in the
// current conversation has ended with one, no later reply in it carries one.
//
// HOW IT KNOWS, AND WHAT IT CANNOT KNOW. Nothing stored marks a sent message
// as an offer: it is an ordinary row, the last one of its reply. So this reads
// the end of our own messages for the way an offer is worded, the same
// reasoning as already-apologised.ts. The list is wide on purpose. A false hit
// costs one offer the guest did not get, which is the safe direction; a miss
// is the defect this exists for. Knowing exactly would take a marker on the
// row, which is a column on `messages`.

import { reachedGuest } from './retrieval-context'
import type { RecentMessage } from '@/lib/ai/types'

const OFFER_WORDING =
  /\b(happy to|glad to|anything else|any other|if you (?:want|need|have|tell|let|ever)|let (?:me|us) know|just ask|ask away|ask (?:me|us)|more about|point you|narrow it down)\b/i

/** How much of the end of a message is read. An offer is its last line. */
const TAIL_CHARS = 160

const endsWithOffer = (m: RecentMessage): boolean =>
  OFFER_WORDING.test(m.body.slice(-TAIL_CHARS))

/**
 * Has a message of ours in the current conversation already ended with an
 * offer of more help? The offer decision sends none after that.
 *
 * "Current conversation" is the caller's window, the one definition
 * build-runtime-context hoists, measured back from when the guest's message
 * arrived.
 */
export function offeredThisConversation(
  recentMessages: readonly RecentMessage[],
  asOf: Date,
  conversationWindowMs: number,
): boolean {
  return recentMessages.some(
    (m) =>
      m.direction === 'outbound' &&
      reachedGuest(m) &&
      asOf.getTime() - m.createdAt.getTime() <= conversationWindowMs &&
      endsWithOffer(m),
  )
}

/**
 * Did the LAST message of ours that reached this guest end with an offer?
 * Then the guest's message now is, as far as code can tell, taking us up on
 * it, and the prompt says so (`## They are answering your offer`).
 */
export function previousReplyOffered(
  recentMessages: readonly RecentMessage[],
): boolean {
  const last = recentMessages
    .filter((m) => m.direction === 'outbound' && reachedGuest(m))
    .at(-1)
  if (last === undefined) return false
  return endsWithOffer(last)
}
