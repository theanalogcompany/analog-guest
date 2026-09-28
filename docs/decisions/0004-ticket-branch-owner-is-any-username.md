# 0004 - A ticket branch is `<username>/<ticket>-...`, any username

**Date:** 2026-09-28
**Status:** accepted. Supersedes the earlier rule that `jaipal/` was a protocol token to be
used verbatim by everyone.

## Decision

Name a ticket branch `<your-username>/<ticket>-short-description`, with the ticket id in
lowercase. Any single path segment works as the owner.

One definition of that pattern, in `scripts/lib/ticket-branch.mjs`:

```js
export const TICKET_BRANCH_OWNER = '[\\w.-]+';
```

`team/alex/<ticket>-x` is still not a ticket branch, and neither is a bare `<ticket>-x`: the
owner is what makes a branch attributable to a session.

## Why

It was the literal `jaipal`, which reads like a username and was not one. Three places matched
that literal, and the load-bearing one is claim detection - so **a branch under your own name
registered as nobody's claim, and a build run would start a ticket a local session already
had.** That is the 2026-09-17 incident (run 35299836324 resumed TAC-396 mid-build); a human
cancelling the run was the only thing that stopped it.

The old note told everyone to use the literal instead, and recorded the generalisation as the
proper fix, deferred until all the matchers could move together. They have now moved together.

The ambiguity was real and had already bitten: on 2026-09-25 a session authenticated as a
different user read the line as a template, happened to push a `jaipal/` branch and was right
by accident, then nearly "corrected" it to its own username - which would have silently broken
claim detection.

**The change is strictly safety-increasing.** More branches count as claims, so fewer
double-starts. The new failure mode is that an unrelated branch containing `/<ticket>-` claims
that ticket, which is the correct reading of such a branch anyway.

## What breaks if reversed

Changing the pattern back in **one** place is worse than in none: claim detection and the
turn-limit report would disagree about what a ticket branch is, so a ticket could look
unclaimed to the build selection while a session was working it.

That is why the pattern is a **leaf module** both readers import rather than a constant either
one owns. It is not in `claims.mjs` because `build-ready.yml` copies `run-report.mjs` and its
transitive imports to `$RUNNER_TEMP` before the session starts, and a test asserts the copy
list equals that closure - importing `claims.mjs` for one string would drag the whole
claim-check module into the reporter's copy. A leaf adds exactly one file. That test caught the
first attempt.

## Where it lives

| | |
| --- | --- |
| `scripts/lib/ticket-branch.mjs` | the one definition |
| `scripts/lib/claims.mjs` | `isTicketBranch`, which decides claims; `reconcile-status.mjs` imports it |
| `scripts/lib/run-report.mjs` | `readGitState`, the turn-limit report |
| `.claude/commands/work-ticket.md` | `branchExists` greps `'*/tac-xxx-*'` - a fourth copy, in prose a session reads rather than code it runs, pinned by `build-workflow.test.ts` |
| `.github/workflows/build-ready.yml` | the reporter copy step must list the leaf |

Mutation-verified: reverting the pattern to `jaipal` fails 10 tests, widening it to `.+` fails
2, and dropping the leaf from the copy step fails 2.

**A count of these sites was quoted as five for a long time and two were stale** - one
double-counted `reconcile-status.mjs`, which imports rather than matches, and one cited a
`Bash(git checkout jaipal/:*)` permission rule that TAC-471 had already removed. Re-verify
rather than trusting a number, including this one:

```
grep -rn "jaipal" --include='*.mjs' --include='*.ts' --include='*.yml' . \
  | grep -v node_modules | grep -v '\.test\.'
```
