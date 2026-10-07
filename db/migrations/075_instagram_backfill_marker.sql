-- TAC-515: mark what the Instagram history import writes, so a run can be
-- found and deleted cleanly.
--
-- ============================================================================
-- WHAT THIS IS FOR
-- ============================================================================
--
-- scripts/backfill-instagram-contacts.ts imports a venue's existing Instagram
-- conversations: a guest per person the account has talked to, and the recent
-- messages of each thread. Both need a marker that says "the import wrote
-- this", for two reasons. A test run has to be removable without touching a
-- single live row. And the import's own second rule (never write a message
-- dated after a guest's oldest LIVE message) needs to tell an imported row
-- from a live one on a rerun.
--
-- Two changes, and `messages` is in neither.
--
--   1. guests.created_via gains 'instagram_backfill'. The marker for a guest.
--   2. instagram_backfill_messages, a ledger of the message ids the import
--      wrote. The marker for a message.
--
-- ============================================================================
-- WHY A LEDGER AND NOT A COLUMN ON messages
-- ============================================================================
--
-- `messages` has no source or metadata column, and adding one is a migration
-- against a high-stakes table for a one-off script. A ledger says the same
-- thing from outside.
--
-- `message_id` DELIBERATELY HAS NO FOREIGN KEY TO messages. The script writes
-- the ledger row FIRST, with an id it generated, and only then inserts the
-- message under that id, so that a crash between the two leaves a ledger row
-- with no message (harmless, and a rollback simply finds nothing to delete)
-- rather than an imported message nothing marks. A foreign key would forbid
-- exactly that order. It also keeps this file from taking any lock on
-- `messages` at all.
--
-- `guest_id` and `venue_id` DO cascade: deleting a guest removes their
-- messages (001) and should remove the record that some of them were imported.
--
-- The table holds ids and a run id. No handle, no text, no Instagram-scoped
-- id, so there is nothing in it for a deletion request to redact.
--
-- ============================================================================
-- WHAT 'instagram_backfill' DOES TO A GUEST
-- ============================================================================
--
-- Every COMPARISON on created_via is an equality test on 'qr_scan'
-- (lib/agent/stages.ts, build-runtime-context.ts, extract-reported-order.ts,
-- visit-checkin.ts, and lib/recognition/load-scan-visits.ts at the time of
-- writing; `grep -rn "'qr_scan'"` is the list, not this comment). None is
-- exhaustive and the column is typed `string` on the read side, so the new
-- value behaves exactly as 'inbound_message' does: no QR opener, no
-- enrolment-day visit. As for every guest, only
-- creation sets it; a guest the venue already has is never re-labelled.
--
-- ============================================================================
-- THE CONSTRAINT NAME
-- ============================================================================
--
-- `guests_created_via_check` is Postgres's own name for the inline CHECK in
-- 001, and 006 and 034 both dropped and recreated it under that name. No
-- migration since 034 touches it. VERIFY IT AGAINST pg_constraint BEFORE
-- APPLYING, and that it still holds exactly the six values below:
--
--   select conname, pg_get_constraintdef(oid)
--   from pg_constraint
--   where conrelid = 'guests'::regclass and conname = 'guests_created_via_check';
--
-- ============================================================================
-- ORDER
-- ============================================================================
--
-- Additive, and NO DEPLOYED CODE READS OR WRITES EITHER HALF: the only reader
-- and writer is the script, run by hand. So order against the merge does not
-- matter. It must be applied before `--confirm`, which refuses to start
-- without the ledger table; `--dry-run` works before it and says so.
--
-- Widening a CHECK re-validates every `guests` row under an ACCESS EXCLUSIVE
-- lock for the length of that scan. At pilot size that is milliseconds, and
-- `lock_timeout` makes a busy table fail this cleanly instead of queueing
-- behind it. Apply outside the pilot venue's opening hours regardless.

begin;

set local lock_timeout = '5s';

-- ============================================================================
-- 1. guests.created_via: add 'instagram_backfill'
-- ============================================================================

alter table guests drop constraint guests_created_via_check;

alter table guests add constraint guests_created_via_check
  check (created_via in (
    'nfc_tap',
    'csv_import',
    'manual',
    'pos_match',
    'inbound_message',
    'qr_scan',
    'instagram_backfill'
  ));

-- ============================================================================
-- 2. the ledger of imported messages
-- ============================================================================

create table instagram_backfill_messages (
  -- The id the import generated for the message, written here BEFORE the
  -- message itself. Not a foreign key; see the header.
  message_id uuid primary key,
  venue_id uuid not null references venues(id) on delete cascade,
  guest_id uuid not null references guests(id) on delete cascade,
  -- One per invocation of the script, printed by it, so a single run's rows
  -- can be told from another's.
  run_id uuid not null,
  created_at timestamptz not null default now()
);

-- The rollback's read (every row for a venue) and the planner's (every row
-- for a guest).
create index idx_instagram_backfill_messages_venue
  on instagram_backfill_messages (venue_id);
create index idx_instagram_backfill_messages_guest
  on instagram_backfill_messages (guest_id);

commit;

-- verify:
--   select pg_get_constraintdef(oid) from pg_constraint
--   where conrelid = 'guests'::regclass and conname = 'guests_created_via_check';
--   -- expect the seven values above
--   select count(*) from instagram_backfill_messages;
--   -- expect 0
--
-- rollback:
--   begin;
--   drop table instagram_backfill_messages;
--   alter table guests drop constraint guests_created_via_check;
--   alter table guests add constraint guests_created_via_check
--     check (created_via in (
--       'nfc_tap', 'csv_import', 'manual', 'pos_match', 'inbound_message',
--       'qr_scan'
--     ));
--   commit;
--
-- TWO CAUTIONS ON THAT ROLLBACK.
--
-- Run the script's own `--rollback --confirm` FIRST. Dropping the ledger
-- before that leaves imported messages on already-known guests with nothing
-- left to say which they are.
--
-- Narrowing the CHECK ABORTS while any guest still carries
-- 'instagram_backfill', which is correct: those rows are real. Prefer leaving
-- the CHECK wide; a value nothing writes costs nothing.
