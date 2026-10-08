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
// sign-off, a scan greeting, a follow-up and a holding message are never
// offers, whatever they say: a close's "message us anytime about the
// menu" is its whole job. So a row counts only when its stored category is one
// a reply with an offer can have. That is an ALLOW-list on purpose: a close or
// sign-off sent under a category that does not exist yet is excluded without
// anyone remembering to add it here.
//
// WHAT IT STILL CANNOT KNOW. Inside those replies, nothing stored marks one as
// having carried an offer, so both tests read the end of the message for the
// way an offer is worded. Knowing exactly would take a marker on the row,
// which is a column on `messages`.

import { replyCouldCarryOffer } from '@/lib/ai/further-help-offer'
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
 * A MESSAGE WITH NO CATEGORY IS NOT ONE OF OURS IN THE USUAL SENSE. Production
 * has them: a reply staff typed by hand in Instagram arrives as an echo row
 * with none, and so does a card an operator wrote out after a photo-only
 * message. The two callers treat it differently, and say so:
 *
 *   the veto    counts it by its wording. If staff wrote "let us know if you
 *               need anything else", the guest has had their offer.
 *   the block   does not. "Your last message ended by offering more help" is
 *               a claim about what the agent did, and it did not write this.
 */
function couldCarryOffer(
  m: RecentMessage,
  uncategorised: 'counts' | 'does_not_count',
): boolean {
  if (m.direction !== 'outbound' || !reachedGuest(m)) return false
  if (m.category == null) return uncategorised === 'counts'
  if (!(OFFER_REPLY_CATEGORIES as ReadonlySet<string>).has(m.category)) {
    return false
  }
  // And it has to be a reply an offer is ever appended to. A welcome that
  // invites the guest to say what they need is worded like an offer and is
  // not one (replyCouldCarryOffer has the phone thread this came from).
  return replyCouldCarryOffer(m.body, m.category as MessageCategory)
}

/** A model may write either apostrophe; the lists below use the plain one. */
const plain = (s: string): string => s.replace(/[\u2018\u2019]/g, "'")

/** Wide, for the veto. */
const OFFER_WORDING =
  /\b(happy to|glad to|anything else|any other|more questions|if you(?:'d|'re| would| are)? (?:want|need|have|tell|let|ever|like|curious|interested|not sure|unsure)|let (?:me|us) know|just ask|ask away|ask (?:me|us)|tell (?:me|us)|say the word|feel free|more about|point you|narrow it down|here (?:if|for|whenever)|whenever you need|reach out|shout|holler|can help|(?:i|we) can (?:walk|help|pick|point|go|talk|explain|find))\b/i

/** Narrow, for the block: phrasing that is an offer of more help and little else. */
const CLEAR_OFFER =
  /\b(?:happy|glad) to (?:help|answer|point|narrow|walk|talk|explain|(?:say|share|tell you) more|go deeper)\b|\banything else\b|\bany (?:other|more) questions?\b|\bif you(?:'d| would)? (?:want|need|have|like) (?:more|any (?:other|more)|help|a hand|anything)\b|\blet (?:me|us) know if you (?:want|need|have|'d like)\b|\bask away\b|\bfeel free to ask\b/i

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
      couldCarryOffer(m, 'counts') &&
      asOf.getTime() - m.createdAt.getTime() <= conversationWindowMs &&
      OFFER_WORDING.test(plain(m.body).slice(-WIDE_TAIL_CHARS)),
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
  if (last === undefined || !couldCarryOffer(last, 'does_not_count')) {
    return false
  }
  if (asOf.getTime() - last.createdAt.getTime() > conversationWindowMs) {
    return false
  }
  return CLEAR_OFFER.test(plain(last.body).slice(-CLEAR_TAIL_CHARS))
}
