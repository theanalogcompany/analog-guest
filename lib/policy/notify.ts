import { capturePolicyNotification } from '@/lib/analytics/posthog'
import type { GateDecision } from './gate'

// The sink for `notify` policy hits. gate.ts accumulates them into
// GateDecision.notifications and says "the caller fires the events"; this is
// that firing, extracted so the one production caller (phase 6) and any
// future one cannot each grow their own version of the loop.
//
// WHY A NOTIFY ROW EXISTS AT ALL. A queue does two jobs that are not the same
// job: it tells the venue something happened, and it makes the reply wait for
// a human. Before this, the only way to get the first was to pay for the
// second, so the opening of a complaint - "sorry to hear that, what
// happened?", which is what the owner would have typed - sat in a queue.
// `notify` buys the telling without the waiting. The rows that decide which
// complaint turns still wait are in default-policies.ts.
//
// NEVER CHANGES CONTROL FLOW. Every failure is swallowed and logged, per
// .claude/rules/errors-as-values.md: a Slack outage must not cost a guest
// their reply. allSettled rather than a sequential await so one failing hit
// cannot discard another's event - the same reasoning the two post-generation
// check batches use.

export interface GateNotificationContext {
  agentRunId: string
  venueId: string
  guestId: string
  /** Active situations this turn, as handed to the gate. */
  situations: string[]
  /** The guest's message this turn, for the Slack line; null when proactive. */
  inboundBody: string | null
  /** The draft as generated, bubble per entry. */
  draftMessages: string[]
}

/**
 * Fire one event per notify-policy hit. No-op when nothing matched, so the
 * caller does not need to guard.
 *
 * `decision.verdict` rides along on every event: a notify row does not move
 * the verdict, so a hit can land on a turn another row queued, and the two
 * cases need telling apart downstream (capturePolicyNotification relays only
 * the sent ones to Slack - the queued ones already have an operator card).
 */
export async function fireGateNotifications(
  decision: GateDecision,
  context: GateNotificationContext,
): Promise<void> {
  if (decision.notifications.length === 0) return

  const generatedBody = context.draftMessages.join(' ')
  const results = await Promise.allSettled(
    decision.notifications.map((hit) =>
      capturePolicyNotification({
        agentRunId: context.agentRunId,
        venueId: context.venueId,
        guestId: context.guestId,
        policyKey: hit.policyKey,
        label: hit.label,
        verdict: decision.verdict,
        situations: context.situations,
        probability: hit.probability,
        inboundBody: context.inboundBody,
        generatedBody,
      }),
    ),
  )

  for (const [i, result] of results.entries()) {
    if (result.status === 'rejected') {
      console.error(
        `[policy-notify] ${decision.notifications[i]?.policyKey ?? 'unknown'} failed:`,
        result.reason,
      )
    }
  }
}
