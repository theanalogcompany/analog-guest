/**
 * TAC-523: the vocabulary of `inbound_turn_outcomes` (migration 055).
 *
 * One row per inbound turn, saying what came of it — a COMPLETE ledger
 * including successes, so a failure count has a denominator (ruled
 * 2026-09-23). Before this, both webhooks discarded the AgentResult and
 * eighteen distinct paths could end a turn with nothing queryable behind it.
 *
 * These constants are mirrored by CHECK constraints in migration 055 and
 * bound to it by `inbound-turn-outcome.test.ts`, which reads the migration
 * file. Adding a value here without widening the CHECK ships a writer whose
 * every insert fails; the test is what stops that reaching production.
 *
 * Deliberately NOT exported from lib/schemas/index.ts. Every consumer imports
 * it by path, so a barrel entry would add a second import route for no gain —
 * and `dispatch-operator-outbound.test.ts` mocks that barrel, which is the
 * shape `emoji-cadence.ts` is kept out of `lib/ai/index.ts` to avoid.
 *
 * Deliberately NO Zod parse schema and no reader. Nothing in this repo reads
 * the table yet — surfacing it is a later ticket — and a parser with no
 * caller is the dead layer this codebase keeps having to explain.
 */

/**
 * What came of the turn.
 *
 * `not_run` is the layer-1 answer: the agent was never invoked, so there is
 * no AgentResult at all. Every other value maps from one.
 */
export const INBOUND_TURN_OUTCOMES = [
  /** a reply reached the guest */
  'sent',
  /** a card was created for an operator to answer */
  'queued',
  /** the agent was never invoked; `reason` says why */
  'not_run',
  /** the agent ran but a reply to this inbound already existed */
  'skipped_duplicate',
  /** generation refused to produce a body */
  'refused',
  /** a draft was produced and had nowhere to go */
  'dropped',
  /** already answered by hand before the agent's send (Instagram) */
  'superseded',
  /** a stage threw; `reason` carries the stage */
  'failed',
] as const

export type InboundTurnOutcome = (typeof INBOUND_TURN_OUTCOMES)[number]

/**
 * The sub-reason. Null for outcomes that have none — `sent`, `queued`,
 * `skipped_duplicate`, `superseded`.
 */
export const INBOUND_TURN_REASONS = [
  // ---- layer 'webhook', Instagram (PR 1) ----
  /** INSTAGRAM_AGENT_REPLIES_ENABLED was false. The 2026-09-20 incident. */
  'gate_shut',
  /** an icebreaker tap with no title: an empty inbound, nothing to reply to */
  'titleless_postback',
  /** the delivery was not saved: unhandled, skipped, or the insert failed */
  'event_not_persisted',
  /**
   * The guest sent something we cannot act on — Meta could not render it
   * (`message_unsupported`, a voice note or sticker) or it carried neither
   * text nor an attachment (`message_no_content`). Saved nowhere, so before
   * this it was invisible; CLAUDE.md notes a STOP sent as a voice note would
   * have been missed entirely. A guest turn that got nothing, which is exactly
   * what the ledger is for.
   */
  'message_unrenderable',

  // ---- layer 'webhook', Sendblue (PR 2 writes these; nothing does yet) ----
  'venue_number_missing',
  'venue_lookup_failed',
  'venue_not_found',
  'guest_lookup_failed',
  'guest_insert_failed',
  'idempotency_lookup_failed',
  'duplicate_provider_message',
  'empty_inbound_content',
  'message_insert_failed',

  // ---- outcome 'refused' ----
  'low_fidelity',

  // ---- outcome 'dropped' (SlotDropReason, lib/agent/pending-slots.ts) ----
  'knowledge_gap_card_protected',
  'obligation_slot_taken',
  'slot_occupied',

  // ---- outcome 'failed' (AlertContext['stage'], lib/agent/alerts.ts) ----
  'context_build',
  'classification',
  'corpus',
  'generation',
  'persist',
  'send',
  /** the wrapper caught something the orchestrator's own catch did not */
  'unexpected',
] as const

export type InboundTurnReason = (typeof INBOUND_TURN_REASONS)[number]

/** Which layer decided. `webhook` means the agent was never invoked. */
export const INBOUND_TURN_LAYERS = ['webhook', 'agent'] as const

export type InboundTurnLayer = (typeof INBOUND_TURN_LAYERS)[number]
