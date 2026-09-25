/**
 * TAC-523: the vocabulary of `inbound_turn_outcomes` (migration 055).
 *
 * One row per inbound turn, saying what came of it — a COMPLETE ledger
 * including successes, so a failure count has a denominator (ruled
 * 2026-09-23). Before this, both webhooks discarded the AgentResult and
 * eighteen distinct paths could end a turn with nothing queryable behind it.
 *
 * These constants are mirrored by CHECK constraints in the migrations and
 * bound to them by `inbound-turn-outcome.test.ts`, which reads the migration
 * files. Adding a value here without widening the CHECK ships a writer whose
 * every insert fails; the test is what stops that reaching production.
 *
 * THE REASON LIST LIVES IN 057, NOT 055. TAC-526 widened it by one value, and
 * widening a CHECK means dropping and recreating it, so 057 now carries the
 * live constraint. `outcome`, `layer` and `channel` are still 055's. The
 * binding test reads whichever migration owns each one; migrations are
 * append-only, so a later one that replaces any of these has to update that
 * test itself.
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
 * `not_run` means NO STAGE RAN — nothing was classified, retrieved or
 * generated. It reaches the table from two layers, and `layer` is the
 * discriminator:
 *
 *   - `layer = 'webhook'`: the agent was never invoked at all, so there is no
 *     AgentResult. The Instagram and Sendblue bail reasons.
 *   - `layer = 'agent'`: the run WAS invoked and decided not to reply before
 *     any stage ran. `venue_paused` (TAC-529), where the venue's own status is
 *     'paused' or 'archived', and TAC-536's five scan-greeting reasons, where
 *     a bare Instagram scan did not become a greeting.
 *
 * **`not_run` no longer implies `layer = 'webhook'`, and a query that assumes
 * it does is wrong.** It did until TAC-529, and the sentence saying so lived
 * here; this is the corrected version. Every other outcome maps from an
 * AgentResult.
 */
export const INBOUND_TURN_OUTCOMES = [
  /** a reply reached the guest */
  'sent',
  /** a card was created for an operator to answer */
  'queued',
  /**
   * No stage ran; `reason` says why, and `layer` says whether the agent was
   * invoked at all (`webhook`) or was invoked and declined before any stage
   * (`agent`, i.e. `venue_paused`). See the note above the list.
   */
  'not_run',
  /** the agent ran but a reply to this inbound already existed */
  'skipped_duplicate',
  /** generation refused to produce a body */
  'refused',
  /** a draft was produced and had nowhere to go */
  'dropped',
  /** already answered by hand before the agent's send (Instagram) */
  'superseded',
  /**
   * TAC-397: the guest's message needed no answer ("haha", "thanks") and they
   * already hold a pending conversation card. Nothing generated, nothing sent.
   *
   * A DECISION, not a failure. It is the nineteenth path and the one the
   * ledger most needs to tell apart: before this table, a deliberate silence
   * and a swallowed reply looked identical from the database, which is this
   * ticket's whole subject. Anyone counting failures must exclude it.
   */
  'silenced',
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

  // ---- outcome 'superseded' (TAC-526) ----
  /**
   * This message was folded into another run's turn: the guest sent it
   * seconds after another, one run claimed the conversation, and this one
   * stood down. A DECISION, not a failure — the guest WAS answered, by the
   * turn named in `detail.coalescedIntoAgentRunId`.
   *
   * Distinct from a bare `superseded`, which is TAC-469's reply check: staff
   * answered by hand in the Instagram app. Same outcome, different cause, and
   * merging them would make both unanswerable in SQL.
   *
   * With `skipped_duplicate`, this is the second value meaning the agent ran
   * more than once for one guest action, so a strict turn count excludes it:
   *
   *   select count(*) from inbound_turn_outcomes
   *   where layer = 'agent'
   *     and outcome <> 'skipped_duplicate'
   *     and reason is distinct from 'coalesced_into_turn'
   */
  'coalesced_into_turn',

  // ---- outcome 'not_run' (TAC-529) ----
  /**
   * The venue's own `venues.status` is `paused` or `archived`, so the agent
   * did not reply. Ruled 2026-09-23: pausing a venue stops inbound replies
   * too, not only the proactive paths, because the reply path is where the
   * damage would happen at a venue something is wrong with.
   *
   * A DECISION, not a failure, and NOT a guest who was ignored: the venue is
   * switched off. The inbound row is still saved by the webhook — the history
   * is what you want when it is unpaused — and only the reply is withheld.
   *
   * It exists as its own value because silence and a swallowed reply are
   * indistinguishable from the database otherwise, which is the whole reason
   * this table exists. `gate_shut` is the nearest candidate and is wrong:
   * that is INSTAGRAM_AGENT_REPLIES_ENABLED, a global kill switch, and
   * reusing it would make the 2026-09-20 incident's own metric unanswerable.
   *
   *   select count(*) from inbound_turn_outcomes
   *   where outcome = 'not_run' and reason = 'venue_paused'
   */
  'venue_paused',

  // ---- outcome 'not_run' (TAC-536): a scan that did not become a greeting ----
  /**
   * The guest wrote within the five minutes the scan started, so their own
   * message was the turn and this scan needed no greeting of its own.
   *
   * A DECISION and the commonest of these five, not a miss: it is the flow
   * working. `understand_order` arms on that message's turn through the
   * carry-forward, which is the whole point of treating the scan as an
   * at-counter signal rather than a message to answer.
   */
  'inbound_during_window',
  /**
   * The cron was late enough that the greeting would have been a guess. It
   * says the guest is in the shop right now, and the code is at the pickup
   * counter, so a to-go guest is gone well before the bound.
   *
   * Only reachable when the cron misses ticks, so a run of these is a signal
   * about the cron, not about guests.
   */
  'scan_too_stale',
  /**
   * The venue's own hours positively say it is shut. `unknown` hours proceed,
   * per TAC-363's rule that unknown behaves as open.
   *
   * Distinct from `venue_paused`: that is the venue switched off, this is the
   * middle of the night at a venue that is fine.
   */
  'venue_closed',
  /**
   * `guests.opted_out_at` is set. Its own value rather than folded into any
   * other: an unprompted send is exactly where the difference between "the
   * venue is off" and "this person asked us to stop" matters.
   */
  'guest_opted_out',
  /**
   * Another scan already greeted this guest on this venue-local day. The
   * repeat guard firing, which is a decision working rather than a failure.
   *
   *   select count(*) from inbound_turn_outcomes
   *   where outcome = 'not_run' and reason = 'already_greeted_today'
   */
  'already_greeted_today',
] as const

export type InboundTurnReason = (typeof INBOUND_TURN_REASONS)[number]

/** Which layer decided. `webhook` means the agent was never invoked. */
export const INBOUND_TURN_LAYERS = ['webhook', 'agent'] as const

export type InboundTurnLayer = (typeof INBOUND_TURN_LAYERS)[number]
