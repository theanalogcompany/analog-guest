import { z } from 'zod'

// Persisted shape of messages.response_review JSONB (THE-235). Captures a
// single per-message review from the Command Center conversation viewer.
// Latest-only — re-edits replace this object in place; no review history.
//
// No `verdict` field. Field-existence semantics carry the signal:
//   - editedMessage present and non-empty → operator made a correction,
//     route writes a voice_corpus row
//   - rule present and non-empty → operator captured an anti-pattern,
//     route dedupe-appends to brand_persona.voiceAntiPatterns
//   - expectedFailure true → operator flagged a known acceptable failure,
//     route skips corpus + antipattern entirely (mirrors the 08-flow's
//     `expected_failure:` comment-prefix branch in classifyRow)
//
// category is optional — the form auto-prefills from messages.category and
// the operator may leave it as-is. Persisted as a permissive string so
// future MessageCategory additions don't require a schema bump.
//
// schemaVersion is a forward-compat hook. Bump on shape changes; readers
// branch on the value if/when v2 lands.

export const MESSAGE_REVIEW_SCHEMA_VERSION = 1

export const MessageReviewSchema = z.object({
  schemaVersion: z.number().int().positive(),
  reviewedBy: z.string().uuid(),
  reviewedAt: z.string(),
  category: z.string().optional(),
  editedMessage: z.string().optional(),
  comment: z.string().optional(),
  rule: z.string().optional(),
  expectedFailure: z.boolean().optional(),
})

export type MessageReview = z.infer<typeof MessageReviewSchema>
