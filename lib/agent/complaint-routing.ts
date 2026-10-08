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
// TAC-307 — WHEN THIS MODULE IS CONSULTED AT ALL. applyApprovalPolicyStage
// calls it only when the category's hold resolved with source 'code_default'
// (the fleet-wide APPROVAL_POLICY_DEFAULT route). When a venue chose the hold
// itself — a ticked category in Command Center, or the master switch — the
// hold is ABSOLUTE and nothing here runs. So the answer to "does a clarifying
// question auto-send?" is: yes on a venue that hasn't configured its own
// policy, no on one that has.
//
// THE OFFER-SHAPED QUESTION (closed 2026-10-07; it had been deferred until a
// body proved it). "want me to make you another?" carries a question mark, no
// first-person modal, and possibly no commitment emission, so it passed all
// four checks: three constructed bodies were run through this function and
// all three auto-sent ("happy to remake it, when are you back in?" among
// them). Ruled the same day: a reply that offers to make it right always
// waits for the owner. Check 5 below holds a "clarifying" turn that names a
// remedy. It is vocabulary, which complaint-floor.ts rejects for the floor
// and for good reason: the ways to describe what is being given are
// unbounded. It is acceptable here, and only here, because of where it sits.
// This function decides one thing, whether a complaint turn may SKIP review,
// so a remedy word it does not know leaves the turn exactly where it was
// before this check, and one it wrongly matches costs a clarifying question
// a wait. It cannot hold anything that was not already a complaint.

import { matchForwardCommitment } from './complaint-floor'

/**
 * Words that put a remedy on the table. Matched only on a complaint turn the
 * model called `clarifying`, where the reply is supposed to ask and propose
 * nothing. Each is shaped as an OFFER, because the question this protects is
 * often about the very thing: "was it not fresh?", "was it the gluten free
 * one?", "did you pay by credit card?", "was it this location or another
 * one?" and "has the refund not come through yet?" all pass.
 */
export const REMEDY_PATTERNS: readonly RegExp[] = [
  /\bre-?ma(?:ke|kes|king|de)\b/i,
  /\bredo\b/i,
  /\breplac(?:e|es|ed|ing|ement)\b/i,
  // "make you another", "get you another one", "another one made". Not
  // "another visit", "another barista", "this location or another one".
  /\b(?:make|get|have|pour|bring|grab)\b[^.?!]*\banother\b/i,
  /\banother (?:one|cup|drink|round) (?:on|made|for)\b/i,
  /\b(?:a|another) fresh\b|\bfresh one\b/i,
  /\bon (?:us|me|the house)\b/i,
  /\bmake (?:it|this|that) (?:right|up)\b/i,
  /\bmake up for\b/i,
  /\bput (?:it|this|that) right\b/i,
  /\bmoney back\b/i,
  // An offer of one, not a question about one: "has the refund not come
  // through?" and "did the discount not apply?" stay questions.
  /\b(?:a|your) (?:full |partial )?refund\b|\brefund (?:you|it|that)\b/i,
  /\b(?:a|your|store) credit\b(?! (?:or debit )?card\b)/i,
  /\b(?:a|your) discount\b/i,
  // "for free", "a free one". Not "gluten free", "dairy-free".
  /\b(?:a|an|for|your|another) free\b/i,
]

/** True when a reply names a remedy. Pure. */
export function namesRemedy(body: string): boolean {
  return REMEDY_PATTERNS.some((p) => p.test(body))
}

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
 *   5. no remedy named
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

  // 5. A question that offers. "Want me to make you another?" asks and
  //    proposes in one breath, and the proposing is what the owner approves.
  if (namesRemedy(input.body)) return false

  return true
}
