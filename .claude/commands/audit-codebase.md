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
4. `db/migrations/CLAUDE.md`, cross-referenced against the `db/migrations/` directory listing.
5. The PRs merged in the last 7 days: `gh pr list --state merged --search "merged:>$(date -v-7d +%Y-%m-%d)"`. For each, check whether the PR description's documentation-routing note (per /work-ticket Phase 3 step 19) matches what actually landed.

# What to check

## Cross-file drift
- Functions or utilities that appear in 2+ places with similar logic. Grep for similar names, common patterns. Specifically check `lib/voice-training/` vs `lib/voices/`, `lib/recognition/` vs `lib/agent/`, `/admin` routes vs `/api` routes for parallel implementations.
- New Zod schemas overlapping with ones in `lib/schemas/`.
- Two patterns doing the same thing — e.g., two different error-handling styles, two different ways of reading `brand_persona`.

## CLAUDE.md staleness (entries that shouldn't exist anymore, or entries that should)
- Entries that reference files, functions, or patterns that no longer exist (renamed, deleted, moved).
- Migrations on disk whose own header does not say why they exist. There is no migration log; the numbered files are the record.
- Gotchas that have been resolved by code changes and could be removed.
- Conventions or patterns referenced in code in 3+ places that aren't documented in CLAUDE.md (promote to documented convention).
- Workarounds that no longer have a reason — e.g. `<name>-pure.ts` module splits whose original reason no longer applies. List them; do not remove them without a ticket.

## Documentation routing from past week's PRs
- For each PR merged in last 7 days, the PR description should include "Documentation routing considered: ..." per /work-ticket Phase 3 step 19. List PRs that skipped this note. List PRs that included a note but landed code that should have been written down somewhere. Check it landed in the place CLAUDE.md's "Where things are written down" table names — subsystem detail appended to the root file is itself a finding.

## Dead code
- Exports not imported anywhere (grep `^export` against import statements).
- Commented-out blocks older than 2 weeks that should be deleted.
- Files in `scripts/` that haven't been run (no recent `package.json` references, no recent commits).
- Env vars referenced in code that aren't actually set in any deployment (check `vercel.json`, `.env.example` if it exists).

## Documentation drift (descriptions that no longer match reality)
- **CLAUDE.md entries that exist but inaccurately describe current code behavior** — function signatures that changed, return types that flipped (e.g., from boolean to `{ok, data}`), file paths that got moved, parameter lists that drifted. Different from staleness above: the entry IS there, it's just wrong about what the code does now. Sample 5–10 specific claims in CLAUDE.md (function names, return values, file locations, conventions) and verify against the actual code. List discrepancies.
- README.md sections referencing outdated commands or workflows.
- Inline code comments that contradict current behavior (the code was changed, the comment wasn't).
- Type definitions in `db/types.ts` patches that should have been overwritten by `db:types` regeneration (per CLAUDE.md migration workflow).

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
- Category: drift / dead code / staleness / convention / docs
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