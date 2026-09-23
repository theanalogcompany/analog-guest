-- 057_inbound_turn_coalescing.sql
-- TAC-526: one claim per (venue, guest) so a guest's burst produces one reply.
--
-- WHY THIS EXISTS. Both webhooks call `waitUntil(runInboundAgent(id))` once
-- per inbound row, so two messages seconds apart start two independent agent
-- runs in two serverless invocations that share no memory. Observed live at
-- Le Mil's on 2026-09-23: a guest sent two messages 7 seconds apart and was
-- asked their name twice, 5 seconds apart.
--
-- The ticket's premise was half wrong, and the half that is wrong decides the
-- design. Both runs could see the other's MESSAGE -- build-runtime-context.ts
-- excludes only `currentMessage.id`, so the second run had the first message
-- in `## Recent conversation`. Neither could see the other's REPLY, because it
-- did not exist yet. So the fix is "only one run may produce a reply", not
-- "let the reply see both messages" -- which is why this is a claim table and
-- not a prompt change.
--
-- WHY A TABLE, and specifically why NOT a column on `messages`. Verified
-- before choosing: `messages.status` is CHECK-constrained to nine values with
-- no claim state (001), `updated_at` is trigger-maintained so it cannot be a
-- CAS witness, and every column already used as a claim (`pending_until`,
-- `review_state`, `generated_by`) is outbound-only. A claim column would mean
-- a migration against `messages`, the most dangerous table in the repo. This
-- ticket ships NO migration against `messages` at all, and that is a
-- deliberate property of the design rather than an accident of scope.
--
-- WHY THE PRIMARY KEY IS THE MECHANISM. `findExistingReply` in
-- handle-inbound.ts is the only idempotency guard today and it is a READ keyed
-- on `reply_to_message_id = thisMessageId`: structurally incapable of seeing a
-- concurrent run for a DIFFERENT message id, and check-then-act even for the
-- same one. An in-memory guard is not a guard across serverless invocations.
-- `primary key (venue_id, guest_id)` is what makes exactly one INSERT win; the
-- application does a plain INSERT with no ON CONFLICT clause, so a race
-- surfaces as 23505 -- `claimFollowupLogRows` (followups/log.ts) is the same
-- idiom against the same class of race.
--
-- One Instagram delivery can carry several guest messages (entry[] x
-- messaging[]) inserted in the same millisecond, so `order by created_at desc`
-- is not a total order on its own. That is the concrete reason the claim is
-- load-bearing rather than ceremony: the tie has to be broken by something
-- that can only have one winner.
--
-- EXPIRES_AT IS A BACKSTOP, NOT THE MECHANISM. The normal path releases the
-- claim explicitly in a `finally`. The lease exists for the case no code runs
-- at all -- a function killed by OOM or wall clock -- so a dead run cannot
-- mute a guest for longer than the lease. Takeover of an expired claim is
-- CAS-gated on the holder's `agent_run_id` still being the one just read
-- (`refresh-profile.ts`'s `claimed_elsewhere` shape), so two runs finding the
-- same expired claim cannot both take it over.
--
-- ONE ROW, NOT A HISTORY. The table holds at most one row per (venue, guest)
-- and rows are deleted on release, so it stays tiny -- bounded by the number
-- of guests in a conversation at one instant, which at pilot scale is single
-- digits. It is not an audit trail: `inbound_turn_outcomes` (055) is, and the
-- second half of this migration is what lets it tell a coalesced message apart
-- from a message staff answered by hand.
--
-- NO INDEX BEYOND THE PRIMARY KEY, deliberately. Every read is by the full
-- primary key. A sweep of expired claims would want one, and there is no sweep
-- (see the rollback note).
--
-- ORDERING: additive -- a new table, and a CHECK that only gains a value --
-- but deployed code both INSERTs into the new table and writes the new
-- `reason` on the very next coalesced turn after deploy, so apply in Studio
-- BEFORE merging. That is the call 026 / 029 / 035 / 050 / 055 all made on
-- their own new tables.

begin;

-- The FKs briefly take a SHARE ROW EXCLUSIVE lock on each referenced table.
-- Instant at this size, but `messages` is on the live webhook path, so fail
-- fast rather than queue behind a long transaction. Migration 048's reasoning.
set local lock_timeout = '5s';

create table inbound_turn_claims (
  -- The claim is on the CONVERSATION, not on a message: that is what makes
  -- two runs for two different messages contend for the same thing.
  venue_id uuid not null references venues(id) on delete cascade,
  guest_id uuid not null references guests(id) on delete cascade,

  -- Which message the holder is answering. Recorded so a loser's ledger row
  -- can name the turn that covered it, and so a human reading the table
  -- mid-incident can see what is in flight.
  claimed_message_id uuid not null references messages(id) on delete cascade,

  -- The holder. Every write is gated on this: release deletes only its own
  -- claim, and takeover of an expired lease is CAS-gated on it.
  agent_run_id uuid not null,

  claimed_at timestamptz not null default now(),

  -- Backstop for a process that dies without running its `finally`. Written by
  -- the application from CLAIM_LEASE_MS rather than defaulted here, so the
  -- lease is one number in one place (lib/agent/coalesce-turn.ts).
  expires_at timestamptz not null,

  primary key (venue_id, guest_id)
);

comment on table inbound_turn_claims is
  'TAC-526: at most one in-flight agent run per (venue, guest). The primary key is the mechanism -- a plain INSERT with no ON CONFLICT means a race surfaces as 23505 and exactly one run proceeds. Rows are deleted on release; expires_at is only a backstop for a run killed without running its finally.';

-- The second half: let the ledger tell a coalesced message apart from one
-- staff answered by hand. Both are outcome 'superseded'; without a distinct
-- reason they are one bucket in SQL, and the turn count below cannot be
-- written at all.
--
-- Drop-and-recreate is the only way to widen a CHECK: Postgres has no ALTER
-- CONSTRAINT for the expression. Same pattern migrations 011 / 012 / 016 /
-- 034 / 047 use on messages_category_check and transactions_source_check.
--
-- The constraint name is Postgres's own for the inline CHECK migration 055
-- declared on `reason`. VERIFY IT AGAINST pg_constraint BEFORE APPLYING --
-- CLAUDE.md's standing caution, because a name assumed rather than checked is
-- how a drop silently removes the wrong constraint:
--
--   select conname, pg_get_constraintdef(oid)
--   from pg_constraint
--   where conrelid = 'inbound_turn_outcomes'::regclass and contype = 'c';

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
    -- TAC-526, outcome 'superseded': this message was folded into another
    -- run's turn. A DECISION, not a failure -- the guest was answered, by the
    -- turn named in `detail.coalescedIntoAgentRunId`. It is the second value
    -- (with 'skipped_duplicate') that means the agent ran more than once for
    -- one guest action, so a strict turn count excludes it:
    --
    --   select count(*) from inbound_turn_outcomes
    --   where layer = 'agent'
    --     and outcome <> 'skipped_duplicate'
    --     and reason is distinct from 'coalesced_into_turn'
    --
    -- Distinct from a bare 'superseded', which is TAC-469's reply check: staff
    -- answered by hand in the Instagram app. Same outcome, different cause,
    -- and merging them would make both unanswerable.
    'coalesced_into_turn'
  ));

commit;

-- rollback:
--   begin;
--   drop table if exists inbound_turn_claims;
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
--       'generation', 'persist', 'send', 'unexpected'
--     ));
--   commit;
--
-- NARROWING THE CHECK IS NOT SAFE ONCE ROWS CARRY THE NEW VALUE. Postgres
-- validates an added CHECK against existing rows, so the rollback ABORTS if
-- any row already holds 'coalesced_into_turn' -- which is the correct
-- behaviour (it refuses rather than lying about the data), but it means the
-- rollback must be run before, or together with, deleting those rows:
--
--   delete from inbound_turn_outcomes where reason = 'coalesced_into_turn';
--
-- Dropping the claims table is safe at any time: it holds only in-flight
-- state, nothing reads it outside lib/agent/coalesce-turn.ts, and with the
-- feature flag off nothing writes it. An in-flight claim lost to the drop
-- means at worst one guest gets two replies, which is today's behaviour.
--
-- NO SWEEP CRON for claims orphaned by a killed function: the lease is what
-- bounds them, takeover is CAS-gated, and a stale row is overwritten by the
-- next turn for that guest rather than accumulating. Deliberately out of scope.
