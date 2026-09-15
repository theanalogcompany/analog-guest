---
name: audit-ticket
description: Read-only audit of a Linear ticket. Verifies claims against the code, produces questions, writes no code.
---

Audit Linear ticket $ARGUMENTS.

This is an audit. Do not plan, do not branch, do not write code, do not edit
the ticket's description except for the `## Open questions` block as directed
below.

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

**4. FINDINGS** — defects you hit that are not in any ticket. Describe them.
Do not file tickets. Maximum three; list any remainder as one-liners under a
"not detailed" heading.

**5. UNBLOCKED** — what could be built with zero further input from Jaipal.

If a question blocks verifying a later claim, say so and stop verifying that
branch. Do not assume an answer in order to keep going.

# After posting

If section 3 is non-empty: copy those questions into the ticket body's
`## Open questions` block, set the ticket to **Needs Ruling**, and add the
`Needs Decision` label. A ticket whose audit found open questions must not
sit in Todo — Claude Code would pick it up as buildable.

If section 3 is empty and the ticket is in Needs Ruling only because of
questions this audit has now resolved against the code, say so in the
comment but do not move it. Only a ruling from Jaipal moves a ticket to Todo.

If the ticket's `## Gate` section names no QA route, propose one — `QA: Script`
if the gate is provable by a test or query, `QA: Device` if it needs Jaipal on
a real device or at the venue — and say what would make a device gate
script-provable.

Do not self-commit. Do not call ScheduleWakeup. Do not start another ticket.
