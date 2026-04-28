-- 007_test_synthetic_guests.sql
-- adds an is_test_synthetic flag to guests so analytics + future rollups can
-- exclude the synthetic guests seeded by run-test-scenarios (the-181). these
-- guests, plus their seeded transactions/messages/engagement_events, exist
-- solely to drive recognition state during onboarding response-review runs
-- and shouldn't contaminate real-guest metrics.
--
-- per-venue isolation: guests.venue_id is NOT NULL, so synthetic guests are
-- still scoped per-venue. each venue gets its own four synthetic guest rows
-- (one per recognition state) when run-test-scenarios first runs against it.
-- the deterministic phone numbers (+15550001000..1300) are reused across
-- venues; the guest rows are not.
--
-- not in this migration:
--   - any change to existing app-side queries. all per-(venue, guest) lookups
--     in lib/recognition + lib/agent already filter by guest_id, which is the
--     only level at which synthetic guests interact with the runtime. when
--     analytics rollups land in analog-operator (or a future dashboard repo)
--     they should add `where not is_test_synthetic` joins.

alter table guests
  add column is_test_synthetic boolean not null default false;

-- partial index: only synthetic rows index, real guests don't pay the cost.
-- supports the existence check in scripts/onboarding/run-test-scenarios.ts
-- (one query per state per venue at script start).
create index idx_guests_test_synthetic on guests(venue_id, is_test_synthetic)
  where is_test_synthetic = true;