# Ticket process

Canonical definitions for statuses, labels, comment prefixes, and standing
rulings. Applies to every repo and every command.

`work-ticket.md` restates parts of this operationally, as a state machine.
Where the two disagree, this file is authoritative and the command file is
the bug.

## Linear statuses

Pipeline: **Backlog → Todo → Ready → In Progress → Ready For QA → Done**,
plus **Canceled** and **Duplicate**.

Backlog is Linear's default for a ticket created without an explicit status.
Every ticket we create sets its status explicitly.

| Status | Meaning |
|---|---|
| Backlog | Uncommitted. Not yet triaged. |
| Todo | Committed, **not yet audited**. The audit automation picks it up on its next scheduled run. Never build from here. |
| Ready | Audited, buildable. **The only status a build starts from.** |
| In Progress | Claude Code has it. Set automatically on PR open. |
| Ready For QA | Merged and deployed. Gate not yet passed. Set automatically on merge. |
| Done | Gate passed in production. Only Jaipal sets this. |
| Canceled | Not being done. |
| Duplicate | Covered by another ticket. |

**"The next scheduled run" can be hours.** GitHub runs our scheduled
workflows 2–5 hours apart whatever their cron says, and has since 2026-08-27
(TAC-428). Nothing in this process promises a time. Say "picked up on the
next scheduled run", never "within 15 minutes".

## Blocked on Jaipal is a label, not a status

A ticket that needs Jaipal stays in whatever status it is in and gains one
`Blocked On` label. Nothing bounces between statuses: a ticket whose audit
found questions sits in Ready with the label, and a ticket blocked mid-build
stays where it is with the label. When he answers, remove the label. The
status does not change because he answered.

A PR waiting to merge carries no label. The open PR is the signal. Labelling
it would make `Blocked On` mean two different kinds of waiting, fill the Slack
rulings channel with merge notices, and stop it being a decision queue.

Rules, in order of how badly they break things if ignored:

1. **Build only from Ready or In Progress, and only when the ticket carries
   one repo label, no `Blocked On` label, and no open question under
   `## Open questions`.** A ticket in Todo has not been audited. A ticket
   with two repo labels needs splitting (see "Which repo works a ticket"). An audit that finds questions still sets Ready,
   so Ready alone does not mean unblocked. **Ready never means approved.** An
   audit sets Ready without asking Jaipal anything, and a ticket can reach In
   Progress the same way: TAC-403 did, with a `[PLAN]` nobody had answered.
   An unanswered plan blocks the build whatever the status says.
2. **Never promote a ticket to Ready yourself.** Only the audit moves a ticket
   there, whatever it finds.
3. **Never mark a ticket Done.** Merging moves it to Ready For QA
   automatically. Done requires a passed gate, which is Jaipal's act.
4. **Never run a production migration.** Write the SQL, hand it over. See
   `[NEEDS-ACTION]` below.
5. **Anything that needs Jaipal adds the right `Blocked On` label at the
   moment it needs him**, and leaves the status alone. Never wait silently. A
   plan awaiting approval counts. A PR awaiting merge does not.

## Labels

**Blocked On**: at most one, on any ticket waiting on Jaipal, in any status.
Linear allows only one label from the group. Remove it when he answers.

- `Needs Decision`: he answers a question. Answerable from the ticket, on a phone, without opening code.
- `Needs Action`: he runs something himself: migration, env var, third-party config, device step.

**QA Route**: exactly one, set when the ticket is written, not at close time.

- `QA: Script`: gate is provable by a test or query.
- `QA: Device`: gate needs Jaipal on a real device or at the venue.

**Repo**: `analog-guest`, `analog-operator`. A buildable ticket carries
exactly one.

**Finding**: surfaced by an audit or mid-build, not yet triaged into a gate.

## Which repo works a ticket

**Cross-repo work is two tickets, one per repo, linked.** One ticket, one
repo, always. A single ticket carrying both repo labels is a ticket-writing
defect. Built as one ticket, only one repo would build it, the other half
would never be built, and merging that one PR would still move the whole
ticket to Ready For QA. It is the same defect as a missing Repo: line is for
the audit. It just fails later and more expensively.

The labels say where the work lands. The **Repo:** line says where it starts.
The audit and the build both narrow by label and decide by the Repo: line:

- **A Repo: line naming exactly one repo, and the ticket is labelled for
  it:** that repo works it.
- **A Repo: line naming more than one repo** is a ticket-writing defect,
  whatever the labels say. Cross-repo work is two tickets, one per repo,
  linked. The repo the ticket is labelled for posts `[BUILD-SKIPPED]` (or
  `[AUDIT-SKIPPED]`), adds `Needs Decision`, and does not guess. Naming a
  second repo used not to be a defect, and that is what let TAC-439 sit
  labelled `analog-guest` with a line naming both: guest picked it up
  silently and operator never saw it at all.
- **No Repo: line, one repo label:** that repo works it.
- **No Repo: line, two repo labels** is a ticket-writing defect. The audit
  automation posts `[AUDIT-SKIPPED]` saying so, adds `Needs Decision`, and
  does not guess.
- **A Repo: line naming no repo the ticket is labelled for** is the same
  defect, handled the same way. Nothing else would ever pick the ticket up.
- **No repo label:** no automation sees the ticket.

The build adds one rule: **a ticket with two repo labels is never built**,
even when its Repo: line picks a repo. The repo that would have built it
posts `[BUILD-SKIPPED]` instead, adds `Needs Decision`, and does not start it:

```
[BUILD-SKIPPED] TAC-XXX

This ticket can't be built. It carries the analog-guest and analog-operator
labels, and cross-repo work is two tickets, one per repo, linked. Built as
one ticket, only one repo would build it and the other half would never be
built.

Split it: one ticket per repo, each with its own repo label and Repo: line,
linked to each other. Replying here will not unblock it: the ticket needs
splitting.
```

A ticket that reached Ready or In Progress with a Repo: line naming no
labelled repo gets `[BUILD-SKIPPED]` too, saying the two disagree.

Only an edit to the ticket fixes any of these defects. A reply doesn't,
because the automations read the Repo: line and the labels, not the
comments.

## Comments

Every comment on a ticket is authored under Jaipal's Linear account,
including your own. Identify comments by prefix, never by author ID.

All agent comments open with `**[FROM CLAUDE CODE]**`, then a blank line,
then the marker. **A comment's marker is the first `[MARKER]` after the
prefix**, not a marker quoted anywhere in the body: an audit or a plan that
quotes `[NEEDS-INPUT]` is still an audit or a plan.

**Post every comment flat, at the top level. Never set `parentId`.** Jaipal
reads a ticket top to bottom, and a threaded reply puts an answer inside an
earlier comment where that reading misses it.

| Marker | When | Then |
|---|---|---|
| `[NEEDS-INPUT]` | A question blocks the work | Add it to `## Open questions`, add `Needs Decision`. Status unchanged |
| `[HUMAN-REVIEW-REQUIRED]` | A hard-stop plan has been approved | Remove `Needs Decision`. The build is a session Jaipal drives. Posted once, after the plan, never instead of it |
| `[NEEDS-ACTION]` | Something only Jaipal can run | Add `Needs Action`. Status unchanged. Format below is mandatory |
| `[PLAN]` | A plan awaiting approval | Add `Needs Decision`. Approval is a decision like any other |
| `[FINDING]` | A defect outside this ticket | Describe it. Never file a ticket. Max three per ticket |
| `[AUDIT]` | Output of `/audit-ticket`, or a run that failed to finish one | Read-only pass. Its presence stops the audit automation picking the ticket up again |
| `[AUDIT-SKIPPED]` | The audit automation can't tell which repo works the ticket | Add `Needs Decision`. Deliberately not `[AUDIT]`, so the ticket is audited once fixed |
| `[BUILD-SKIPPED]` | The ticket carries two repo labels, or its Repo: line and labels disagree | Add `Needs Decision`. Never start the build |
| `[SLACK]` | The Slack sync posted the ticket; edited in place as it syncs | Bookkeeping, not a turn |
| `[RESUME-CLAIM]` | The build workflow is about to resume the ticket after a ruling | Bookkeeping, not a turn. Two claims on the same ruling and the workflow stops retrying it |
| `[DENIALS]` | A build or audit session hit permission denials on a ticket it worked | Bookkeeping, not a turn. Posted by the workflow, listing the denied commands with the key redacted. A denial on a run that otherwise succeeded usually means a prompt teaches a form the allowlist refuses |
| `[SILENT-RUN]` | The build workflow's check after the session found no comment from the session on a ticket it worked | Posted by the workflow, not a session. Adds `Needs Decision` if no `Blocked On` label is on, and the run fails. **Not bookkeeping, deliberately**: it counts as the newest comment, so nothing retries the ticket until Jaipal replies. Retrying a permission failure would only repeat it. Read the run before replying: a reply resumes the ticket |

A comment that does **not** carry `[FROM CLAUDE CODE]` is human input. When
the newest comment on a ticket is human input, the ticket is unblocked and a
session may resume it. **Bookkeeping comments (`[SLACK]`, `[RESUME-CLAIM]`,
`[DENIALS]`) never count as the newest comment.** They record what a workflow did, and
counting them would bury the reply they were posted around. The build
automation resumes only Ready and In Progress tickets; a reply on a ticket in
any other status is recorded but starts nothing.

**Only a comment that asks something waits for a reply**: one whose marker
is `[NEEDS-INPUT]`, `[PLAN]`, `[HUMAN-REVIEW-REQUIRED]` or `[NEEDS-ACTION]`,
or an `[AUDIT]` that asked at least one question. A clean `[AUDIT]` asks
nothing. A ticket that has only been cleanly audited is a fresh start for the
build, not a question still waiting for a reply.

## Asking Jaipal a question

Applies to every question put to him: an audit's QUESTIONS, `[NEEDS-INPUT]`,
and `## Open questions`.

Every question leads with a concrete case in plain language: three lines of
situation, one line of what breaks, then the question with options. No
identifiers, no file paths, no function names, no schema columns.

The shape and these rules are the same in every repo. The example is not:
each repo's copy uses a case from its own domain.

```
A guest texts "omw can you have my usual ready?" at 6pm.
The venue closed at 5.

Today: the agent replies "Got it, see you soon" and it
auto-sends. The guest walks to a locked door.

The question: should a reply that confirms an arrival while
the venue is closed always go to Jaipal's queue first?
  A — yes, always
  B — only when it also promises something
```

State the options. Do not recommend one.

**If a question cannot be written that way, it is not a decision for
Jaipal.** It is an implementation detail. Decide it yourself, and say in the
same comment that you did and why.

## When Jaipal answers

**His answer is applied to `## Open questions` before anything checks
whether the block is empty.** Otherwise the check sees his own question still
there, stops, and his answer, from Slack or from Linear, is ignored until he
edits the ticket by hand.

- An open question is a numbered item with text. The template's empty `1.`,
  HTML comments, and italic notes such as *None* or *Ruled …* are not.
- A reply answers a question when it gives the decision that question asks
  for: its number with an option or a stated choice ("1 A", "2: the most
  recent"), or, when only one question is open, an option or a choice alone.
- An answered question leaves the block. One italic line at the end of the
  block records it: `*Ruled YYYY-MM-DD, question N: <the decision>.*` The
  remaining questions keep their numbers, because replies refer to them.
- A reply that could answer more than one question, or states no decision,
  answers nothing. Never guess a match.
- When no open question is left, `Needs Decision` comes off. The status does
  not change.

**A failure to match is loud, by rule.** When a reply leaves any question
open, the session posts `[NEEDS-INPUT]` naming each question still open and
why the reply didn't settle it. `[NEEDS-INPUT]` reaches Slack, where he
answered. More generally, **a session never exits a ticket carrying a
`Blocked On` label without a comment when the newest comment is his.** A quiet exit
there leaves the ticket looking exactly like one still waiting for him. The
only silent exit is when the newest comment is already the agent's, which
already says why the ticket is waiting.

**The workflow checks too, because the rule cannot report its own failure.** A
session is loud only by writing to Linear, so a session that cannot write
cannot say so. After every build session a shell step, not the session,
looks for a comment from the session on each ticket it worked. A ticket with
none gets `[SILENT-RUN]`, naming the permission denials, and the run fails.
The denial count is printed in the run log on every build and audit run,
and any run with denials also posts the denied commands on the ticket as
`[DENIALS]` bookkeeping, because a run that succeeds with denials otherwise
looks identical to one without.
This check exists because TAC-401's first resume ran green, hit 30
permission denials, and wrote nothing.

**Nothing tests this.** It is instructions to the build session, not code.
The workflow fixtures cover which tickets get picked up, not whether a
session applies an answer. The loud-failure rule is instructions too, so it
can fail the same way. And no rule makes these loud: a session that never
runs, or one that applies the wrong decision and carries on. The only proof
is a real answer on a real ticket. After any change to this section or to
Phase 0 of `work-ticket.md`, name one ticket, answer it, and check within a
few hours that its questions left the block or a `[NEEDS-INPUT]` explains
why not.

## High-stakes work: a plan gate, and a narrower hard stop

A high-stakes ticket gets a plan. It does not get an unattended build.

Phase 0 of `work-ticket.md` sorts every ticket into one of three tiers on
every run, after it applies answers and before any plan.

**Hard stop.** The narrow list in `work-ticket.md` step 4: auth, Stripe, the
Sendblue webhook handlers, and migrations on `messages`,
`engagement_events` or `voice_corpus`. The session audits, plans, posts
`[PLAN]` with `Needs Decision`, and exits. On approval it does **not**
build: it posts `[HUMAN-REVIEW-REQUIRED]` saying the plan is approved and
the build is a session Jaipal drives, removes `Needs Decision`, and exits.

**Plan gate.** Everything else the repo calls high-stakes — here, the agent
runtime contract. The session audits, plans, posts `[PLAN]` with
`Needs Decision`, and exits. A human reply resumes it on the next scheduled
run, exactly as every other plan does. It then builds, commits, pushes, and
opens a draft PR, and stops. Jaipal reviews and merges.

**Ordinary.** Unchanged, and now the same flow as the plan gate.

**Guest-facing copy is its own gate.** A plan that changes wording a guest
can read shows the new wording verbatim and waits for approval of that
wording specifically. Approving a plan's shape is not approving its copy.

`[HUMAN-REVIEW-REQUIRED]` means one thing: this ticket's build is a session
Jaipal drives. It is posted once, after a hard-stop plan is approved, never
instead of a plan, and it is terminal for the automation — a reply after it
starts nothing.

**Superseded, the 2026-09-16 ruling.** It said no go-ahead lets
`/work-ticket` past the high-stakes check, and it described the shape the
check then had correctly: the check fired before any plan, so each answer
produced another stop and the human never got anything to approve. The check
now fires after the plan, so the ruling no longer holds.

## On hitting a question

Stop that thread. Do not guess, do not pick the likelier answer and note the
assumption, do not widen scope to route around it.

If the question blocks only one item of several, ship the unblocked items and
split the blocked item into its own ticket, **created in Todo** with one repo
label, a Repo: line naming that repo, and the question under its
`## Open questions`. The audit then moves it to Ready with
`Needs Decision`, so only the audit ever sets Ready. The parent carries on.

## Contracts

A `## Contract` section locks what two pieces of work build against:
endpoint path, request shape with a concrete example, response shape per
status code, env vars with format notes. CLAUDE.md's "Cross-repo contracts"
covers building against one. Three rules cover writing one:

1. **Every `## Contract` carries a `### What this doesn't settle`
   subsection**, an H3 under the Contract, next to
   `### What it may not assume` as TAC-395 does. Silence in a spec reads as
   permission and gets implemented. Three times on TAC-395 the spec was
   applied to a case it said nothing about, and the code would have been
   exactly correct and exactly wrong. State the silence.
2. **Any Contract line saying "apply X to all of Y" states what Y
   surprisingly contains**: empty bodies, NULL columns, rows in states nobody
   pictures. All three TAC-395 cases came from there.
3. **A `## Contract` means cross-repo only when the other side is not built
   yet.** A Contract against work that has already shipped documents it; the
   ticket stays single-repo. TAC-298 has a Contract with already-shipped
   tickets and is operator-only.

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
