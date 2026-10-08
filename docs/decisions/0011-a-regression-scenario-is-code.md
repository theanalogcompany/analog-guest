# 0011 - A regression scenario is code; the table carries only its enabled flag

**Date:** 2026-10-08
**Status:** accepted

## Decision

`REGRESSION_SCENARIOS` in `lib/eval/regression-scenarios.ts` is the source of truth for every
template-regression scenario: its script, its bars, its ceilings, its lesson.
Adding a test case is an edit to that array, reviewed in the PR that changes the template, with no migration and no SQL.

The `regression_scenarios` table is an overlay carrying one field, `enabled`, so a case can be silenced from `/admin/regression` without a deploy.
Nothing else about a row is read.
`resolveScenarios` is the only place the two are merged; the harness and the admin loader both call it.

There is no way to create a scenario from the admin surface.
An overlay row whose key is in no code definition is an orphan: the page renders it as such, and the harness does not run it.

## Why

It was the other way round until migration 077.
The table held definitions, the code array was a seed plus an all-or-nothing fallback, and the consequences were two separate failures.

The one people felt: every new test case cost a hand-applied Studio insert, because a row was the only thing that reached production and a numbered migration is this repo's only reviewable channel for writing one.
Migrations 070, 071 and 072 are each one test case.

The one that actually cost something: a scenario added to the code array alone was **inert, and silently**.
The fallback fires when the table is unreadable or empty, never when it is merely incomplete, so a table missing half the guards looks exactly like a healthy one.
That produced two false greens in two days.
A 2026-10-05 run printed `6/6 scenarios passed` while covering six of eleven cases, and the scenario encoding the very fix it was certifying was not among them (071's header).
A 2026-10-06 run printed `10/11 scenarios passed` while the agent could not answer "what is a good first order?" at all (072's header).

Both are the same shape: the set that ran was not the set anyone had read.
Putting definitions in code makes that divergence impossible rather than merely discouraged, because there is no second copy to drift.

This is a carve-out from [0009](0009-relationship-engine-v2.md), which makes behaviour three versioned data artifacts.
A test case is not behaviour; it is the thing that checks behaviour, and it has to be reviewable in the same diff as the change it guards.
A guard that can be edited without review is not a guard.

## What breaks if reversed

Scenario definitions back in the table means the add-a-case-costs-a-migration treadmill returns, and - worse - the silent-inert failure returns with it.
Any future design that lets a scenario exist in the database and not in git reintroduces exactly the two false greens above.

Keeping `enabled` in the table is deliberate and is not the same hazard: a wrongly-flagged scenario either runs when it should not, which prints a visible failure, or is skipped, which the page states and the harness warns about.
Neither can quietly shrink the set without saying so.

## Where it lives

- `lib/eval/regression-scenarios.ts` - the array, `resolveScenarios`, `validateScenarioSet`, `scenarioVerdict`
- `scripts/measurement/template-regression.ts` - the harness; validates the code set, then overlays
- `app/admin/(authed)/regression/` - the page, its loader, and the one write route (PATCH/DELETE on the overlay)
- `db/migrations/077_regression_scenarios_are_an_overlay.sql` - the inversion, with the prod verification that made it safe
- `.claude/rules/v2-template-regression.md` - the rule that a new measured lesson ships with a new scenario
