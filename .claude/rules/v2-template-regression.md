---
paths:
  - "lib/ai/v2/**"
  - "lib/relationship/default-graph.ts"
---

# A V2_PROMPT_VERSION bump ships with a regression run

**THE HARNESS CURRENTLY JUDGES NOTHING.** `OWNER_JUDGES_ANSWERS` in
`scripts/measurement/template-regression.ts` is `true` (owner-ruled 2026-10-09), so a run
generates and prints every reply, counts the text tells, prints the gate verdicts, and
emits **no** PASS/FAIL and no "N/M passed".
`regression_runs.verdicts` records `NOT JUDGED` rather than a verdict nobody computed - a
green row on `/admin/regression` for an unjudged run would be a false green.

The bars are **not** deleted: they stay in `REGRESSION_SCENARIOS`, and flipping that one
constant restores all of them. That is why it is a switch and not an edit. Read the rest of
this file as what applies when it goes back to `false`.

**What this costs, so nobody rediscovers it:** nothing automated catches a regression now.
The `Use emojis sparingly` arm produced 83 emoji across 11 of 13 scenarios and was caught by
these bars in a single run. While the switch is on, that class of defect reaches a person
only if a person reads every body. A disqualified sample still fails the run, because "the
harness did not work" is not a judgment about an answer.

Every measured lesson in `lib/ai/v2/template.ts`'s changelog exists as a scenario in
`REGRESSION_SCENARIOS` in `lib/eval/regression-scenarios.ts`.
The comments are the record; the harness is the enforcement.
A template or seed-graph copy change that bumps `V2_PROMPT_VERSION` is not done until:

1. `npm run measure-template-regression` has run on the new version.
   n=3 is the default, owner-ruled 2026-10-09: generation is at temperature 0, so a
   single-turn reply barely moves.
   **A multi-turn scenario still moves, and the ruling does not change that** - the assessor
   runs at 0.2 and each turn's brief is built from the last turn's assessment, so the variance
   compounds. Two n=6 runs over a byte-identical prompt disagreed on `bare-hey` and
   `hi-then-good`, both crossing the 2-of-N pursuit bar in opposite directions (2026-10-09).
   Use `--samples=6` when a verdict has to hold, and say which n produced any number you
   report. Round 5 of turn-one-move was falsified at n=3, back when generation ran at the
   provider default.
2. The numbers - scenario verdicts, breaches with attributions, judge-axis means - are in
   the PR body. The run log path alone is not a report.
3. Any CEILING breach is either fixed or explicitly ruled on by the owner in the PR.
   A breach attributed to a `voice_corpus` row is a data decision (the row's page is
   linked in the breach line), not a wording arm - do not chase it with template copy.

## When the template gains a measured lesson, the harness gains a scenario

A new changelog entry citing a measurement belongs in `REGRESSION_SCENARIOS`
(`lib/eval/regression-scenarios.ts`) in the same PR - scenario key, script, and which bar or
ceiling encodes the lesson.
A lesson that lives only as a comment is one rewrite away from silently undone.

**Adding a scenario is a code edit and nothing else.** No migration, no Studio apply, no row
to insert: the array is the source of truth and the harness reads it directly (decision 0011).
The `regression_scenarios` table carries only the `enabled` flag, for silencing a case from
`/admin/regression` without a deploy.
It was the other way round until migration 077, and a scenario added in code alone was inert
and silently so - that cost two false greens in two days.

## What this harness is not

- Not CI. It spends real model calls; it runs from an operator shell, never a workflow.
- Not a judge gate. Judge axes print as directional means (plus `--compare` deltas);
  until the phase-4 calibration set lands, a score shift is a prompt to read bodies,
  never an automatic verdict.
- Not for v1. `PROMPT_VERSION` has its own sweep rule (`prompt-versioning.md`).
