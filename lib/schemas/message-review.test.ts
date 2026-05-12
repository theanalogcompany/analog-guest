import { describe, expect, it } from 'vitest'
import {
  getReviewedVia,
  MESSAGE_REVIEW_SCHEMA_VERSION,
  MessageReviewSchema,
} from './message-review'

const baseRequired = {
  schemaVersion: MESSAGE_REVIEW_SCHEMA_VERSION,
  reviewedBy: '11111111-1111-4111-8111-111111111111',
  reviewedAt: '2026-05-07T12:00:00.000Z',
}

describe('MessageReviewSchema', () => {
  it('accepts the minimum stamp (required fields only)', () => {
    const parsed = MessageReviewSchema.safeParse(baseRequired)
    expect(parsed.success).toBe(true)
  })

  it('accepts all optional fields populated together', () => {
    const parsed = MessageReviewSchema.safeParse({
      ...baseRequired,
      category: 'comp_complaint',
      editedMessage: 'try a refund of the cortado.',
      comment: 'too defensive in the original',
      rule: "rule: don't apologize twice",
      expectedFailure: 'classifier confidence dipped below threshold here',
    })
    expect(parsed.success).toBe(true)
  })

  it('accepts edit without category (category is optional)', () => {
    const parsed = MessageReviewSchema.safeParse({
      ...baseRequired,
      editedMessage: 'try a refund of the cortado.',
    })
    expect(parsed.success).toBe(true)
  })

  it('accepts a rule-only stamp without editedMessage', () => {
    const parsed = MessageReviewSchema.safeParse({
      ...baseRequired,
      rule: 'rule: be terser',
    })
    expect(parsed.success).toBe(true)
  })

  it('accepts expectedFailure with a reason string (short-circuits ingestion at the route)', () => {
    const parsed = MessageReviewSchema.safeParse({
      ...baseRequired,
      expectedFailure: 'known false positive in classifier confidence',
    })
    expect(parsed.success).toBe(true)
  })

  it('rejects non-uuid reviewedBy', () => {
    const parsed = MessageReviewSchema.safeParse({
      ...baseRequired,
      reviewedBy: 'not-a-uuid',
    })
    expect(parsed.success).toBe(false)
  })

  it('rejects non-positive schemaVersion', () => {
    const parsed = MessageReviewSchema.safeParse({
      ...baseRequired,
      schemaVersion: 0,
    })
    expect(parsed.success).toBe(false)
  })

  it('rejects unknown verdict field if provided (no longer in schema)', () => {
    // Defensive: with .strict() this would fail; with default (.passthrough),
    // unknown keys are dropped silently. Confirm the canonical roundtrip
    // strips it from the parsed output.
    const parsed = MessageReviewSchema.safeParse({
      ...baseRequired,
      verdict: 'edit',
    })
    expect(parsed.success).toBe(true)
    if (parsed.success) {
      expect('verdict' in parsed.data).toBe(false)
    }
  })

  it('rejects non-string expectedFailure (e.g. legacy boolean)', () => {
    const parsed = MessageReviewSchema.safeParse({
      ...baseRequired,
      expectedFailure: true,
    })
    expect(parsed.success).toBe(false)
  })

  // ─── TAC-258 additions: reviewedVia + originalAiBody ─────────────────────

  it('accepts a legacy cc-review row with no reviewedVia field (backward-compat)', () => {
    const parsed = MessageReviewSchema.safeParse(baseRequired)
    expect(parsed.success).toBe(true)
    if (parsed.success) {
      expect(parsed.data.reviewedVia).toBeUndefined()
    }
  })

  it("accepts explicit reviewedVia: 'cc_review' (TAC-258 forward-stamp on the cc-review path)", () => {
    const parsed = MessageReviewSchema.safeParse({
      ...baseRequired,
      reviewedVia: 'cc_review',
      editedMessage: 'a hypothetical edit',
    })
    expect(parsed.success).toBe(true)
  })

  it("accepts reviewedVia: 'mobile_operator' with originalAiBody (TAC-258 mobile-edit shape)", () => {
    const parsed = MessageReviewSchema.safeParse({
      ...baseRequired,
      reviewedVia: 'mobile_operator',
      editedMessage: 'the dispatched text',
      originalAiBody: 'the AI draft before the operator edit',
    })
    expect(parsed.success).toBe(true)
    if (parsed.success) {
      expect(parsed.data.reviewedVia).toBe('mobile_operator')
      expect(parsed.data.originalAiBody).toBe('the AI draft before the operator edit')
    }
  })

  it('rejects unknown reviewedVia values (closed enum)', () => {
    const parsed = MessageReviewSchema.safeParse({
      ...baseRequired,
      reviewedVia: 'web_dashboard',
    })
    expect(parsed.success).toBe(false)
  })

  it('accepts originalAiBody on its own (schema is permissive on cross-field invariants)', () => {
    // The implication "originalAiBody truthy implies reviewedVia === 'mobile_operator'"
    // is a route-layer concern, not a schema-layer constraint.
    const parsed = MessageReviewSchema.safeParse({
      ...baseRequired,
      originalAiBody: 'leftover from a different path',
    })
    expect(parsed.success).toBe(true)
  })
})

describe('getReviewedVia', () => {
  it("defaults missing reviewedVia to 'cc_review' (legacy compat)", () => {
    const review = MessageReviewSchema.parse(baseRequired)
    expect(getReviewedVia(review)).toBe('cc_review')
  })

  it('returns the explicit value when present', () => {
    const review = MessageReviewSchema.parse({
      ...baseRequired,
      reviewedVia: 'mobile_operator',
    })
    expect(getReviewedVia(review)).toBe('mobile_operator')
  })
})
