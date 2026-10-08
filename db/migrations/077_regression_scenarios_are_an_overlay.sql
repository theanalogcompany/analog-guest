-- 077: regression_scenarios stops carrying definitions and becomes an overlay
--
-- THIS MIGRATION EXISTS TO END A SERIES. Migrations 070, 071 and 072 were
-- each one test case, inserted as data, because the harness read its
-- scenarios from this table and treated the code array as a fallback only
-- (069's header). So every new regression case cost a hand-applied Studio
-- insert, and - worse - a case added in code alone was inert and SILENTLY
-- so: the fallback fires on an unreadable or empty table, never on a merely
-- incomplete one, so a table missing half the guards looks exactly like a
-- healthy one. That produced two false greens in two days ("6/6 passed"
-- covering six of eleven cases, 071; "10/11 passed" while the agent could
-- not answer an open recommendation ask at all, 072).
--
-- After this migration the direction is reversed. REGRESSION_SCENARIOS in
-- lib/eval/regression-scenarios.ts is the source of truth for every
-- scenario's definition - its script, its bars, its ceilings, its lesson -
-- and a new case is an edit to that array, reviewed in the PR that changes
-- the template, with no SQL and no apply. This table keeps exactly one job
-- it alone can do: carry the `enabled` flag, so a case can be silenced from
-- /admin/regression without a deploy.
--
-- Decision record: docs/decisions/0011-a-regression-scenario-is-code.md.
--
-- What changes here:
--
--   lesson, script    DROP NOT NULL. An overlay row is {key, enabled} and
--                     nothing else, so the columns must admit NULL. Every
--                     other definition column was already nullable or
--                     defaulted.
--   the 14 live rows  definitions NULLED. The columns are no longer read for
--                     a code-defined key, and a column that is ignored but
--                     still full of authoritative-looking prose is the trap
--                     this schema has already paid for once (046: a default
--                     that contradicted its own CHECK, believed for months
--                     because nothing could fail). Leaving a stale `lesson`
--                     in Studio for someone to read and trust is the same
--                     defect in slower motion. `enabled` is preserved
--                     exactly - it is the one thing this table still owns.
--
-- VERIFIED BEFORE WRITING THIS (read-only select against prod, 14 rows):
-- every row's key is present in REGRESSION_SCENARIOS, no code scenario is
-- missing a row, and no `enabled` flag diverges. So nulling the definitions
-- drops no guard - the set the harness runs is identical across the change.
-- One row did diverge on prose: knowledge-pastries' stored `lesson` carried
-- a measured record (two n=6 runs, the BAR_MIN quorum, and why a single
-- sample misreads as a failure) that the code array lacked. That paragraph
-- is ported into the array in the same commit. Nothing else differed.
--
-- ADDITIVE-WIDENING, AND THE NEW CODE WRITES NULL - apply in Studio BEFORE
-- merging. The PATCH route upserts {key, enabled} with no definition, so
-- against the pre-migration schema every toggle would fail 23502 on
-- lesson's NOT NULL.
--
-- ON ROLLBACK: dropping back to the previous deploy leaves nulled rows that
-- the old loader cannot parse, so the old harness warns and runs its builtin
-- set and the old admin page renders 14 parse-error banners. The builtin set
-- and this table's enabled set are identical today (verified above), so the
-- rolled-back harness runs exactly the same scenarios it ran before. Loud
-- and equivalent, which is the right failure: re-adding NOT NULL would
-- instead abort against the nulled rows.

begin;

alter table regression_scenarios
  alter column lesson drop not null,
  alter column script drop not null;

-- The definitions live in code now. Keep `key` and `enabled`; drop the rest
-- to NULL so nothing here can be read as authoritative.
update regression_scenarios
set lesson = null,
    script = null,
    target = '[]'::jsonb,
    expect_first_name = null,
    no_turn_one_name_ask = false,
    expect_reply_contains = null,
    forbid_policy_keys = '[]'::jsonb,
    updated_at = now();

comment on table regression_scenarios is
  'OVERLAY ONLY. Scenario definitions live in REGRESSION_SCENARIOS in lib/eval/regression-scenarios.ts; a row here carries `key` + `enabled` and nothing else, so a case can be disabled from /admin/regression without a deploy. A row whose key is absent from that array is an orphan: the page renders it, the harness does not run it. Migration 077, decision 0011.';

comment on column regression_scenarios.enabled is
  'The only field this table still owns. Overrides the code scenario''s own `enabled`; absent row means the code flag stands.';

comment on column regression_scenarios.lesson is
  'DEAD as of 077 - always NULL. The lesson is in the code array. Do not read.';

comment on column regression_scenarios.script is
  'DEAD as of 077 - always NULL. The script is in the code array. Do not read.';

comment on column regression_scenarios.target is
  'DEAD as of 077 - always []. The bar is in the code array. Do not read.';

comment on column regression_scenarios.expect_first_name is
  'DEAD as of 077 - always NULL. In the code array. Do not read.';

comment on column regression_scenarios.no_turn_one_name_ask is
  'DEAD as of 077 - always false. In the code array. Do not read.';

comment on column regression_scenarios.expect_reply_contains is
  'DEAD as of 077 - always NULL. In the code array. Do not read.';

comment on column regression_scenarios.forbid_policy_keys is
  'DEAD as of 077 - always []. In the code array. Do not read.';

commit;
