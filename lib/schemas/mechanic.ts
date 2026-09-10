import { z } from 'zod'
import { GUEST_STATES, type MechanicType, type RedemptionPolicy } from '@/lib/recognition'

// TAC-343 Stage C: the admin edit-boundary schema for `mechanics` rows.
// Deliberately separate from parse-venue-spec.ts's onboarding-time
// MechanicSchema, which stays untouched (it validates markdown-extracted
// spec content pre-seed; this validates an operator's edit against the live
// DB row shape, camelCase to match the loader's VenueDetailMechanicRow).
//
// Scope is the corrected §2 field set from the TAC-343 investigation, not
// the full "Part B parameter set" the ticket originally assumed:
//   - editable, live at runtime: type, name, description, qualification,
//     rewardDescription, minState, redemptionPolicy, redemptionWindowDays,
//     requiresOperatorApproval
//   - editable, real content the agent doesn't read yet: triggerType,
//     expirationRule
//   - NOT exposed: redemption (identical on all 6 live mechanics; revisit
//     when it varies)

// Literal arrays derived FROM the canonical types in lib/recognition/
// eligibility.ts (re-exported via lib/recognition/index.ts), not a second
// hand-typed copy of the same union — `satisfies` makes a typo or a
// forgotten new member fail `tsc` instead of silently drifting from the
// type mechanics-eligibility filtering already relies on. An earlier
// version of this file redeclared both types from scratch; caught in code
// review as the exact class of drift `APPROVAL_POLICY_DEFAULT`'s own
// `satisfies` annotation (lib/schemas/approval-policy.ts) exists to prevent.
export const MECHANIC_TYPES = [
  'perk',
  'referral',
  'content_unlock',
  'event_invite',
  'merch',
] as const satisfies readonly MechanicType[]

export const MECHANIC_TRIGGER_TYPES = ['guest_initiated_request', 'manual_invite'] as const
export type MechanicTriggerType = (typeof MECHANIC_TRIGGER_TYPES)[number]

export const MECHANIC_REDEMPTION_POLICIES = [
  'one_time',
  'renewable',
] as const satisfies readonly RedemptionPolicy[]

// Per-field constraints only — no cross-field refinement. Used to parse the
// PATCH request body, which may carry any subset of fields. Nullable (not
// just optional) on the DB-nullable free-text fields so a client can
// explicitly clear one (send `null`) while omitting a key still means
// "leave this field alone" at the route's read-modify-write boundary.
const MechanicFieldsSchema = z.object({
  type: z.enum(MECHANIC_TYPES),
  name: z.string().min(1),
  description: z.string().min(1).nullable(),
  qualification: z.string().min(1).nullable(),
  rewardDescription: z.string().min(1).nullable(),
  minState: z.enum(GUEST_STATES),
  redemptionPolicy: z.enum(MECHANIC_REDEMPTION_POLICIES),
  redemptionWindowDays: z.number().int().positive().nullable(),
  requiresOperatorApproval: z.boolean(),
  triggerType: z.enum(MECHANIC_TRIGGER_TYPES),
  expirationRule: z.string().min(1).nullable(),
})

/** Request-body shape for PATCH — any subset of fields, each still
 *  individually constrained. Cross-field validation happens after merge,
 *  against MechanicFullSchema below — .partial() doesn't compose cleanly
 *  with a .refine() (same reasoning as BrandPersonaSchema's PATCH route). */
export const MechanicPatchSchema = MechanicFieldsSchema.partial()
export type MechanicPatch = z.infer<typeof MechanicPatchSchema>

/**
 * The whole-object shape validated after a read-modify-write merge (mirrors
 * the venue_info / brand_persona pattern: partial patch in, whole object
 * re-validated before write). Mirrors migration 009's DB-level CHECK
 * constraint in application code so a violation surfaces as a clean 400
 * before it ever reaches Postgres.
 */
export const MechanicFullSchema = MechanicFieldsSchema.refine(
  (m) => (m.redemptionPolicy === 'renewable') === (m.redemptionWindowDays !== null),
  {
    message:
      'redemptionWindowDays must be set when redemptionPolicy is renewable, and omitted when one_time',
    path: ['redemptionWindowDays'],
  },
)
export type MechanicFull = z.infer<typeof MechanicFullSchema>

/**
 * Request-body shape for POST (add) — structurally identical to
 * MechanicFullSchema (every field required, same redemption-pairing
 * constraint): a new mechanic starts fully parameterized AND
 * pairing-consistent, rather than accumulating the same gap a PATCH merge
 * guards against. Named separately from MechanicFullSchema so call sites
 * read as "the create-request shape," not "reusing an unrelated schema."
 */
export const MechanicCreateSchema = MechanicFullSchema
export type MechanicCreate = z.infer<typeof MechanicCreateSchema>
