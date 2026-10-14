-- 083: blind human evaluation of v1 against v2
--
-- The golden set already puts v1's answer next to v2's for a human to read
-- (migration 078). This records what the human DECIDED - and records it
-- blind: both engines answer the same inbound, the two replies are shown as
-- A and B in a per-question random order with no label, and the rater marks
-- each one pass or fail. When at least one side fails they also say which
-- reply was better and why. /admin/tests/human-eval.
--
-- NO QUESTIONS TABLE, for the reason 078's header gives at length: the set is
-- GOLDEN_QUESTIONS in lib/eval/golden-set.ts and nowhere else, so there is no
-- overlay to diverge and no incomplete-table state to misread.
--
--   human_eval_sessions  one row per pass: the venue, who rated it, and the
--                        code state both arms ran at. A pass is generated
--                        live from the browser rather than by the harness, so
--                        there is no local JSONL behind it - these rows ARE
--                        the record, which is why each answer is written the
--                        moment it lands rather than once at the end.
--   human_eval_units     one row per question: both answers, the A/B
--                        scramble, and the verdicts. JSONB shapes are
--                        lib/schemas/golden.ts (GoldenV1Schema /
--                        GoldenV2Schema) - the same shapes the golden set
--                        stores, read through those schemas and never through
--                        raw SQL paths.
--
-- VERDICTS ARE STORED AS THE HUMAN GAVE THEM - a_verdict, b_verdict,
-- preference in ('a','b','neither') - never pre-translated into v1 and v2.
-- That is the honest record of a blind pass: the rater judged A and B, and
-- `a_arm` is what turns it back into a statement about the engines.
-- lib/eval/human-eval.ts is the one place that does that, so the page and the
-- CSV export cannot disagree about which engine won a row.
--
-- WHY `revealed_at` EXISTS. A surface can claim a pass was blind and nothing
-- can contradict it. This column can: reveal is only offered once both
-- verdicts are in, the instant is recorded, and the export derives whether a
-- verdict landed after it. A row judged before its reveal is evidence; a row
-- judged after is a row someone changed their mind on knowing the answer, and
-- the two must not read alike.
--
-- `rated_by` CARRIES NO FOREIGN KEY, deliberately. The local dev bypass
-- (lib/auth/dev-bypass.ts) stamps an all-zeros sentinel operator id that is
-- not a row in the operator table at all, so an FK here would make every
-- write from a developer's own `next dev` fail with a constraint violation -
-- invisible to tsc, discovered only by running the thing. The sentinel is
-- documented as greppable and honest about its origin, and that is what this
-- column holds when it appears.
--
-- WHAT IS NOT COMPARABLE, repeated from 078's header because these columns
-- invite it just as much: bubble COUNT is not a finding about the engines (the
-- v1 test path pins the probabilistic sentence split off), and v1 has no route
-- verdict at all, because `draftInboundReply` stops before the approval
-- triggers. The rater is judging the TEXT of a reply. Four of the set's
-- scenarios never reach a row here, because only one engine can answer them -
-- two proactive and two media - and the page lists them rather than letting a
-- 58-row pass read as the whole set.
--
-- PURELY ADDITIVE, AND THE DEPLOYED CODE READS IT - two new tables, no
-- existing object altered. Applied by
-- `npm run db:apply -- 083_human_eval.sql` (root CLAUDE.md's additive-apply
-- rule), and applied BEFORE merging, because the /admin/tests/human-eval
-- loader selects both tables on first render.

begin;

create table human_eval_sessions (
  id uuid primary key default gen_random_uuid(),
  venue_id uuid not null references venues(id) on delete cascade,
  -- The analog admin who ran the pass. No FK - see the header.
  rated_by uuid not null,
  -- Both engines' prompt versions, so a verdict can be attributed after
  -- either side moves. v1's PROMPT_VERSION and v2's V2_PROMPT_VERSION.
  v1_prompt_version text not null,
  v2_prompt_version text not null,
  -- The resolved v2 generation profile id (V2_GENERATION_MODEL's switch).
  -- Stored because the profiles do not answer alike, and a verdict about "v2"
  -- that cannot name which model answered is not attributable. This is the
  -- column `golden_runs` is missing.
  v2_model text not null,
  -- 'open' | 'closed' | 'unknown' - never a boolean, so "the hours were
  -- unreadable" stays distinguishable from "the venue was closed"
  -- (.claude/rules/errors-as-values.md). The prompt carries an open/closed
  -- line, so two passes in different states are not comparable.
  venue_open_state text not null
    check (venue_open_state in ('open', 'closed', 'unknown')),
  -- VERCEL_GIT_COMMIT_SHA when deployed, null on a local dev server - which
  -- is where most passes will be run. Null means "no commit recorded", never
  -- "clean tree at an unknown commit".
  git_sha text,
  started_at timestamptz not null default now()
);

create index human_eval_sessions_recency
  on human_eval_sessions (venue_id, started_at desc);

create table human_eval_units (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null
    references human_eval_sessions(id) on delete cascade,
  -- GOLDEN_QUESTIONS[].key. No FK: the questions are code, so there is no
  -- table to reference - and a question later reworded must leave the
  -- verdicts already given against it readable.
  question_key text not null,
  -- Which engine was shown in the A column. One column rather than two: B is
  -- the complement by construction, and a second column could disagree with
  -- it.
  a_arm text not null check (a_arm in ('v1', 'v2')),
  v1 jsonb not null,
  v2 jsonb not null,
  -- Null until the rater marks it. Null is "not judged yet", which is not a
  -- verdict and must never render or export as one.
  a_verdict text check (a_verdict in ('pass', 'fail')),
  b_verdict text check (b_verdict in ('pass', 'fail')),
  -- Which reply was better, asked only once at least one side has failed:
  -- with both passing there is nothing to adjudicate. 'neither' is a real
  -- answer (both bad, or genuinely level), distinct from null.
  preference text check (preference in ('a', 'b', 'neither')),
  -- Why. Free text, the rater's own words, and the most valuable column here:
  -- a pass rate says v2 regressed, this says what about it did.
  note text,
  generated_at timestamptz not null default now(),
  -- The most recent verdict write. Compared against revealed_at by the
  -- export - see the header.
  judged_at timestamptz,
  revealed_at timestamptz,
  -- One row per question per pass. Re-generating a question overwrites its
  -- answers in place and clears its verdicts, because a verdict is about a
  -- reply and the reply changed.
  unique (session_id, question_key)
);

comment on table human_eval_sessions is
  'One blind human-evaluation pass over the golden set: both engines answer, the rater judges A against B without being told which is which. Questions are code (GOLDEN_QUESTIONS in lib/eval/golden-set.ts) - no table carries a definition. Migration 083.';

comment on table human_eval_units is
  'One golden-set question per blind pass: both answers, the A/B scramble and the verdicts. Verdicts are stored exactly as the rater gave them (A/B); lib/eval/human-eval.ts is the one place that turns them back into a statement about v1 and v2. Answer shapes are lib/schemas/golden.ts. Neither bubble count nor route is comparable across the two - see 083''s header.';

comment on column human_eval_units.a_arm is
  'Which engine was shown as A. B is the complement - one column, so the two cannot disagree.';

comment on column human_eval_units.revealed_at is
  'When the rater unblinded this row. Reveal is offered only once both verdicts are in, and the CSV export derives whether a verdict landed afterwards, so "this pass was blind" is checkable rather than asserted.';

commit;
