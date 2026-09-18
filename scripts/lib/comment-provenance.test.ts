import { describe, expect, it } from 'vitest'
import {
  BOOKKEEPING_MARKERS,
  auditHasQuestions,
  commentMarker,
  isBookkeepingComment,
  isBotComment,
  isContextChatComment,
  isRulingComment,
  unescapeBrackets,
} from './comment-provenance.mjs'

// A thread shaped like TAC-394's: every comment shares one author id, which
// is exactly the production state that made author-id-based provenance
// unusable (TAC-396). None of these fixtures carries an `author` field —
// proof by construction that the functions under test never read one.
const HRR_NO_REPLY = '**[FROM CLAUDE CODE]**\n\n[HUMAN-REVIEW-REQUIRED] TAC-394\n\nPlan v2 is high-stakes. Waiting for a ruling.'
const HRR_ESCAPED = '**\\[FROM CLAUDE CODE\\]**\n\n\\[HUMAN-REVIEW-REQUIRED\\] TAC-394\n\nPlan v2 is high-stakes. Waiting for a ruling.'
const CHAT_PLAIN = '**[FROM CLAUDE CHAT]**\n\nSplit 2026-09-17 after the [BUILD-SKIPPED] notice above. The analog-operator label and half move to TAC-437.'
const CHAT_RULING = '**[FROM CLAUDE CHAT — RULING, posted on Jaipal\'s behalf]**\n\nRuled 2026-09-15. Option 1: key on the prefix.'
const CHAT_RULING_BARE = '**[FROM CLAUDE CHAT — RULING]**\n\nPlan approved as written. Build it.'
const QUOTES_MARKER_MIDBODY = '**[FROM CLAUDE CODE]**\n\n[AUDIT] TAC-443\n\nLater on, a run might post [NEEDS-INPUT] if it hits a question, but none was raised here.'
const SLACK_REPLY = '**Ruling, via Slack**\n\nOption 1, go ahead.'
const PLAN_COMMENT = '**[FROM CLAUDE CODE]**\n\n[PLAN] TAC-396\n\nResuming via the [AUDIT] route...'
const DENIALS_BOOKKEEPING = '**[FROM CLAUDE CODE]**\n\n[DENIALS] TAC-396 run=35284910437 count=3\n\nThis run hit 3 permission denials.'

describe('isBotComment', () => {
  it('recognises the plain CC prefix', () => {
    expect(isBotComment(HRR_NO_REPLY)).toBe(true)
  })

  it('recognises an escaped CC prefix', () => {
    expect(isBotComment(HRR_ESCAPED)).toBe(true)
  })

  it('does not recognise a plain CHAT comment as CC\'s own', () => {
    expect(isBotComment(CHAT_PLAIN)).toBe(false)
  })

  it('does not recognise a CHAT — RULING comment as CC\'s own', () => {
    expect(isBotComment(CHAT_RULING)).toBe(false)
  })

  it('does not recognise an unprefixed human reply as CC\'s own', () => {
    expect(isBotComment(SLACK_REPLY)).toBe(false)
  })

  it('does not recognise a comment that merely quotes the prefix mid-body', () => {
    expect(isBotComment('Someone pasted **[FROM CLAUDE CODE]** into a reply.')).toBe(false)
  })
})

describe('commentMarker', () => {
  it('reads the marker directly after the CC prefix', () => {
    expect(commentMarker(HRR_NO_REPLY)).toBe('HUMAN-REVIEW-REQUIRED')
    expect(commentMarker(PLAN_COMMENT)).toBe('PLAN')
    expect(commentMarker(DENIALS_BOOKKEEPING)).toBe('DENIALS')
  })

  it('reads the marker after an escaped CC prefix', () => {
    expect(commentMarker(HRR_ESCAPED)).toBe('HUMAN-REVIEW-REQUIRED')
  })

  it('never reads a marker quoted mid-body as the comment\'s own marker', () => {
    // The comment's real marker is [AUDIT]; [NEEDS-INPUT] only appears later
    // in the body and must not be picked up.
    expect(commentMarker(QUOTES_MARKER_MIDBODY)).toBe('AUDIT')
  })

  it('returns null for a non-CC comment, whatever it contains', () => {
    expect(commentMarker(CHAT_RULING)).toBeNull()
    expect(commentMarker(SLACK_REPLY)).toBeNull()
  })
})

describe('isRulingComment', () => {
  it('recognises the — RULING, posted on Jaipal\'s behalf form', () => {
    expect(isRulingComment(CHAT_RULING)).toBe(true)
  })

  it('recognises the bare — RULING form', () => {
    expect(isRulingComment(CHAT_RULING_BARE)).toBe(true)
  })

  it('does not recognise a plain CHAT comment with no — RULING', () => {
    expect(isRulingComment(CHAT_PLAIN)).toBe(false)
  })

  it('does not recognise a CC comment as a ruling', () => {
    expect(isRulingComment(HRR_NO_REPLY)).toBe(false)
  })

  it('does not recognise an unprefixed human reply as a ruling', () => {
    expect(isRulingComment(SLACK_REPLY)).toBe(false)
  })
})

describe('isContextChatComment', () => {
  it('recognises a plain CHAT comment', () => {
    expect(isContextChatComment(CHAT_PLAIN)).toBe(true)
  })

  it('does not recognise a CHAT — RULING comment as plain context', () => {
    expect(isContextChatComment(CHAT_RULING)).toBe(false)
    expect(isContextChatComment(CHAT_RULING_BARE)).toBe(false)
  })

  it('does not recognise a CC comment', () => {
    expect(isContextChatComment(HRR_NO_REPLY)).toBe(false)
  })
})

describe('unescapeBrackets', () => {
  it('turns escaped brackets back into plain ones', () => {
    expect(unescapeBrackets('**\\[FROM CLAUDE CODE\\]**\n\n\\[AUDIT\\] TAC-1'))
      .toBe('**[FROM CLAUDE CODE]**\n\n[AUDIT] TAC-1')
  })

  it('is a no-op on text with no escaped brackets', () => {
    expect(unescapeBrackets(PLAN_COMMENT)).toBe(PLAN_COMMENT)
  })
})

// A HUMAN-REVIEW-REQUIRED comment written by CC must never be readable, by
// any of these functions, as a human ruling — the exact failure this ticket
// exists to close (TAC-396).
describe('a CC HUMAN-REVIEW-REQUIRED comment is never a ruling', () => {
  it('for the plain prefix', () => {
    expect(isBotComment(HRR_NO_REPLY)).toBe(true)
    expect(isRulingComment(HRR_NO_REPLY)).toBe(false)
    expect(commentMarker(HRR_NO_REPLY)).toBe('HUMAN-REVIEW-REQUIRED')
  })

  it('for the escaped prefix Linear can return', () => {
    expect(isBotComment(HRR_ESCAPED)).toBe(true)
    expect(isRulingComment(HRR_ESCAPED)).toBe(false)
    expect(commentMarker(HRR_ESCAPED)).toBe('HUMAN-REVIEW-REQUIRED')
  })
})

describe('isBookkeepingComment', () => {
  it('recognises every marker in BOOKKEEPING_MARKERS', () => {
    for (const marker of BOOKKEEPING_MARKERS) {
      expect(isBookkeepingComment(`**[FROM CLAUDE CODE]**\n\n[${marker}] TAC-1`)).toBe(true)
    }
  })

  it('does not recognise a marker outside the list', () => {
    expect(isBookkeepingComment(PLAN_COMMENT)).toBe(false)
    expect(isBookkeepingComment(HRR_NO_REPLY)).toBe(false)
  })

  it('does not recognise a non-CC comment, whatever it contains', () => {
    expect(isBookkeepingComment('[CLAIM] TAC-1 mentioned mid-body, no prefix')).toBe(false)
    expect(isBookkeepingComment(CHAT_RULING)).toBe(false)
  })
})

describe('auditHasQuestions', () => {
  // TAC-273's real [AUDIT] comment, fetched 2026-09-18: its own QUESTIONS
  // section says "None." and lists two calls under "Decided without
  // asking" — real evidence that a decided-without-asking bullet must never
  // read as a question, whatever number precedes similar lines elsewhere in
  // the same comment.
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

  // TAC-386's real [AUDIT] comment, fetched 2026-09-18: headed with "##"
  // rather than bold asterisks, and its QUESTIONS section carries twelve
  // real numbered questions (trimmed to the first two here).
  const TAC_386_AUDIT_WITH_QUESTIONS = `**[FROM CLAUDE CODE]**

[AUDIT] TAC-386

## 1. CONFIRMED

- \`crisisSafety\` is a boolean on the single \`classifyMessage\` call.

## 2. WRONG

- "\`classifyMessage\` already runs on every inbound." It doesn't run on a photo sent without text.

## 3. QUESTIONS

1. **What counts as implying a visit?** Le Mil's has 11 real inbounds from guests other than Jaipal.
   - (a) A stated plan to come, alone or with a logistics question.
   - (b) A logistics question whose only purpose is a visit.
2. **Is the delay fixed or taken from venue hours?**
   - (a) A fixed number of hours after the question.
   - (b) Worked out from venue hours.

## 4. FINDINGS

- A real guest's question at Le Mil's produced no row at all.

## 5. UNBLOCKED

- Measure the classifier's output headroom.`

  it('reads a real clean audit as asking nothing, bold-heading form', () => {
    expect(auditHasQuestions(TAC_273_CLEAN_AUDIT)).toBe(false)
  })

  it('reads a real audit with numbered questions as still asking, "## N. NAME" heading form', () => {
    expect(auditHasQuestions(TAC_386_AUDIT_WITH_QUESTIONS)).toBe(true)
  })

  it('does not read a "Decided without asking" bullet as a question', () => {
    const decidedOnly = `**[FROM CLAUDE CODE]**

[AUDIT] TAC-1

**3. QUESTIONS**

None.

**Decided without asking:**

- Some decision, numbered like a question would be: 1. not actually a question, just prose.

**4. FINDINGS**

None.`
    expect(auditHasQuestions(decidedOnly)).toBe(false)
  })

  it('defaults to true — still asking — when it cannot find a QUESTIONS heading at all', () => {
    const noHeading = `**[FROM CLAUDE CODE]**

[AUDIT] TAC-1

Some unstructured audit text with no recognisable section headings.`
    expect(auditHasQuestions(noHeading)).toBe(true)
  })

  it('is heading-tolerant: matches "### 3. Questions" mixed case', () => {
    const mixedCase = `**[FROM CLAUDE CODE]**

[AUDIT] TAC-1

### 3. QUESTIONS

1. A real numbered question.

### 4. FINDINGS

None.`
    expect(auditHasQuestions(mixedCase)).toBe(true)
  })

  it('unescapes brackets before parsing, matching the rest of the module', () => {
    const escaped = TAC_273_CLEAN_AUDIT.replace(/\[/g, '\\[').replace(/\]/g, '\\]')
    expect(auditHasQuestions(escaped)).toBe(false)
  })
})
