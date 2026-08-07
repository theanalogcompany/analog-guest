// Push fire/skip decision for the draft-flagged APNs surface (TAC-207).
//
// WHY THIS MODULE EXISTS — the regression it prevents:
//
// The original TAC-207 implementation derived its fire-set from the keys of
// the context-label map in send.ts:
//
//   const CONTEXT_BY_TRIGGER = { model_flagged, comp_regex_backstop,
//                                fidelity_below_auto_send_floor }
//   const SHOULD_PUSH_TRIGGERS = new Set(Object.keys(CONTEXT_BY_TRIGGER))
//
// One constant did two jobs — fire-set membership AND label lookup — and the
// fire-set was an ALLOW-list. Two triggers shipped afterwards without
// touching send.ts:
//
//   ff653be (TAC-297)  commitment_type_gated  — ranked FIRST in
//                      PRIMARY_TRIGGER_PRIORITY, so it wins primaryTrigger for
//                      exactly the comp-commit scenario the TAC-288 UAT used.
//   0c1515c (#95)      hold_all_outbound      — per-venue blanket hold.
//
// Both landed on messages.review_reason, neither was in the allow-list, and
// `shouldSendDraftFlaggedPush` silently returned false. No APNs request was
// attempted between 2026-06-01 and the fix. 121 unit tests stayed green
// throughout — nothing asserted the two sets agreed.
//
// THE FIX, three properties:
//
//   1. TOTAL map. `satisfies Record<ApprovalTrigger, PushDecision>` is
//      exhaustive, so adding a 7th member to APPROVAL_TRIGGERS fails tsc
//      until someone types 'push' or 'skip' here. The decision becomes a
//      compile error, not a silent drop.
//   2. Fail-OPEN at runtime. An unrecognized trigger string PUSHES (see
//      shouldSendDraftFlaggedPush). A noisy push beats a silent one — the
//      operator can dismiss a push they didn't need, but cannot act on a
//      queued draft they were never told about.
//   3. Label lookup lives in send.ts and is deliberately PARTIAL. A trigger
//      with no label still pushes, just without the context dash. That
//      fallback was unreachable before; it is now the designed degradation.
//
// Prior art in this repo: lib/operator/queue.ts:79 types its label map as
// `Record<ApprovalTrigger | ExtraReviewReason, string>`. That map has NEVER
// drifted — both ff653be and 0c1515c added their labels because tsc refused
// to compile without them. Same repo, same hazard, already solved once; this
// module applies the same technique to the push surface.

import { APPROVAL_TRIGGERS, type ApprovalTrigger } from '@/lib/agent/stages'

export type PushDecision = 'push' | 'skip'

/**
 * Every approval trigger's push decision. TOTAL over ApprovalTrigger — the
 * `satisfies` clause is the compile-time gate.
 *
 * ApprovalTrigger is DERIVED from APPROVAL_TRIGGERS
 * (`(typeof APPROVAL_TRIGGERS)[keyof typeof APPROVAL_TRIGGERS]`), not a
 * hand-written union, so a trigger added to the const object automatically
 * widens the type and breaks this map. The runtime test in
 * push-policy.test.ts is belt-and-braces, not the primary guard.
 */
const PUSH_POLICY = {
  // Voice fidelity in the [0.4, 0.6) band. Soft signal, still needs eyes.
  [APPROVAL_TRIGGERS.FIDELITY_BELOW_AUTO_SEND_FLOOR]: 'push',

  // Model self-flagged a resource commitment.
  [APPROVAL_TRIGGERS.MODEL_FLAGGED]: 'push',

  // Comp regex backstop caught operator-action language.
  [APPROVAL_TRIGGERS.COMP_REGEX_BACKSTOP]: 'push',

  // TAC-297 (ff653be). Structured commitment of type comp/hold/discount.
  // Ranked FIRST in PRIMARY_TRIGGER_PRIORITY, so it outranks both the comp
  // regex and the model self-flag — the single most important trigger to
  // push on, and the one the original allow-list silently dropped.
  [APPROVAL_TRIGGERS.COMMITMENT_TYPE_GATED]: 'push',

  // #95 (0c1515c). Venue-wide "hold everything" flag.
  // Product call: a venue that opted into flagging EVERYTHING wants eyes on
  // everything — silently queuing without notifying defeats the flag's whole
  // purpose. Ranked last in PRIMARY_TRIGGER_PRIORITY, so this only wins the
  // label when no more-specific trigger co-fired.
  [APPROVAL_TRIGGERS.HOLD_ALL_OUTBOUND]: 'push',

  // The ONLY skip. A pending draft already exists for this (venue, guest),
  // and migration 020's partial unique index means persistOrRegenQueuedDraft
  // UPDATEs that row IN PLACE rather than inserting a new one. The operator
  // was already pushed when the original draft queued, the card is already
  // in their queue, and TAC-298's Realtime subscription refreshes its body
  // live. A second push would notify about a card they are already holding.
  [APPROVAL_TRIGGERS.PREVIOUS_PENDING_HELD]: 'skip',
} as const satisfies Record<ApprovalTrigger, PushDecision>

/**
 * Should this primaryTrigger fire a draft-flagged push?
 *
 * Fail-OPEN by design: only an explicit 'skip' suppresses. An unrecognized
 * string — a trigger added to APPROVAL_TRIGGERS in a deploy that raced this
 * module, or a review_reason written by a non-policy path — pushes.
 */
export function shouldSendDraftFlaggedPush(primaryTrigger: string): boolean {
  return (PUSH_POLICY as Record<string, PushDecision | undefined>)[primaryTrigger] !== 'skip'
}

/** Test-only accessor. Not for runtime branching — use the function above. */
export const _PUSH_POLICY_FOR_TESTS: Record<string, PushDecision> = PUSH_POLICY
