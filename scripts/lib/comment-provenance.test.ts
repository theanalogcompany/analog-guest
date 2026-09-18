import { describe, expect, it } from 'vitest'
import {
  commentMarker,
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
