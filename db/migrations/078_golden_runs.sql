-- 078: golden set run records
--
-- The golden set is the questions a guest actually asks - hours, oat milk,
-- "is the gulab jamun cake vegan", "my latte came out cold" - run through v1
-- and v2 on the same inbound so a human can read the two answers side by
-- side at /admin/tests/golden. It answers "does v2 regress" before the
-- per-venue flag flips, and it answers it by being read, not by being scored.
--
-- NO QUESTIONS TABLE HERE, DELIBERATELY. The set is GOLDEN_QUESTIONS in
-- lib/eval/golden-set.ts and nowhere else, so adding or rewording a question
-- is a code edit reviewed in a PR, with no SQL and no apply. That is the
-- direction migration 077 established for regression scenarios (decision
-- 0011) and the reason is the same one 077's header records: when the table
-- held the definitions, a case added in code alone was inert and SILENTLY so,
-- because the code fallback fires on an unreadable or empty table and never
-- on a merely incomplete one. Two false greens came out of that in two days.
-- Starting here with no definition table at all means there is no overlay to
-- diverge and no incomplete-table state to misread.
--
-- There is no `enabled` overlay either, which 077 does keep. A regression
-- scenario has bars and a verdict, so silencing a misfiring one without a
-- deploy is worth a column; a golden question has neither - its only cost is
-- model calls - so "run a subset" is `--questions=` on the harness, and
-- `full_run` below records whether a stored run covered the whole set.
--
--   golden_runs        one row per harness invocation. Grouped by git_sha on
--                      the page, which is why git_subject and git_dirty are
--                      stored: a run made over uncommitted edits is NOT that
--                      commit's behaviour, and a page that silently filed it
--                      under the commit anyway would be making a claim
--                      nothing enforces.
--   golden_run_units   one row per question: what each arm said, plus how it
--                      got there. JSONB shapes are lib/schemas/golden.ts -
--                      read them through those, never raw SQL paths.
--
-- WHAT IS NOT COMPARABLE, recorded here because the columns invite it:
--   * bubble COUNT. Both arms store real bubble boundaries, but the v1 test
--     path pins the probabilistic sentence split off (TEST_RUN_SPLIT_RNG =
--     0.99 against SPLIT_PROBABILITY = 0.5), so a v1 reply splits only where
--     a tail earns its own bubble structurally - the further-help offer, the
--     getting-to-know-you question. v2 emits `messages[]` directly. Measured
--     on the first full run: v1 26 single / 5 two, v2 19/8/3/1. Part of that
--     gap is the harness, so the count is not a finding about the engines.
--   * route. v1's test draft stops before the 20 approval triggers and the
--     four post-generation checks, so it cannot say whether v1 would have
--     sent or queued. `v2.gateVerdict` has no counterpart and is rendered
--     for v2 alone.
--   * two runs in different venue_open_state. The prompt carries an
--     open/closed line, so a run after close hedges its way through all 31
--     questions. Stored so a stale file cannot be misread later; the page
--     refuses to diff across a mismatch.
--
-- The local JSONL run log stays the harness's primary, crash-safe record
-- (the run-log convention in scripts/CLAUDE.md); these tables are the viewing
-- copy, written once at the end. A run that dies mid-way is in the JSONL and
-- absent here, which is the honest representation of "no complete result".
--
-- PURELY ADDITIVE, AND THE DEPLOYED CODE READS IT - two new tables, no
-- existing object altered. Applied by `npm run db:apply -- 078_golden_runs.sql`
-- (root CLAUDE.md's additive-apply rule), and applied BEFORE merging, because
-- the /admin/tests/golden loader selects both tables on first render.

begin;

create table golden_runs (
  id uuid primary key default gen_random_uuid(),
  venue_id uuid not null references venues(id) on delete cascade,
  -- The commit the run was made at, and whether the tree was clean. Nullable
  -- sha because a run outside a git checkout is possible; the page files
  -- those under "(no commit recorded)" rather than hiding them.
  git_sha text,
  git_subject text,
  git_dirty boolean not null default false,
  -- Both engines' prompt versions, so a reply can be attributed after either
  -- side moves. v1's PROMPT_VERSION and v2's V2_PROMPT_VERSION.
  v1_prompt_version text not null,
  v2_prompt_version text not null,
  -- 'open' | 'closed' | 'unknown' - never a boolean. "The venue's hours were
  -- unreadable" has to stay distinguishable from "the venue was closed", or a
  -- failed read renders as a stated closure (the three-state rule in
  -- .claude/rules/errors-as-values.md).
  venue_open_state text not null
    check (venue_open_state in ('open', 'closed', 'unknown')),
  questions_total integer not null,
  -- True when the run covered every question in GOLDEN_QUESTIONS. A
  -- --questions= subset is a cheap iteration, not a result set, and the page
  -- labels it so.
  full_run boolean not null,
  started_at timestamptz not null default now(),
  finished_at timestamptz
);

create index golden_runs_recency on golden_runs (started_at desc);
create index golden_runs_commit on golden_runs (git_sha);

create table golden_run_units (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references golden_runs(id) on delete cascade,
  -- GOLDEN_QUESTIONS[].key. No FK: the questions are code, so there is no
  -- table to reference - and a question later reworded or removed must leave
  -- its historical answers readable rather than cascade them away.
  question_key text not null,
  v1 jsonb not null,
  v2 jsonb not null,
  unique (run_id, question_key)
);

comment on table golden_runs is
  'One golden-set harness invocation. Questions are code (GOLDEN_QUESTIONS in lib/eval/golden-set.ts) - no table carries a definition. Migration 078.';

comment on table golden_run_units is
  'One golden-set question per row: v1''s answer and v2''s answer to the same cold-open inbound. Shapes in lib/schemas/golden.ts. Neither bubble count nor route is comparable across the two columns - see 078''s header.';

commit;
