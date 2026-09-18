// TAC-468: agent replies are OFF for Instagram guests until outbound exists.
//
// The inbound handler saves Instagram messages, but nothing can send a reply
// over Instagram yet (TAC-469 builds that). Running the agent anyway fails
// visibly with no working path behind it:
//   - an auto-send reaches the phone-format guard, which correctly refuses a
//     guest with no phone number, and ends in a red alert on every message;
//   - a queued card an operator approves is stuck as approved, never sent.
//
// TAC-469 LIFTS THIS GATE by setting INSTAGRAM_AGENT_REPLIES_ENABLED to true
// (and then deleting the constant and the `enabled` parameter). The call site
// is already in place in app/api/webhooks/instagram/route.ts, so nothing else
// needs wiring. agent-gate.test.ts pins the constant at false; that assertion
// is expected to change with it.
//
// Before lifting it, TAC-469 has three things the shut gate is hiding:
//   - a postback saved with no title has body '' and no media, a row the
//     Sendblue path never produces (it refuses empty content before
//     inserting), and it would reach the agent as an empty inbound;
//   - a message the guest unsent is only logged (message_deleted), so it stays
//     in the thread and in the agent's history;
//   - a STOP received while the gate was shut was never classified, so for
//     that guest nothing opt-out-shaped ever happened.
//
// The kind check below is NOT part of the gate and stays when it goes: an echo
// is the venue's own message and a read receipt is not a message, so neither
// is ever handed to the agent. Without it, the agent would answer its own
// replies once TAC-469 makes them echo back.
//
// The other two ways into the agent are already closed for Instagram guests by
// TAC-467: the follow-up engine scans only guests with a phone number, and the
// Command Center Follow Up button refuses a guest without one.

import type { InstagramEventOutcome } from './handle-events'

export const INSTAGRAM_AGENT_REPLIES_ENABLED: boolean = false

/**
 * The message row to hand to the agent for this outcome, or null. Only a
 * guest message or postback saved by this delivery qualifies, and only while
 * the gate is open. A duplicate is never handed over: its first delivery was.
 */
export function agentMessageIdFor(
  outcome: InstagramEventOutcome,
  enabled: boolean = INSTAGRAM_AGENT_REPLIES_ENABLED,
): string | null {
  if (!enabled) return null
  if (outcome.status !== 'persisted' || outcome.kind === 'echo') return null
  return outcome.messageId
}
