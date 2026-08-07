// Clarifying-question exemption from category routing (v1.24.0).
//
// venue_configs.approval_policy routes comp_complaint to operator approval,
// which would queue EVERY complaint turn including the opening "what went
// wrong?". That is wrong for the guest: a question commits nothing, and
// making someone wait on an operator before you'll even ask what happened is
// worse service than the cold reply this ticket is fixing.
//
// So exactly one exemption exists — a turn that is genuinely just asking.
// This module decides that, and it is built to be WRONG IN ONE DIRECTION.
//
// The asymmetry, stated plainly because it is the whole design:
//   false QUEUE  -> a clarifying question waits for an operator. The guest is
//                   slower to get a reply. Recoverable, visible, annoying.
//   false SEND   -> a resolution goes out unreviewed. On 2026-08-07 that was
//                   "Come by and I'll have another made for you" on a refund
//                   request: free product, no operator, irreversible.
// Every check below therefore fails toward QUEUE, and the model's claim is
// necessary but never sufficient.
//
// KNOWN RESIDUAL (deliberately deferred): an offer-shaped interrogative like
// "want me to make you another?" carries a question mark, no first-person
// modal, and possibly no commitment emission, so it can pass all four checks.
// The model should label that `resolving` — it IS resolving — so the model is
// the primary defense there and these checks are secondary. Closing it means
// extending FORWARD_COMMITMENT_PATTERNS, which was explicitly deferred until
// a real body proves the gap, because the last two predicate bugs came from
// widening patterns without fixtures to measure against.

import { matchForwardCommitment } from './complaint-floor'

/**
 * What the model says this complaint turn is doing. Required (not optional)
 * on GeneratedMessageSchema so it costs nothing against the TAC-300
 * 24-optional-parameter budget.
 *
 *   clarifying — asking what happened; proposing nothing
 *   resolving  — addressing the problem, proposing or declining a remedy
 *   none       — not a complaint turn
 */
export type ComplaintIntent = 'clarifying' | 'resolving' | 'none'

export interface ComplaintTurnInput {
  complaintIntent: ComplaintIntent
  /** The generated body. */
  body: string
  /** GeneratedMessageSchema.commitment — `{}` is the no-op shape. */
  commitment: { type?: string; description?: string }
}

/**
 * May this category-routed complaint turn auto-send anyway?
 *
 * True only when ALL of:
 *   1. the model claims `clarifying`
 *   2. the body actually asks something
 *   3. no first-person forward-commitment grammar (the complaint_commitment_floor predicate)
 *   4. no actionable structured commitment
 *
 * Anything else — including an unrecognized intent — queues.
 */
export function canAutoSendComplaintTurn(input: ComplaintTurnInput): boolean {
  // 1. The model's claim. Necessary, never sufficient.
  if (input.complaintIntent !== 'clarifying') return false

  // 2. A clarifying turn has to actually ask. Catches the model labelling a
  //    statement as a question — "Tell me what went wrong" is an instruction,
  //    and "Noted." is not a question at all.
  if (!input.body.includes('?')) return false

  // 3. Reuse the shipped floor predicate rather than a second copy of the
  //    grammar. A question that also promises ("What was off with it? I'll
  //    have another made either way") is a promise wearing a question mark.
  if (matchForwardCommitment(input.body).matched) return false

  // 4. Structured commitment. Mirrors commitment_type_gated's actionability
  //    test exactly — type AND non-empty description — so a partial emission
  //    is treated as the no-op it is, and the two gates can't disagree about
  //    what counts as a commitment.
  const type = input.commitment.type
  const description = input.commitment.description?.trim()
  if (type && description) return false

  return true
}
