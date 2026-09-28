# 0001 - CLAUDE.md is an index; detail is nested and history is in git

**Date:** 2026-09-28
**Status:** accepted

## Decision

The root `CLAUDE.md` holds only what every task needs. Subsystem detail lives in a nested
`CLAUDE.md` in the directory it governs. Rules that follow a file pattern live in
`.claude/rules/*.md` with `paths` frontmatter. Reasoning for a specific decision lives in that
source file's own header. Per-ticket narrative lives in git and nowhere else.

The routing rule, which replaces the old "Keeping this file current":

| what you have | where it goes |
| --- | --- |
| a rule every task needs | root `CLAUDE.md` |
| a rule one directory needs | that directory's `CLAUDE.md` |
| a rule that follows a file pattern | `.claude/rules/` |
| why a decision was made | the source file's header |
| an incident or a measurement run | the PR body, or `docs/decisions/` if cross-cutting |
| per-ticket narrative, test-count deltas, mutation logs | nowhere - git has it |

Enforced by `scripts/lib/claude-md-budget.test.ts`.

## Why

The root file reached **1,336,095 bytes / 376,170 tokens**, loaded in full at every session
start. Three consequences, measured at `31ae45a`:

- **No subagent could run.** A spawn was rejected at 376,170 tokens against a 200k limit, so
  `.claude/agents/*`, `Explore`, and every subagent handoff in `work-ticket.md` were
  non-functional. Not a cost argument - a broken feature.
- Claude Code **skips a `CLAUDE.md` over 4 MiB entirely**. At roughly 5 KB per commit the file
  was a few hundred commits from silently not loading at all.
- A merge took both sides of one paragraph and **135,475 characters were a verbatim
  duplicate**, unnoticed because they sat on a single 362 KB line.

The cause was the old instruction to append here on every ticket, plus the absence of any
budget. Most of the removed prose already existed beside the code: `db/migrations/*.sql` carry
60 to 90-line headers, and `lib/venues/status.ts`, `lib/notifications/push-policy.ts`,
`lib/messaging/instagram/agent-gate.ts` and `lib/agent/coalesce-turn.ts` say the same things in
the same words.

Nested files were chosen over `@path` imports because imports are **eager** - the docs are
explicit that imported files load at launch, so they organise without saving anything. Nested
files load only when Claude reads a file in that directory.

## What breaks if reversed

Appending subsystem detail to root restores the per-token cost on every unrelated task and,
past 200k, breaks subagents again. Relocating deleted narrative into a new browsable tree
recreates the same growth dynamic one directory over: a history file invites appending, and
nobody reads 300 KB of it.

## Where it lives

Root `CLAUDE.md` (routing rule) · `scripts/lib/claude-md-budget.test.ts` (enforcement) ·
ten nested `CLAUDE.md` files · `.claude/rules/` · the pre-split file is
`git show 31ae45a:CLAUDE.md`.
