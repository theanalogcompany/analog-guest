import { describe, expect, it } from 'vitest'
import { pendingQuestionLabel } from './pending-question.mjs'
import { deriveNeedsDecision } from './reconcile-needs-decision.mjs'

/**
 * TAC-499: the build selection's gate (pending-question.mjs's
 * pendingQuestionLabel, TAC-453) and the Needs Decision label reconciler
 * (reconcile-needs-decision.mjs's deriveNeedsDecision, TAC-446) both answer
 * "does this ticket's [AUDIT] comment still ask Jaipal something?" — one to
 * decide whether a build run may START the ticket, the other to decide
 * whether Needs Decision should be WRITTEN. They shipped from the same spec
 * within an hour of each other and, until this ticket, answered it with two
 * separate parsers that could silently disagree: one read the colon-form
 * "**Decided without asking:**" heading most real audits render and the
 * other didn't, so a ticket could read as answered to one and still-asking
 * to the other with nothing recording that the two disagreed.
 *
 * Both now delegate to comment-provenance.mjs's auditHasQuestions, so
 * agreement is structural rather than coincidental — but this file asserts
 * on the two PUBLIC gates' behaviour, not on that shared internal, so it
 * keeps working as a regression guard even if either module's
 * implementation changes later, and it would have failed before this fix
 * (the colon-form-plus-numbered-list case below is exactly the shape that
 * made the deleted auditHasOpenQuestions disagree with auditHasQuestions).
 *
 * Each corpus entry is the sole, newest comment of a thread — the shape
 * both gates actually consume in production (an [AUDIT] comment nothing
 * has replied to yet). Deliberately not a shared fixture module across the
 * three test files here, comment-provenance.test.ts and
 * reconcile-needs-decision.test.ts: each transcribes its own small corpus
 * (real bodies, one documented as constructed), matching how those two
 * files already avoid depending on each other's fixtures.
 */

const CREATED_AT = '2026-09-19T21:17:08.849Z'

// TAC-273's real [AUDIT] comment, fetched 2026-09-18 (also used in
// comment-provenance.test.ts): a clean audit, colon-form
// "**Decided without asking:**" heading, bulleted (not numbered) list.
const TAC_273_CLEAN_AUDIT = `**[FROM CLAUDE CODE]**

[AUDIT] TAC-273

**1. CONFIRMED**

- Outage A's exact repro is still live in the code.

**2. WRONG**

- The "Technical approach" file list is stale.

**3. QUESTIONS**

None. The ticket's own "User-facing behavior" and "Out of scope" sections already settle the questions that would otherwise need asking (analog admins always see everything in Command Center, unconditionally on their own \`operator_venues\` rows; the operator dashboard's separate scoping is out of scope here).

**Decided without asking:**

- Fixing \`verifyAnalogAdminAccess\`'s own \`allowedVenueIds\` (the root of the 2026-09-13 recurrence), not just the six page-level call sites, is in scope for this ticket.
- Removing the vestigial \`operator_venues.permission_level = 'analog_admin'\` value is out of scope here.

**4. FINDINGS**

- The auth module's own test suite locks in the exact scope-drift bug as its "happy path."

**5. UNBLOCKED**

- Building \`getAdminScopedVenueIds(operatorId)\` needs no further input.`

// TAC-396's real [AUDIT] comment, trimmed to its QUESTIONS and FINDINGS
// sections per this file's and reconcile-needs-decision.test.ts's own
// convention (CONFIRMED/WRONG don't affect classification) — seven real
// numbered questions, no "Decided without asking" subsection at all.
const TAC_396_AUDIT_WITH_QUESTIONS = `**[FROM CLAUDE CODE]**

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

- F1. analog-operator's work-ticket.md cites CLAUDE.md sections this repo doesn't have.`

// Constructed, documented as such (not trimmed from a real thread): a
// colon-form "**Decided without asking:**" heading followed by a NUMBERED
// list. This is the exact shape that made the two gates disagree before
// this ticket — the deleted auditHasOpenQuestions required nothing but
// whitespace between "asking" and the closing "**", so the colon defeated
// its heading match, and it then read the numbered list beneath as an
// open question. auditHasQuestions's plain substring split never cared
// about the punctuation and always read this as answered.
const COLON_FORM_NUMBERED_LIST = `**[FROM CLAUDE CODE]**

[AUDIT] TAC-999

**3. QUESTIONS**

None — every ambiguity found resolves to an implementation detail.

**Decided without asking:**

1. Reused the existing helper rather than writing a new one — matches the file's own convention.
2. Named the new file to mirror its sibling — no ambiguity to resolve.

**4. FINDINGS**

None.`

// This ticket's own real [AUDIT] comment, fetched 2026-09-19, trimmed per
// the same convention as TAC_396_AUDIT_WITH_QUESTIONS above: 1. CONFIRMED,
// 2. WRONG, 4. FINDINGS and 5. UNBLOCKED dropped whole (don't affect
// classification), and each "Decided without asking:" bullet cut at its
// own bold lead sentence — a natural sentence boundary in the real text,
// not a paraphrase.
const TAC_499_REAL_AUDIT = `**[FROM CLAUDE CODE]**

[AUDIT] TAC-499

**3. QUESTIONS**

None.

**Decided without asking:**

- **Which parser is correct where they differ.**
- **Whether the two gates should be allowed to genuinely disagree.**
- **Whether TAC-470 is a usable comparison fixture for this ticket's item 1.**`

const CORPUS: Array<{ name: string; body: string; stillAsking: boolean }> = [
  { name: 'TAC-273 clean audit, colon-form heading, bulleted list', body: TAC_273_CLEAN_AUDIT, stillAsking: false },
  { name: 'TAC-396 real audit, seven real numbered questions', body: TAC_396_AUDIT_WITH_QUESTIONS, stillAsking: true },
  { name: 'constructed: colon-form heading, NUMBERED list (pre-fix disagreement case)', body: COLON_FORM_NUMBERED_LIST, stillAsking: false },
  { name: 'TAC-499 own real audit, colon-form heading, bulleted list', body: TAC_499_REAL_AUDIT, stillAsking: false },
]

describe('the selection gate and the label gate agree on every corpus body', () => {
  it.each(CORPUS)('$name', ({ body, stillAsking }) => {
    const comment = { createdAt: CREATED_AT, body }

    const selectionSaysAsking = pendingQuestionLabel([comment]) === 'Needs Decision'
    const labelSaysAsking = deriveNeedsDecision([comment])

    // The acceptance criterion itself: whatever either gate says, they must
    // say the same thing. Asserted before the expected-value checks below,
    // so a genuine disagreement fails here with its own message rather than
    // being read as "one of them was simply wrong."
    expect(selectionSaysAsking).toBe(labelSaysAsking)

    // And both must be RIGHT, not merely equal to each other — two gates
    // agreeing on the wrong answer would pass the line above and still be
    // a real defect.
    expect(selectionSaysAsking).toBe(stillAsking)
    expect(labelSaysAsking).toBe(stillAsking)
  })
})
