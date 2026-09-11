// TAC-347 Stage 2. Structural invariant test for the decision-only approval
// boundary — see the human-authorized constraint: "The harness calls
// applyApprovalPolicyStage for its return value and nothing after it. It
// must not import or call persistOrRegenQueuedDraft, scheduleAndSend, the
// Sendblue client, the APNs push path, or any guest_commitments writer.
// Enforce this with a test on the harness module's imports, not by
// convention." Mirrors lib/agent/handle-operator-decline.test.ts (TAC-299)
// exactly, extended to the full ban list traced from every name reachable
// downstream of applyApprovalPolicyStage in the two production orchestrators
// (handle-inbound.ts, handle-followup.ts) — see the TAC-347 audit comment on
// the Linear ticket for the trace.

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const source = readFileSync(resolve(__dirname, 'evaluate-approval-decision.ts'), 'utf-8')

/** Same extraction technique as handle-operator-decline.test.ts. */
function importedIdentifiers(src: string): Set<string> {
  const out = new Set<string>()
  const re = /import\s+(?:type\s+)?\{([^}]+)\}\s+from\s+['"][^'"]+['"]/g
  let m: RegExpExecArray | null
  while ((m = re.exec(src)) !== null) {
    for (const name of m[1].split(',')) {
      const withoutInlineType = name.trim().replace(/^type\s+/, '')
      const trimmed = withoutInlineType.split(/\s+as\s+/)[0].trim()
      if (trimmed.length > 0) out.add(trimmed)
    }
  }
  return out
}

const imports = importedIdentifiers(source)

// Every name reachable downstream of applyApprovalPolicyStage in production:
// the two persist/dispatch helpers, every messaging primitive, every
// notification sender, every guest_commitments writer, every side-effect
// dispatched from handle-inbound.ts's post-generation window, the two
// orchestrator entry points themselves (importing either pulls in all of the
// above transitively), and waitUntil (every one of the above is fired
// through it in production, so its presence is a reliable canary that
// something async/fire-and-forget snuck in).
const BANNED_IMPORTS = [
  'persistOrRegenQueuedDraft',
  'scheduleAndSend',
  'sendMessage',
  'markAsRead',
  'sendTypingIndicator',
  'sendDraftFlaggedPush',
  'shouldSendDraftFlaggedPush',
  'sendCommitmentArrivalPush',
  'createCommitmentFromPending',
  'transitionToPendingAck',
  'scheduleArrival',
  'markAcknowledged',
  'markCancelled',
  'updateGuestContext',
  'dispatchArrivalCapture',
  'extractReportedOrder',
  'recordIntentionPrompts',
  'handleInbound',
  'handleFollowup',
  'waitUntil',
] as const

describe('evaluate-approval-decision structural invariants (TAC-347)', () => {
  it('imports ONLY applyApprovalPolicyStage plus its own type surface', () => {
    // Positive assertion first: the whole point of this module is to be
    // small enough that a human can verify it by eye. If this list grows,
    // that's the signal the module has stopped being decision-only.
    expect(imports).toEqual(new Set(['applyApprovalPolicyStage', 'ApprovalDecision', 'RuntimeContext', 'GenerateMessageResult']))
  })

  for (const name of BANNED_IMPORTS) {
    it(`does NOT import ${name}`, () => {
      expect(imports.has(name)).toBe(false)
    })
  }
})
