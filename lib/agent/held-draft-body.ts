// The text a draft carries when it is held for an operator instead of sent.
//
// A DRAFT HELD FOR APPROVAL NEVER CARRIES THE OFFER-MORE-HELP LINE (ruled
// 2026-10-07). An approved draft is sent as one message, verbatim (TAC-313 §2,
// reaffirmed on TAC-319), so nothing peels the offer off as its own message
// the way an auto-send does. A reply that sends a link usually ends on the
// link or an emoji with no full stop, and the offer folded in behind it reads
// "...pages/cafe-menu happy to answer anything else": on the operator's card,
// and then to the guest. Withholding it costs a held reply its offer; the
// answer is whole without it, which is the field's own contract.
//
// The getting-to-know-you question and the review invitation are NOT touched.
// They stay folded into a held draft as they were before this existed.
//
// Pure, and its own file, so the no-model check
// (scripts/harness/held-draft-offer) drives the function dispatch calls rather
// than a copy of it.

import { collapseToSingleMessage } from './split-message'
import type { GenerateMessageResult } from '@/lib/ai/types'

/**
 * The reply without its offer line.
 *
 * `furtherHelpOffer` is the exact tail of `body` when it is non-empty
 * (appendFurtherHelpOffer joined them), so this is a slice, not a search. A
 * body that does not end with the line is returned as it is: something edited
 * it after generation, and cutting a guess out of guest-facing text is worse
 * than leaving a line in.
 */
export function withoutFurtherHelpOffer(body: string, offer: string): string {
  const line = offer.trim()
  const reply = body.trimEnd()
  if (line === '' || !reply.endsWith(line)) return body
  const before = reply.slice(0, reply.length - line.length)
  // The line has to start where a message could: at the beginning, or after
  // whitespace. A suffix that lands inside a word is a coincidence, not a tail.
  if (before !== '' && !/\s$/.test(before)) return body
  return before.trimEnd()
}

/**
 * The messages of a reply without its offer, when the offer is the last one.
 *
 * For the Instagram arm's partial send: some messages went out and the rest
 * become a card. By then the offer is a message of its own with its terminal
 * full stop stripped and its whitespace collapsed, so it is matched on those
 * terms rather than as the raw tail heldDraftBody slices.
 */
export function withoutOfferBubble(
  bubbles: readonly string[],
  offer: string,
): string[] {
  const norm = (s: string): string =>
    collapseToSingleMessage(s).replace(/\.$/, '')
  const last = bubbles.at(-1)
  if (offer.trim() === '' || last === undefined) return [...bubbles]
  return norm(last) === norm(offer) ? bubbles.slice(0, -1) : [...bubbles]
}

/** What a held draft's row stores: one message, with no offer line. */
export function heldDraftBody(
  generation: Pick<GenerateMessageResult, 'body' | 'furtherHelpOffer'>,
): string {
  return collapseToSingleMessage(
    withoutFurtherHelpOffer(generation.body, generation.furtherHelpOffer),
  )
}
