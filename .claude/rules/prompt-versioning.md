---
paths:
  - "lib/ai/prompts/**"
  - "lib/ai/generate-message.ts"
  - "lib/ai/classify-message.ts"
  - "lib/agent/**"
  - "lib/voices/**"
---

<!--
Scoped to the directories that own the composed prompt, NOT to `**/*.test.ts`.
That glob matched all 304 test files in the repo to reach the 52 in these
directories, so this file loaded on five reads out of six that had nothing to do
with the prompt. The cost is not tokens: a rule that shows up on every unrelated
read is a rule that gets skimmed, and injected mid-session text competes for
authority with the actual task (root CLAUDE.md, "later beats earlier").

The sweep this file describes is still repo-wide - the tests it warns about are
fixtures scattered anywhere. That is what the grep is for. The rule does not have
to be resident in every session to be followed once you are bumping the constant,
and every path that gets you there is covered above.
-->

# Bumping PROMPT_VERSION is a repo-wide sweep

`PROMPT_VERSION` lives in `lib/ai/prompts/system-template.ts`. Changing the composed prompt
means bumping it, and the bump touches files in several directories.

## Grep. Never read a list, including this one.

```
grep -rn "v1\.<old>\.<new>" --include='*.ts' --include='*.md' .
```

**`--include='*.md'` is not optional, and it was missing here until TAC-554.** Two sites live
in prose rather than code - the constants table in the root `CLAUDE.md` and the
`PROMPT_VERSION` sentence in `lib/ai/CLAUDE.md` - so a `*.ts`-only sweep cannot see either,
and this file was telling people to run exactly that. What caught them was
`scripts/lib/claude-md-claims.test.ts`, which compares both against the live constant. That
guard works; the instruction above did not.

**A carried count is worse than no count - no count makes you grep, a stale one tells you
that you already did.** The site list has grown on essentially every bump, because every new
orchestrator test adds a `promptVersion` fixture. Recorded history: 4 files, then 7, then 8,
then 9, then 12 sites in 9 files, then 14 in 13. Fixture inputs left that population on
2026-09-29 (they derive the constant now); only assertions and prose can still grow it.

**Re-run the grep after EVERY rebase**, and do not carry the earlier result forward. One
sweep found 14 sites and its re-run found 12, and the two sets were not the same. Another
re-run **grew** by two files that arrived with the commits the rebase was picking up - one of
them from a ticket that had merged into the very head commit being rebased onto. That is the
expensive direction: a carried list silently **omits** the new sites, and those are fixture
values fed to mocks, so nothing fails.

## Fixture inputs derive the constant; assertions stay literal

A `promptVersion` in a mocked result is never compared against the live constant, so a stale
one ships green - that used to be the majority of every sweep. Since 2026-09-29 fixture
INPUTS derive the live constant instead of spelling a version (11 sites across 7 files:
`stages`, `handle-inbound`, `handle-followup`, `two-pending-slots`, `coalesce-inbound`,
`holding-message-replay`, `regenerate-with-critique`). A new mock or factory imports
`PROMPT_VERSION`; it must never spell a version string. Historical literals in fixtures
(`v1.6.0`, `v1.13.0`, `v1.16.0`) are deliberate old-version shapes and are not sweep hits.

What the grep still finds, and must keep finding, is ASSERTION literals
(`expect(r.data.promptVersion).toBe('v1.7x.0')`). Those are the tripwires: they go red the
moment the constant moves, which is what makes the sweep unavoidable rather than optional.
Replacing one with the imported constant would be circular - the test would compare the
constant to itself and certify nothing (testing-discipline.md: "a test comparing a
derivation against a literal that could never differ from it").

## Two kinds of hit you must NOT change

1. **`system-template.ts`'s own changelog entry** for the old version. That is history.
2. **Comments elsewhere citing what a past version decided** (`serializers.ts`,
   `serializers.test.ts` have carried these). Also history.

A blind `sed` breaks all of them.

## The number can be taken out from under you

Three tickets bumping this one constant in a night is not a conflict to resolve by taking the
highest - they are different changes, so every changelog entry stays and your branch takes the
**next free** number. One branch renumbered twice on the way: built at v1.60.0, which another
ticket took; renumbered to v1.61.0, which a third took; landed at v1.62.0. Another tried four
numbers.

**Re-read the constant on `main` at rebase time** rather than trusting a number that was free
when the branch was cut.

## Sibling versions are independent and must not be bumped along

The verifiers and extractors each carry their own version
(`VERIFY_GROUNDING_PROMPT_VERSION`, `VERIFY_PROSE_PROMISE_PROMPT_VERSION`,
`EXTRACT_REPORTED_ORDER_PROMPT_VERSION`, and the rest). They never touch the
classify/generate contract, so bumping `PROMPT_VERSION` for a change to one of them is a
false signal - and vice versa.

## Bump means the harness baseline resets

`run-test-scenarios` grades against the composed prompt, so a diff across a bump is a
**baseline reset**, not a regression. Say so when reporting one. A change that alters what a
scenario can raise, or that makes the model hold more drafts, moves routing grades for
reasons unrelated to routing.
