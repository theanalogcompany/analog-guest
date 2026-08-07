// Per-venue, per-category approval routing (v1.24.0).
//
// venue_configs.approval_policy has existed since migration 001 and has been
// seeded on every venue since 2026-04-27 (commit 6828918, THE-148) as
// {"default":"auto_send","perCategory":{}} — with ZERO readers and no schema.
// A per-category approval slot was scaffolded and abandoned. This module is
// the reader it never had.
//
// WHY IT MATTERS NOW: the intended complaint behavior is "understand, then
// draft something generous and let a human authorize it." That requires a
// gate that fires on the CATEGORY, before the model has said anything —
// independent of what the reply contains. Every other approval trigger
// inspects the generated draft; this one inspects the classification.
//
// THE MERGE IS LOAD-BEARING. Every venue in production carries an EMPTY
// perCategory. If the stored value replaced the code default, wiring this
// column would route nothing in production while passing every unit test.
// So the code default is the base and stored entries layer ON TOP:
//
//   effective = { ...APPROVAL_POLICY_DEFAULT.perCategory, ...stored.perCategory }
//
// This ships the comp_complaint route fleet-wide with no data migration,
// while leaving any venue free to override it explicitly.

import { z } from 'zod'

import type { MessageCategory } from '@/lib/ai/types'

/** What happens to a draft in this category. */
export const APPROVAL_DISPOSITIONS = ['auto_send', 'operator_approval'] as const
export type ApprovalDisposition = (typeof APPROVAL_DISPOSITIONS)[number]

const DispositionSchema = z.enum(APPROVAL_DISPOSITIONS)

/**
 * Per-category overrides, keyed loosely.
 *
 * `MessageCategory` is a hand-written union in lib/ai/types.ts with no
 * companion const array, so the key set can't be enumerated at runtime
 * without duplicating it here — and a duplicated category list is exactly
 * the drift hazard CLAUDE.md's total-map gotcha warns about. Keying on
 * `z.string()` instead means an unknown or typo'd key parses fine and is
 * simply never matched by a lookup (resolveCategoryPolicy only ever looks up
 * real MessageCategory values). A hand-edited venue row with a typo degrades
 * to "that one override is ignored" rather than "the whole policy is
 * malformed and every category falls back" — the same
 * permissive-at-the-live-boundary posture as filterActiveContext.
 *
 * Typo safety on the code-level default is recovered below via `satisfies`.
 */
const PerCategorySchema = z.record(z.string(), DispositionSchema)

export const ApprovalPolicySchema = z.object({
  /** Disposition for any category without an explicit entry. */
  default: DispositionSchema,
  perCategory: PerCategorySchema,
})

export type ApprovalPolicy = z.infer<typeof ApprovalPolicySchema>

/**
 * Code-level default. This is the source of truth, not the DB — see the
 * merge note above.
 *
 * comp_complaint routes to operator approval because a guest reporting a bad
 * experience is precisely the moment the venue should be generous, and
 * generosity is the operator's call to make. The agent proposes; the human
 * authorizes. Everything else auto-sends: routing more categories here would
 * queue the product.
 */
export const APPROVAL_POLICY_DEFAULT = {
  default: 'auto_send',
  perCategory: {
    comp_complaint: 'operator_approval',
  },
  // `satisfies Partial<Record<MessageCategory, …>>` restores the typo safety
  // the loose z.record key gives up: a misspelled category here fails tsc.
} as const satisfies {
  default: ApprovalDisposition
  perCategory: Partial<Record<MessageCategory, ApprovalDisposition>>
}

/**
 * Parse venue_configs.approval_policy. Fails OPEN to defaults on
 * null/missing/malformed, mirroring parseFollowupRules.
 *
 * Note the asymmetry that makes failing open safe here: the fallback routes
 * comp_complaint to MORE review, not less. A malformed policy cannot cause an
 * unreviewed comp.
 */
export function parseApprovalPolicy(value: unknown): ApprovalPolicy {
  if (value === null || value === undefined) return APPROVAL_POLICY_DEFAULT
  const parsed = ApprovalPolicySchema.safeParse(value)
  if (!parsed.success) {
    console.warn(
      `[approval-policy] malformed approval_policy JSONB, falling back to defaults: ${parsed.error.message}`,
    )
    return APPROVAL_POLICY_DEFAULT
  }
  return parsed.data
}

/**
 * Effective disposition for a category. Resolution order:
 *   1. explicit stored perCategory entry
 *   2. code-level APPROVAL_POLICY_DEFAULT.perCategory entry
 *   3. the policy's own `default`
 *
 * `category` is optional because the followup path has no inbound
 * classification; an absent category is unrouted and falls to the default.
 */
export function resolveCategoryPolicy(
  policy: ApprovalPolicy | null | undefined,
  category: MessageCategory | undefined,
): ApprovalDisposition {
  // Tolerating a missing policy is a RUNTIME requirement, not test
  // convenience. This is called from inside applyApprovalPolicyStage, so a
  // throw here fails the whole agent run and the guest gets nothing at all.
  // build-runtime-context always populates it, but any future path that
  // assembles a context differently should degrade to the code defaults —
  // which route comp_complaint to review, so degrading adds oversight.
  const effective = policy ?? APPROVAL_POLICY_DEFAULT
  if (category === undefined) return effective.default
  const merged: Partial<Record<MessageCategory, ApprovalDisposition>> = {
    ...APPROVAL_POLICY_DEFAULT.perCategory,
    ...effective.perCategory,
  }
  return merged[category] ?? effective.default
}
