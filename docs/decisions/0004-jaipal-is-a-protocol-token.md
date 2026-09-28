# 0004 - `jaipal/` is a protocol token, not a personal namespace

**Date:** 2026-09-25
**Status:** accepted, with a known fix deferred

## Decision

Ticket branches are named `jaipal/<ticket>-short-description`. **Use that exact literal
whoever you are.** It reads like a username and is not one.

## Why

Five executable places match on that exact string. A branch under your own name is invisible
to all of them:

| where | what breaks |
| --- | --- |
| `scripts/lib/claims.mjs` (`isTicketBranch`, `^jaipal/<ticket>-.+$`) | **the load-bearing one** - this is how a session claims a ticket, so a differently-prefixed branch does not register and a build run will start the same ticket |
| `scripts/lib/run-report.mjs` | the same regex over `refs/heads` and `refs/remotes/origin` |
| `scripts/lib/reconcile-status.mjs` | a matching branch is what moves a ticket to In Progress |
| `.claude/commands/work-ticket.md` (`branchExists` greps `*jaipal/tac-xxx-*`) | a session would not find your branch and would create a second one for the same ticket |
| the `Bash(git checkout jaipal/:*)` permission rule | a branch under another prefix is not covered |

The first is the expensive one. Two sessions working one ticket has already happened: a build
run resumed a ticket while a local session was building it, and a human cancelling the run was
all that stopped it.

**This is genuinely ambiguous in the source and has bitten.** On 2026-09-25 a session
authenticated as a different user read the line as a template, happened to push a `jaipal/`
branch and was right by accident, then nearly "corrected" it to its own username - which would
have silently broken claim detection.

## What breaks if reversed

Changing the prefix in **one** of the five places is worse than changing it in none: claim
detection and status reconciliation disagree, so a ticket looks unclaimed to the build
selection while a local session is working it.

## The proper fix, deliberately not done

Generalise all five matchers to `^[\w.-]+/<ticket>-` so the prefix becomes a real personal
namespace. **Until someone does that in all five places at once, do not change it in one.**

## Where it lives

The five sites above. `scripts/lib/claims.test.ts` carries the real thread and branches from
the incident, including the half no check can catch.
