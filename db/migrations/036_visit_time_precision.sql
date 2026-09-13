-- 036_visit_time_precision.sql
-- TAC-377: self-reported visits set guests.last_visit_at, gated by how
-- precisely the visit's time is known.
--
-- WHY: `guests.last_visit_at` is written in exactly two places, both on the
-- Square path (lib/pos/reconcile.ts, lib/pos/reconcile-tap.ts). Le Mil's
-- transactions are `manual` and `guest_reported`, so every one of its guests
-- has last_visit_at = null — and `detectPostVisitReason` /
-- `detectColdLapsedReason` both key on that field. The hourly follow-up cron
-- runs, the engine scans, it reports success, and it cannot fire. TAC-323's
-- self-report write now advances last_visit_at too.
--
-- Two columns, both nullable text with a CHECK:
--
--   1. `transactions.occurred_at_precision` — how precisely THIS visit's
--      occurred_at is known. 'pinned' when the guest reported in present
--      tense while the venue was open (the message IS the receipt);
--      'approximate' otherwise.
--
--   2. `guests.last_visit_precision` — the same value for whichever visit
--      last_visit_at currently points at. Denormalized alongside
--      last_visit_at for the same reason last_visit_at is itself a cache
--      rather than a MAX() at scan time: the follow-up engine's per-venue
--      guest scan reads it directly, and a cold_lapsed candidate's anchoring
--      transaction is at least absence_window_days old (default 21), so
--      there is no usable occurred_at cutoff to bound a join. Both columns are written in ONE UPDATE, so the
--      precision can never describe a timestamp other than the one stored.
--
-- NO BACKFILL, deliberately. Every existing row is null, meaning "nobody
-- recorded a precision", which is honestly different from both 'pinned' and
-- 'approximate' — guessing either would be inventing evidence. The detector
-- treats null as PERMISSIVE (it does not block post_visit_*): null is the
-- pre-existing state of every Square-written last_visit_at, and the gate's
-- job is to stop a self-report from claiming precision it doesn't have, not
-- to switch off followups for visit records that predate the concept. That
-- reasoning is forward-looking — as of 2026-09-13 only four guests fleet-wide
-- have a non-null last_visit_at, all at mock venues, so no live venue
-- currently depends on it either way.
--
-- CONSTRAINTS: both are NEW names on NEW columns. No existing constraint is
-- dropped or recreated, so the name-drift hazard that migration 034 had to
-- verify against live pg_constraint does not apply here — there is nothing
-- to collide with. `add constraint` fails loudly if either name somehow
-- already exists.
--
-- HIGH-STAKES (touches `transactions`). ORDERING: additive shape, but the
-- deployed code SELECTs both columns, so apply in Studio BEFORE merging this
-- PR — same call migration 034 made on this table, confirmed with Jaipal on
-- the ticket. db/types.ts is hand-patched in the same commit until
-- `npm run db:types` runs post-apply.

alter table transactions
  add column occurred_at_precision text;

alter table transactions
  add constraint transactions_occurred_at_precision_check
  check (occurred_at_precision is null or occurred_at_precision in ('pinned', 'approximate'));

comment on column transactions.occurred_at_precision is
  'TAC-377: how precisely occurred_at pins this visit. pinned = the timestamp IS the visit time (present-tense self-report during open hours, or a POS receipt). approximate = best available anchor only. NULL = never recorded; treated as permissive by the follow-up detectors.';

alter table guests
  add column last_visit_precision text;

alter table guests
  add constraint guests_last_visit_precision_check
  check (last_visit_precision is null or last_visit_precision in ('pinned', 'approximate'));

comment on column guests.last_visit_precision is
  'TAC-377: precision of the visit last_visit_at points at. Written in the same UPDATE as last_visit_at so the two can never describe different visits. NULL = never recorded; does NOT block post_visit_* followups.';
