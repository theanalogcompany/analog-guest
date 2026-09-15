---
description: Weekly drift audit. Surfaces accumulated cross-file duplication, CLAUDE.md staleness, dead code, and convention drift that per-PR review misses.
---

You are running the weekly codebase audit for analog-guest.

# Goal

Surface drift that escapes per-PR review. The per-PR `code-reviewer` sees one diff in isolation; this audit looks across the whole repo for issues that only emerge over time — duplicated utilities sneaking in across separate PRs, abandoned helpers, CLAUDE.md going stale, gotchas that no longer apply.

This is not a per-file code review. Don't relitigate the per-PR `code-reviewer`'s job. Look for cross-cutting patterns and accumulated cruft.

# What to read

1. CLAUDE.md in full.
2. Files modified in the last 7 days: `git log --since="7 days ago" --name-only --pretty=format:"" | sort -u | grep -v "^$"`.
3. The full file tree of `lib/` and `app/` (for cross-file checks — duplicates, abandoned modules).
4. The migration log section in CLAUDE.md, cross-referenced against `db/migrations/` directory listing.
5. The PRs merged in the last 7 days: `gh pr list --state merged --search "merged:>$(date -v-7d +%Y-%m-%d)"`. For each, check whether the PR description's CLAUDE.md note (per /work-ticket Phase 3 step 13) matches what actually landed.

# What to check

## Cross-file drift
- Functions or utilities that appear in 2+ places with similar logic. Grep for similar names, common patterns. Specifically check `lib/voice-training/` vs `lib/voices/`, `lib/recognition/` vs `lib/agent/`, `/admin` routes vs `/api` routes for parallel implementations.
- New Zod schemas overlapping with ones in `lib/schemas/`.
- Two patterns doing the same thing — e.g., two different error-handling styles, two different ways of reading `brand_persona`.

## CLAUDE.md staleness (entries that shouldn't exist anymore, or entries that should)
- Entries that reference files, functions, or patterns that no longer exist (renamed, deleted, moved).
- Migration log entries missing for migrations that exist on disk.
- Migrations on disk that aren't in the migration log.
- Gotchas that have been resolved by code changes and could be removed.
- Conventions or patterns referenced in code in 3+ places that aren't documented in CLAUDE.md (promote to documented convention).
- "Module split for testability" exceptions or other workarounds — list anywhere this pattern is in use, flag if any have been resolved (e.g., the gotcha is no longer needed).

## CLAUDE.md hygiene from past week's PRs
- For each PR merged in last 7 days, the PR description should include "CLAUDE.md update considered: ..." per /work-ticket Phase 3 step 13. List PRs that skipped this note. List PRs that included a note but landed code that arguably should have prompted a CLAUDE.md update.

## Dead code
- Exports not imported anywhere (grep `^export` against import statements).
- Test files for code that no longer exists.
- Commented-out blocks older than 2 weeks that should be deleted.
- Files in `scripts/` that haven't been run (no recent `package.json` references, no recent commits).
- Env vars referenced in code that aren't actually set in any deployment (check `vercel.json`, `.env.example` if it exists).

## Documentation drift (descriptions that no longer match reality)
- **CLAUDE.md entries that exist but inaccurately describe current code behavior** — function signatures that changed, return types that flipped (e.g., from boolean to `{ok, data}`), file paths that got moved, parameter lists that drifted. Different from staleness above: the entry IS there, it's just wrong about what the code does now. Sample 5–10 specific claims in CLAUDE.md (function names, return values, file locations, conventions) and verify against the actual code. List discrepancies.
- README.md sections referencing outdated commands or workflows.
- Inline code comments that contradict current behavior (the code was changed, the comment wasn't).
- Type definitions in `db/types.ts` patches that should have been overwritten by `db:types` regeneration (per CLAUDE.md migration workflow).

## Tests and coverage
- Test count vs baseline in CLAUDE.md (currently ~580). Is it growing in proportion to functional code?
- Files with new functional code that don't have corresponding test files.
- Test files that have been around for 30+ days with 0 tests inside.

# Output

Produce a structured report in chat:

```
## Codebase audit — week of <date>

### Summary
- Files reviewed: N (modified last 7 days)
- PRs reviewed: M (merged last 7 days)
- Findings: K total (P high, Q medium, R low)
- Recommended Linear tickets: T
- CLAUDE.md edits suggested: U

### Findings

**[HIGH | MEDIUM | LOW] — one-line summary**
- Category: drift / dead code / staleness / convention / docs / tests
- Evidence: file paths with line numbers
- Proposed action: create ticket / update CLAUDE.md / delete / refactor / no action
- If creating ticket: draft title + 2-line description

(Repeat for each finding.)

### Recommended next actions
[Ranked list. Easy wins first, then high-impact items. Note effort: <30min / ~1hr / >2hr.]

### CLAUDE.md edits suggested
[Specific diffs — what to add, remove, or correct. Include both staleness fixes (missing/extra entries) and accuracy fixes (entries that exist but describe code incorrectly).]
```

# Constraints

- Don't propose changes requiring >2 hours of work unless HIGH severity.
- Don't flag stylistic preferences. Only real drift, rule violations, or genuine cruft.
- Cite specific evidence (file:line) for every finding.
- A clean audit is fine — "no significant findings" is a valid outcome on a quiet week.
- Don't propose creating tickets for cleanup items smaller than 30 minutes; just include them as a "minor cleanup batch" recommendation.
- This is a read-only command. Do not modify any files. The output is a triage list; you decide what becomes a ticket.