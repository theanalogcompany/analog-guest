import { z } from 'zod'

// Per-guest context that accumulates across conversations (TAC-296).
// Stored as `guests.context` JSONB, loaded into AiRuntimeContext.guestContext,
// rendered as the ## Guest context user-prompt block, and mutated via the
// agent's contextUpdate field on GeneratedMessageSchema.
//
// Schema strategy: every field optional, no .min() / .max() on strings (per
// THE-157 — Anthropic structured-output rejects those JSON Schema constraints),
// timestamps stored as plain strings rather than coerced Dates so a malformed
// value drops just the affected entry at filter time rather than crashing the
// whole guests.context parse (same posture as filterActiveContext on
// venue_info.currentContext, THE-150). The schema does NOT use .strict() —
// unknown keys are silently stripped so future migrations can extend the shape
// without breaking older deploys that still read the same rows.

const HomeBaseSchema = z.object({
  neighborhood: z.string().optional(),
  zip: z.string().optional(),
  city: z.string().optional(),
  address: z.string().optional(),
})

const WorkplaceSchema = z.object({
  neighborhood: z.string().optional(),
  employer: z.string().optional(),
})

const GuestDetailsSchema = z.object({
  first_name: z.string().optional(),
  last_name: z.string().optional(),
  date_of_birth: z.string().optional(),
  pronouns: z.string().optional(),
  home_base: HomeBaseSchema.optional(),
  workplace: WorkplaceSchema.optional(),
})

const PreferencesSchema = z.object({
  dietary: z.array(z.string()).optional(),
  favorites: z.array(z.string()).optional(),
  dislikes: z.array(z.string()).optional(),
})

// life_context entries are time-bounded notes ("going to Tokyo for two weeks,
// back on the 30th"). expires_at is the read-time filter boundary. captured_at
// is required at the persisted boundary — the runtime stamps it on every
// merged entry — but the PATCH schema makes it optional so the agent can emit
// a bare { note, expires_at } and the runtime fills in the timestamp.
const LifeContextEntrySchema = z.object({
  note: z.string(),
  captured_at: z.string(),
  expires_at: z.string().optional(),
})

const ObservationEntrySchema = z.object({
  note: z.string(),
  captured_at: z.string(),
})

export const GuestContextSchema = z.object({
  guest_details: GuestDetailsSchema.optional(),
  preferences: PreferencesSchema.optional(),
  life_context: z.array(LifeContextEntrySchema).optional(),
  observations: z.array(ObservationEntrySchema).optional(),
})

export type GuestContext = z.infer<typeof GuestContextSchema>

// Patch schema — what the agent emits on `contextUpdate.structured`. Same
// shape as the persisted form but with `captured_at` optional on the array
// entries so the agent can emit `{ note, expires_at }` and let the runtime
// stamp the timestamp.
//
// All fields optional all the way down per the TAC-296 reply: "schema-rejection
// risk is contained by aggressive optionality." Unknown keys stripped (default
// zod behavior, no .strict()). No .min() / .max() / .datetime() refinements
// that would surface as JSON Schema constraints and trip Anthropic's
// structured-output validator.
const LifeContextPatchEntrySchema = z.object({
  note: z.string(),
  captured_at: z.string().optional(),
  expires_at: z.string().optional(),
})

const ObservationPatchEntrySchema = z.object({
  note: z.string(),
  captured_at: z.string().optional(),
})

export const GuestContextPatchSchema = z.object({
  guest_details: GuestDetailsSchema.optional(),
  preferences: PreferencesSchema.optional(),
  life_context: z.array(LifeContextPatchEntrySchema).optional(),
  observations: z.array(ObservationPatchEntrySchema).optional(),
})

export type GuestContextPatch = z.infer<typeof GuestContextPatchSchema>

// Runtime-ready shape: post-filterActiveLifeContext + observations truncated.
// Distinct from GuestContext (the persisted shape) so the prompt-rendering
// path can't accidentally see expired life_context entries or the full
// untruncated observations list. Same fields, different invariants.
export interface ParsedGuestContext {
  guest_details?: GuestContext['guest_details']
  preferences?: GuestContext['preferences']
  // Filtered: expired entries dropped, malformed expires_at logged + dropped.
  life_context?: NonNullable<GuestContext['life_context']>
  // Truncated: most-recent OBSERVATION_RENDER_LIMIT (10) only.
  observations?: NonNullable<GuestContext['observations']>
}

// Observation render cap. The full history is preserved on disk; only the most
// recent N are loaded into the prompt. Trade-off picked in the TAC-296 plan:
// unbounded growth with read-time truncation rather than eviction at write
// time, per the ticket's "out of scope" list.
export const OBSERVATION_RENDER_LIMIT = 10

/**
 * Drop life_context entries whose expires_at has elapsed. Entries with no
 * expires_at are permanent. Entries with a malformed expires_at are logged
 * and dropped (per-entry resilience — never crash the agent run for one bad
 * date). Mirrors filterActiveContext in venue-info.ts.
 *
 * Comparison is strictly-future: `expires_at > now` keeps the entry. Equality
 * drops.
 */
export function filterActiveLifeContext(
  entries: readonly z.infer<typeof LifeContextEntrySchema>[],
  now: Date,
): z.infer<typeof LifeContextEntrySchema>[] {
  return entries.filter((entry) => {
    if (entry.expires_at === undefined) return true
    const expiry = new Date(entry.expires_at)
    if (Number.isNaN(expiry.getTime())) {
      console.warn(
        `[guest-context] dropping life_context entry "${entry.note.slice(0, 40)}": malformed expires_at "${entry.expires_at}"`,
      )
      return false
    }
    return expiry.getTime() > now.getTime()
  })
}

/**
 * Convert a persisted GuestContext into the runtime-ready ParsedGuestContext.
 * Applies filterActiveLifeContext (drops expired + malformed) and truncates
 * observations to the last OBSERVATION_RENDER_LIMIT. Pure — no side effects
 * beyond the console.warn from the filter step.
 *
 * Empty arrays are normalized to `undefined` so the serializer's null-check
 * (`if (!preferences && !guest_details && ...)`) sees absence consistently.
 */
export function toParsedGuestContext(
  context: GuestContext,
  now: Date,
): ParsedGuestContext {
  const filtered = context.life_context
    ? filterActiveLifeContext(context.life_context, now)
    : []
  const truncated = context.observations
    ? context.observations.slice(-OBSERVATION_RENDER_LIMIT)
    : []
  return {
    guest_details: context.guest_details,
    preferences: context.preferences,
    life_context: filtered.length > 0 ? filtered : undefined,
    observations: truncated.length > 0 ? truncated : undefined,
  }
}

/**
 * True when a ParsedGuestContext has no renderable content. Used by the
 * serializer to skip the prompt block entirely (empty context → zero tokens,
 * not a header with no body).
 */
export function isEmptyGuestContext(context: ParsedGuestContext): boolean {
  return (
    context.guest_details === undefined &&
    context.preferences === undefined &&
    context.life_context === undefined &&
    context.observations === undefined
  )
}
