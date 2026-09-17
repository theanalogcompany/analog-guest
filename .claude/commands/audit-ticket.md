---
name: audit-ticket
description: Read-only audit of a Linear ticket. Verifies claims against the code, produces questions, writes no code.
---

Audit Linear ticket $ARGUMENTS.

This is an audit. Do not plan, do not branch, do not write code, do not edit
the ticket's description except for the `## Open questions` block as directed
below.

**An audit never changes the state of what it is auditing.** No cancels, no
reruns, no dispatches, and no writes to the repo or to GitHub. Its writes
are the Linear ones this file lists: the `[AUDIT]` comment, and the status,
label and `## Open questions` changes under "After posting". If the ticket describes something
broken, describing it is the whole job. That holds when the claim is about
what a command does: verify it from what can be read, and if nothing
readable settles it, say so. Never run the command to see what happens.

# Check the repo

Work out which repo works this ticket, by the rule under "Which repo works a
ticket" in `.claude/process.md`:

- If its **Repo:** line names at least one repo the ticket is labelled for,
  the first such repo.
- If it has no Repo: line and one repo label, that repo.

If that is a repo other than the one you are running in, stop and say which
repo to run in. Do not audit across a repo boundary.

If the ticket has two repo labels and no Repo: line, a Repo: line naming no
repo it is labelled for, or no repo label at all, say so and stop. That is a
defect in the ticket, not something to guess past.

A ticket is audited once, by one session, regardless of how many repos it
touches. Audit it from the repo chosen above, and state in the report what
could not be verified from there.

A ticket carrying two repo labels can be audited but never built: cross-repo
work is two tickets, one per repo, linked. The same is true of a ticket whose
Repo: line names more than one repo, whatever its labels say. Audit it anyway,
and say under WRONG that it needs splitting before anything can build it.
Saying so now is cheaper than the build refusing it later.

When a ticket has a sibling in the other repo, say which kind of pair it is,
because they are audited differently. A **contract pair** is a server
endpoint and its client: check the `## Contract` exists, and say plainly
that the server half ships and is curl-verified first. A **mirror pair** is
the same text landing in both repos with no runtime dependency: there is no
Contract to check and no order to enforce, so check instead that the ticket
says which blocks must be identical and which are per-repo. See "Which repo
works a ticket" in `.claude/process.md`.

# The audit

Read CLAUDE.md and `.claude/process.md` first.

Then read the ticket and every comment on it. Identify comments by their
`[...]` marker, not by author ID — every comment is under Jaipal's account,
including your own.

Read the files the ticket names, plus anything they import that bears on the
claims. Verify each claim against the code as it actually exists: live schema
over migrations, `pg_get_functiondef` over migration files, the running query
over the query you would expect. A claim you cannot verify is not confirmed —
say so rather than assuming the ticket is right.

Post one comment, flat at the top level, never as a reply, in this shape:

```
**[FROM CLAUDE CODE]**

[AUDIT] TAC-XXX
```

followed by exactly these sections:

**1. CONFIRMED** — claims in the ticket that hold, each with the `file:line`
that proves it.

**2. WRONG** — claims that do not hold, with what is actually true.

**3. QUESTIONS** — numbered, one decision each, each written in the format
under "Asking Jaipal a question" in `.claude/process.md`: a concrete case in
plain language first, then the question with options. No identifiers, no file
paths, no function names, no schema columns. Do not recommend. Do not answer
your own question. Do not rank them.

**A question that cannot be written that way is not a decision for Jaipal —
it is an implementation detail.** Decide it yourself, and list it at the end
of this section under **Decided without asking**, one line each with the
reason, so he can overrule it.

**Cap at seven.** If the ticket raises more than seven distinct decisions,
that is itself the finding: the ticket is too large to rule on and should be
split. Say so, list the seven that block the most, and name the rest in one
line each.

**4. FINDINGS** — defects you hit that are not in any ticket. Describe them.
Do not file tickets. Maximum three; list any remainder as one-liners under a
"not detailed" heading.

**5. UNBLOCKED** — what could be built with zero further input from Jaipal.

**The comment does not describe how the audit was done.** It holds the
findings, the evidence for each, and what could not be verified. No list of
the tools or commands used, no "I checked X by doing Y", nothing about what
you did or did not do. Evidence is the source, stated as what it shows: a
`file:line`, a query result, the fields a run records. An audit that
narrates its own process is writing from memory, and on TAC-431 two runs in
a row got that narration wrong. A refused command is something that happened
to the session, not a finding about the ticket: the comment does not mention
it. In CI the workflow records refusals in `[DENIALS]`.

If a question blocks verifying a later claim, say so and stop verifying that
branch. Do not assume an answer in order to keep going.

# After posting — the ticket always leaves Todo

An audited ticket never stays in Todo. Todo means not yet looked at, and
leaving it there means nothing picks the ticket up and the board lies about
why.

**Questions found** → set the ticket to **Ready**, add the `Needs Decision`
label, and copy the questions into the ticket body's `## Open questions`
block. Ready says it has been audited; the label says it is waiting on Jaipal,
and nothing builds it while the label is on.

**No questions** → set the ticket to **Ready**, with no `Blocked On` label. It
is verified and buildable, and the build automation pulls from Ready.

Never change the status for any other reason.

If the ticket body already has an `## Open questions` block, merge rather than
append. A question already asked in a different form is not a new question;
say which existing item it duplicates.

If `## Open questions` already held questions Jaipal was asked before this
audit, and this audit resolved them against the code, say so in the comment
but leave them, and the `Needs Decision` label, in place. Only a ruling from
Jaipal clears a question he was asked.

A `Needs Decision` label that a failed audit run or an `[AUDIT-SKIPPED]`
comment put on the ticket is not a question he was asked. This audit's own
outcome replaces it.

If the ticket's `## Gate` section names no QA route, set one — `QA: Script`
if the gate is provable by a test or query, `QA: Device` if it needs Jaipal on
a real device or at the venue — and say what would make a device gate
script-provable.

Do not self-commit. Do not call ScheduleWakeup. Do not start another ticket.
