import { applyApprovalPolicyStage, type ApprovalDecision } from '@/lib/agent/stages'
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
): Promise<ApprovalDecision> {
  return applyApprovalPolicyStage(ctx, generation)
}
