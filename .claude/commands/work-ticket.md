---
name: work-ticket
description: Run the autonomous ticket workflow on a Linear ticket. Plan-first, build only on explicit approval.
---

You are working on Linear ticket $ARGUMENTS for analog-guest. Each invocation is idempotent: it reads the ticket's state from Linear (and git), determines what to do, runs that work, and either exits cleanly or schedules the next invocation via `ScheduleWakeup` where a harness is available. Never instruct the operator to type `/loop`.

# State detection (run first on every invocation)

1. **Re-read ticket state.** `Linear:get_issue` for body + status, `Linear:list_comments` for the full comment thread (createdAt order). In CI there is no Linear MCP — use the GraphQL API with curl and `$LINEAR_API_KEY`.

2. **Compute.** Marker-detection convention: "body contains `[MARKER]`" means `body.includes('[MARKER]')` — substring match, NOT `startsWith`. Bot comments always begin with the `**[FROM CLAUDE CODE]**` prefix, so markers never sit at byte 0. Use `includes` uniformly across `[POLLING-STATE]`, `[POLLING-ACK]`, `[POLLING-TIMEOUT]`, `[POLLING-CLOSED]`, `[NEEDS-INPUT]`, `[NEEDS-ACTION]`, `[PLAN]`, `[HUMAN-REVIEW-REQUIRED]`.

   **Provenance comes from the prefix, never from the author ID.** Every comment on every ticket is under Jaipal's account, your own included.

   - `botComments` — comments whose body contains `**[FROM CLAUDE CODE]**`
   - `humanComments` — every other comment. A comment with no recognised prefix is human input.
   - `lastBotComment` — most recent of `botComments` (null if none). **Used for `parentId` threading and terminal-state detection only.**
   - `lastQuestionComment` — most recent bot comment whose body does NOT contain any of `[POLLING-STATE]`, `[POLLING-ACK]`, `[POLLING-TIMEOUT]`, `[POLLING-CLOSED]` (null if none). **Used for routing decisions and as the `newReplies` baseline.**
   - `newReplies` — human comments created after `(lastQuestionComment?.createdAt ?? '0')`
   - `pollingState` — most recent bot comment containing `[POLLING-STATE]`
   - `branchExists` — `git branch --list jaipal/TAC-XXX-*` non-empty

3. **Stale-session check.** Capture `invocationStartedAt` BEFORE the comment read. If `pollingState` exists AND `pollingState.updatedAt > invocationStartedAt`, another chain is active for this ticket — exit immediately, no further action, no new ScheduleWakeup.

4. **Branch table.** Terminal-state checks read `lastBotComment`. All other rows read `lastQuestionComment`.

| Condition | Action |
|---|---|
| `lastBotComment` contains `[HUMAN-REVIEW-REQUIRED]` and no human reply postdates it | Exit. No wakeup. |
| `lastBotComment` contains `[NEEDS-ACTION]` and no human reply postdates it | Exit. Blocked on Jaipal executing something. |
| `lastBotComment` contains `[POLLING-TIMEOUT]` and no human reply postdates it | Exit. No wakeup. |
| `lastBotComment` contains `[POLLING-CLOSED]` | Exit. No wakeup. Operator-driven wind-down. |
| `lastBotComment` contains a PR link (Phase 5 marker) | Exit. No wakeup. Manual merge gate. |
| `botComments.length === 0` | Fresh run. Phase 0 → Phase 2. |
| `lastQuestionComment` exists, `newReplies.length === 0`, harness available, `pollingState.iteration < 26` | Run Phase 0. Increment iteration, update `[POLLING-STATE]`, ScheduleWakeup per backoff, exit. |
| `lastQuestionComment` exists, `newReplies.length === 0`, no harness | Exit. The ticket is in Needs Ruling; the 15-minute poll resumes it when Jaipal replies. |
| `lastQuestionComment` exists, `newReplies.length === 0`, `pollingState.iteration >= 26` | Post `[POLLING-TIMEOUT]`. Exit. Leave the ticket in Needs Ruling. |
| `lastQuestionComment` exists, `newReplies.length > 0` | Run Phase 0. Classify the most recent reply (see "Reply classification"). Route accordingly. |

# Reply classification (3-way)

Take the most recent human reply and classify it:

1. **Proceed** — approves the plan or answers the question with a clear go signal ("build", "approved, proceed", or a direct answer that unblocks). Route per "Phase resumption".
2. **Modify** — carries revisions or new constraints ("looks good but change X"). Integrate, re-post the plan prefixed `[PLAN]`, leave the ticket in Needs Ruling, exit.
3. **Wind-down** — says stop without proceeding ("this works, close it", "no further scope", "smoke test passed"). Post `[POLLING-CLOSED]`, exit. Status untouched; Jaipal closes manually.

Chit-chat or holding-pattern ("let me think", "be back in an hour") is NOT substantive — post `[POLLING-ACK]`, leave the ticket where it is, exit.

When intent is ambiguous between Proceed/Modify and Wind-down, default to Proceed/Modify. A false wind-down terminates the chain; a false negative is recoverable.

# Phase resumption

When the classification is **Proceed**, route by `lastQuestionComment`:

- **`[PLAN]`** → approval received. Advance to Phase 3.
- **`[NEEDS-INPUT]` AND `branchExists === false`** → Phase 2 question answered. Re-run Phase 1 audit integrating the answer, re-post the plan, return to Needs Ruling.
- **`[NEEDS-INPUT]` AND `branchExists === true`** → Phase 3 question answered. Read `git status` and `git diff` on the branch to establish what is done and what is left, then continue.

On resuming from a ruling, remove the answered item from the ticket body's `## Open questions` block, and remove the `Needs Decision` label. Then move the ticket to where it left: **In Progress** if a branch exists, **Ready** if none does. Never move a ticket to Todo — Todo means unaudited, and this ticket has been audited and ruled on.

# Phase 0 — Verify scope (runs every invocation)
1. Re-read the ticket body and status — surfaces mid-flow edits.
2. **Status and open-questions gate.** This ticket must be in **Ready** or **In Progress**. A ticket in **Todo** has not been audited yet — say so and exit; the audit automation reaches it within fifteen minutes. If `## Open questions` has any content, it is not buildable whatever its status: move it to Needs Ruling, add `Needs Decision`, post a short comment naming the unanswered items, and exit. Do not plan. Do not branch.
3. Re-read the relevant sections of CLAUDE.md — Workflow rules, Code conventions, Common gotchas. Cite which sections you consulted on the FIRST invocation.
4. Check the "Notes for Claude Code" block. If high-stakes (auth, Stripe, Sendblue webhooks, agent runtime contract, or migrations on `messages` / `engagement_events` / `voice_corpus`), STOP. Post `[HUMAN-REVIEW-REQUIRED]` summarizing what you would be touching and the risks. Set status to Needs Ruling with `Needs Decision`. Exit.

# Phase 1 — Audit (read-only) — fresh start or post-`[NEEDS-INPUT]` Phase 2 resumption
5. Use the Explore subagent to map the affected surface area. Read at least one existing file the new code will sit next to (per the audit-first rule). Read migrations touching relevant tables. Read existing tests for modules being modified.
6. Identify existing utilities to reuse — don't reinvent. Specifically check `lib/voice-training/`, `lib/voices/`, `lib/recognition/`, `lib/agent/`, `lib/auth/`, `lib/observability/`, `lib/schemas/`, `lib/ui/` for matching patterns. Grep for any new function name you would add to confirm it does not already exist.
7. **Cross-repo audit.** If the ticket has a `## Contract` section, OR references a sibling ticket in another repo (e.g. TAC-207 ↔ TAC-288), fetch the sibling ticket and read both the Contract section and the sibling's body before writing the plan. The plan MUST cite the Contract VERBATIM wherever it touches contract surface — endpoint paths, request/response shapes, env var names and formats. Any deviation (e.g. codebase convention is singular `/api/operator/*` but the Contract drafted plural `/api/operators/*`) requires updating the ticket description FIRST during plan review — implementation never silently diverges. See CLAUDE.md "Cross-repo contracts".

# Phase 2 — Plan
8. Output a written plan: scope, file paths to touch, function decomposition, sequence of operations, existing patterns reused, edge cases, what you intentionally chose NOT to do, open questions.
9. If the Testing section is blank or partial, propose automated coverage (unit tests, E2E, API smoke). Match the qa-runner subagent's categorization rules.
10. If `## Gate` names no QA route, propose one — `QA: Script` if the gate is provable by a test or query, `QA: Device` if it needs Jaipal on a real device or at the venue. If it is currently device-only, say what would make it script-provable.
11. If the plan has open questions:
    - Post `[NEEDS-INPUT]` with questions numbered and options stated, threaded via `parentId` if a prior bot comment exists. State the options; do not recommend one.
    - Add the same numbered questions to the ticket body's `## Open questions` block.
    - Set status to **Needs Ruling** with `Needs Decision`.
    - Where a harness exists, write `[POLLING-STATE]` (iteration=1) and ScheduleWakeup(60s). In CI, exit.
12. If the plan is clear:
    - Post it prefixed `[PLAN]`, threaded via `parentId` if a prior bot comment exists.
    - Set status to **Needs Ruling** with `Needs Decision`. A plan awaiting approval is a decision Jaipal owes, and it belongs where he looks.
    - Where a harness exists, write `[POLLING-STATE]` (iteration=1) and ScheduleWakeup(60s) so a fast reply is caught. In CI, exit; the poll resumes it.

Advance to Phase 3 only on a substantive approval reply. A reply with revisions counts as substantive — integrate, re-post, return to Needs Ruling.

# Standing rulings

Pre-authorized. Decide and proceed, naming the ruling in your comment so a pre-authorized decision is distinguishable from a silent one.

- **SR-1 Contrast and accessibility figures.** WCAG arithmetic, not taste.
- **SR-2 Copy that is factually wrong about system behaviour.** Correct it. Does not extend to copy in the agent's voice.
- **SR-3 Test quality.** Mutation verification, real gate vs mock, assertion targets.

Everything else is Jaipal's. In particular: anything in the agent's voice a guest can read, anything that changes what auto-sends or when, and anything where the answer is taste rather than fact.

# Phase 3 — Build (only after explicit substantive approval)
13. **Sync local main before branching.** `git checkout main` → `git fetch origin` → `git pull origin main --ff-only`. If the fast-forward pull fails — local main has diverged — STOP. Post a Linear comment with the divergence details (`git status`, `git log origin/main..main --oneline`), set Needs Ruling with `Needs Decision`, exit. Don't auto-resolve — divergence on shared main is a bug worth flagging. (TAC-37 branched from local main at TAC-112 while origin had advanced to TAC-206: six conflict files at PR time.)
14. Create the branch if not already present: `jaipal/TAC-XXX-short-description`.
15. Implement the plan. Match existing patterns. `@/*` alias for imports. Errors as values via `RAGResult<T>` / `AIResult<T>` / `RequireAdminResult<T>` or matching alias. Zod at boundaries. No `any`. No new top-level directories without asking first.
16. If a question surfaces mid-build that wasn't in the plan, post `[NEEDS-INPUT]`, add it to `## Open questions`, set Needs Ruling with `Needs Decision`, exit. Don't guess. If it blocks only one item of a multi-item ticket, ship the unblocked items and split the blocked item into its own ticket in Needs Ruling.
17. **If something requires Jaipal to execute it** — a production migration, an env var, a third-party console change, a device step — post `[NEEDS-ACTION]`, set Needs Ruling with `Needs Action`, exit. The comment must contain, and nothing may substitute for:
    1. The exact command or SQL in a code block, runnable as-is. No placeholders, no "replace `<table>` with".
    2. Where it runs — which database, which environment, which shell.
    3. The rollback in its own code block, runnable as-is. If you cannot write one, say so explicitly rather than omitting it.
    4. One line: what should be true afterward, checkable in one query or one glance.

    When Jaipal confirms it ran, verify against the live schema — `pg_get_functiondef`, live table inspection — not against the migration file and not against his confirmation.
18. **If you find a defect outside this ticket's scope**, post `[FINDING]` describing it. Do not file a ticket, do not fix it, do not widen scope. Maximum three per ticket; list any remainder as one-liners under a "not detailed" heading.
19. **CLAUDE.md hygiene check.** Before exiting Build, evaluate whether this change introduces anything belonging in CLAUDE.md per the "Keeping this file current" rule: new scripts in `package.json`, new migrations (with migration log entry), new library patterns or conventions, gotchas discovered during implementation, new directories, new env vars, new workflow rules, version bumps to documented dependencies. If yes, update CLAUDE.md in the same commit as the code change. If no, note in the PR description: *"CLAUDE.md update considered: [what you checked, why no update needed]."* If that line is not in the PR description by Phase 5, the task is incomplete.

**Env-var validators.** If this change introduces a new required env var, include a startup validator in the SAME PR. For credential env vars (PEM keys, JWT secrets, signed-payload secrets), parse the value once at module init — not lazily on first use — so a malformed paste crashes at deploy time, not 9 hours later on first call. See CLAUDE.md "Environment variables" → boot-time validation.

# Phase 4 — Verify
20. `npx tsc --noEmit` — must pass.
21. `npm run lint` — must pass.
22. `npx vitest run` — all tests must pass. Report count delta vs main.
23. If the diff touches `app/admin/**` or any browser surface, invoke the `qa-runner` subagent.
24. Invoke the `code-reviewer` subagent on the diff. Address BLOCKER and MAJOR findings; explain skips on MINOR.

# Phase 5 — Ship
25. Commit. Subject: `TAC-XXX: <imperative lowercase subject>`. Body explains why if non-obvious.
26. `gh pr create`. Title matches commit subject. Body: changes + test count delta + plan deviations + the CLAUDE.md note + anything you would push back on.
27. Post a Linear comment with the PR link (threaded via `parentId`). Apply the QA route label (`QA: Script` or `QA: Device`) if not already set. **Do not set the status to Ready For QA by hand** — opening the PR moves the ticket to In Review automatically, and merging moves it to Ready For QA automatically.
28. Set the ticket to **Needs Ruling** with the `Needs Action` label: the merge is Jaipal's to run. Then exit. He runs `gh pr merge --squash --delete-branch` after reviewing the PR on GitHub, and the merge automation moves the ticket to Ready For QA.

**Cross-repo UAT gate.** If the Phase 1 cross-repo audit flagged a sibling ticket, the PR description MUST explicitly call out: *"Cross-repo UAT REQUIRED before Done — unit tests passing on both sides does not prove the contract is consistent."* Without manual end-to-end UAT confirming the cross-repo behavior, the ticket stays in Ready For QA. The 2026-05-27 TAC-207 incident (server tests green, client tests green, integration broken on first push 9 hours after deploy) is the documented case.

# Polling protocol

Where a harness is available, ScheduleWakeup the next invocation after posting a comment that requires a human response. Exceptions that exit immediately: `[HUMAN-REVIEW-REQUIRED]`, `[NEEDS-ACTION]`, `[POLLING-CLOSED]`, `[POLLING-TIMEOUT]`, and PR-link comments at Phase 5.

**In CI there is no harness.** Do not attempt ScheduleWakeup. Move the ticket to Needs Ruling and exit; the 15-minute poll is the resume mechanism.

`[NEEDS-ACTION]` never polls even with a harness. The blocking step is Jaipal at a laptop running something, not answering a question from his phone.

## Backoff

Intervals (seconds): 60, 120, 240, 300, 300, ... cap at 300. `TIMEOUT_LIMIT = 26` iterations, ≈ 2 hours (60 + 120 + 240 + 23 × 300 ≈ 7320s). At the limit, post `[POLLING-TIMEOUT]` and exit, leaving the ticket in Needs Ruling.

## `[POLLING-STATE]` comment (single, edited in place)

One per session. Capture its id from the create response; later updates edit that comment.

```
**[FROM CLAUDE CODE]**

[POLLING-STATE] iteration=N nextWakeupAt=<ISO timestamp> sessionStartedAt=<ISO timestamp>
```

Reset iteration to 1 whenever any reply lands. Its `updatedAt` is also the staleness signal: if at the start of an invocation `pollingState.updatedAt > invocationStartedAt`, another chain is active and this one exits.

## `[POLLING-ACK]` comment

Threaded under the operator's holding-pattern reply, not under `lastBotComment`:

```
**[FROM CLAUDE CODE]**

[POLLING-ACK] Got it — still polling for your answer.
```

Then update `[POLLING-STATE]` (iteration 1) and ScheduleWakeup(60s).

## `[POLLING-TIMEOUT]` comment

```
**[FROM CLAUDE CODE]**

[POLLING-TIMEOUT] Exhausted automated polling after 2 hours. Reply when ready — the poll will pick this back up.
```

## `[POLLING-CLOSED]` comment

Threaded under the operator's wind-down reply:

```
**[FROM CLAUDE CODE]**

[POLLING-CLOSED] Acknowledged — exiting per operator's wind-down reply.
```

Status untouched. The agent never sets a ticket to Done; the permission hook denies that and that's intentional.

## Comment threading

Default `parentId = lastBotComment.id` (or omitted if no prior bot comment). Exception: `[POLLING-CLOSED]` and `[POLLING-ACK]` thread under the operator's triggering reply, so bookkeeping markers don't parent to other bookkeeping markers. Polling logic does not depend on `parentId`, so threading failures are cosmetic — log and continue.

# Hard rules (non-negotiable)
- Plan gate (Phase 2 → 3) requires explicit substantive approval. Do not advance on silence or on a non-substantive reply. The substantive-answer judgment IS the gate.
- **Provenance is the prefix, never the author ID.** Every comment shares one author. A comment with no `**[FROM CLAUDE CODE]**` prefix is human input.
- ScheduleWakeup is the only polling primitive where a harness exists — no `Bash sleep`, no until-loops chaining short sleeps. In CI, don't poll at all.
- No auto-merge. The merge gate stays manual.
- **Build only from Ready or In Progress.** Todo means committed but not yet audited.
- **Never promote a ticket to Ready.** Only an audit that found nothing, or a ruling from Jaipal, puts a ticket there. Never move anything to Todo at all.
- **Anything that needs Jaipal moves the ticket to Needs Ruling immediately**, with the right `Blocked On` label. Never wait silently on a ticket whose status still claims it is available. A plan awaiting approval counts.
- **Never run a production migration.** Write the SQL and hand it over via `[NEEDS-ACTION]`.
- No loyalty-program language anywhere — points, rewards, tier, earn, badges, progress bars are forbidden. Guests are recognized, not enrolled.
- High-stakes uncertainty → `[HUMAN-REVIEW-REQUIRED]`, never `[NEEDS-INPUT]`.
- Wind-down is operator-driven. The agent never decides to wind down on its own.
- The agent never marks a ticket Done. In Review and Ready For QA are set by Linear's PR automations, not by you.
- CLAUDE.md hygiene is mandatory in every Build phase. Skipping = drift, drift = future pain.
- **Cross-repo tickets** MUST cite the `## Contract` section verbatim in the plan and ship server-first with curl-verified deployment before the sibling client work starts. Manual end-to-end UAT is a Done-gate; unit-test pass on both sides is not sufficient.
- New required env vars MUST ship in the same PR as a startup validator that crashes loudly at module init. Credential env vars MUST be parsed once at boot, not lazily on first use.