// Pure helpers over a single mechanics row's shape (TAC-343). Shared by
// readiness.ts (Stage A) and the mechanics editor (Stage C) so the two never
// disagree about how to read `trigger` or what counts as "missing".
//
// `trigger` is a jsonb column with no Zod schema at the runtime-read
// boundary (build-runtime-context.ts never selects it) — the investigation
// found only `.type` is ever meaningfully read in practice
// (guest_initiated_request | manual_invite). We defensively narrow rather
// than assume the shape, since a hand-edited or legacy row could carry
// anything.

export function parseMechanicTriggerType(trigger: unknown): string | null {
  if (typeof trigger !== 'object' || trigger === null) return null
  const type = (trigger as Record<string, unknown>).type
  return typeof type === 'string' && type.length > 0 ? type : null
}

// Subset of a mechanics row this module reasons about. Callers (the detail
// loader) project the full DB row down to this shape.
export interface MechanicFieldsInput {
  description: string | null
  qualification: string | null
  rewardDescription: string | null
  redemptionPolicy: string | null
  redemptionWindowDays: number | null
}

/**
 * Names the free-text/nullable mechanic fields that are absent. Deliberately
 * excludes `min_state` (DB default 'new' — never actually null) and
 * `requires_operator_approval` (DB default false — a legitimate value, and
 * the specific manual_invite-without-approval gap has its own dedicated
 * Readiness check rather than being folded into a generic "missing" list).
 *
 * `redemption_window_days` is only "missing" when the policy is 'renewable'
 * — migration 009's CHECK constraint pairs one_time+null / renewable+non-null,
 * so a one_time mechanic with a null window is correct, not a gap.
 */
export function findMissingMechanicFields(mechanic: MechanicFieldsInput): string[] {
  const missing: string[] = []
  if (!mechanic.description || mechanic.description.trim().length === 0) {
    missing.push('description')
  }
  if (!mechanic.qualification || mechanic.qualification.trim().length === 0) {
    missing.push('qualification')
  }
  if (!mechanic.rewardDescription || mechanic.rewardDescription.trim().length === 0) {
    missing.push('reward_description')
  }
  if (mechanic.redemptionPolicy === 'renewable' && mechanic.redemptionWindowDays === null) {
    missing.push('redemption_window_days')
  }
  return missing
}
