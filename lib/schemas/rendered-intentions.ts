import { z } from 'zod'

// TAC-385 PR 1: the shape of `messages.rendered_intentions` (migration 045).
//
// The intentions that RENDERED into the prompt which produced this draft, so
// that dispatchOperatorOutbound can record the ask when an operator approves or
// edits it. Sibling of PendingCommitmentSchema: a jsonb intent carrier on the
// draft row, written at queue time and read back at dispatch. Inner keys are
// camelCase, matching that carrier (`expiresAt`), even though the DB columns
// they mirror are snake_case.
//
// This module is deliberately DOMAIN-FREE. It knows the payload's shape and
// nothing about intentions — resolving a key to a live definition needs
// lib/agent/intentions/definitions.ts, and lib/schemas must not depend on
// lib/agent. That resolution lives in lib/agent/intentions/rendered.ts.

export const RenderedIntentionSchema = z.object({
  /**
   * The intention key as it was at render time. Deliberately a bare string, not
   * an enum: a draft queued before a deploy that retires or renames an
   * intention must still parse. The reader resolves and drops unknown keys.
   */
  key: z.string().min(1),
  /**
   * The eligibility anchor AS IT WAS WHEN THE PROMPT RENDERED, ISO-8601.
   *
   * Stored rather than looked up at dispatch because the two event-armed
   * intentions re-arm on a newer recommendation or order, which moves the
   * anchor. Recording against the guest's CURRENT anchor would let a re-arm
   * between queue and dispatch stamp a prompt from the old arming onto the new
   * one. Migration 045's header carries the full reasoning.
   */
  eligibleAt: z.string().min(1),
})
export type RenderedIntention = z.infer<typeof RenderedIntentionSchema>

export const RenderedIntentionsSchema = z.array(RenderedIntentionSchema)

/**
 * Parse the raw jsonb column into entries.
 *
 * PERMISSIVE at this live boundary, per CLAUDE.md's strict-offline /
 * permissive-live split, and the failure direction is deliberate: this runs
 * inside the operator's approve tap, and a malformed payload must cost the
 * recording, never the dispatch. So a null column, a non-array value, or a
 * malformed entry degrades rather than throwing — and a bad entry is dropped
 * ON ITS OWN, keeping its well-formed siblings, mirroring
 * `filterActiveContext`'s per-entry posture.
 *
 * Returns `[]` for null/undefined without warning: that is the overwhelmingly
 * common case (every row predating migration 045, every non-inbound draft, and
 * every blank knowledge-gap card) and means "record nothing", not "something
 * went wrong".
 */
export function parseRenderedIntentions(value: unknown): RenderedIntention[] {
  if (value === null || value === undefined) return []

  if (!Array.isArray(value)) {
    console.warn(
      `[rendered-intentions] expected an array, got ${typeof value}. Recording nothing for this draft.`,
    )
    return []
  }

  const entries: RenderedIntention[] = []
  for (const raw of value) {
    const parsed = RenderedIntentionSchema.safeParse(raw)
    if (!parsed.success) {
      console.warn(
        `[rendered-intentions] dropping a malformed entry: ${parsed.error.message}`,
      )
      continue
    }
    entries.push(parsed.data)
  }
  return entries
}
