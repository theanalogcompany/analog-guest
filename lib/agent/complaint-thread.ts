// A complaint stays a complaint across its own clarifying question.
//
// THE DEFECT (phone test, 2026-10-07). "my cake was stale" classified
// comp_complaint and the agent auto-sent "which one did you get?" through the
// clarifying carve-out (complaint-routing.ts). The guest answered "the gulab
// jamun". Read on its own that is an answer to a venue question, so it
// classified `reply`, and on `reply` every complaint gate is off: no
// category_requires_approval, no complaint_commitment_floor, no willBeReviewed.
// The agent auto-sent "really sorry... we'll flag this with them", a promise
// no operator saw.
//
// Nothing recorded that a complaint was open. The hold was keyed on the
// classification of ONE message, and the answer to a clarifying question is by
// construction not a complaint when read alone.
//
// MEASURED before the change, 8 runs per cell on the exact sequence: the answer
// classified `reply` on both arms (Jev 6 of 8 with 2 new_question, Haiku 8 of
// 8), on this week's Jev wording and on the wording before it. It classified
// comp_complaint only with OLDER complaints earlier in the thread (Jev 8 of 8),
// which is the context-driven misread TAC-514 recorded in comp-complaint.ts.
// So the flow had passed earlier phone tests on a guest with complaint history
// and failed on a reset one. It was never enforced.
//
// THE RULE. The turn after an auto-sent clarifying question is a complaint
// turn, whatever the classifier makes of the message. Ruled 2026-10-07: that
// includes a change of subject ("nvm what time do you close"), because the
// classifier cannot tell an answer from one (it called "the gulab jamun"
// new_question in 2 of 8 runs). The cost is a slower answer for that guest;
// the alternative is the incident.
//
// Two exemptions, both because being held is the wrong outcome for them:
// opt_out (an opt-out confirmation can never be held, TCPA) and a crisis
// signal (which never reaches the gate at all, crisis-safety.ts).
//
// IT IS ONE TURN ONLY, and the rule gets that for free by reading the NEWEST
// outbound row rather than searching for a question. Once the held
// make-it-right is drafted, that draft is the newest outbound, and it is not
// an auto-sent row, so the thread reads as closed whether the draft is still
// waiting, approved, edited or skipped. A turn that wrote no outbound at all
// (silenced or dropped) leaves the question as the newest row, so the thread
// stays open, which is right: the complaint is still unanswered.
//
// Pure: no DB, no I/O. build-runtime-context feeds it the history rows.

import { deriveDelivery, type HistoryRow } from './group-responses'
import type { MessageCategory } from '@/lib/ai/types'

/** The category a complaint turn's reply is stored under. */
const COMPLAINT_CATEGORY: MessageCategory = 'comp_complaint'

/**
 * `messages.review_state` of a reply that went out with no operator. On a
 * comp_complaint row that is the clarifying carve-out, because every other
 * complaint reply queues (or a demo guest's bypass, where nothing is held
 * anyway).
 */
const AUTO_SENT_REVIEW_STATE = 'auto_sent'

/** The history columns the rule reads. `category` is not on HistoryRow. */
export type ComplaintThreadRow = Pick<
  HistoryRow,
  'direction' | 'status' | 'review_state' | 'created_at'
> & { category: string | null }

/**
 * Is this guest's next message the answer to a complaint's clarifying question?
 *
 * True only when the NEWEST outbound row in the history is a comp_complaint
 * reply that auto-sent, reached the guest, and is inside the conversation
 * window. `rowsNewestFirst` is the history query's own order and must exclude
 * the current inbound, as that query does.
 *
 * `now` is the current message's received time, not wall-clock: a replay pins
 * history to a past moment (the re-dating trap in lib/agent/CLAUDE.md).
 */
export function isComplaintClarificationOpen(
  rowsNewestFirst: readonly ComplaintThreadRow[],
  now: Date,
  conversationWindowMs: number,
): boolean {
  const newestOutbound = rowsNewestFirst.find((r) => r.direction === 'outbound')
  if (newestOutbound === undefined) return false
  if (newestOutbound.category !== COMPLAINT_CATEGORY) return false
  if (newestOutbound.review_state !== AUTO_SENT_REVIEW_STATE) return false
  if (deriveDelivery(newestOutbound) !== 'delivered') return false
  const ageMs = now.getTime() - new Date(newestOutbound.created_at).getTime()
  return ageMs >= 0 && ageMs <= conversationWindowMs
}

export interface ComplaintThreadCategory {
  /** The category the turn runs under. */
  category: MessageCategory
  /** True when the thread, not the classifier, chose it. */
  carried: boolean
}

/**
 * The category a turn runs under, given the classifier's pick and whether a
 * complaint's clarifying question is open.
 *
 * `carried` is false when the classifier already said comp_complaint: the
 * thread agreed with it and changed nothing, which is what the override rate
 * must not count.
 */
export function resolveComplaintThreadCategory(input: {
  classifierCategory: MessageCategory
  crisisSafety: boolean
  openComplaintClarification: boolean
}): ComplaintThreadCategory {
  const unchanged = { category: input.classifierCategory, carried: false }
  if (!input.openComplaintClarification) return unchanged
  if (input.classifierCategory === 'opt_out') return unchanged
  if (input.crisisSafety) return unchanged
  if (input.classifierCategory === COMPLAINT_CATEGORY) return unchanged
  return { category: COMPLAINT_CATEGORY, carried: true }
}
