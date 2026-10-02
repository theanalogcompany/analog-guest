import {
  applyApprovalPolicyStage,
  type ApprovalDecision,
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
 */
export async function evaluateApprovalDecision(
  ctx: RuntimeContext,
  generation: GenerateMessageResult,
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
    { status: 'skipped' },
    prosePromiseBackstop ?? { status: 'skipped' },
    { resolution: { status: 'none' }, claim: 'skipped' },
    closedVenueArrivalBackstop ?? { status: 'skipped' },
  )
}
