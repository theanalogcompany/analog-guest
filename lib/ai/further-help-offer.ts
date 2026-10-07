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
 * WHAT CODE CAN SEE AND WHAT IT TAKES ON TRUST. A link is in the text. A
 * recommendation is the turn's category or an emitted recommendation
 * commitment. Instructions leave no mark in prose (task-draft.ts says the same
 * of its own gap), so that one is the model's `gaveInstructions`, a
 * self-report, backed by a length proxy (EXPLAINED_WORDS) because the
 * self-report alone never fired. The vetoes are all code's.
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
  /** The model's self-report that `body` walks the guest through how to do something. */
  gaveInstructions: boolean
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
}

export type FurtherHelpOfferReason =
  | 'link'
  | 'recommendation'
  | 'instructions'
  | 'no_offer_written'
  | 'nothing_to_offer_about'
  | 'not_a_reply'
  | 'sign_off'
  | 'complaint'
  | 'already_asks'
  | 'knowledge_gap'

/**
 * A bare domain counts here. extractUrls wants a scheme or a path, which is
 * right for checking a link against the venue's allowlist and wrong for this:
 * "head to example.com" sends the guest somewhere just as much.
 */
const BARE_DOMAIN = /\b[a-z0-9-]+\.(?:com|co|org|net|io|shop|coffee|cafe)\b/i

function sendsLink(body: string): boolean {
  return extractUrls(body).length > 0 || BARE_DOMAIN.test(body)
}

/**
 * How long a reply has to be before an offer the model wrote is read as
 * following an explanation rather than a fact.
 *
 * A PROXY, AND STATED AS ONE. `gaveInstructions` came back false on every
 * one of 100 generations, including a five-sentence answer on how to
 * brew each bean, so on its own that condition never fired. What did separate
 * the two kinds of answer was the model's own choice to write the line: it
 * wrote one after every brewing answer and after none of forty single facts.
 * So an offer the model wrote, on a reply this long, counts. Single facts in
 * those runs were mostly under a dozen words; the long one, about parking,
 * never carried an offer line.
 *
 * THE FLAG IS STILL IN THE SCHEMA AND HAS NEVER FIRED. Removing it changes
 * the prompt, and the budget for this change ran out before that could be
 * measured. It is recorded here so nobody reasons from it as a working switch.
 */
const EXPLAINED_WORDS = 25

function wordCount(body: string): number {
  return body.split(/\s+/).filter((w) => w !== '').length
}

const NEVER_ON: ReadonlySet<MessageCategory> = new Set([
  'comp_complaint',
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
  if (input.offer.trim() === '') return no('no_offer_written')
  if (!input.repliesToGuest) return no('not_a_reply')
  if (input.knowledgeGap) return no('knowledge_gap')
  if (input.onComplaintTurn || input.category === 'comp_complaint') {
    return no('complaint')
  }
  if (input.signsOff || NEVER_ON.has(input.category)) return no('sign_off')
  if (input.carriesAnAsk || input.body.includes('?')) return no('already_asks')

  if (sendsLink(input.body)) return { append: true, reason: 'link' }
  if (
    input.category === 'recommendation_request' ||
    input.commitment.type === 'recommendation'
  ) {
    return { append: true, reason: 'recommendation' }
  }
  if (input.gaveInstructions || wordCount(input.body) >= EXPLAINED_WORDS) {
    return { append: true, reason: 'instructions' }
  }
  return no('nothing_to_offer_about')
}

/**
 * The reply with the offer on the end.
 *
 * One more sentence when the reply ends a sentence; its own line when it does
 * not. Replies here often end on a link or an emoji with no full stop, and the
 * first bodies read "...pages/cafe-menu happy to answer anything else".
 */
export function appendFurtherHelpOffer(body: string, offer: string): string {
  const reply = body.trimEnd()
  const joiner = /[.!?]$/.test(reply) ? ' ' : '\n'
  return `${reply}${joiner}${offer.trim()}`
}
