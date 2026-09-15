---
name: audit-ticket
description: Read-only audit of a Linear ticket. Verifies claims against the code, produces questions, writes no code.
---

Audit Linear ticket $ARGUMENTS.

This is an audit. Do not plan, do not branch, do not write code, do not edit
the ticket's description except for the `## Open questions` block as directed
below.

# Check the repo

Find the ticket's **Repo:** line. If it names a repo other than the one you
are running in, stop and say which repo to run in. Do not audit across a repo
boundary.

If the ticket names no repo, say so and stop. That is a defect in the ticket,
not something to guess past.

A ticket is audited once, by one session, regardless of how many repos it
touches. If it spans repos, audit from the one its **Repo:** line names and
state in the report what could not be verified from there.

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

Post one comment in this shape:

```
**[FROM CLAUDE CODE]**

[AUDIT] TAC-XXX
```

followed by exactly these sections:

**1. CONFIRMED** — claims in the ticket that hold, each with the `file:line`
that proves it.

**2. WRONG** — claims that do not hold, with what is actually true.

**3. QUESTIONS** — numbered, one decision each, options stated. Do not
recommend. Do not answer your own question. Do not rank them.

**Cap at seven.** If the ticket raises more than seven distinct decisions,
that is itself the finding: the ticket is too large to rule on and should be
split. Say so, list the seven that block the most, and name the rest in one
line each.

**4. FINDINGS** — defects you hit that are not in any ticket. Describe them.
Do not file tickets. Maximum three; list any remainder as one-liners under a
"not detailed" heading.

**5. UNBLOCKED** — what could be built with zero further input from Jaipal.

If a question blocks verifying a later claim, say so and stop verifying that
branch. Do not assume an answer in order to keep going.

# After posting — the ticket always moves

An audited ticket never stays in Todo. Todo means unaudited, and leaving it
there means nothing picks the ticket up and the board lies about why.

**Questions found** → copy them into the ticket body's `## Open questions`
block, set the ticket to **Needs Ruling**, add the `Needs Decision` label.

**No questions** → set the ticket to **Ready**. It is verified and buildable,
and the build automation pulls from Ready.

If the ticket body already has an `## Open questions` block, merge rather than
append. A question already asked in a different form is not a new question;
say which existing item it duplicates.

If the ticket was already in Needs Ruling and this audit resolved its
questions against the code, say so in the comment but do **not** move it.
Only a ruling from Jaipal clears a question he was asked.

If the ticket's `## Gate` section names no QA route, set one — `QA: Script`
if the gate is provable by a test or query, `QA: Device` if it needs Jaipal on
a real device or at the venue — and say what would make a device gate
script-provable.

Do not self-commit. Do not call ScheduleWakeup. Do not start another ticket.