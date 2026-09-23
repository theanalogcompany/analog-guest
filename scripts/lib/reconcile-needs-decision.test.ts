import { describe, expect, it } from 'vitest'
import {
  EXIT,
  USAGE,
  deriveNeedsDecision,
  reconcile,
  run,
} from './reconcile-needs-decision.mjs'

// Every fixture body below is real text from the named ticket, fetched
// 2026-09-18. Trimmed of prose that doesn't affect classification (a
// [DENIALS] comment's denied-command list, an [AUDIT]'s CONFIRMED/WRONG/
// FINDINGS sections when only its QUESTIONS section matters) — never
// paraphrased. Each comment keeps its real prefix, marker line and
// createdAt. TAC-446's own AC requires exactly these three threads.

// ---------------------------------------------------------------------
// TAC-396: /work-ticket identifies its own comments by author ID
// ---------------------------------------------------------------------
// This is incidents #1 and #2 from the ticket: the label never landed on
// the [PLAN] at 20:39:05 (a later session had to add it by hand at
// 23:04:40), and it was never removed after the 23:10:24 approval ruling.
// One [AUDIT] is included (the second; the first was superseded by it as
// lastQuestionComment, so both fold to the same real-thread outcome and
// only one is needed here).
const TAC_396_THREAD = [
  {
    createdAt: '2026-09-15T02:43:50.075Z',
    body: `**[FROM CLAUDE CODE]**

[AUDIT] TAC-396

**3. QUESTIONS**

*In the ticket body these are numbered B1–B7, to keep them apart from the other audit's 1–5.*

1. **Which repos does this ticket change?**
   (a) analog-operator's \`work-ticket.md\` only.
   (b) analog-guest's only.
   (c) Both, as two PRs.
2. **Which fix?**
   (a) Option 1: key on the prefix.
   (b) Option 2: post as Claude Code Bot again, using the existing account (W3).
   (c) Both.
3. **How are \`[FROM CLAUDE CHAT]\` comments classified?**
4. **How is an unprefixed comment classified, given W4?**
5. **What is the match rule for the provenance prefix?**
6. **What does "tested" mean for the fourth acceptance criterion?**
7. **How does an HRR ticket resume after a ruling?**

**4. FINDINGS**

- F1. analog-operator's work-ticket.md cites CLAUDE.md sections this repo doesn't have.`,
  },
  {
    createdAt: '2026-09-15T03:04:15.006Z',
    body: `**[FROM CLAUDE CHAT — RULING]**

Ruled 2026-09-15.

**Option 1: key on the prefix.** Do not pursue a separate Linear identity for the MCP.

\`/work-ticket\` parses the \`**[FROM CLAUDE CODE]**\` / \`**[FROM CLAUDE CHAT]**\` prefixes and the bracketed markers, never \`author.id\`.

No open questions remain. Moving to Todo.`,
  },
  {
    createdAt: '2026-09-15T05:10:26.298Z',
    body: '**[FROM CLAUDE CODE]**\n\n[SLACK] channel=C0C1VH2V50A ts=1789449026.198889 synced=1789449026.198889 q=9270df6dde09c2f7',
  },
  {
    createdAt: '2026-09-15T19:47:34.856Z',
    body: `**[FROM CLAUDE CHAT — RULING]**

Ruled 2026-09-15 — partial. This clears the original question only.

**So this ticket stays in Needs Ruling.** It also exceeds the seven-question cap, which is itself the finding: it is too large to rule on in one sitting and should be split.`,
  },
  {
    createdAt: '2026-09-15T21:59:10.866Z',
    body: `**[FROM CLAUDE CODE]**

[FINDING] A ticket reached In Progress twice with nothing behind it

Per the 21:55 ruling on TAC-395, which asked for a line here.`,
  },
  {
    createdAt: '2026-09-15T23:40:27.417Z',
    body: `**[FROM CLAUDE CODE]**

[FINDING] The \`Needs Ruling\` workflow state is archived, and both process files route to it 24 times

Flagged here per Jaipal's 23:26 ruling on TAC-411, because this ticket is already the one about status and attribution not meaning what they appear to mean.`,
  },
  {
    createdAt: '2026-09-17T16:17:15.672Z',
    body: `**[FROM CLAUDE CHAT — RULING]**

Rules the remaining questions to match how the automation behaves today.

1. **Q2 / B3: (b).** A comment starting \`**[FROM CLAUDE CHAT — RULING\` advances a gate, and so does an unprefixed comment.
2. **Q3 / B5: unescape \`\\[\` to \`[\`, then match with \`startsWith\`.**

Much of this may already be built. Verify each point against current code first. Close as verified for anything already correct.`,
  },
  {
    createdAt: '2026-09-17T17:18:04.424Z',
    body: `**[FROM CLAUDE CODE]**

[BUILD-SKIPPED] TAC-396

This ticket can't be built. It carries the analog-guest and analog-operator labels, and cross-repo work is two tickets, one per repo, linked. Built as one ticket, only one repo would build it and the other half would never be built.

Split it: one ticket per repo, each with its own repo label and Repo: line, linked to each other. Replying here will not unblock it: the ticket needs splitting.`,
  },
  {
    createdAt: '2026-09-17T18:15:07.096Z',
    body: `**[FROM CLAUDE CHAT]**

Split 2026-09-17 after the \`[BUILD-SKIPPED]\` notice above. The \`analog-operator\` label and half move to TAC-437; this ticket is the \`analog-guest\` half and keeps its \`Repo:\` scope accordingly.`,
  },
  {
    createdAt: '2026-09-17T20:39:05.281Z',
    body: `**[FROM CLAUDE CODE]**

[PLAN] TAC-396

Resuming via the \`[AUDIT]\` route: the second audit (\`762218ac\`) is \`lastQuestionComment\`, and every question it and the first audit raised (1–5, B1–B7) now has a ruling.

## Open questions

None. Proceeding to build on approval.`,
  },
  {
    createdAt: '2026-09-17T20:43:50.522Z',
    body: '**[FROM CLAUDE CODE]**\n\n[DENIALS] TAC-396 run=35271049290 count=8\n\nThis run\'s session did its work on this ticket but hit 8 permission denials on the way.',
  },
  {
    // Real: a bot comment with NO bracket marker directly after the
    // prefix at all — `commentMarker` returns null for it. Load-bearing
    // fixture: this is exactly the shape that must fall to "unchanged",
    // not to the null-is-falsy trap of reading it as no marker => clear.
    createdAt: '2026-09-17T23:04:40.616Z',
    body: `**[FROM CLAUDE CODE]**

Resume check, no new turn. \`lastQuestionComment\` is still this thread's own \`[PLAN]\` (a076489f, 2026-09-17T20:39:05Z) — no human reply has landed since.

The one thing that row assumes was already true wasn't: the ticket had no \`Needs Decision\` label despite the plan asking for one. Added it now.`,
  },
  {
    createdAt: '2026-09-17T23:10:24.406Z',
    body: `**[FROM CLAUDE CHAT — RULING]**

Plan approved as written. Build it.

The scope split is right: close the five as verified, build the three, one shared module rather than a third copy.

Note the consequence: the \`workflows\` token permission stays unverified after this ticket. That is fine here; it gets its own fixture.`,
  },
  {
    createdAt: '2026-09-17T23:13:20.002Z',
    body: '**[FROM CLAUDE CODE]**\n\n[DENIALS] TAC-396 run=35284910437 count=3\n\nThis run\'s session did its work on this ticket but hit 3 permission denials on the way.',
  },
  {
    createdAt: '2026-09-18T00:13:09.365Z',
    body: `**[FROM CLAUDE CODE]**

[NEEDS-ACTION] TAC-396

The buildable part of the approved plan is done and pushed. What's NOT in that PR: the two doc edits from the plan's items 1 and 2 — this session's tools refuse every write to \`.claude/process.md\` and \`.claude/commands/*.md\`.`,
  },
  {
    createdAt: '2026-09-18T00:13:42.078Z',
    body: '**[FROM CLAUDE CODE]**\n\n[DENIALS] TAC-396 run=35288433905 count=23\n\nThis run\'s session did its work on this ticket but hit 23 permission denials on the way.',
  },
  {
    createdAt: '2026-09-18T01:33:27.001Z',
    body: `**[FROM CLAUDE CHAT — RULING]**

**Reopening.** This ticket was marked Done with its \`[NEEDS-ACTION]\` never applied, and I merged PR #204 without checking the label. Found during TAC-437's build, 2026-09-17.

Build locally on a branch from current \`main\`. Do not commit to \`main\` and do not merge.`,
  },
  {
    createdAt: '2026-09-18T02:34:19.032Z',
    body: '**[FROM CLAUDE CODE]**\n\n[RESUME-CLAIM] ruling=55bea2c5-73f5-4433-9bb7-a0ee3845a70d run=35299836324',
  },
  {
    createdAt: '2026-09-18T02:40:36.757Z',
    body: `**[FROM CLAUDE CODE]**

Draft PR for the reopened wording: https://github.com/theanalogcompany/analog-guest/pull/208

Labels and status are unchanged. The PR is waiting for your review and merge.`,
  },
]

// ---------------------------------------------------------------------
// TAC-325: ongoing order capture after enrollment
// ---------------------------------------------------------------------
// Incident #3: the [PLAN] at 23:12:23 ended "## Open questions\n\nNone."
// and the label stayed on. This thread also carries a [TURN-LIMIT] and a
// [SILENT-RUN], both real markers this ticket's own build history hit.
const TAC_325_THREAD = [
  {
    createdAt: '2026-09-07T18:11:21.206Z',
    body: `**[FROM CLAUDE CHAT]**

Unblocked. TAC-332 shipped its opener-turn gate and TAC-330 passed UAT, so the recording defect this ticket depends on is closed.`,
  },
  {
    createdAt: '2026-09-15T02:44:31.973Z',
    body: `**[FROM CLAUDE CODE]**

[AUDIT] TAC-325

**3. QUESTIONS**

1. **Trigger.** Which inbounds may write an ongoing order?
   - (a) Any message the extractor reads as a completed order.
   - (b) Only a reply to a Sana message that asked what they got.
   - (c) Only present-tense reports ("just grabbed a cortado").
2. **Storage.** The live index allows one \`guest_reported\` row per guest, and enrollment's gate reads that source.
3. **Dedupe.** When a guest reports again, what counts as the same order?

**4. FINDINGS**

None.`,
  },
  {
    createdAt: '2026-09-15T05:10:28.270Z',
    body: '**[FROM CLAUDE CODE]**\n\n[SLACK] channel=C0C1VH2V50A ts=1789449028.172439 synced=1789449028.172439 q=ac3ad914348762cd',
  },
  {
    createdAt: '2026-09-17T18:10:02.077Z',
    body: `**[FROM CLAUDE CHAT — RULING]**

Ruled 2026-09-17.

1. **(a)** Any inbound the extractor reads as a completed order may write an ongoing capture.
2. **(a)** A new \`source\` value; enrollment's index and gate stay as they are.
3. **(a)** One row per guest per venue-local day, with later items merged into it.`,
  },
  {
    createdAt: '2026-09-17T23:12:23.473Z',
    body: `**[FROM CLAUDE CODE]**

[PLAN] TAC-325

Resuming via the \`[AUDIT]\` route: \`lastQuestionComment\` was the 2026-09-15 audit, and every question now has a ruling.

## Open questions

None. Every ruling maps to a concrete design decision above.`,
  },
  {
    createdAt: '2026-09-17T23:13:20.523Z',
    body: '**[FROM CLAUDE CODE]**\n\n[DENIALS] TAC-325 run=35284910437 count=3\n\nThis run\'s session did its work on this ticket but hit 3 permission denials on the way.',
  },
  {
    createdAt: '2026-09-17T23:45:27.093Z',
    body: `**[FROM CLAUDE CHAT — RULING]**

Plan approved as written. Build it.

Three things noted rather than changed.`,
  },
  {
    createdAt: '2026-09-18T01:46:36.677Z',
    body: `**[FROM CLAUDE CODE]**

[SILENT-RUN] TAC-325

The build workflow worked this ticket and its session posted nothing, so nothing here says what it did.`,
  },
  {
    createdAt: '2026-09-18T02:33:09.919Z',
    body: `**[FROM CLAUDE CHAT — RULING]**

Rebuild this. The plan approved on 2026-09-17 stands unchanged — nothing about it has become wrong.`,
  },
  {
    createdAt: '2026-09-18T02:57:30.277Z',
    body: '**[FROM CLAUDE CODE]**\n\n[RESUME-CLAIM] ruling=6b194892-cf23-42b7-9ce0-1ccc47f61b8a run=35299836324',
  },
  {
    createdAt: '2026-09-18T03:25:53.500Z',
    body: `**[FROM CLAUDE CODE]**

[TURN-LIMIT] TAC-325

The build session was stopped at its turn limit (121 turns against a limit of 120).`,
  },
  {
    createdAt: '2026-09-18T03:32:39.735Z',
    body: `**[FROM CLAUDE CHAT — RULING]**

Continue from the branch. Do not start over, and do not split the ticket yet.`,
  },
  {
    createdAt: '2026-09-18T04:20:41.738Z',
    body: `**[FROM CLAUDE CODE]**

[NEEDS-ACTION] TAC-325

Draft PR: https://github.com/theanalogcompany/analog-guest/pull/211

Build finished pending a Studio migration.`,
  },
  {
    createdAt: '2026-09-18T04:22:08.190Z',
    body: '**[FROM CLAUDE CODE]**\n\n[DENIALS] TAC-325 run=35306017791 count=9\n\nThis run\'s session did its work on this ticket but hit 9 permission denials on the way.',
  },
  {
    createdAt: '2026-09-18T04:28:02.514Z',
    body: `**[FROM CLAUDE CHAT — RULING]**

**Migration applied, 2026-09-18.** Steps 1 through 4 run in Supabase Studio against production.`,
  },
  {
    createdAt: '2026-09-18T15:46:30.138Z',
    body: `**[FROM CLAUDE CHAT — RULING]**

**Gate passed on device at Le Mil's, 2026-09-18.** Closing.

Tested with a fresh QR enrolment guest, real inbound messages, real generation path.`,
  },
]

// ---------------------------------------------------------------------
// TAC-389: decline draft has no structural anchor to the commitment
// ---------------------------------------------------------------------
// Incident #4: the label stayed on after every question in
// "## Open questions — decline half only" was ruled. Trimmed to end right
// after that ruling (2026-09-17T16:37:20.921Z) — the moment the incident
// is about. TAC-389's real thread continues past this point into an
// unrelated repo-split defect ([HUMAN-REVIEW-REQUIRED] followed by
// [BUILD-SKIPPED], which is its own puzzle CLAUDE.md doesn't document and
// this ticket doesn't touch); including it would test that defect, not
// this one, so the fixture stops here. Every comment kept is real.
const TAC_389_THREAD = [
  {
    // Real: another bot comment with no bracket marker at all, this time
    // bold prose rather than a bracketed one.
    createdAt: '2026-09-14T20:00:34.415Z',
    body: `**[FROM CLAUDE CODE]**

**Finding from TAC-394: a heads-up decline can overwrite a pending draft that carries a different obligation. TAC-394's planned fix won't cover this path.** Recorded here because this ticket owns the endpoint. Nothing is fixed and no code changed for it.`,
  },
  {
    createdAt: '2026-09-15T02:45:20.803Z',
    body: `**[FROM CLAUDE CODE]**

[AUDIT] TAC-389

Verified against \`main\` at \`dcf7eae\`, the live database (read-only SELECTs), four Langfuse traces from the incident, and \`analog-operator\` \`main\`. No code changed, no SQL written.

## 3. QUESTIONS

1. **The wrong-commitment defect doesn't reproduce. What happens to the decline half of this ticket?**
   (a) Drop it; the ticket becomes the out-of-hours arrival defect only.
   (b) Keep acceptance criteria 1-3 as regression tests with no code change.
   (c) Re-run the decline swipe on device, then decide.
2. **An \`imminent\` arrival arrives while the venue is \`closed\`. What does capture record?**
3. **When \`resolveOpenState\` returns \`unknown\` (hours unreadable), does an imminent arrival behave as open or closed?**
4. **The CLOSED line was in the prompt and the model still said "See you soon". What enforces the reply?**
5. **A recommendation reached \`pending_ack\` and became a card. Where does that change, and in which ticket?**
6. **The earlier \`[FROM CLAUDE CODE]\` comment on this ticket is half closed. What should a decline do when that card is a knowledge-gap card?**

## 4. FINDINGS

None.`,
  },
  {
    createdAt: '2026-09-15T05:10:26.681Z',
    body: '**[FROM CLAUDE CODE]**\n\n[SLACK] channel=C0C1VH2V50A ts=1789449026.578609 synced=1789449026.578609 q=f76897f87fcf01c4',
  },
  {
    createdAt: '2026-09-16T00:20:36.242Z',
    body: `**[FROM CLAUDE CODE]**

[AUDIT] TAC-389

Second pass, scoped to the **decline half** as directed. Verified against \`main\` at \`846aab3\`, the live database.

## 3. QUESTIONS

**The cap is exceeded and that is itself the finding.** Merged with the five still open from the first pass, this ticket now carries **nine** distinct decisions across two unrelated defects.

1. **The decline body's only anchor is a description quoted in prose; the id never reaches the model. What anchors it?**
2. **On a decline turn the \`## Active commitments\` intro invites weaving an arrival ask for still-open siblings. What renders?**
3. **The decline path runs no gate and no verification backstop. Does it get a post-generation check?**
4. **Acceptance criteria 2 and 3 demand a test that the draft cannot be about the wrong commitment. Against a free-text model body, what counts?**
5. **An \`imminent\` arrival arrives while the venue is \`closed\`. What does capture record?** *(first pass, unchanged)*
6. **When \`resolveOpenState\` returns \`unknown\`, does an imminent arrival behave as open or closed?** *(first pass, unchanged)*
7. **The CLOSED status line was in the 1:03am prompt and the model still said "See you soon". What enforces the reply?** *(first pass, unchanged)*

## 4. FINDINGS

None.`,
  },
  {
    createdAt: '2026-09-16T00:22:48.034Z',
    body: `**[FROM CLAUDE CODE]**

[NEEDS-INPUT] Status left in Todo: the **Needs Ruling** status no longer exists.

The audit above ended by saying it would move this to Needs Ruling. It could not — \`Needs Ruling\` is archived.`,
  },
  {
    createdAt: '2026-09-17T16:37:09.964Z',
    body: `**[FROM CLAUDE CHAT]**

**Correction:** this ticket was already split on 2026-09-16, and the arrival half lives in **TAC-363**. TAC-435 was created in error and is marked a duplicate of TAC-363. Ignore it.`,
  },
  {
    createdAt: '2026-09-17T16:37:20.921Z',
    body: `**[FROM CLAUDE CHAT — RULING]**

Decline half, ruled 2026-09-17.

1. **(b)** On a decline turn, filter \`ctx.activeCommitments\` to the declined row only. The draft has one job; siblings are what it drifted toward.
2. **(b)** A decline-specific intro for \`## Active commitments\` that drops the arrival-ask invitation.
3. **(a)** No post-generation check. Every decline draft lands on the operator's edit screen before sending.
4. **(a)** A structural test that the declined row is the only one rendered.
5. **The decline regenerating a pending knowledge-gap card in the conversation slot: separate ticket**, filed from Chat. Out of scope here.

Arrival capture outside venue hours is TAC-363.`,
  },
]

describe('deriveNeedsDecision', () => {
  it('TAC-396: ends false — the last real word on the thread is a ruling', () => {
    expect(deriveNeedsDecision(TAC_396_THREAD)).toBe(false)
  })

  it('TAC-396: goes true the moment [BUILD-SKIPPED] posts (incident: never removed after a plan with no open questions is the mirror; this is the other direction)', () => {
    const upToBuildSkipped = TAC_396_THREAD.filter((c) => c.createdAt <= '2026-09-17T17:18:04.424Z')
    expect(deriveNeedsDecision(upToBuildSkipped)).toBe(true)
  })

  it('TAC-396: goes false the moment the 23:10:24 approval ruling posts — the exact moment incident #2 says it should have cleared and did not', () => {
    const upToApproval = TAC_396_THREAD.filter((c) => c.createdAt <= '2026-09-17T23:10:24.406Z')
    expect(deriveNeedsDecision(upToApproval)).toBe(false)
  })

  it('TAC-396: a bot comment with no marker at all ("Resume check, no new turn") never changes the state', () => {
    const upToNoMarkerComment = TAC_396_THREAD.filter((c) => c.createdAt <= '2026-09-17T23:04:40.616Z')
    const upToJustBefore = TAC_396_THREAD.filter((c) => c.createdAt < '2026-09-17T23:04:40.616Z')
    expect(deriveNeedsDecision(upToNoMarkerComment)).toBe(deriveNeedsDecision(upToJustBefore))
  })

  it('TAC-325: ends false — matches the ticket, which reached Ready For QA with no label', () => {
    expect(deriveNeedsDecision(TAC_325_THREAD)).toBe(false)
  })

  it('TAC-325: the [PLAN] ending "Open questions: None" sets it true — the label should have gone on and, per incident #3, never came off wrongly either since the very next comment is a ruling', () => {
    const upToPlan = TAC_325_THREAD.filter((c) => c.createdAt <= '2026-09-17T23:12:23.473Z')
    expect(deriveNeedsDecision(upToPlan)).toBe(true)
  })

  it('TAC-325: [TURN-LIMIT] and [SILENT-RUN] both set it true, same as [PLAN]', () => {
    const upToSilentRun = TAC_325_THREAD.filter((c) => c.createdAt <= '2026-09-18T01:46:36.677Z')
    expect(deriveNeedsDecision(upToSilentRun)).toBe(true)
    const upToTurnLimit = TAC_325_THREAD.filter((c) => c.createdAt <= '2026-09-18T03:25:53.500Z')
    expect(deriveNeedsDecision(upToTurnLimit)).toBe(true)
  })

  it('TAC-389: the two [AUDIT]s each set it true — both have real numbered questions', () => {
    const upToFirstAudit = TAC_389_THREAD.filter((c) => c.createdAt <= '2026-09-15T02:45:20.803Z')
    expect(deriveNeedsDecision(upToFirstAudit)).toBe(true)
    const upToSecondAudit = TAC_389_THREAD.filter((c) => c.createdAt <= '2026-09-16T00:20:36.242Z')
    expect(deriveNeedsDecision(upToSecondAudit)).toBe(true)
  })

  it('TAC-389: goes false the moment the ruling answering every open question posts — incident #4, which the real ticket got wrong', () => {
    expect(deriveNeedsDecision(TAC_389_THREAD)).toBe(false)
  })

  it('TAC-389: a bot comment with no marker at all ("Finding from TAC-394") never changes the state', () => {
    expect(deriveNeedsDecision(TAC_389_THREAD.slice(0, 1))).toBe(false)
  })

  it('is false on an empty thread', () => {
    expect(deriveNeedsDecision([])).toBe(false)
    expect(deriveNeedsDecision(undefined)).toBe(false)
  })

  it('does not depend on input order — it sorts by createdAt itself', () => {
    const forwards = deriveNeedsDecision(TAC_396_THREAD)
    const shuffled = deriveNeedsDecision([...TAC_396_THREAD].reverse())
    expect(shuffled).toBe(forwards)
  })

  // TAC-499: the [AUDIT] branch used to run its own parser
  // (auditHasOpenQuestions, deleted) rather than comment-provenance.mjs's
  // auditHasQuestions — the same function pending-question.mjs's selection
  // gate already used. The two disagreed on the colon-terminated
  // "**Decided without asking:**" heading most real audits actually render
  // (confirmed against TAC-471, TAC-493, TAC-490, TAC-487, TAC-483,
  // TAC-480): the deleted regex required nothing but whitespace before the
  // closing `**` and so never matched the colon form, silently reading the
  // numbered "Decided without asking" list beneath it as still-open
  // questions. These two tests are what deriveNeedsDecision itself does
  // with that shape now, both via a real audit and a constructed one built
  // to isolate exactly the difference.
  it('TAC-499: this ticket\'s own real [AUDIT] comment (colon-form heading) — ends false, not still asking', () => {
    // Trimmed per this file's own convention above ("never paraphrased"):
    // the 1. CONFIRMED / 2. WRONG / 5. UNBLOCKED sections are dropped
    // whole (they don't affect classification), and each bullet under
    // "Decided without asking:" is cut at its own bold lead sentence — a
    // natural sentence boundary in the real text, not a paraphrase. The
    // 4. FINDINGS section is dropped too, for the same reason this file's
    // header already gives for TAC-396/325/389: only the QUESTIONS section
    // matters here. Fetched 2026-09-19.
    const tac499RealAudit = `**[FROM CLAUDE CODE]**

[AUDIT] TAC-499

**3. QUESTIONS**

None.

**Decided without asking:**

- **Which parser is correct where they differ.**
- **Whether the two gates should be allowed to genuinely disagree.**
- **Whether TAC-470 is a usable comparison fixture for this ticket's item 1.**`
    expect(deriveNeedsDecision([{ createdAt: '2026-09-19T21:17:08.849Z', body: tac499RealAudit }])).toBe(false)
  })

  it('TAC-499: a colon-form "**Decided without asking:**" heading followed by a NUMBERED list — the exact shape the deleted regex would have misread as still asking', () => {
    // Same shape as this file's former "clean audit" fixture (a plain
    // "Decided without asking" heading, no colon, per audit-ticket.md's
    // literal template), but with the colon real audits actually render.
    // Constructed, documented as such, same disclosure convention as that
    // fixture: no three-named-ticket real thread in this file happens to
    // pair a colon-form heading with a numbered (not bulleted) list.
    const body = `**[FROM CLAUDE CODE]**

[AUDIT] TAC-999

**3. QUESTIONS**

None — every ambiguity found resolves to an implementation detail.

**Decided without asking:**

1. Reused the existing helper rather than writing a new one — matches the file's own convention.
2. Named the new file to mirror its sibling — no ambiguity to resolve.

**4. FINDINGS**

None.`
    expect(deriveNeedsDecision([{ createdAt: '2026-09-19T21:17:08.849Z', body }])).toBe(false)
  })
})

// A ticket whose newest comment (at this point in the thread) is
// [BUILD-SKIPPED] — derives true — but which never got the label written,
// same shape as incident #1 (a denied or skipped write).
const TAC_396_AT_BUILD_SKIPPED = TAC_396_THREAD.filter((c) => c.createdAt <= '2026-09-17T17:18:04.424Z')

describe('reconcile', () => {
  it('AC5: writes the add action when a plan or notice that asks something never got the label', () => {
    const candidates = [{ id: 'id-1', identifier: 'TAC-1', hasNeedsDecision: false, hasNeedsAction: false, comments: TAC_396_AT_BUILD_SKIPPED }]
    expect(reconcile(candidates)).toEqual([{ id: 'id-1', identifier: 'TAC-1', action: 'add' }])
  })

  it('AC5: writes the remove action when a stale label disagrees with a cleared derived state', () => {
    const candidates = [{ id: 'id-1', identifier: 'TAC-1', hasNeedsDecision: true, hasNeedsAction: false, comments: TAC_396_THREAD }]
    expect(reconcile(candidates)).toEqual([{ id: 'id-1', identifier: 'TAC-1', action: 'remove' }])
  })

  it('writes nothing when the stored label already matches the derived state', () => {
    const candidates = [{ id: 'id-1', identifier: 'TAC-1', hasNeedsDecision: false, hasNeedsAction: false, comments: TAC_396_THREAD }]
    expect(reconcile(candidates)).toEqual([])
  })

  it('skips a candidate carrying Needs Action, whatever the derived state', () => {
    const candidates = [{ id: 'id-1', identifier: 'TAC-1', hasNeedsDecision: false, hasNeedsAction: true, comments: TAC_396_AT_BUILD_SKIPPED }]
    expect(reconcile(candidates)).toEqual([])
  })

  it('writes nothing for an empty candidate list', () => {
    expect(reconcile([])).toEqual([])
    expect(reconcile(undefined)).toEqual([])
  })

  it('reconciles every candidate independently, in order', () => {
    const candidates = [
      { id: 'id-1', identifier: 'TAC-1', hasNeedsDecision: false, hasNeedsAction: false, comments: TAC_396_AT_BUILD_SKIPPED },
      { id: 'id-2', identifier: 'TAC-2', hasNeedsDecision: false, hasNeedsAction: false, comments: TAC_396_THREAD },
      { id: 'id-3', identifier: 'TAC-3', hasNeedsDecision: true, hasNeedsAction: false, comments: TAC_325_THREAD },
    ]
    expect(reconcile(candidates)).toEqual([
      { id: 'id-1', identifier: 'TAC-1', action: 'add' },
      { id: 'id-3', identifier: 'TAC-3', action: 'remove' },
    ])
  })
})

describe('run', () => {
  function invoke(stdin: string) {
    const out: string[] = []
    const err: string[] = []
    const code = run({
      stdin,
      stdout: (s: string) => out.push(s),
      stderr: (s: string) => err.push(s),
    })
    return { code, out: out.join(''), err: err.join('') }
  }

  it('prints the writes to make, in the shape the workflow reads', () => {
    const r = invoke(JSON.stringify([{ id: 'id-1', identifier: 'TAC-1', hasNeedsDecision: false, hasNeedsAction: false, comments: TAC_396_AT_BUILD_SKIPPED }]))
    expect(r.code).toBe(EXIT.OK)
    expect(JSON.parse(r.out)).toEqual([{ id: 'id-1', identifier: 'TAC-1', action: 'add' }])
    expect(r.err).toBe('')
  })

  it('prints an empty array, not nothing, when there is nothing to write', () => {
    const r = invoke('[]')
    expect(r.code).toBe(EXIT.OK)
    expect(JSON.parse(r.out)).toEqual([])
  })

  it('refuses non-JSON stdin as a usage error', () => {
    const r = invoke('not json')
    expect(r.code).toBe(EXIT.USAGE)
    expect(r.out).toBe('')
    expect(r.err).toContain(USAGE)
  })

  it('refuses a non-array payload', () => {
    const r = invoke('{}')
    expect(r.code).toBe(EXIT.USAGE)
  })
})
