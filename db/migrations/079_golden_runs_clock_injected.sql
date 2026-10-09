-- 079: did this golden-set run invent its own clock?
--
-- `golden_runs.venue_open_state` has meant one thing since migration 078: the
-- state the venue was measured in. `--at=10:30` now lets a run taken at 11pm
-- ask the questions a guest asks mid-service, which puts 'open' in that column
-- for a venue that was shut. Without this flag the two are indistinguishable,
-- and the stale reading is the dangerous one - an injected 'open' would be
-- read as evidence the agent handles open hours correctly in the wild.
--
-- NOT NULL DEFAULT FALSE, so every run recorded before this migration keeps
-- the only honest answer available for it: those runs could not inject a
-- clock, because the flag did not exist.
--
-- Additive: one column on a table nothing outside /admin/tests/golden reads.

begin;

set local lock_timeout = '5s';

alter table golden_runs
  add column clock_injected boolean not null default false;

comment on column golden_runs.clock_injected is
  'True when the run was taken with --at=, so venue_open_state describes the clock the prompt was given rather than the clock the venue was on. An injected open state is not the same evidence as a measured one.';

commit;
