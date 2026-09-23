-- 058_inbound_turn_venue_paused.sql
-- TAC-529: a paused venue does not reply, and the turn says so.
--
-- WHY THIS EXISTS. `venues.status` had no behavioural reader anywhere in the
-- repo. Two readers existed and neither changed what ran: the Command Center
-- rendered it as a label and a dot, and `assertVenueGuard` refused an OFFLINE
-- test-scenario run when the status IS 'active'. So the only forceful reader
-- ran backwards, and migration 001 built `idx_venues_status` for a filter
-- nobody ever wrote. Observed live: Mock Central Perk was set to `paused` at
-- 16:30:35Z on 2026-09-23 and went on failing hourly at 17:10Z.
--
-- Ruled 2026-09-23 (question 1: A): `paused` and `archived` stop the agent
-- replying to an ordinary inbound too, not only the two proactive paths. A
-- venue is paused because something is wrong, and the reply path is where the
-- damage would happen; a switch that stops the crons and leaves the agent
-- talking to guests is a partial stop that reads as a complete one.
--
-- WHAT THE GUEST GETS: silence, and that is a decision rather than a default.
-- No reply, no holding message, no queued card. The inbound row is still
-- SAVED by the webhook, because the history is what you want when the venue is
-- unpaused. The alternative considered and rejected was an auto-reply saying
-- the venue is paused, which is a message from a venue that has been switched
-- off.
--
-- SO THE TURN HAS TO BE COUNTABLE. Silence and a swallowed reply look
-- identical from the database, which is the whole subject of TAC-523 and the
-- reason its ledger exists. `venue_paused` is what tells them apart:
--
--   select count(*) from inbound_turn_outcomes
--   where outcome = 'not_run' and reason = 'venue_paused'
--
-- WHY A NEW REASON RATHER THAN AN EXISTING ONE. The nearest candidates are
-- both wrong in a way that would corrupt a count someone else relies on.
-- 'gate_shut' is INSTAGRAM_AGENT_REPLIES_ENABLED, a global kill switch, not a
-- per-venue state. Reusing it would make the 2026-09-20 incident's own metric
-- unanswerable. And nothing under outcome 'failed' fits: this is not a stage
-- that threw, it is a decision taken before any stage ran.
--
-- NO MIGRATION AGAINST `messages`, deliberately, as TAC-526 also chose: the
-- gate reads `venues.status` and writes only this ledger row.
--
-- Drop-and-recreate is the only way to widen a CHECK: Postgres has no ALTER
-- CONSTRAINT for the expression. Same pattern migrations 011 / 012 / 016 /
-- 034 / 047 / 057 use.
--
-- The constraint name is the one migration 057 created. VERIFY IT AGAINST
-- pg_constraint BEFORE APPLYING -- CLAUDE.md's standing caution, because a
-- name assumed rather than checked is how a drop silently removes the wrong
-- constraint:
--
--   select conname, pg_get_constraintdef(oid)
--   from pg_constraint
--   where conrelid = 'inbound_turn_outcomes'::regclass and contype = 'c';
--
-- ORDERING: additive -- a CHECK that only gains a value -- but deployed code
-- writes the new `reason` on the very next inbound at a paused venue, and a
-- rejected insert would lose exactly the record this ticket adds. Apply in
-- Studio BEFORE merging, the call 055 and 057 both made on this table.

begin;

set local lock_timeout = '5s';

alter table inbound_turn_outcomes
  drop constraint inbound_turn_outcomes_reason_check;

alter table inbound_turn_outcomes
  add constraint inbound_turn_outcomes_reason_check check (reason in (
    -- layer 'webhook', Instagram (TAC-523 PR 1)
    'gate_shut',
    'titleless_postback',
    'event_not_persisted',
    -- a guest message Meta could not render, or with no text and no
    -- attachment. Saved nowhere, so invisible before this.
    'message_unrenderable',
    -- layer 'webhook', Sendblue (TAC-523 PR 2; nothing writes these yet)
    'venue_number_missing',
    'venue_lookup_failed',
    'venue_not_found',
    'guest_lookup_failed',
    'guest_insert_failed',
    'idempotency_lookup_failed',
    'duplicate_provider_message',
    'empty_inbound_content',
    'message_insert_failed',
    -- outcome 'refused'
    'low_fidelity',
    -- outcome 'dropped' (SlotDropReason, lib/agent/pending-slots.ts)
    'knowledge_gap_card_protected',
    'obligation_slot_taken',
    'slot_occupied',
    -- outcome 'failed' (AlertContext['stage'], lib/agent/alerts.ts)
    'context_build',
    'classification',
    'corpus',
    'generation',
    'persist',
    'send',
    'unexpected',
    -- TAC-526, outcome 'superseded': folded into another run's turn.
    'coalesced_into_turn',
    -- TAC-529, outcome 'not_run': the venue's own status is 'paused' or
    -- 'archived', so the agent did not reply. A DECISION, not a failure, and
    -- not a guest who was ignored: the venue is switched off. The inbound row
    -- is still saved; only the reply is withheld.
    'venue_paused'
  ));

commit;

-- rollback:
--   begin;
--   alter table inbound_turn_outcomes
--     drop constraint inbound_turn_outcomes_reason_check;
--   alter table inbound_turn_outcomes
--     add constraint inbound_turn_outcomes_reason_check check (reason in (
--       'gate_shut', 'titleless_postback', 'event_not_persisted',
--       'message_unrenderable', 'venue_number_missing', 'venue_lookup_failed',
--       'venue_not_found', 'guest_lookup_failed', 'guest_insert_failed',
--       'idempotency_lookup_failed', 'duplicate_provider_message',
--       'empty_inbound_content', 'message_insert_failed', 'low_fidelity',
--       'knowledge_gap_card_protected', 'obligation_slot_taken',
--       'slot_occupied', 'context_build', 'classification', 'corpus',
--       'generation', 'persist', 'send', 'unexpected', 'coalesced_into_turn'
--     ));
--   commit;
--
-- NARROWING THE CHECK IS NOT SAFE ONCE ROWS CARRY THE NEW VALUE. Postgres
-- validates an added CHECK against existing rows, so the rollback ABORTS if
-- any row already holds 'venue_paused'. That is the correct behaviour -- it
-- refuses rather than lying about the data -- but it means the rollback must
-- run before, or together with, deleting those rows:
--
--   delete from inbound_turn_outcomes where reason = 'venue_paused';
--
-- Deleting them loses the record that those guests were not answered, so
-- prefer rolling the CODE back and leaving the CHECK wide: a value the
-- application no longer writes costs nothing.
