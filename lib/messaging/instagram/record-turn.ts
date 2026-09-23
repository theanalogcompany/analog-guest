/**
 * TAC-523: write the ledger row for an Instagram delivery the agent never saw.
 *
 * The agent records its own outcome when it runs (handle-inbound's wrapper).
 * This is the other half: a delivery that never reaches it — the gate shut, a
 * titleless postback, a save that failed — which before this left nothing
 * behind but a console line.
 *
 * Never throws: `insertInboundTurnOutcome` swallows everything, and the route
 * hands this to `waitUntil` so it cannot sit inside Meta's delivery deadline.
 */

import { insertInboundTurnOutcome } from '@/lib/agent/record-inbound-turn-outcome'
import type { InboundTurnReason } from '@/lib/schemas/inbound-turn-outcome'
import type { InstagramEventOutcome } from './handle-events'

/**
 * What the ledger can know about this delivery. A `persisted` outcome carries
 * the full identity; `skipped` and `failed` carry none, because they are the
 * cases where resolving it is what went wrong. The columns are nullable for
 * exactly that reason (migration 055).
 */
function identityOf(outcome: InstagramEventOutcome): {
  venueId: string | null
  guestId: string | null
  messageId: string | null
  detail: Record<string, unknown>
} {
  switch (outcome.status) {
    case 'persisted':
      return {
        venueId: outcome.venueId,
        guestId: outcome.guestId,
        messageId: outcome.messageId,
        detail: { kind: outcome.kind, guestCreated: outcome.guestCreated },
      }
    case 'skipped':
      return {
        // TAC-523: null ONLY for venue_not_found, where the venue genuinely
        // could not be resolved. For unknown_guest it is known, and without it
        // the row is invisible to the per-venue query — the headline read on
        // this table.
        venueId: outcome.venueId,
        guestId: null,
        messageId: null,
        // Vocabulary constants, never guest content.
        detail: { kind: outcome.kind, skippedReason: outcome.reason },
      }
    case 'failed':
      return {
        venueId: outcome.venueId,
        guestId: null,
        messageId: null,
        detail: { kind: outcome.kind, stage: outcome.stage, code: outcome.code },
      }
    case 'unhandled':
      // A guest message saved nowhere (message_unsupported / no_content). The
      // delivery carries no venue or guest — parse-events could not file it.
      return { venueId: null, guestId: null, messageId: null, detail: { reason: outcome.reason } }
    default:
      // resolveAgentHandoff returns 'not_a_turn' for every other status, so
      // nothing routes them here. Recorded with no identity rather than
      // thrown: a ledger writer must never be the thing that breaks a webhook.
      return { venueId: null, guestId: null, messageId: null, detail: {} }
  }
}

export async function recordInstagramTurnNotRun(
  outcome: InstagramEventOutcome,
  reason: InboundTurnReason,
): Promise<void> {
  const identity = identityOf(outcome)
  await insertInboundTurnOutcome({
    layer: 'webhook',
    entry: {
      outcome: 'not_run',
      reason,
      outboundMessageId: null,
      detail: identity.detail,
    },
    venueId: identity.venueId,
    guestId: identity.guestId,
    inboundMessageId: identity.messageId,
    channel: 'instagram',
    agentRunId: null,
  })
}
