import { z } from 'zod'

// The policy registry: what may be sent without a human, as versioned data.
// v2 successor of the 19 hardcoded approval triggers and the four verifier
// modules (decision 0009). A policy row either reads the generation's
// declared actions (structural - free, deterministic) or asks Jev one Noul
// about the draft (semantic - one request total, flat in policy count).
//
// Parses DB JSONB, not LLM output, so .min()/.max() are allowed here.
//
// Failure direction is DECLARED PER ROW (`onCheckFailure`), because the two
// directions are both right for different policies: money fails closed, a
// style nudge fails open. The gate additionally scopes fail-closed to drafts
// that declared actions or carry tripwire text - see lib/policy/gate.ts.

/** Action types the generation schema may declare. One enum, shared with lib/ai/v2/actions.ts. */
export const ACTION_TYPES = [
  'offer_comp',
  'offer_hold',
  'offer_discount',
  'cancel_commitment',
] as const
export type ActionType = (typeof ACTION_TYPES)[number]

export const PolicyDetectionSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('structural'),
    /** Matches when the draft declares an action of this type. */
    action: z.enum(ACTION_TYPES),
  }),
  z.object({
    /**
     * Matches EVERY draft; scoping comes entirely from `conditions`. This is
     * how "any reply during a complaint goes to the owner" is written - the
     * v2 successor of v1's category_requires_approval - and, with no
     * conditions at all, a venue-wide hold-everything switch.
     */
    kind: z.literal('always'),
  }),
  z.object({
    kind: z.literal('semantic'),
    /** The Noul question Jev is asked about the draft. */
    instructions: z.string().min(1),
    criteria: z.object({ true: z.string(), false: z.string() }).optional(),
    /** P(yes) at or above this matches the policy. */
    threshold: z.number().min(0).max(1),
  }),
])
export type PolicyDetection = z.infer<typeof PolicyDetectionSchema>

export const PolicyRowSchema = z.object({
  key: z.string().regex(/^[a-z][a-z0-9_]*$/),
  /** Operator-facing, shown on the review card and the graph viewer. */
  label: z.string().min(1),
  detection: PolicyDetectionSchema,
  /**
   * queue: hold the draft for operator review. block: drop it outright.
   * notify: send, but fire the observation event.
   */
  then: z.enum(['queue', 'block', 'notify']),
  /**
   * Scoping. Absent/empty = global. A draft matches when the guest's state
   * key is in `states` (if given) AND an active situation is in `situations`
   * (if given). Graph-scoped rows render on the graph viewer.
   */
  conditions: z
    .object({
      states: z.array(z.string()).optional(),
      situations: z.array(z.string()).optional(),
    })
    .optional(),
  /** What the gate does with this policy when the semantic check is unavailable. */
  onCheckFailure: z.enum(['open', 'closed']),
})
export type PolicyRow = z.infer<typeof PolicyRowSchema>

export const PolicySetSchema = z.object({
  policies: z.array(PolicyRowSchema).superRefine((rows, ctx) => {
    const seen = new Set<string>()
    for (const row of rows) {
      if (seen.has(row.key))
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `duplicate policy key "${row.key}"`,
        })
      seen.add(row.key)
    }
  }),
})
export type PolicySet = z.infer<typeof PolicySetSchema>

export function semanticPolicies(set: PolicySet): (PolicyRow & {
  detection: Extract<PolicyDetection, { kind: 'semantic' }>
})[] {
  return set.policies.filter(
    (
      p,
    ): p is PolicyRow & {
      detection: Extract<PolicyDetection, { kind: 'semantic' }>
    } => p.detection.kind === 'semantic',
  )
}
