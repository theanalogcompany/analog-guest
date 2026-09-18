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
| In Progress | Claude Code has it. The build workflow derives this from a branch existing on GitHub and writes it, every run (TAC-466). Not Linear's own automation — see "Which repo works a ticket" below. |
| Ready For QA | Merged and deployed. Gate not yet passed. The build workflow derives this from a merged PR and writes it, every run (TAC-466). |
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
   An unanswered plan blocks the build whatever the status says. Nor is a
   ticket another session has yours to build, whatever its status (see
   "Claims").
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

**Two kinds of sibling pair, and they need different rules.**

- **Contract pair.** A server endpoint and its client (TAC-207 ↔ TAC-288).
  Order is absolute: the server ships, deploys, and is curl-verified against
  the `## Contract` before the client half starts. CLAUDE.md's "Cross-repo
  contracts" covers it.
- **Mirror pair.** The same text lands in both repos with no runtime
  dependency (TAC-396 ↔ TAC-437, TAC-441 ↔ TAC-442). Order is irrelevant,
  and the Contract rules actively misfit it: there is no endpoint, no curl,
  nothing to ship first. Its gate is that the shared blocks are identical
  and every per-repo block is listed explicitly with what differs and why —
  **never whole-file identity**, because several blocks are required to
  differ. The worked question example in this file is one; the high-stakes
  list in `work-ticket.md` step 4 is another.

**How the second half learns the first has landed: the sibling ticket's own
status.** For analog-guest, this is not Linear's own GitHub automation — its
integration does not attach an analog-guest PR to its ticket at all
(confirmed 2026-09-18: PR #215 merged for TAC-467 after the "Public
repositories" integration setting was fixed, and TAC-467 still shows no PR
attachment). The build workflow derives and writes the status itself,
every run (TAC-466, `scripts/reconcile-status.mjs`): a branch on GitHub
moves a ticket to In Progress, a merged PR moves it to Ready For QA.
"Has the other half shipped" is still answerable without any cross-repo
access — which is just as well, because there is none. A run is bound to
its own repo: the GitHub App token it holds reaches exactly one repo, and
nothing sends a `repository_dispatch` to the other. Whether
analog-operator's status moves the same way — by its own GitHub automation
or by something else — was not re-investigated here: only PR attachment was
confirmed there, a different fact from whether status moves, so treat it as
that repo's own open question until checked. The branch name and any curl
verification belong in the Phase 5 comment, because nothing else carries
them across.

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

**Before checking whether a comment opens with the CC prefix, unescape `\[`
to `[` and `\]` to `]`, then match with `startsWith`.** Linear can return
brackets escaped, and a comment opening with a CC prefix in any bracket form
is CC's own, never human input and never a ruling (TAC-396).
`scripts/lib/comment-provenance.mjs` implements this rule and the ruling
rule below, with tests. Extend it rather than writing the check again.

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
| `[CLAIM]` | A session is about to work the ticket: the build workflow before it starts one or works one named in a dispatch, naming its run, or a local session before anything else it writes, naming none. A local session edits its own to `released` when it hands the ticket back | Bookkeeping, not a turn. The build workflow skips a ticket a local session has claimed, and a local session leaves alone a ticket whose build run is still going. See "Claims" |
| `[RESUME-CLAIM]` | The build workflow is about to resume the ticket after a ruling | Bookkeeping, not a turn. Two claims on the same ruling and the workflow stops retrying it |
| `[DENIALS]` | A build or audit session hit permission denials on a ticket it worked | Bookkeeping, not a turn. Posted by the workflow, listing the denied commands with the key redacted. A denial on a run that otherwise succeeded usually means a prompt teaches a form the allowlist refuses |
| `[SILENT-RUN]` | The build workflow's check after the session found no comment from the session on a ticket it worked | Posted by the workflow, not a session. Adds `Needs Decision` if no `Blocked On` label is on, and the run fails. **Not bookkeeping, deliberately**: it counts as the newest comment, so nothing retries the ticket until Jaipal replies. Retrying a permission failure would only repeat it. Read the run before replying: a reply resumes the ticket |
| `[TURN-LIMIT]` | The CLI stopped the build session at its turn limit, before it finished | Posted by the workflow, in place of `[SILENT-RUN]` and `[DENIALS]`. Names what reached GitHub and what died with the runner. Adds `Needs Decision` like `[SILENT-RUN]`, the run fails, and it is **not bookkeeping** for the same reason. A reply resumes the build from the ticket's branch on GitHub |
| `[OVER-LIMIT]` | The build session finished its work but used more turns than its limit, so claude-code-action failed the run afterwards | Bookkeeping, not a turn. Posted by the workflow, saying what was pushed. The run stays failed (ruled on TAC-447). Bookkeeping because it lands after the session's own last comment, often a PR link, and must not hide it |
| `[CANCELLED]` | A fixture ticket has served its purpose | Posted just before cancelling the fixture, naming the ticket it was a fixture for. See "Testing a workflow change" |

A comment that does **not** open with `**[FROM CLAUDE CODE]**` is human
input, including one that quotes the prefix further down. When
the newest comment on a ticket is human input, the ticket is unblocked and a
session may resume it. **Bookkeeping comments (`[SLACK]`, `[CLAIM]`,
`[RESUME-CLAIM]`, `[DENIALS]`, `[OVER-LIMIT]`) never count as the newest comment.** They record what a workflow did, and
counting them would bury the reply they were posted around. The build
automation resumes only Ready and In Progress tickets; a reply on a ticket in
any other status is recorded but starts nothing.

**A reply advances a gate only when it is unprefixed or opens
`**[FROM CLAUDE CHAT — RULING`.** A plain `**[FROM CLAUDE CHAT]**` comment
is context and is never matched against `## Open questions`, whatever it
says (TAC-396). Nor does it approve a plan, say a `[NEEDS-ACTION]` ran, or
wind a ticket down. The build workflow's resume check is coarser: it reads only
the CC prefix, without unescaping, so it can start a session on a plain
`[FROM CLAUDE CHAT]` comment or on an escaped CC prefix. The session it
starts applies both rules.

**Only a comment that asks something waits for a reply**: one whose marker
is `[NEEDS-INPUT]`, `[PLAN]`, `[HUMAN-REVIEW-REQUIRED]` or `[NEEDS-ACTION]`,
or an `[AUDIT]` that asked at least one question. A clean `[AUDIT]` asks
nothing. A ticket that has only been cleanly audited is a fresh start for the
build, not a question still waiting for a reply.

## Claims

Two sessions must never work one ticket. On 2026-09-17 the build workflow
resumed TAC-396 while a local session was building it (run 35299836324,
attempt 1), and only a human reading the run log stopped it. The status
did not help: the ticket was In Progress, and the resume path never read
the status.

**The status is not a claim.** In Progress is set only once a branch
exists (TAC-448, ruling 2), so a ticket can be taken long before its
status says so. The build workflow still starts only Ready tickets, but it
decides whether another session has one from what that session left behind:

- **A local session's `[CLAIM]`**, edited in the last 3 hours
  (`LIVE_SESSION_HOURS`), unless it says `released`. A local session posts
  its claim before anything else it writes, and edits it to `released` when
  it hands the ticket back to wait for Jaipal (`work-ticket.md`, "Claiming
  the ticket"). A claim that is not released holds whatever Jaipal rules in
  the meantime: his ruling reaches Linear when the Slack sync posts it, which
  can be long after a local session heard the answer another way.
- **A `[POLLING-STATE]`** edited in the last 3 hours.
- **A commit on the ticket's branch on GitHub** in the last 3 hours, by
  anyone but the build session itself. Only a branch named
  `jaipal/tac-xxx-...` counts.
- **An open PR from the ticket's branch.** For a start only: the build is
  finished and waiting for Jaipal to merge it. A ticket reopened while its
  old PR is still open is not started until that PR is merged or closed.

When resuming on a ruling, a `[POLLING-STATE]` or a commit counts only if it
is no older than the ruling. A polling chain that stopped, or a branch last
pushed before he answered, has not acted on the answer, so it is the next
session's to act on. The one exception is a `[POLLING-STATE]` edited in the
last 10 minutes: that session polls at least every 5 minutes and will read
the ruling itself.

A skipped ticket is named in the run log with the reason. The check is
`scripts/claims.mjs`; if it cannot read the branches it takes nothing and
fails the run rather than choose blind. A skip can be harmless: a commit
made in GitHub's web editor ("Update branch") counts as a session's, and
holds the ticket for 3 hours like any other.

The other direction: the build workflow posts `[CLAIM]` (on a start, and
for a ticket named in a dispatch) or `[RESUME-CLAIM]` (on a resume) naming
its run, before its session starts, and a local session leaves the ticket
alone while that run is still going. Two build runs never overlap: the
workflow's concurrency group runs one at a time.

**What nothing protects.** A session that has neither posted to the ticket
nor pushed to its branch is invisible, so a local session is unprotected
until its `[CLAIM]` lands, and one that never posts a claim is unprotected
until it first pushes to a `jaipal/tac-xxx-...` branch. A session whose
claim is released or more than 3 hours old is unprotected on a resume unless
it has pushed since the ruling. A build dispatched with a named ticket skips
the selection, and with it this check. A local session and a build run that
read the thread in the same few seconds can both proceed; the local session
reads again after posting its claim, which narrows that window without
closing it. Two local sessions are kept apart only by each reading the
other's claim before it starts.

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

**The check after the session also reports the turn limit** (TAC-447), and
that part is code, tested in `scripts/lib/`. A build run works one ticket, so
the limit is that ticket's alone, and the session pushes each planned commit
as it makes it. A session the CLI stops at the limit gets `[TURN-LIMIT]`, and
one that finishes over it gets `[OVER-LIMIT]`. Both say what reached GitHub,
read from the runner's git after the session, by a copy of the reporter taken
before the session, so a branch that predates or edits the reporter cannot
affect the notice.

## Testing a workflow change

What a change to a ticket workflow can be tested on before it merges depends
on which workflow it is.

- **The audit workflow runs whole from a branch.** It passes the job's own
  token and does no App-token exchange, so nothing compares the file with
  `main`'s. Dispatch it from the branch against a fixture ticket
  (`gh workflow run audit-new-todo.yml --ref <branch> -f ticket=<fixture>`)
  and read the run and the fixture's comments. TAC-444's helper was tested
  this way before merge, in run 35293187884.
- **The build workflow runs its shell steps from a branch, but not its
  session.** The App-token exchange refuses a workflow file that differs
  from `main`'s ("Workflow validation failed"), so the Work step skips itself
  and exits green: a green build run from a branch proves the session
  skipped, not that it worked. The steps around it still run. Ticket selection
  is checked from the branch with `-f dry_run=true`, which writes nothing, and
  the check after the session is checked against a fixture ticket, where the
  skipped session reads as a session that posted nothing (run 35149594063
  posted `[SILENT-RUN]` on fixture TAC-430 this way). **What the session
  does is only testable after merge**, by dispatching `main` against a
  fixture. `-f max_turns=<a small number>` stops it early, to reach
  `[TURN-LIMIT]`.

**The fixture-ticket pattern:**

1. Ask Jaipal before creating one: it is a Linear write outside the ticket
   being worked. Create it just before dispatching: a fixture in Ready with
   this repo's label is a ticket any scheduled build run may pick up.
2. Create a throwaway ticket titled `FIXTURE: <what it tests> for TAC-XXX —
   not real work, do not build`, with this repo's label and a Repo: line.
   Keep guest, venue and production data off it: `full_output` puts a run's
   transcript in this public repo's log, and it is only for fixtures.
3. Dispatch the workflow from the branch, or from `main` after merge, with
   `-f ticket=<fixture>`.
4. Read the run and the fixture's comments.
5. Cancel the fixture, with a `[CANCELLED]` comment naming the ticket it
   was a fixture for. TAC-450, the fixture for TAC-444, is the model.

## "Do not self-commit"

Tickets often end their notes with "Do not self-commit". It means **no
commit to `main`, and no merge**. It does not mean don't commit. A build
commits to the ticket's own branch, pushes each commit as it makes it, and
opens a draft PR (`work-ticket.md` Phases 3 and 5); Jaipal merges. An audit
commits nothing, whatever a ticket says.

Say it that way in new tickets: "**Commits:** to the ticket's branch, with a
draft PR. Never to `main`, and never a merge."

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
