<!-- GENERATED FILE - do not edit by hand. Run `npm run test-map` to regenerate. -->
<!-- Source: scripts/lib/test-map.ts. Enforced by scripts/lib/test-map.test.ts. -->

# The shape of the test suite

305 test files, 5942 `it`/`test` declaration sites across 26 areas.

**Declaration sites are not the test count.** 192 `.each` tables expand at runtime, so
the figure `vitest` reports is higher. Quote the run, never this number.

## To find which test covers something, do not read this file

`grep -rn "^describe(" <area> --include="*.test.ts"` lists every test file in a directory
with what it covers, generated live and scoped to the directory you care about. For a
behaviour with an obvious literal, `grep -rn "<literal>" --include="*.test.ts"` is
exhaustive by construction. Measured against a control arm, neither is beaten by an index.

This file is for the question grep cannot answer: **what is not tested anywhere.**

## Per area

The `headers` column counts files that open with a comment block saying what they pin. A
low ratio means that area explains itself poorly - budget more reading, and write a header
when you leave.

| area | files | cases | headers |
| --- | --- | --- | --- |
| `<root>` | 1 | 7 | 0/1 |
| `app/admin` | 51 | 474 | 11/51 |
| `app/api` | 26 | 271 | 20/26 |
| `lib/agent` | 42 | 1539 | 15/42 |
| `lib/ai` | 18 | 911 | 1/18 |
| `lib/analytics` | 2 | 19 | 0/2 |
| `lib/auth` | 7 | 72 | 1/7 |
| `lib/followups` | 3 | 94 | 2/3 |
| `lib/guests` | 5 | 209 | 3/5 |
| `lib/messaging` | 28 | 396 | 18/28 |
| `lib/notifications` | 7 | 122 | 2/7 |
| `lib/observability` | 1 | 23 | 0/1 |
| `lib/operator` | 11 | 231 | 8/11 |
| `lib/pos` | 12 | 70 | 4/12 |
| `lib/rag` | 1 | 12 | 0/1 |
| `lib/recognition` | 5 | 33 | 0/5 |
| `lib/schemas` | 17 | 298 | 3/17 |
| `lib/tunables` | 1 | 8 | 0/1 |
| `lib/ui` | 1 | 4 | 0/1 |
| `lib/venues` | 1 | 14 | 0/1 |
| `lib/voice-training` | 6 | 38 | 6/6 |
| `lib/voices` | 6 | 61 | 3/6 |
| `scripts` | 2 | 81 | 0/2 |
| `scripts/lib` | 16 | 436 | 0/16 |
| `scripts/measurement` | 10 | 170 | 0/10 |
| `scripts/onboarding` | 25 | 349 | 3/25 |

## What is not covered, anywhere

- **No rendered-component tests.** There is no `.test.tsx` in the repo. The Command Center
  UI is verified through its loaders and by eye, never by rendering.
- **No end-to-end tier in `vitest`.** `scripts/measurement/*` make real model calls, cost
  money, and are run by hand. `npm run run-test-scenarios` must run during a venue's open
  hours. CI runs none of them.
- **DB-touching code is generally not unit-tested**, by the convention in the root
  `CLAUDE.md`, and neither is the non-`-pure.ts` half of a module split. A source file with
  no sibling test is often deliberate; it is not a gap by itself.

Known gaps that are NOT deliberate, each confirmed by mutating the source and watching the
full suite stay green:

- `app/api/webhooks/square/route.ts` has no test. Its own header flags it high-stakes and
  payment-adjacent; the sibling `sendblue` and `instagram` routes both have large ones.
- `lib/recognition/evaluate-state.ts` and `normalize-signals.ts` have none. Changing
  `MONEY_MAX_DOLLARS` from 300 to 37, and inverting `normalizeRecency`, both pass the whole
  suite. These feed the relationship score that gates auto-send.
- `lib/auth/require-admin.ts` has none. Deleting the cross-venue span check in
  `requireKnowledgeEntriesAdmin` passes the whole suite, on a hard-stop surface.
