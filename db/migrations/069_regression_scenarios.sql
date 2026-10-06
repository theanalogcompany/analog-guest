-- 069: regression scenarios and runs - the v2 template's test cases as data
--
-- The template-regression harness (scripts/measurement/template-regression.ts)
-- guards every measured lesson in lib/ai/v2/template.ts's changelog. Until
-- now its scenarios were a hardcoded array and its results local JSONL files;
-- this moves both behind an admin surface (/admin/regression) so a human can
-- see what each case tests, read results, and add/disable cases without
-- editing code - the same reasoning that put the graph, the prompt template
-- and the judge rubric in tables (decision 0009: behaviour is versioned data
-- artifacts, not code).
--
--   regression_scenarios   one row per case: the guest-side script, the bars
--                          and ceilings, and `lesson` - why the case exists,
--                          in prose. Seeded below from
--                          lib/eval/regression-scenarios.ts (the builtin set,
--                          which stays as the harness's fallback when this
--                          table is unreadable). `enabled` is the soft
--                          delete: a scenario that caught something once
--                          should not vanish silently - hard DELETE exists
--                          on the admin surface but is the explicit path.
--   regression_runs        one row per harness invocation: versions, sample
--                          count, git sha, and `verdicts` (scenario key ->
--                          verdict line, computed ONCE by the harness via
--                          scenarioVerdict and stored - the page renders
--                          stored verdicts rather than re-deriving, so two
--                          surfaces cannot disagree about what passed).
--   regression_run_units   one row per sample: full turns, breaches (with
--                          voice_corpus attributions), judge scores. JSONB
--                          shapes are lib/schemas/regression.ts.
--
-- ADDITIVE, BUT THE DEPLOYED CODE READS IT - apply in Studio BEFORE merging
-- (the /admin/regression loader and the harness's scenario read both select
-- these tables; both degrade gracefully when the tables are missing, so the
-- order is about avoiding a banner, not an outage).
--
-- The local JSONL run log remains the harness's primary, crash-safe record
-- (run-log convention); these tables are the viewing copy, written once at
-- the end of a run. A run that dies mid-way is in the JSONL and not here,
-- which is the honest representation of "no complete result".
--
-- regression_run_units carries NO FK to voice_corpus for its attributions
-- (they live inside JSONB): attributions are observational, and a corpus row
-- deleted from /admin/voices SHOULD leave the historical breach record
-- intact - that deletion is often exactly what the breach argued for.

begin;

create table regression_scenarios (
  key text primary key
    check (key ~ '^[a-z0-9-]+$' and char_length(key) <= 64),
  lesson text not null,
  script jsonb not null,
  target jsonb not null default '[]'::jsonb,
  expect_first_name text,
  no_turn_one_name_ask boolean not null default false,
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table regression_runs (
  id uuid primary key default gen_random_uuid(),
  venue_id uuid not null references venues(id) on delete cascade,
  prompt_version text not null,
  assessor_version text not null,
  judge_version text not null,
  samples integer not null,
  git_sha text,
  pack_rows integer not null,
  -- scenario key -> verdict line, harness-computed (scenarioVerdict).
  verdicts jsonb not null default '{}'::jsonb,
  scenarios_passed integer not null,
  scenarios_total integer not null,
  -- True when the run covered every enabled scenario - only such runs certify.
  full_run boolean not null,
  started_at timestamptz not null default now(),
  finished_at timestamptz
);

create index regression_runs_recency on regression_runs (started_at desc);

create table regression_run_units (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references regression_runs(id) on delete cascade,
  scenario_key text not null,
  sample integer not null,
  unit jsonb not null,
  unique (run_id, scenario_key, sample)
);

-- Seed: the builtin set, verbatim from lib/eval/regression-scenarios.ts.
insert into regression_scenarios
  (key, lesson, script, target, expect_first_name, no_turn_one_name_ask)
values
  (
    'bare-hey',
    'Pursuit without a turn-one name ask on a thin opener. The first thing a guest ever gets is a welcome, not an intake question - and pursuit still has to land on turn 2+ (template v2.4.0, turn-one-move rounds 4-5).',
    '["hey", "haha just saw the number at the counter, figured i would text"]'::jsonb,
    '["learn_name", "understand_order"]'::jsonb,
    null,
    true
  ),
  (
    'hi-then-good',
    'The round-5 falsification case: a low-content continuation ("all good") must not stall pursuit or pull the service-desk register (turn-one-move rounds 4-5).',
    '["hi", "all good, just checking this out"]'::jsonb,
    '["learn_name", "understand_order"]'::jsonb,
    null,
    true
  ),
  (
    'claude-name',
    'A guest named "Claude" is a guest, not the assistant. The opener invites a name exchange so the bare "Claude." lands as the answer; the bar is the assessor capturing first_name, not a judged reading (template v2.5.0).',
    '["hey! new around here, figured i should introduce myself", "Claude."]'::jsonb,
    '[]'::jsonb,
    'Claude',
    false
  ),
  (
    'order-after-name',
    'The guest''s message beats the stale brief: the name arrives volunteered mid-exchange, so learn_name closes and the order becomes the live aim - no re-ask (template v2.3.0).',
    '["hey", "i''m alex btw - was in this morning actually"]'::jsonb,
    '["understand_order"]'::jsonb,
    'Alex',
    false
  ),
  (
    'compliment-turn',
    'Register on a compliment reply - the turn that caught "what should I call you?" and two-question bursts (template v2.8.0).',
    '["hey", "just had the cascara - that was something else actually"]'::jsonb,
    '[]'::jsonb,
    null,
    false
  ),
  (
    'service-desk',
    'A thin opener gets a welcome, never a service-desk opener ("how can I help" / "what can I do for you") - the v2.2.0 lesson, watched since the explicit negative was cut in v2.8.0.',
    '["hi"]'::jsonb,
    '[]'::jsonb,
    null,
    true
  );

commit;
