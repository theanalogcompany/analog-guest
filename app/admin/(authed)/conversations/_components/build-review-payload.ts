// Pure projection from form state to the PUT body shape accepted by
// /admin/conversations/api/review/[messageId] (PR-A). Lives outside the
// component so the schema mapping has its own unit-test surface — drift
// here silently breaks save with a 400 from the route's PutBodySchema.
//
// Rules:
//   - Whitespace-only fields are dropped (route would do the same on its
//     side — PutBodySchema accepts the empty string but the route's
//     length checks treat them as absent — but mirroring at the form
//     boundary keeps the JSONB stamp lean).
//   - editedMessage / rule / comment / category / expectedFailure dropped
//     when empty. Required-on-route-side fields (none) and required-on-
//     form-side fields (comment) are validated separately at the form's
//     Save button.
//   - Trim is applied to all string fields. The textarea preserves
//     internal newlines but strips leading/trailing whitespace.

export interface ReviewFormState {
  category: string
  comment: string
  editedMessage: string
  rule: string
  expectedFailure: string
}

export interface ReviewPutBody {
  category?: string
  comment?: string
  editedMessage?: string
  rule?: string
  expectedFailure?: string
}

/**
 * Build the PUT body. Empty / whitespace-only fields are omitted entirely
 * so the JSONB stamp doesn't carry empty strings. The route accepts a
 * subset of these keys (all optional), so an empty form state with just
 * a comment produces { comment: '...' } — minimal stamp.
 */
export function buildReviewPayload(state: ReviewFormState): ReviewPutBody {
  const body: ReviewPutBody = {}
  const category = state.category.trim()
  if (category.length > 0) body.category = category
  const comment = state.comment.trim()
  if (comment.length > 0) body.comment = comment
  const editedMessage = state.editedMessage.trim()
  if (editedMessage.length > 0) body.editedMessage = editedMessage
  const rule = state.rule.trim()
  if (rule.length > 0) body.rule = rule
  const expectedFailure = state.expectedFailure.trim()
  if (expectedFailure.length > 0) body.expectedFailure = expectedFailure
  return body
}

/**
 * The form's Save button is enabled when this returns true. Today the
 * single rule is "comment is required" — see THE-235 plan note re:
 * comment as the journal entry, present even on expected-failure-only
 * stamps. Add new gates here if the rule evolves.
 */
export function canSaveReview(state: ReviewFormState): boolean {
  return state.comment.trim().length > 0
}
