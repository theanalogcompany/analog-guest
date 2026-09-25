-- 064_instagram_scan_arrivals.sql
-- TAC-536: the pending greeting a bare scan starts, and the five ledger
-- reasons that say what became of it.
--
-- ============================================================================
-- WHY A TABLE
-- ============================================================================
--
-- A guest who scans and types nothing is not answered immediately. The scan
-- starts a FIVE-MINUTE TIMER (ruled 2026-09-25): anything they send inside it
-- is treated as at-counter and answered on its own, and only silence produces
-- a greeting. Something has to hold the pending greeting between the webhook
-- and the cron that resolves it, and something has to make "one greeting per
-- guest per venue-local day" true rather than hoped for.
--
-- Not a column on `messages`: that is a second migration against the one
-- table CLAUDE.md names as hard-stop, for state that is not a property of the
-- message, and a partial unique index would have nowhere natural to live.
--
-- ============================================================================
-- THE CLAIM IS ONE STATEMENT THAT DOES TWO JOBS
-- ============================================================================
--
--   update instagram_scan_arrivals
--      set claimed_at = now(), venue_local_date = $2
--    where id = $1 and claimed_at is null
--
--   rowcount 1  this tick owns the greeting
--   rowcount 0  another tick already claimed THIS row
--   23505       this guest already has a claimed row for this venue-local
--               day, from ANY scan: they have been greeted today
--
-- So two overlapping ticks cannot both greet, and neither can two different
-- scans by the same guest on one day. The repeat guard is Postgres, not a
-- read-then-decide, which is migration 038's escalation lesson applied before
-- it could bite: the tick is every minute and a read-then-decide loses to
-- itself.
--
-- `venue_local_date` is NULL at insert and written at claim. Computing it
-- needs the venue's timezone and the webhook has resolved only `venue_id`, so
-- deferring it keeps a timezone read off Meta's delivery deadline. The partial
-- index is `where claimed_at is not null`, so an unclaimed row is simply not
-- in it, and a suppressed one (venue closed, guest wrote first, opted out)
-- leaves `claimed_at` null and does NOT burn the day.
--
-- ROWS ARE NEVER DELETED by the processor. A resolved row is the record of a
-- scan that did not become a greeting, which is the thing this ticket exists
-- to stop losing. `delete-venue-data.ts` does delete them, for a different
-- reason -- see that file.
--
-- ============================================================================
-- THE FIVE LEDGER REASONS
-- ============================================================================
--
-- Each is a genuinely different cause, and collapsing any pair would make the
-- distinction inbound_turn_outcomes exists for unanswerable in SQL. All five
-- are `outcome = 'not_run'`, `layer = 'agent'`.
--
-- Drop-and-recreate is the only way to widen a CHECK. The constraint name is
-- the one migration 057 created and 059 last recreated. VERIFY IT AGAINST
-- pg_constraint BEFORE APPLYING:
--
--   select conname, pg_get_constraintdef(oid)
--   from pg_constraint
--   where conrelid = 'inbound_turn_outcomes'::regclass and contype = 'c';
--
-- ORDERING: additive, but the deployed code INSERTs into the new table on the
-- very next scan and writes the new reasons a minute later. Apply in Studio
-- BEFORE merging, the call 026 / 029 / 035 / 055 / 057 / 059 all made.

begin;

set local lock_timeout = '5s';

create table instagram_scan_arrivals (
  id uuid primary key default gen_random_uuid(),
  venue_id uuid not null references venues(id) on delete cascade,
  guest_id uuid not null references guests(id) on delete cascade,
  -- The inbound row the scan was saved as. ON DELETE SET NULL rather than
  -- cascade: losing the pointer is better than losing the record that a scan
  -- happened and what came of it.
  scan_message_id uuid references messages(id) on delete set null,
  -- Meta's own clock for the scan when the delivery carried one, else our
  -- receipt time. The five minutes and the staleness bound both run from it.
  scanned_at timestamptz not null,
  -- The CAS claim. Non-null means a tick owns this row's greeting.
  claimed_at timestamptz,
  -- YYYY-MM-DD in the venue's timezone, written AT CLAIM TIME. Text rather
  -- than date because that is what Intl.DateTimeFormat('en-CA') produces and
  -- it is lexicographically comparable, the same shape commitments-due uses.
  venue_local_date text,
  -- What became of it. Null while pending.
  outcome text check (outcome in (
    -- a greeting was generated and dispatched (sent, queued or refused: the
    -- agent's own ledger row carries which)
    'greeted',
    -- the guest wrote before the five minutes were up, so their own message
    -- is the turn and this scan needed no greeting of its own
    'inbound_during_window',
    -- the cron was late enough that "in the shop right now" would be a guess
    'too_stale',
    -- venues.status is paused or archived
    'venue_paused',
    -- the venue's own hours positively say it is shut
    'venue_closed',
    -- guests.opted_out_at is set
    'guest_opted_out',
    -- another scan already greeted this guest today
    'already_greeted_today',
    -- the run itself threw
    'errored'
  )),
  resolved_at timestamptz,
  created_at timestamptz not null default now()
);

-- The cron's scan: due rows, oldest first.
create index idx_instagram_scan_arrivals_pending
  on instagram_scan_arrivals (scanned_at)
  where claimed_at is null and resolved_at is null;

-- The repeat guard AND the second half of the endpoint's idempotency. See the
-- header: one UPDATE does both jobs against this index.
create unique index instagram_scan_arrivals_one_greeting_per_venue_day
  on instagram_scan_arrivals (venue_id, guest_id, venue_local_date)
  where claimed_at is not null;

-- The carry-forward read: the most recent scan for this guest, to decide
-- whether an inbound arriving now is at the counter.
create index idx_instagram_scan_arrivals_recent
  on instagram_scan_arrivals (venue_id, guest_id, scanned_at desc);

alter table inbound_turn_outcomes
  drop constraint inbound_turn_outcomes_reason_check;

alter table inbound_turn_outcomes
  add constraint inbound_turn_outcomes_reason_check check (reason in (
    -- layer 'webhook', Instagram (TAC-523 PR 1)
    'gate_shut',
    'titleless_postback',
    'event_not_persisted',
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
    -- TAC-526, outcome 'superseded'
    'coalesced_into_turn',
    -- TAC-529, outcome 'not_run'
    'venue_paused',
    -- TAC-536, outcome 'not_run': a scan that did not become a greeting.
    -- The guest wrote inside the five minutes, so their own message was the
    -- turn. The commonest of the five, and a success rather than a miss.
    'inbound_during_window',
    -- The cron was late and the guest is long gone. "In the shop right now"
    -- would be a guess by then, and a missed greeting is cheaper than a wrong
    -- one.
    'scan_too_stale',
    -- The venue's own hours positively say it is shut. `unknown` hours
    -- proceed, per TAC-363's rule that unknown behaves as open.
    'venue_closed',
    -- guests.opted_out_at is set. Its own value rather than folded into
    -- venue_paused: one is the venue switched off, the other is a person who
    -- asked us to stop, and an unprompted send is exactly where that matters.
    'guest_opted_out',
    -- Another scan already greeted this guest today. The repeat guard firing,
    -- which is a decision working rather than anything going wrong.
    'already_greeted_today'
  ));

commit;

-- rollback:
--   begin;
--   drop table instagram_scan_arrivals;
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
--       'generation', 'persist', 'send', 'unexpected', 'coalesced_into_turn',
--       'venue_paused'
--     ));
--   commit;
--
-- TWO CAUTIONS ON THAT ROLLBACK.
--
-- `drop table` loses every pending greeting and every record of a scan that
-- did not become one. Nothing else reads the table, so nothing breaks, but the
-- history is gone.
--
-- Narrowing the CHECK ABORTS once a row carries one of the five new reasons,
-- which is correct: it refuses rather than lying about the data. Deleting
-- those rows loses the record that those guests were not greeted, so prefer
-- rolling the CODE back and leaving the CHECK wide -- a value the application
-- no longer writes costs nothing.
