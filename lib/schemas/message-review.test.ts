import { describe, expect, it } from 'vitest'
import {
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
      expectedFailure: false,
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

  it('accepts expectedFailure=true (short-circuits ingestion at the route)', () => {
    const parsed = MessageReviewSchema.safeParse({
      ...baseRequired,
      expectedFailure: true,
      comment: 'known false positive in classifier confidence',
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

  it('rejects non-boolean expectedFailure', () => {
    const parsed = MessageReviewSchema.safeParse({
      ...baseRequired,
      expectedFailure: 'true',
    })
    expect(parsed.success).toBe(false)
  })
})
