-- 072_transactions_retracted_at.sql
-- TAC-573: a guest can take back a visit they told us about.
--
-- ============================================================================
-- WHAT THIS IS FOR
-- ============================================================================
--
-- A guest who writes "my latte was cold" gets a `transactions` row from
-- lib/agent/extract-reported-order.ts. On 2026-10-06 a guest then wrote
-- "actually I've never been here" and the visit stayed counted: nothing could
-- un-count it short of the Command Center delete, which destroys the record of
-- what was said.
--
-- `retracted_at` marks the row instead. Ruled 2026-10-06 (ruling 2): the row is
-- KEPT, and excluded from the visit count and from `guests.last_visit_at`.
-- NULL is every row today and every row that is still a visit.
--
-- ============================================================================
-- THE CHECK IS THE SCOPE RULING, ENFORCED
-- ============================================================================
--
-- Ruling 4: only a visit the guest reported can be retracted; POS visits are
-- never touched. Ruled 2026-10-07 (question 1): that is BOTH self-reported
-- sources, 'guest_reported' (the enrollment order) and
-- 'guest_reported_ongoing' (every later one, migration 047). The constraint
-- makes it a fact about the table rather than a property of one code path, so
-- a hand edit in Studio cannot retract a Square row either.
--
-- What it does NOT enforce, because Postgres cannot see it: "reported in the
-- same conversation" and "not on a day the guest scanned" (ruled 2026-10-07,
-- question 2). Both are decided in lib/agent/retract-reported-visit.ts.
--
-- Every existing row has retracted_at NULL, so the CHECK validates trivially.
-- There is no default, so migration 046's default-against-CHECK sweep has
-- nothing to find here.
--
-- ============================================================================
-- WHAT IS DELIBERATELY UNTOUCHED
-- ============================================================================
--
-- `idx_transactions_one_guest_reported_per_guest` (migration 034) keeps its
-- predicate `where source = 'guest_reported'`. A retracted enrollment row
-- still holds the one-per-guest slot, so a later genuine report from that
-- guest is stored as 'guest_reported_ongoing'. Narrowing the predicate to
-- un-retracted rows would let them enrol twice, and nothing asked for that.
--
-- No index on retracted_at: 127 rows live, and every reader already filters
-- on (venue_id, guest_id), which idx_transactions_venue_guest serves.
--
-- Live shape checked 2026-10-06 against information_schema.columns,
-- pg_indexes and pg_constraint: 16 columns, no retracted_at, no constraint of
-- this name, and no function, view or trigger body that reads `transactions`
-- (the only trigger is trg_transactions_updated_at).
--
-- ============================================================================
-- ORDERING
-- ============================================================================
--
-- Additive, but the deployed code READS it: every visit reader filters
-- `retracted_at is null`, including build-runtime-context on the inbound
-- webhook path. Merged first, the first inbound after deploy fails its context
-- build. APPLY IN STUDIO BEFORE MERGING.
--
-- ROLLBACK, only after the code is rolled back, since that code selects the
-- column (the constraint goes with it):
--
--   alter table transactions drop column retracted_at;
--
-- AFTER APPLYING, this returns 0:
--
--   select count(*) from transactions where retracted_at is not null;
--
-- db/types.ts is hand-patched in the same commit; the next `npm run db:types`
-- overwrites the patch with canonical output.

begin;

set local lock_timeout = '5s';

alter table transactions
  add column retracted_at timestamptz;

alter table transactions
  add constraint transactions_retracted_at_source_check
  check (
    retracted_at is null
    or source in ('guest_reported', 'guest_reported_ongoing')
  );

comment on column transactions.retracted_at is
  'TAC-573: when the guest took back a visit they had reported. Row kept; excluded from visit counts, spend, visit history and last_visit_at.';

commit;

-- ============================================================================
-- end of migration
-- ============================================================================
