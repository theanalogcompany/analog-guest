import { describe, expect, it } from 'vitest'
import { PROMPT_VERSION } from '@/lib/ai/prompts/system-template'
import {
  buildCrisisSafetyResult,
  CRISIS_SAFETY_REPLY_BODY,
  CRISIS_SAFETY_REVIEW_REASON,
} from './crisis-safety'

describe('CRISIS_SAFETY_REPLY_BODY (TAC-348)', () => {
  it('names both required resources', () => {
    expect(CRISIS_SAFETY_REPLY_BODY).toContain('911')
    expect(CRISIS_SAFETY_REPLY_BODY).toContain('988')
  })

  it('contains no em or en dashes (R3)', () => {
    expect(CRISIS_SAFETY_REPLY_BODY).not.toMatch(/[—–]/)
  })

  it('does not claim to have seen or been with the guest', () => {
    const lower = CRISIS_SAFETY_REPLY_BODY.toLowerCase()
    expect(lower).not.toContain('saw you')
    expect(lower).not.toContain('glad you came in')
  })

  it('does not name a venue, staff member, or menu item', () => {
    // Loose guard: the fixed body is short and hand-authored, so this is a
    // content sanity check rather than an exhaustive scan.
    expect(CRISIS_SAFETY_REPLY_BODY).not.toMatch(/menu|perk|drink|latte|cortado|cafe|café/i)
  })

  it('does not ask a clarifying question', () => {
    expect(CRISIS_SAFETY_REPLY_BODY).not.toContain('?')
  })
})

describe('buildCrisisSafetyResult (TAC-348)', () => {
  const result = buildCrisisSafetyResult()

  it('uses the fixed body', () => {
    expect(result.body).toBe(CRISIS_SAFETY_REPLY_BODY)
  })

  it('stamps voiceFidelity=0, not a high score — this text was never matched to the venue voice (mirrors buildFallbackGeneration)', () => {
    expect(result.voiceFidelity).toBe(0)
    expect(result.attemptScores).toEqual([0])
    expect(result.attemptHistory[0].voiceFidelity).toBe(0)
  })

  it('never flags operator approval — the approval gate is bypassed entirely, not suppressed', () => {
    expect(result.requiresOperatorApproval).toBe(false)
    expect(result.approvalReason).toBe('')
  })

  it('carries no-op emission shapes for every structured field', () => {
    expect(result.contextUpdate).toEqual({})
    expect(result.commitment).toEqual({})
    expect(result.arrivalCapture).toEqual({})
    expect(result.knowledgeGap).toBe(false)
    expect(result.complaintIntent).toBe('none')
  })

  it('is not a dash violation', () => {
    expect(result.dashViolationPersisted).toBe(false)
  })

  it('carries the current PROMPT_VERSION', () => {
    expect(result.promptVersion).toBe(PROMPT_VERSION)
  })

  it('attemptHistory has exactly one entry matching the top-level result', () => {
    expect(result.attempts).toBe(1)
    expect(result.attemptHistory).toHaveLength(1)
    expect(result.attemptHistory[0].body).toBe(result.body)
  })
})

describe('CRISIS_SAFETY_REVIEW_REASON (TAC-348)', () => {
  it('is a stable, self-describing string', () => {
    expect(CRISIS_SAFETY_REVIEW_REASON).toBe('crisis_safety_reply')
  })
})
