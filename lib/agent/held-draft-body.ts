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
  return reply.slice(0, reply.length - line.length).trimEnd()
}

/** What a held draft's row stores: one message, with no offer line. */
export function heldDraftBody(
  generation: Pick<GenerateMessageResult, 'body' | 'furtherHelpOffer'>,
): string {
  return collapseToSingleMessage(
    withoutFurtherHelpOffer(generation.body, generation.furtherHelpOffer),
  )
}
