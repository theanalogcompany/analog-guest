---
name: work-ticket
description: Run the autonomous ticket workflow on a Linear ticket. Plan-first, build only on explicit approval.
---

You are working on Linear ticket $ARGUMENTS for analog-guest. The operator types `/work-ticket TAC-XXX` exactly once. Each invocation is idempotent: it reads the ticket's state from Linear (and git), determines what to do, runs that work, and either exits cleanly or schedules the next invocation via `ScheduleWakeup`. Never instruct the operator to type `/loop`.

# State detection (run first on every invocation)

1. **Re-read ticket state.** `Linear:get_issue` for body + status, `Linear:list_comments` for the full comment thread (createdAt order). Cache `botAuthorId` from any prior bot comment, or from your own `save_comment` response on first post.

2. **Compute.** Marker-detection convention: throughout this spec, "body contains `[MARKER]`" means `body.includes('[MARKER]')` — substring match, NOT `startsWith`. Bot comments always begin with the `**[FROM CLAUDE CODE]**` prefix (per CLAUDE.md Comment protocol), so markers never sit at byte 0. Use `includes` uniformly across `[POLLING-STATE]`, `[POLLING-ACK]`, `[POLLING-TIMEOUT]`, `[POLLING-CLOSED]`, `[NEEDS-INPUT]`, `[HUMAN-REVIEW-REQUIRED]`.
   - `botComments` — comments where `author.id === botAuthorId`
   - `lastBotComment` — most recent of `botComments` (null if none). **Used for `parentId` threading default and terminal-state detection only.**
   - `lastQuestionComment` — most recent bot comment whose body does NOT contain any of `[POLLING-STATE]`, `[POLLING-ACK]`, `[POLLING-TIMEOUT]`, or `[POLLING-CLOSED]` (null if none). **Used for routing decisions and as the `newReplies` baseline.** Excluding bookkeeping markers ensures phase resumption sees the actual question or plan post, not a `[POLLING-STATE]` writeback.
   - `newReplies` — comments where `author.id !== botAuthorId AND createdAt > (lastQuestionComment?.createdAt ?? '0')`
   - `pollingState` — most recent bot comment whose body contains `[POLLING-STATE]` (carries the iteration counter, see "Polling protocol")
   - `branchExists` — `git branch --list jaipal/TAC-XXX-*` non-empty

3. **Stale-session check.** Capture `invocationStartedAt = new Date().toISOString()` at the top of the invocation, BEFORE the `list_comments` call. If `pollingState` exists AND `pollingState.updatedAt > invocationStartedAt`, another `/work-ticket` chain is active for the same ticket — exit immediately with no further action and no new ScheduleWakeup. (Manual re-invocation may "miss" iterations because of this; that's intentional, see the CLAUDE.md note.)

4. **Branch table.** Terminal-state checks read `lastBotComment` (terminal markers should halt the chain regardless of what came before). All other rows read `lastQuestionComment` so bookkeeping markers don't confuse routing.

| Condition | Action |
|---|---|
| `lastBotComment` body contains `[HUMAN-REVIEW-REQUIRED]` | Exit. No wakeup. |
| `lastBotComment` body contains `[POLLING-TIMEOUT]` | Exit. No wakeup. |
| `lastBotComment` body contains `[POLLING-CLOSED]` | Exit. No wakeup. Operator-driven wind-down. |
| `lastBotComment` body contains a PR link (Phase 5 step 22 marker) | Exit. No wakeup. Manual merge gate. |
| `botComments.length === 0` | Fresh run. Run Phase 0 → Phase 2. Post plan or `[NEEDS-INPUT]` or `[HUMAN-REVIEW-REQUIRED]`. If polling-eligible: write `[POLLING-STATE]` (iteration=1), ScheduleWakeup(60s), exit. If `[HUMAN-REVIEW-REQUIRED]`: exit, no wakeup. |
| `lastQuestionComment` exists, `newReplies.length === 0`, `pollingState.iteration < 26` | Run Phase 0 (re-verify scope). If still safe: increment iteration, update `[POLLING-STATE]` in place, ScheduleWakeup(nextInterval per backoff), exit. |
| `lastQuestionComment` exists, `newReplies.length === 0`, `pollingState.iteration >= 26` | Post `[POLLING-TIMEOUT]`. Exit. No wakeup. |
| `lastQuestionComment` exists, `newReplies.length > 0` | Run Phase 0. Take most recent reply and apply the 3-way classification (see "Reply classification"). Route accordingly. |

# Reply classification (3-way)

When `newReplies.length > 0`, take the most recent reply and apply LLM judgment to classify it into one of three categories:

1. **Proceed** — substantive answer that approves the plan or answers the question with a clear "go" signal (e.g., "build", "approved, proceed", "yes go ahead", or a direct answer to a `[NEEDS-INPUT]` question that unblocks the next phase). Route per "Phase resumption" below.
2. **Modify** — substantive answer carrying revisions, additions, or new constraints to the plan or design (e.g., "looks good but change X", "add a step for Y", "use this pattern instead"). Integrate the revisions, re-post the updated plan, return to polling: write `[POLLING-STATE]` iteration=1, ScheduleWakeup(60s), exit.
3. **Wind-down** — substantive answer indicating the work should stop without proceeding (e.g., "this works, close it", "no further scope", "smoke test passed", "we're done", "exit cleanly"). Post `[POLLING-CLOSED]` per the template in "Polling protocol", do NOT call ScheduleWakeup, exit cleanly. Status is left untouched — operator closes manually.

If the reply is **chit-chat or holding-pattern** ("let me think", "be back in an hour"), it is NOT a substantive reply — post `[POLLING-ACK]`, reset iteration to 1 in `[POLLING-STATE]`, ScheduleWakeup(60s), exit.

Bias guidance: when intent is genuinely ambiguous between Proceed/Modify and Wind-down, default to Proceed/Modify — Wind-down is the rarer signal and a false positive prematurely terminates the chain. Wind-down false negatives are recoverable (the operator replies again with clearer wind-down language).

# Phase resumption

When the 3-way classification is **Proceed**, route by `lastQuestionComment`:

- **Plain plan post (no tag prefix)** → approval received. Advance to Phase 3.
- **`[NEEDS-INPUT]` AND `branchExists === false`** → Phase 2 question answered. Re-run Phase 1 audit (cheap, read-only) integrating the answer, re-post plan, return to polling.
- **`[NEEDS-INPUT]` AND `branchExists === true`** → Phase 3 question answered. Resume build by reading `git status` + `git diff` on the branch to identify what's done vs what's left, then continue from there.

# Phase 0 — Verify scope (runs every invocation)
1. `Linear:get_issue` for the ticket. Re-read body + status — surfaces mid-flow edits (e.g., scope changes, "actually this is high-stakes now").
2. Re-read the relevant sections of CLAUDE.md — Workflow rules, Code conventions, Common gotchas. Cite which sections you consulted on the FIRST invocation; subsequent wakeup invocations may skip the citation to save context.
3. Check the "Notes for Claude Code" block in the ticket body. If high-stakes (auth, Stripe, Sendblue webhooks, agent runtime contract, or migrations on messages/engagement_events/voice_corpus), STOP. Post a `[HUMAN-REVIEW-REQUIRED]` Linear comment summarizing what you'd be touching and what the risks are. Exit immediately. No ScheduleWakeup.

# Phase 1 — Audit (read-only) — runs only on fresh start or post-`[NEEDS-INPUT]` Phase 2 resumption
4. Use the Explore subagent to map the affected surface area. Read at least one existing file the new code will sit next to (per the audit-first rule). Read migrations touching relevant tables. Read existing tests for modules being modified.
5. Identify existing utilities to reuse — don't reinvent. Specifically check `lib/voice-training/`, `lib/voices/`, `lib/recognition/`, `lib/agent/`, `lib/auth/`, `lib/observability/`, `lib/schemas/`, `lib/ui/` for patterns that match. Run grep for any new function name you'd add to confirm it doesn't already exist.

**Cross-repo audit.** If the ticket body has a `## Contract` section, OR references a sibling ticket in another repo (e.g., TAC-207 ↔ TAC-288), fetch the sibling ticket via Linear and read both the Contract section and the sibling's body before writing the plan. The plan in Phase 2 must cite the Contract VERBATIM wherever it touches contract surface — endpoint paths, request/response shapes, env var names + formats. Any deviation from the Contract (e.g., codebase convention is singular `/api/operator/*` but the Contract drafted plural `/api/operators/*`) requires updating the ticket description FIRST during plan-review — implementation never silently diverges. See CLAUDE.md "Cross-repo contracts."

# Phase 2 — Plan
6. Output a written plan covering: scope, file paths to touch, function decomposition, sequence of operations, existing patterns being reused, edge cases, what you intentionally chose NOT to do, open questions.
7. If the ticket's Testing section is blank or partial, propose automated coverage (unit tests, E2E, API smoke) as part of the plan. Match the categorization rules in the qa-runner subagent.
8. If the plan has open questions:
   - Post a `[NEEDS-INPUT]` Linear comment with questions numbered, threaded via `parentId = lastBotComment.id` if a prior bot comment exists.
   - Set ticket status to "Awaiting Input."
   - Write a `[POLLING-STATE]` comment (iteration=1), ScheduleWakeup(60s), exit.
9. If the plan is clear:
   - Post the plan as a Linear comment (no tag prefix), threaded via `parentId` if a prior bot comment exists.
   - Write a `[POLLING-STATE]` comment (iteration=1), ScheduleWakeup(60s), exit.

The implicit question on the plan post is "does this plan look right?" Advance to Phase 3 only on a substantive approval reply ("build", "approved, proceed", or equivalent). A reply with revisions counts as substantive — integrate, re-post the plan, return to polling.

# Phase 3 — Build (only after explicit substantive approval)
10. **Sync local main before branching.** `git checkout main` → `git fetch origin` → `git pull origin main --ff-only`. If the fast-forward pull fails (local main has diverged from origin), STOP. Post a Linear comment with the divergence details (`git status`, `git log origin/main..main --oneline`), exit with no ScheduleWakeup, and let the operator resolve before re-running `/work-ticket TAC-XXX`. Don't auto-resolve — divergence on shared main is a bug worth flagging. Surfacing case: TAC-37 branched from local main at TAC-112 while origin had advanced to TAC-206, six conflict files at PR time.
11. Create the branch if not already present: `jaipal/TAC-XXX-short-description`.
12. Implement the plan. Match existing patterns. `@/*` alias for imports. Errors as values via `RAGResult<T>` / `AIResult<T>` / `RequireAdminResult<T>` or matching alias. Zod at boundaries. No `any`. No new top-level directories without asking first.
13. If a question surfaces mid-build that wasn't in the plan, post `[NEEDS-INPUT]` (threaded), update `[POLLING-STATE]`, ScheduleWakeup(60s), exit. Don't guess.
14. **CLAUDE.md hygiene check.** Before exiting Build, evaluate whether this change introduces anything that should be in CLAUDE.md per the "Keeping this file current" rule. Specifically check for: new scripts in `package.json`, new migrations (with migration log entry), new library patterns or conventions, gotchas discovered during implementation, new directories, new env vars, new workflow rules, or version bumps to documented dependencies. If yes, update CLAUDE.md in the same commit as the code change. If no, note in the PR description: *"CLAUDE.md update considered: [what you checked, why no update needed]."* If you have not written a "CLAUDE.md update considered: …" line in the PR description by the time Phase 5 step 21 runs, the task is incomplete — go back and add it before opening the PR.

**Env-var validators.** If this change introduces a new required env var, include a startup validator in the SAME PR. Don't ship the env var without the validator. For credential env vars (PEM keys, JWT secrets, signed-payload secrets), parse the value once at module init — not lazily on first use — so a malformed paste crashes at deploy time, not 9 hours later on first call. See CLAUDE.md "Environment variables" → boot-time validation.

# Phase 4 — Verify
15. `npx tsc --noEmit` — must pass.
16. `npm run lint` — must pass.
17. `npx vitest run` — all tests must pass. Report count delta vs main.
18. If the diff touches `app/admin/**` or any browser surface, invoke the `qa-runner` subagent.
19. Invoke the `code-reviewer` subagent on the diff. Address BLOCKER and MAJOR findings; explain skips on MINOR.

# Phase 5 — Ship
20. Commit. Subject: `TAC-XXX: <imperative lowercase subject>`. Body explains why if non-obvious.
21. `gh pr create`. Title matches commit subject. Body summarizes changes + test count delta + any plan deviations + CLAUDE.md note (per Phase 3 step 14) + anything you'd push back on.
22. Post a Linear comment with the PR link (threaded via `parentId`). Move ticket status to "Ready for QA."
23. Exit. No ScheduleWakeup. Manual merge gate — operator runs `gh pr merge --squash --delete-branch` after reviewing the PR on GitHub.

**Cross-repo UAT gate.** If the Phase 1 cross-repo audit flagged a sibling ticket, the PR description MUST explicitly call out: *"Cross-repo UAT REQUIRED before Done — unit tests passing on both sides does not prove the contract is consistent."* Without manual end-to-end UAT confirming the cross-repo behavior, the ticket stays in "Ready for QA" — the operator runs UAT against the deployed sibling client before moving to Done. The 2026-05-27 TAC-207 incident (server tests green, client tests green, integration broken on first push 9 hours after deploy) is the documented case.

# Polling protocol

After posting any comment that requires a human response, ScheduleWakeup the next invocation rather than exiting permanently. Exceptions that exit immediately with no wakeup: `[HUMAN-REVIEW-REQUIRED]`, `[POLLING-CLOSED]`, `[POLLING-TIMEOUT]`, and PR-link comments at Phase 5.

## Backoff

Iteration intervals (seconds): 60, 120, 240, 300, 300, 300, ... cap at 300.

`TIMEOUT_LIMIT = 26` iterations, ≈ 2 hours cumulative (60 + 120 + 240 + 23 × 300 ≈ 7320s).

When iteration reaches `TIMEOUT_LIMIT`, post `[POLLING-TIMEOUT]` and exit.

## `[POLLING-STATE]` comment (single, edited in place)

One per `/work-ticket` session. On first post, capture `pollingState.id` from the `save_comment` response. Subsequent updates use `save_comment` with `id` set to that ID — same comment, edited body. Body shape:

```
**[FROM CLAUDE CODE]**

[POLLING-STATE] iteration=N nextWakeupAt=<ISO timestamp> sessionStartedAt=<ISO timestamp>
```

Reset iteration to 1 whenever a substantive or holding-pattern reply lands (the backoff restarts after every operator interaction).

The `updatedAt` on this comment is also the staleness signal: if at the start of an invocation `pollingState.updatedAt > invocationStartedAt`, another chain is active and this one exits.

## `[POLLING-ACK]` comment (one per holding-pattern reply)

Body, posted via `save_comment` with `parentId` set to the ID of the operator's holding-pattern reply (the comment that triggered this ack — NOT `lastBotComment.id`, since bookkeeping markers shouldn't parent to other bookkeeping markers):

```
**[FROM CLAUDE CODE]**

[POLLING-ACK] Got it — still polling for your answer.
```

After posting, update `[POLLING-STATE]` (reset iteration to 1) and ScheduleWakeup(60s).

## `[POLLING-TIMEOUT]` comment

Body:

```
**[FROM CLAUDE CODE]**

[POLLING-TIMEOUT] Exhausted automated polling after 2 hours. Reply when ready and re-run /work-ticket TAC-XXX.
```

Posted, then exit. No further wakeups.

## `[POLLING-CLOSED]` comment (one per wind-down)

Posted when a substantive reply is classified as **Wind-down** per "Reply classification" above. Body, posted via `save_comment` with `parentId` set to the ID of the operator's wind-down reply (the comment that triggered the classification — NOT `lastBotComment.id`, since the closure should visually attach to the message that caused it):

```
**[FROM CLAUDE CODE]**

[POLLING-CLOSED] Acknowledged — exiting per operator's wind-down reply.
```

Posted, then exit. No further wakeups. Status is left untouched — the agent never sets a ticket to Done; the permission hook denies that and that's intentional. Operator closes the ticket manually.

## ScheduleWakeup parameters

- `delaySeconds`: per backoff schedule (60, 120, 240, 300, ...). Harness clamps to [60, 3600].
- `reason`: short, specific. e.g. `"polling TAC-XXX iteration N for plan-approval reply"`.
- `prompt`: literal string `/work-ticket TAC-XXX` (substituting the actual ticket ID). The harness re-fires this as the next turn's input. The state machine handles the re-invocation idempotently — no `/loop` wrapper needed and the operator never sees one.

## Comment threading

Default: every bot comment posts with `parentId = lastBotComment.id` (or omitted if no prior bot comment). Exception: `[POLLING-CLOSED]` and `[POLLING-ACK]` thread under the operator's triggering reply (`parentId` = the ID of the most recent operator reply that caused the action), so bookkeeping markers don't parent to other bookkeeping markers and the visual attachment matches causation. Polling logic does not depend on `parentId` (the MCP doesn't expose it on read), so threading failures are cosmetic only — log and continue.

# Hard rules (non-negotiable)
- Plan gate (Phase 2 → 3) requires explicit substantive approval, delivered as a Linear reply caught by the polling loop. Do not advance on silence or on a non-substantive reply (chit-chat, holding-pattern). The substantive-answer judgment IS the gate.
- The operator types `/work-ticket TAC-XXX` exactly once. Never instruct them to type `/loop`. Subsequent invocations come from the harness re-firing on ScheduleWakeup.
- ScheduleWakeup is the only polling primitive — no `Bash sleep`, no until-loops chaining short sleeps. The harness blocks those.
- No auto-merge (Phase 5 step 23). Manual merge gate stays manual; no wakeup after the PR-link comment.
- No loyalty-program language anywhere — points, rewards, tier, earn, badges, progress bars are forbidden. Guests are recognized, not enrolled.
- High-stakes uncertainty → `[HUMAN-REVIEW-REQUIRED]`, never `[NEEDS-INPUT]`. Exits immediately, no wakeup.
- Wind-down is operator-driven. The agent never decides to wind down on its own — the substantive reply must indicate stopping. The 3-way classification (Proceed / Modify / Wind-down) is the only path to `[POLLING-CLOSED]`.
- The agent never auto-closes the ticket. Status is set automatically only at Phase 5 step 22 (PR ship → "Ready for QA"). Wind-down, timeout, and human-review exits leave status untouched — operators close manually. The permission hook enforces this.
- CLAUDE.md hygiene is mandatory in every Build phase. Skipping = drift, drift = future pain.
- Cross-repo tickets MUST cite the `## Contract` section verbatim in the plan and ship server-first with curl-verified deployment before the sibling client work starts. Manual end-to-end UAT is a Done-gate; unit-test pass on both sides is not sufficient. See CLAUDE.md "Cross-repo contracts."
- New required env vars MUST ship in the same PR as a startup validator that crashes loudly at module init. Credential env vars (PEM keys, JWT secrets) MUST be parsed once at boot, not lazily on first use. See CLAUDE.md "Environment variables" → boot-time validation.
