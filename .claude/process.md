# Ticket process

Canonical definitions for statuses, labels, comment prefixes, and standing
rulings. Applies to every repo and every command.

`work-ticket.md` restates parts of this operationally, as a state machine.
Where the two disagree, this file is authoritative and the command file is
the bug.

## Linear statuses

Pipeline: **Backlog → Needs Ruling → Todo → In Progress → In Review → Ready For QA → Done.**

Backlog is Linear's default for a ticket created without an explicit status.
Every ticket we create sets its status explicitly.

| Status | Meaning |
|---|---|
| Backlog | Uncommitted. Not yet triaged. |
| Needs Ruling | Blocked on Jaipal. Carries a `Blocked On` label saying which kind. |
| Todo | Zero open questions. The only status Claude Code builds from. |
| In Progress | Set automatically on draft PR open. |
| In Review | PR open, not merged. Set automatically. |
| Ready For QA | Merged. Gate not yet passed. Set automatically on merge. |
| Done | Gate passed in production. Never set automatically, never set by the agent. |

Rules, in order of how badly they break things if ignored:

1. **Build only from Todo.** A ticket with anything under `## Open questions`
   is not buildable, whatever its status says. Found one in Todo? Move it to
   Needs Ruling and say so.
2. **Never move a ticket to Todo.** The one exception is clearing the last
   open question immediately after a ruling answered it. Promoting a ticket
   on your own judgment defeats the process.
3. **Never mark a ticket Done.** Merging moves it to Ready For QA
   automatically. Done requires a passed gate, which is a separate act.
4. **Never run a production migration.** Write the SQL, hand it over. See
   `[NEEDS-ACTION]` below.

## Labels

**Blocked On** — exactly one, on every Needs Ruling ticket.

- `Needs Decision` — answerable from the ticket, on a phone, without opening code.
- `Needs Action` — Jaipal must execute something: migration, env var, third-party config, device step.

**QA Route** — exactly one, set when the ticket is written, not at close time.

- `QA: Script` — gate is provable by a test or query.
- `QA: Device` — gate needs Jaipal on a real device or at the venue.

**Finding** — surfaced by an audit or mid-build, not yet triaged into a gate.

## Comment prefixes

Every comment on a ticket is authored under Jaipal's Linear account,
including your own. Identify comments by prefix, never by author ID.

All agent comments open with `**[FROM CLAUDE CODE]**`, then a blank line,
then the marker.

| Marker | When | Then |
|---|---|---|
| `[NEEDS-INPUT]` | A question blocks the work | Add it to `## Open questions`, set Needs Ruling + `Needs Decision` |
| `[HUMAN-REVIEW-REQUIRED]` | The work touches a high-stakes area | Same, and do not plan or branch |
| `[NEEDS-ACTION]` | Something only Jaipal can run | Set Needs Ruling + `Needs Action`. Format below is mandatory |
| `[FINDING]` | A defect outside this ticket | Describe it. Never file a ticket. Max three per ticket |
| `[AUDIT]` | Output of `/audit-ticket` | Read-only pass |

## On hitting a question

Stop that thread. Do not guess, do not pick the likelier answer and note the
assumption, do not widen scope to route around it.

If the question blocks only one item of several, ship the unblocked items and
split the blocked item into its own ticket in Needs Ruling. The parent
carries on.

## Standing rulings

Decide these yourself and proceed. Name the ruling in your comment, so a
pre-authorized decision is distinguishable from a silent one.

- **SR-1 Contrast and accessibility figures.** WCAG arithmetic, not taste.
- **SR-2 Copy that is factually wrong about system behaviour.** Correct it.
  Does not extend to copy in the agent's voice.
- **SR-3 Test quality.** Mutation verification, real gate vs mock,
  assertion targets.

Everything else is Jaipal's. In particular: anything in the agent's voice a
guest can read, anything that changes what auto-sends or when, and anything
where the answer is taste rather than fact.

## `[NEEDS-ACTION]` format

Mandatory. Nothing substitutes for any of the four.

1. The exact command or SQL, in a code block, runnable as-is. No
   placeholders, no "replace `<table>` with".
2. Where it runs: which database, which environment, which shell.
3. The rollback, in its own code block, runnable as-is.
4. One line: what should be true afterward, checkable in one query or one glance.

If you cannot write the rollback, say so explicitly rather than omitting it.
An irreversible action Jaipal discovers is irreversible at 11pm in front of
prod is the failure this rule exists to prevent.

If the action cannot be reduced to a paste, describe the smallest manual step
instead and say why it resisted.

When Jaipal confirms it ran, verify against the live schema —
`pg_get_functiondef`, live table inspection — not against the migration file
and not against his confirmation.
