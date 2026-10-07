// Phone test 2026-10-07: a guest asked for help buying beans and every reply
// in the thread ended with an offer of more help. It read as a script.
//
// ONE OFFER PER CONVERSATION, DECIDED IN CODE (ruled 2026-10-07; it replaced a
// same-day rule that only barred two in a row). Once a reply of ours in the
// current conversation has ended with one, no later reply in it carries one.
//
// TWO QUESTIONS, TWO TESTS, and the first version used one for both:
//
//   offeredThisConversation   feeds a VETO. A false hit costs one offer the
//                             guest did not get, so its wording list is wide.
//   previousReplyOffered      switches on a PROMPT BLOCK that tells the model
//                             the guest is answering our offer. A false hit
//                             there asserts something untrue as the last thing
//                             the model reads, so its list is narrow, it has a
//                             window, and it reads less of the message.
//
// Shared with the wide list, the block rendered after "if you want something
// cold, the tonic is the one", after a comp's "let us know when you're on your
// way", and after the opt-out confirmation's "text START anytime".
//
// WHICH MESSAGES CAN HAVE CARRIED ONE IS DECIDED BY HOW THEY WERE SENT, NOT BY
// HOW THEY READ (ruled 2026-10-07). An offer is only ever appended to a reply
// to a guest's message, in a category the decision allows. A warm close, a
// sign-off, a scan greeting, a follow-up and an operator's own message are
// never offers, whatever they say: a close's "message us anytime about the
// menu" is its whole job. So a row counts only when its stored category is one
// a reply with an offer can have. That is an ALLOW-list on purpose: a close or
// sign-off sent under a category that does not exist yet is excluded without
// anyone remembering to add it here.
//
// WHAT IT STILL CANNOT KNOW. Inside those replies, nothing stored marks one as
// having carried an offer, so both tests read the end of the message for the
// way an offer is worded. Knowing exactly would take a marker on the row,
// which is a column on `messages`.

import { reachedGuest } from './retrieval-context'
import type { MessageCategory, RecentMessage } from '@/lib/ai/types'

/**
 * The categories a reply carrying an offer can be stored under: a reply to a
 * guest's message that is not a complaint, a sign-off or an opt-out
 * (decideFurtherHelpOffer's own vetoes).
 */
const OFFER_REPLY_CATEGORIES: ReadonlySet<MessageCategory> = new Set([
  'reply',
  'new_question',
  'mechanic_request',
  'recommendation_request',
  'casual_chatter',
  'personal_history_question',
  'perk_inquiry',
  'event_question',
  'unknown',
])

/**
 * Could this message of ours have carried an offer at all?
 *
 * A message with NO category recorded counts. In production every row has
 * one; the only threads without are built by hand in a harness, and there the
 * wording is all there is to go on.
 */
function couldCarryOffer(m: RecentMessage): boolean {
  if (m.direction !== 'outbound' || !reachedGuest(m)) return false
  if (m.category == null) return true
  return (OFFER_REPLY_CATEGORIES as ReadonlySet<string>).has(m.category)
}

/** Wide, for the veto. */
const OFFER_WORDING =
  /\b(happy to|glad to|anything else|any other|more questions|if you(?:'d| would)? (?:want|need|have|tell|let|ever|like)|let (?:me|us) know|just ask|ask away|ask (?:me|us)|feel free|more about|point you|narrow it down|here (?:if|for)|reach out|shout|holler|can help)\b/i

/** Narrow, for the block: phrasing that is an offer of more help and little else. */
const CLEAR_OFFER =
  /\b(?:happy|glad) to (?:help|answer|point|say|share|narrow|go|walk|tell|talk|explain|find)\b|\banything else\b|\bany (?:other|more) questions?\b|\bif you(?:'d| would)? (?:want|need|have|like) (?:more|any|help|a hand|anything)\b|\blet (?:me|us) know if\b|\bask away\b|\bfeel free to ask\b/i

/** How much of the end of a message each test reads. An offer is its last line. */
const WIDE_TAIL_CHARS = 160
const CLEAR_TAIL_CHARS = 110

/**
 * Has a reply of ours in the current conversation already ended with an offer
 * of more help? The offer decision sends none after that.
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
      couldCarryOffer(m) &&
      asOf.getTime() - m.createdAt.getTime() <= conversationWindowMs &&
      OFFER_WORDING.test(m.body.slice(-WIDE_TAIL_CHARS)),
  )
}

/**
 * Is the guest's message now, as far as code can tell, taking us up on an
 * offer? True when the LAST message of ours that reached them is a reply in
 * the current conversation that clearly ended with one.
 *
 * The last message of ours of ANY kind: a close or a greeting sent after the
 * offer means the guest is not answering the offer any more.
 */
export function previousReplyOffered(
  recentMessages: readonly RecentMessage[],
  asOf: Date,
  conversationWindowMs: number,
): boolean {
  const last = recentMessages
    .filter((m) => m.direction === 'outbound' && reachedGuest(m))
    .at(-1)
  if (last === undefined || !couldCarryOffer(last)) return false
  if (asOf.getTime() - last.createdAt.getTime() > conversationWindowMs) {
    return false
  }
  return CLEAR_OFFER.test(last.body.slice(-CLEAR_TAIL_CHARS))
}
