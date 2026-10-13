-- 083: can a golden-set run be traced back to code anyone else can read?
--
-- Three columns, all answering questions the page currently gets wrong by
-- omission rather than by error.
--
-- git_on_remote. `golden_runs.git_sha` has been rendered as a link to
-- github.com/theanalogcompany/analog-guest/commit/<sha> since migration 078.
-- The harness runs from an operator shell, so that sha is whatever the local
-- HEAD was - and a local HEAD is routinely a commit that exists on one machine.
-- The link 404s and the page gives no hint, so the sha reads as reviewable
-- code. Every claim here was made by the UI, not by this table: the honest fix
-- is for the table to carry whether the commit was ever pushed.
--
-- Nullable on purpose, three-state: true is on a remote, false is local only,
-- NULL is "could not tell" - no remote configured, or git itself failed. Those
-- are different facts and `unreadable` is not `none`
-- (.claude/rules/errors-as-values.md). Rows written before this migration are
-- NULL, which is the only honest answer available for them.
--
-- git_branch. Two runs an hour apart can sit on two different feature branches
-- and the page shows one sha each with nothing saying they are unrelated lines
-- of work. Nullable: a detached HEAD has no branch, and that is a real state
-- the harness can run in rather than an error.
--
-- v2_generation_model. v2 generation became a switch the same day
-- (V2_GENERATION_MODEL, lib/ai/client.ts), and the available models do not
-- answer alike - a paired regression run put the default at 7/8 with no
-- ceiling breach against 6/8 with two for both alternatives. So "which model
-- answered" is now part of what a reply IS, and a stored run without it cannot
-- be compared against another stored run. The JSONL run log has recorded it
-- from the start; this is the half the page can read.
--
-- Nullable rather than defaulted to the current default model: a row written
-- before the switch existed was produced by whatever the hardcoded constant
-- was at that sha, and writing today's default into it would be inventing a
-- fact with a column behind it. NULL means "not recorded", and the page says
-- so.
--
-- Additive: three nullable columns on a table nothing outside
-- /admin/tests/golden and its export route reads. The new reader ships with
-- them, so this applies BEFORE the PR merges (db/migrations/CLAUDE.md).

begin;

set local lock_timeout = '5s';

alter table golden_runs
  add column git_on_remote boolean,
  add column git_branch text,
  add column v2_generation_model text;

comment on column golden_runs.git_on_remote is
  'True when git_sha was found on a remote branch at run time, false when the commit was local only, NULL when it could not be determined or the run predates migration 083. A local-only sha has no working link out and nobody else can reproduce the run from it.';

comment on column golden_runs.git_branch is
  'The branch checked out when the run was made. NULL for a detached HEAD, when git failed, or for a run predating migration 083.';

comment on column golden_runs.v2_generation_model is
  'The resolved v2 generation model id, from V2_GENERATION_MODEL. NULL for a run predating migration 083, which means not recorded rather than any particular model.';

commit;
