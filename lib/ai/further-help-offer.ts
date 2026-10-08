/**
 * Phone test 2026-10-07: should this reply end by offering more help?
 *
 * The rule is about what the answer DID: it sent a link, it recommended
 * something or helped the guest choose, or it walked them through how to do
 * something. Never after a single fact, on a complaint, on a sign-off, or on a
 * reply that already asks the guest something.
 *
 * WHY THE MODEL WRITES THE LINE AND CODE DECIDES WHETHER IT IS SENT (ruled
 * 2026-10-07). Three rounds left the decision to the prompt and each missed
 * its bar of 9 in 10:
 *
 *   a universal rule                       0 of 10, with or without ## Length
 *   the same text as a late block          3 of 10
 *   a late block on facts known in code    5 of 5 where it rendered, but
 *     BEFORE the reply exists                before the reply exists code can
 *                                            only see the category and the
 *                                            retrieved knowledge, and those do
 *                                            not tell "how do I brew this"
 *                                            from "do you have wifi"
 *
 * The facts that decide it are facts about the finished reply, so the decision
 * moved to after it: the same shape as the getting-to-know-you question and
 * the review invitation (decision 0007), which were each paid for twice before
 * they were separated in code.
 *
 * WHAT CODE CAN SEE. A link is in the text. A recommendation is the turn's
 * category or an emitted recommendation commitment. Instructions leave no mark
 * in prose (task-draft.ts says the same of its own gap), so that one is a
 * proxy: the model chose to write the line, and the reply is long enough to
 * have explained something (EXPLAINED_WORDS). The vetoes are all code's.
 *
 * Its own file, like task-draft.ts, so a harness can drive it without the
 * generation module.
 */

import type { CommitmentEmission } from '@/lib/schemas/guest-commitment'
import { extractUrls } from './url-detector'
import type { MessageCategory } from './types'

export interface FurtherHelpOfferInput {
  /** The finished reply, intention question and review ask already joined. */
  body: string
  /** The model's offer line. '' when it wrote none. */
  offer: string
  category: MessageCategory
  commitment: CommitmentEmission
  /** False on every proactive turn: an offer answers something the guest asked. */
  repliesToGuest: boolean
  /** The reply is, or carries, a sign-off. */
  signsOff: boolean
  /** Anything but 'none'. */
  onComplaintTurn: boolean
  /** A getting-to-know-you question or a review invitation rides this reply. */
  carriesAnAsk: boolean
  /** The body goes to an operator, not the guest. */
  knowledgeGap: boolean
  /** The reply is checking or taking back a visit the guest reported. */
  correctingVisit: boolean
  /** A message of ours in this conversation already ended with an offer. */
  offeredThisConversation: boolean
}

export type FurtherHelpOfferReason =
  | 'link'
  | 'recommendation'
  | 'long_reply'
  | 'no_offer_written'
  | 'offer_is_a_question'
  | 'correcting_visit'
  | 'offered_this_conversation'
  | 'nothing_to_offer_about'
  | 'not_a_reply'
  | 'sign_off'
  | 'needs_operator'
  | 'complaint'
  | 'already_asks'
  | 'knowledge_gap'

/**
 * A bare domain counts here. extractUrls wants a scheme or a path, which is
 * right for checking a link against the venue's allowlist and wrong for this:
 * "head to example.com" sends the guest somewhere just as much.
 *
 * Lower case only and never straight after `@`, a letter or a dot, so an email
 * address, a handle, and a sentence that runs into the next one without a
 * space ("it's great.Coffee is next") are not links.
 */
const BARE_DOMAIN =
  /(?<![@\w.-])[a-z0-9-]{2,}\.(?:com|co|org|net|io|shop|coffee|cafe)\b/

function sendsLink(body: string): boolean {
  return extractUrls(body).length > 0 || BARE_DOMAIN.test(body)
}

/**
 * Could a reply of ours have carried an offer at all? The same three facts the
 * decision below appends one on, read off a reply that has already gone out:
 * it sent a link, the turn was a recommendation, or it ran long enough to
 * count as an explanation.
 *
 * Read by lib/agent/previous-offer.ts, which recognises an earlier offer by
 * its wording because nothing stored marks one. Without this, a welcome that
 * invites the guest to say what they need ("let us know what we can help
 * with") read as the conversation's one offer, and the menu link sent next
 * went out without its line (phone test, 2026-10-07). A nine-word greeting
 * with no link was never a reply an offer could have been appended to.
 *
 * `body` is the whole reply, offer line included, so the length test is
 * generous by the length of that line. It misses two cases, and in both the
 * cost is a second offer in one conversation: a recommendation made outside a
 * `recommendation_request` turn, in a short reply with no link; and a short
 * reply where the model, or an operator editing it, wrote offer wording into
 * the answer itself ("Yeah, we do. Let us know if you need anything else").
 */
export function replyCouldCarryOffer(
  body: string,
  category: MessageCategory,
): boolean {
  return (
    sendsLink(body) ||
    category === 'recommendation_request' ||
    wordCount(body) >= EXPLAINED_WORDS
  )
}

/** The reply with its links taken out, so a `?` in a query string is not a question. */
function proseOf(body: string): string {
  return extractUrls(body).reduce((text, url) => text.replace(url, ' '), body)
}

/**
 * How long a reply has to be before an offer the model wrote is read as
 * following an explanation rather than a fact.
 *
 * A PROXY, AND STATED AS ONE. v1.98.0 also asked the model for a
 * `gaveInstructions` flag. It came back false on every one of 110
 * generations, including a five-sentence answer on how to brew each bean, so
 * v1.99.0 removed it rather than keep a field that reads like a switch and
 * changes nothing. What did separate the two kinds of answer was the model's
 * own choice to write the line: it wrote one after every brewing answer and
 * after none of forty single facts. So an offer the model wrote, on a reply
 * this long, counts. Single facts in those runs were mostly under a dozen
 * words; the long one, about parking, never carried an offer line.
 */
const EXPLAINED_WORDS = 25

function wordCount(body: string): number {
  return body.split(/\s+/).filter((w) => w !== '').length
}

const NEVER_ON: ReadonlySet<MessageCategory> = new Set([
  'acknowledgment',
  'opt_out',
])

/**
 * The one decision. Vetoes first, so a reason names what stopped an offer the
 * model wrote; then the three things an answer can have done.
 */
export function decideFurtherHelpOffer(input: FurtherHelpOfferInput): {
  append: boolean
  reason: FurtherHelpOfferReason
} {
  const no = (reason: FurtherHelpOfferReason) => ({ append: false, reason })
  // A line with nothing sayable in it (a lone dash survives replaceDashes).
  if (!/[\p{L}\p{N}]/u.test(input.offer)) return no('no_offer_written')
  if (!input.repliesToGuest) return no('not_a_reply')
  if (input.knowledgeGap) return no('knowledge_gap')
  if (input.correctingVisit) return no('correcting_visit')
  // One per conversation (ruled 2026-10-07): an offer on the end of every
  // answer in a thread read as a script.
  if (input.offeredThisConversation) return no('offered_this_conversation')
  if (input.onComplaintTurn || input.category === 'comp_complaint') {
    return no('complaint')
  }
  if (input.signsOff || NEVER_ON.has(input.category)) return no('sign_off')
  // A turn the classifier marked as needing an operator's eyes is not one to
  // round off with an offer. It also keeps lib/agent/previous-offer.ts exact:
  // `manual` is what holding messages and an operator's own sends are stored
  // under, so that file cannot count it, and an offer sent under it would be
  // one the once-per-conversation rule could never see.
  if (input.category === 'manual') return no('needs_operator')
  if (input.carriesAnAsk || proseOf(input.body).includes('?')) {
    return no('already_asks')
  }
  // "A statement and not a question" is only prompt wording until this line.
  // A `?` on the end of our last message changes what three readers of it do:
  // the warm-close floor, whether the guest's next message is read as an
  // answer to us, and the check-back.
  if (input.offer.includes('?')) return no('offer_is_a_question')

  if (sendsLink(input.body)) return { append: true, reason: 'link' }
  if (
    input.category === 'recommendation_request' ||
    input.commitment.type === 'recommendation'
  ) {
    return { append: true, reason: 'recommendation' }
  }
  if (wordCount(input.body) >= EXPLAINED_WORDS) {
    return { append: true, reason: 'long_reply' }
  }
  return no('nothing_to_offer_about')
}

/**
 * The reply with the offer on the end, joined the way the two asks are: one
 * space, so the line is the exact tail of `body` and dispatch can peel it off
 * as its own last message (resolveOutboundTail).
 *
 * ITS OWN MESSAGE IS WHAT MAKES IT READABLE. A reply that sends a link usually
 * ends on the link or an emoji, with no full stop, and a line break does not
 * survive dispatch: every path collapses whitespace. The first version joined
 * with a newline and would have delivered "...pages/cafe-menu happy to answer
 * anything else" as one run-on bubble.
 *
 * A draft held for an operator is one message, so it does not carry this line
 * at all: lib/agent/held-draft-body.ts takes it back off.
 */
export function appendFurtherHelpOffer(body: string, offer: string): string {
  return `${body.trimEnd()} ${offer.trim()}`
}
