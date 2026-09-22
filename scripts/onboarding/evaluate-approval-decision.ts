import {
  applyApprovalPolicyStage,
  type ApprovalDecision,
  type GroundingBackstopResult,
  type ClosedVenueArrivalBackstopResult,
  type ProsePromiseBackstopResult,
} from '@/lib/agent/stages'
import type { RuntimeContext } from '@/lib/agent/types'
import type { GenerateMessageResult } from '@/lib/ai'

export type { ApprovalDecision }

/**
 * TAC-347 Stage 2. Decision-only boundary: calls applyApprovalPolicyStage
 * for its return value and nothing else. Deliberately the ONLY thing this
 * file does — see evaluate-approval-decision.test.ts, which parses this
 * file's own import statements and fails if any name from the production
 * dispatch/persist/notify surface appears anywhere in it. Mirrors the
 * handle-operator-decline.ts structural-invariant pattern (TAC-299).
 *
 * Never persists a draft, never dispatches to Sendblue, never fires a push.
 * The harness evaluates what WOULD happen without making it happen.
 *
 * TAC-350: `groundingBackstop` is the caller's already-computed
 * `verifyGroundingStage` result (or `undefined`/`null` if not run), threaded
 * straight through as `applyApprovalPolicyStage`'s third argument. This
 * module still makes no AI call and no decision of its own — the caller
 * (run-test-scenarios.ts) owns calling verifyGroundingStage, exactly as it
 * already owns calling generateStage before this function.
 */
export async function evaluateApprovalDecision(
  ctx: RuntimeContext,
  generation: GenerateMessageResult,
  groundingBackstop?: GroundingBackstopResult | null,
  // TAC-401: the harness grades the SHIPPED mechanism, so the prose-promise
  // check has to reach the gate here too. Optional with a 'skipped' default
  // so a caller that has not run the stage behaves exactly as before.
  prosePromiseBackstop?: ProsePromiseBackstopResult,
  // TAC-363: same reason as the line above. Without it the structural half of
  // the closed-venue pair still fires (it needs no parameter) while the TEXT
  // backstop never runs, so a "see you soon" with no structured emission —
  // the exact shape that check exists for — grades `sent` in a run and queues
  // in production.
  closedVenueArrivalBackstop?: ClosedVenueArrivalBackstopResult,
): Promise<ApprovalDecision> {
  return applyApprovalPolicyStage(
    ctx,
    generation,
    groundingBackstop,
    { status: 'skipped' },
    prosePromiseBackstop ?? { status: 'skipped' },
    { resolution: { status: 'none' }, claim: 'skipped' },
    closedVenueArrivalBackstop ?? { status: 'skipped' },
  )
}
