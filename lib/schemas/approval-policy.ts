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
// column would route nothing in production while looking correct everywhere else.
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
  /**
   * Disposition for the once-ever Google review ask (lib/agent/review-ask.ts).
   *
   * NOT a perCategory entry, deliberately: the ask is not a category — it
   * rides whatever category the praise turn classified as, and a category
   * route would hold the whole turn's reply class rather than the ask. A
   * dedicated knob also keeps the flip-to-auto-send a one-field Studio edit
   * ("reviewAsk": "auto_send") that cannot collide with category routing.
   *
   * Optional, and the DEFAULT IS QUEUE — owned by resolveReviewAskDisposition
   * below, NOT by APPROVAL_POLICY_DEFAULT, so every fallback path (missing
   * field, malformed policy, degraded context) lands on operator approval.
   */
  reviewAsk: DispositionSchema.optional(),
  /**
   * Disposition for the same-visit check-back (lib/agent/visit-checkin-timeout.ts),
   * the one unprompted "how's it treating you?" to a guest who was asked how
   * their order is and went quiet.
   *
   * NOT a perCategory entry, for reviewAsk's reason and a sharper one: the
   * check-back is stored as `follow_up`, and a venue that holds follow-ups
   * would hold it with them. Ruled 2026-10-06 that it auto-sends at Le Mil's
   * "as a venue-level approval setting, not a global default, and not under
   * follow_up's operator_approval".
   *
   * Optional, and the DEFAULT IS QUEUE, owned by
   * resolveVisitCheckbackDisposition below for the reason reviewAsk's is: a
   * check-back held for approval mostly arrives too late to mean anything, so
   * a venue that wants this feature sets "visitCheckback": "auto_send", and a
   * venue that has not been asked sends nothing unprompted.
   */
  visitCheckback: DispositionSchema.optional(),
  /**
   * Disposition for the review invitation carried by a happy guest's SIGN-OFF
   * (TAC-575): the guest said their order is good, and the conversation is
   * closing.
   *
   * A KEY OF ITS OWN, NOT `reviewAsk` (ruled 2026-10-06, "option A"). The two
   * asks have different evidence behind them. `reviewAsk` covers praise the
   * classifier noticed in passing, and launched held "until the praise
   * classifier's precision is proven on real traffic". This one follows a
   * question we asked and an answer the guest gave to it, and was ruled to
   * auto-send at the pilot venue "as a venue-level approval setting, not a
   * global default". Reusing `reviewAsk` would have flipped the first to
   * auto-send as a side effect of turning on the second.
   *
   * Optional, and the DEFAULT IS QUEUE, owned by
   * resolveSignOffReviewAskDisposition below, like the two above it.
   */
  signOffReviewAsk: DispositionSchema.optional(),
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
 * Categories that can NEVER be routed to operator approval — whatever a venue
 * stores, whatever an admin clicks, whatever someone hand-writes in Studio.
 *
 * `opt_out` — TCPA / carrier compliance. An opt-out confirmation has to reach
 * the guest immediately and unconditionally. Queueing one behind a human is a
 * legal exposure, not a product tradeoff, so it is not a decision this surface
 * gets to offer. migration 031 already carves the identical exception on the
 * hold_all_outbound axis (stages.ts trigger 6, `category !== 'opt_out'`); this
 * is the same rule for the policy axis.
 *
 * THE EXEMPTION LIVES IN THE RESOLVER, NOT THE UI (TAC-307). Hand-editing
 * venue_configs in Studio is a normal workflow in this repo — CLAUDE.md
 * documents SQL templates for exactly that — so an exclusion enforced only by
 * a rendering decision would leave the legal constraint guarded by nothing.
 * The Command Center surface reads this same constant to omit the control, so
 * the two cannot disagree.
 *
 * This is NOT the place for crisis-safety: that path never reaches the gate
 * at all (handle-inbound.ts short-circuits before it) and is not a category.
 */
export const POLICY_EXEMPT_CATEGORIES = [
  'opt_out',
] as const satisfies readonly MessageCategory[]

export type PolicyExemptCategory = (typeof POLICY_EXEMPT_CATEGORIES)[number]

/** Is this category structurally ineligible for an operator-approval hold? */
export function isPolicyExemptCategory(
  category: MessageCategory | undefined,
): category is PolicyExemptCategory {
  return (
    category !== undefined &&
    (POLICY_EXEMPT_CATEGORIES as readonly string[]).includes(category)
  )
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
 * The full effective perCategory map — code defaults with any stored
 * overrides layered on top, per the load-bearing merge documented at the
 * top of this file. Extracted (TAC-343 Stage C) so a read-only display —
 * the venue admin page's Readiness panel — can show the exact same merge
 * resolveCategoryPolicy uses internally, rather than recomputing the same
 * expression a second time and risking the two drifting apart.
 */
export function getEffectivePerCategoryPolicy(
  policy: ApprovalPolicy | null | undefined,
): Record<string, ApprovalDisposition> {
  const effective = policy ?? APPROVAL_POLICY_DEFAULT
  const merged: Record<string, ApprovalDisposition> = {
    ...APPROVAL_POLICY_DEFAULT.perCategory,
    ...effective.perCategory,
  }
  // TAC-307: an exempt category reads back as auto_send even when a row
  // stores otherwise, so the read-only admin display cannot claim a hold the
  // runtime will not honour. Applied here rather than only in
  // resolvePolicyDecision so display and decision share one answer.
  for (const category of POLICY_EXEMPT_CATEGORIES) {
    merged[category] = 'auto_send'
  }
  return merged
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
  return resolvePolicyDecision(policy, category).disposition
}

/**
 * Effective disposition for the once-ever review ask.
 *
 * The default is 'operator_approval', here and nowhere else: a missing field
 * resolves here, a malformed policy falls back to APPROVAL_POLICY_DEFAULT
 * (which deliberately carries no reviewAsk key) and resolves here, and a
 * degraded context with no policy at all resolves here. Every failure
 * direction lands on queue, which is the launch posture — flipping a venue
 * to auto-send is one Studio JSONB edit, no deploy.
 */
export function resolveReviewAskDisposition(
  policy: ApprovalPolicy | null | undefined,
): ApprovalDisposition {
  return policy?.reviewAsk ?? 'operator_approval'
}

/**
 * Effective disposition for the same-visit check-back.
 *
 * 'operator_approval' on every fallback path, the launch posture
 * resolveReviewAskDisposition takes. Flipping a venue to auto-send is one
 * Studio JSONB edit and no deploy.
 */
export function resolveVisitCheckbackDisposition(
  policy: ApprovalPolicy | null | undefined,
): ApprovalDisposition {
  return policy?.visitCheckback ?? 'operator_approval'
}

/**
 * Effective disposition for the review invitation on a happy guest's sign-off.
 *
 * 'operator_approval' on every fallback path. A venue opts in with
 * "signOffReviewAsk": "auto_send", one Studio JSONB edit and no deploy.
 */
export function resolveSignOffReviewAskDisposition(
  policy: ApprovalPolicy | null | undefined,
): ApprovalDisposition {
  return policy?.signOffReviewAsk ?? 'operator_approval'
}

/**
 * Where a disposition came from. TAC-307.
 *
 * WHY THE SOURCE MATTERS, and it is the whole reason this function exists
 * alongside resolveCategoryPolicy: a hold that a human explicitly chose is
 * ABSOLUTE, and a hold inherited from the fleet-wide code default is not.
 * applyApprovalPolicyStage consults canAutoSendComplaintTurn only on the
 * latter. Without the source, the two are indistinguishable at the call site
 * and the clarifying-question carve-out would keep punching through a switch
 * an operator deliberately flipped — which is the failure this ticket closes.
 *
 *   exempt         — POLICY_EXEMPT_CATEGORIES; never holdable (TCPA)
 *   stored         — an explicit entry in this venue's perCategory
 *   code_default   — APPROVAL_POLICY_DEFAULT.perCategory (nobody chose it
 *                    per-venue; it ships fleet-wide)
 *   policy_default — fell through to `default`, stored or code-level
 */
export type PolicyDecisionSource =
  'exempt' | 'stored' | 'code_default' | 'policy_default'

export interface PolicyDecision {
  disposition: ApprovalDisposition
  source: PolicyDecisionSource
}

/**
 * Resolve a category to a disposition AND say where that answer came from.
 *
 * Resolution order is unchanged from the original resolveCategoryPolicy —
 * stored entry, then code-level default entry, then the policy's own
 * `default` — with the exemption check ahead of all of it.
 */
export function resolvePolicyDecision(
  policy: ApprovalPolicy | null | undefined,
  category: MessageCategory | undefined,
): PolicyDecision {
  // Tolerating a missing policy is a RUNTIME requirement, not test
  // convenience. This is called from inside applyApprovalPolicyStage, so a
  // throw here fails the whole agent run and the guest gets nothing at all.
  // build-runtime-context always populates it, but any future path that
  // assembles a context differently should degrade to the code defaults —
  // which route comp_complaint to review, so degrading adds oversight.
  //
  // Annotated rather than inferred: APPROVAL_POLICY_DEFAULT is `as const`, so
  // an inferred union would narrow perCategory to its single literal key and
  // reject indexing by an arbitrary MessageCategory.
  const effective: ApprovalPolicy = policy ?? APPROVAL_POLICY_DEFAULT

  // Ahead of everything, including `default`: a blanket hold must not reach a
  // compliance reply either.
  if (isPolicyExemptCategory(category)) {
    return { disposition: 'auto_send', source: 'exempt' }
  }

  // No inbound classification (the followup / proactive path). Falls to the
  // venue's default, which is what makes the master switch cover messages no
  // per-category control could reach.
  if (category === undefined) {
    return { disposition: effective.default, source: 'policy_default' }
  }

  // Read the stored entry off the CALLER'S policy, never off `effective`.
  // When policy is null/undefined, `effective` IS APPROVAL_POLICY_DEFAULT, so
  // indexing it here would report the fleet-wide comp_complaint default as
  // source 'stored' — making every degraded context absolute and silently
  // disabling the clarifying-question carve-out for any caller that hasn't
  // populated a policy. A degraded context must resolve through the
  // code-default branch below, which is what 'code_default' means.
  const stored = policy?.perCategory[category]
  if (stored !== undefined) return { disposition: stored, source: 'stored' }

  // A venue-level `default` of operator_approval is the master switch, and it
  // is checked BEFORE the code-level perCategory map on purpose. Without this
  // ordering the switch would not be absolute for comp_complaint: that
  // category has a fleet-wide code default of its own, so it would resolve
  // with source 'code_default', keep the clarifying-question carve-out, and
  // auto-send past a blanket hold — the exact hole this ticket closes, hiding
  // in the one category the ticket's own incident was about.
  //
  // A venue choosing to hold everything is a stronger signal than a default
  // that ships to every venue, so it outranks it.
  if (effective.default === 'operator_approval') {
    return { disposition: 'operator_approval', source: 'policy_default' }
  }

  const codeDefault = (
    APPROVAL_POLICY_DEFAULT.perCategory as Partial<
      Record<MessageCategory, ApprovalDisposition>
    >
  )[category]
  if (codeDefault !== undefined) {
    return { disposition: codeDefault, source: 'code_default' }
  }

  return { disposition: effective.default, source: 'policy_default' }
}
