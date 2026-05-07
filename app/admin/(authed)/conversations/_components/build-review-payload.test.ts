import { describe, expect, it } from 'vitest'
import {
  buildReviewPayload,
  canSaveReview,
  type ReviewFormState,
} from './build-review-payload'

const empty = (): ReviewFormState => ({
  category: '',
  comment: '',
  editedMessage: '',
  rule: '',
  expectedFailure: '',
})

describe('buildReviewPayload', () => {
  it('returns an empty object when all fields are blank', () => {
    expect(buildReviewPayload(empty())).toEqual({})
  })

  it('drops whitespace-only fields', () => {
    expect(
      buildReviewPayload({
        category: '  ',
        comment: '\n\t',
        editedMessage: '   ',
        rule: '',
        expectedFailure: '\n',
      }),
    ).toEqual({})
  })

  it('trims surrounding whitespace but preserves internal newlines', () => {
    expect(
      buildReviewPayload({
        ...empty(),
        comment: '  line one\nline two  ',
      }),
    ).toEqual({ comment: 'line one\nline two' })
  })

  it('includes all populated fields', () => {
    expect(
      buildReviewPayload({
        category: 'comp_complaint',
        comment: 'too defensive',
        editedMessage: 'try a refund of the cortado.',
        rule: "rule: don't apologize twice",
        expectedFailure: 'classifier confidence dipped below threshold',
      }),
    ).toEqual({
      category: 'comp_complaint',
      comment: 'too defensive',
      editedMessage: 'try a refund of the cortado.',
      rule: "rule: don't apologize twice",
      expectedFailure: 'classifier confidence dipped below threshold',
    })
  })

  it('emits comment-only payload when only comment is set (stamp-only path)', () => {
    expect(
      buildReviewPayload({
        ...empty(),
        comment: 'looks good',
      }),
    ).toEqual({ comment: 'looks good' })
  })
})

describe('canSaveReview', () => {
  it('blocks save when comment is empty', () => {
    expect(canSaveReview(empty())).toBe(false)
  })

  it('blocks save when comment is whitespace-only', () => {
    expect(canSaveReview({ ...empty(), comment: '   ' })).toBe(false)
  })

  it('allows save when comment has content (even if other fields are blank)', () => {
    expect(canSaveReview({ ...empty(), comment: 'noted' })).toBe(true)
  })

  it('allows save with comment + expectedFailure-only (no edit, no rule)', () => {
    expect(
      canSaveReview({
        ...empty(),
        comment: 'expected miss',
        expectedFailure: 'classifier returns low confidence on slang',
      }),
    ).toBe(true)
  })

  it('blocks save when only expectedFailure is set without comment', () => {
    // Locked decision: comment is the journal entry, required on every
    // review including expected-failure-only stamps.
    expect(
      canSaveReview({
        ...empty(),
        expectedFailure: 'a reason',
      }),
    ).toBe(false)
  })
})
