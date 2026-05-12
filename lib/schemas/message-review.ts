import { z } from 'zod'

// Persisted shape of messages.response_review JSONB. Originally THE-235
// (Command Center cc-review surface); widened by TAC-258 to also persist
// mobile-operator pre-dispatch edits. Latest-only — re-edits replace this
// object in place; no review history.
//
// No `verdict` field. Field-existence semantics carry the signal:
//   - editedMessage present and non-empty → operator made a correction. For
//     cc-review (post-hoc) the edit is hypothetical; messages.body still holds
//     the dispatched AI draft. For mobile-operator (pre-dispatch) the edit IS
//     what was dispatched, so messages.body and editedMessage carry the same
//     text. Either way the route writes a voice_corpus row.
//   - rule present and non-empty → operator captured an anti-pattern, route
//     dedupe-appends to brand_persona.voiceAntiPatterns. cc-review only.
//   - expectedFailure present and non-empty → operator flagged a known
//     acceptable failure with a reason; route skips corpus + antipattern
//     entirely (mirrors the 08-flow's `expected_failure: REASON` comment
//     encoding). cc-review only.
//
// reviewedVia distinguishes the surface that captured the review. Optional
// for backward-compat with pre-TAC-258 cc-review rows (which were written
// before the field existed). Readers default missing values to 'cc_review'
// — the only pre-existing channel — so legacy rows parse cleanly without a
// schemaVersion bump. Going forward, both surfaces write this field
// explicitly.
//
// originalAiBody captures the AI's pre-edit draft for mobile-operator edits
// only. Stored on the row so analytics can compute edit deltas without
// round-tripping Langfuse (closes the trace-retention risk). Absent for
// cc-review reviews (where messages.body already carries the AI draft as
// the dispatched text) and absent for non-edit reviews. Truthy presence
// implies reviewedVia === 'mobile_operator', but the schema doesn't enforce
// that cross-field invariant — it's a route-layer concern, not schema-layer.
//
// category is optional — the form auto-prefills from messages.category and
// the operator may leave it as-is. Persisted as a permissive string so
// future MessageCategory additions don't require a schema bump.
//
// schemaVersion is a forward-compat hook. Bump on shape changes; readers
// branch on the value if/when v2 lands.

export const MESSAGE_REVIEW_SCHEMA_VERSION = 1

export const REVIEWED_VIA_VALUES = ['cc_review', 'mobile_operator'] as const
export type ReviewedVia = (typeof REVIEWED_VIA_VALUES)[number]

export const MessageReviewSchema = z.object({
  schemaVersion: z.number().int().positive(),
  reviewedBy: z.string().uuid(),
  reviewedVia: z.enum(REVIEWED_VIA_VALUES).optional(),
  reviewedAt: z.string(),
  category: z.string().optional(),
  editedMessage: z.string().optional(),
  originalAiBody: z.string().optional(),
  comment: z.string().optional(),
  rule: z.string().optional(),
  expectedFailure: z.string().optional(),
})

export type MessageReview = z.infer<typeof MessageReviewSchema>

/**
 * Read-side default: legacy rows written before TAC-258 don't carry
 * reviewedVia. They were all written by the cc-review surface, so resolve
 * missing values to 'cc_review' at read time. Use this rather than reading
 * .reviewedVia directly so the default stays consistent across callers.
 */
export function getReviewedVia(review: MessageReview): ReviewedVia {
  return review.reviewedVia ?? 'cc_review'
}
