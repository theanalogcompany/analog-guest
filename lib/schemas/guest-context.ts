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
//
// TAC-300 reshape: the PATCH schema (what the LLM emits) and the PERSISTED
// schema (what the DB reads back) intentionally diverge.
//   - PATCH side is slim: home_base/workplace are bare strings, no
//     pronouns/date_of_birth slots, no observations[] array (the observation
//     string shortcut is the only append path). This keeps the optional-field
//     count under Anthropic's 24-cap for structured-output tool schemas.
//   - PERSISTED side is widened with z.union back-compat for legacy rows
//     written under the pre-TAC-300 shape (home_base/workplace as objects;
//     pronouns/dob populated). Legacy reads are normalized into the slim
//     shape at toParsedGuestContext time so the serializer and prompt block
//     see one shape end-to-end. Lazy migration: the next patch write replaces
//     a legacy object home_base with a string in place (deepMergeContext does
//     a shallow merge); no separate data backfill required.

// ===== Legacy nested shapes (PERSISTED reads only) =====

// Pre-TAC-300 home_base / workplace were structured objects. Kept here purely
// for legacy persisted-row parsing; the PATCH schema no longer emits these.
// .passthrough() so unknown keys don't fail parse — the union below picks
// these only when the value isn't a bare string.
const LegacyHomeBaseSchema = z.object({
  neighborhood: z.string().optional(),
  zip: z.string().optional(),
  city: z.string().optional(),
  address: z.string().optional(),
})

const LegacyWorkplaceSchema = z.object({
  neighborhood: z.string().optional(),
  employer: z.string().optional(),
})

// ===== PERSISTED shape (read from guests.context JSONB) =====

const GuestDetailsSchema = z.object({
  first_name: z.string().optional(),
  last_name: z.string().optional(),
  // Pronouns / date_of_birth: kept on the persisted shape so legacy rows that
  // captured these under TAC-296 still surface in the prompt block. The PATCH
  // schema no longer emits them — new captures route through the observation
  // shortcut — but capturable-before-stays-capturable-after.
  date_of_birth: z.string().optional(),
  pronouns: z.string().optional(),
  // Union: post-TAC-300 the agent emits these as bare strings. Legacy reads
  // accept the pre-TAC-300 object shape and toParsedGuestContext normalizes
  // either to a single string for the serializer.
  home_base: z.union([z.string(), LegacyHomeBaseSchema]).optional(),
  workplace: z.union([z.string(), LegacyWorkplaceSchema]).optional(),
})

const PreferencesSchema = z.object({
  dietary: z.array(z.string()).optional(),
  favorites: z.array(z.string()).optional(),
  dislikes: z.array(z.string()).optional(),
})

// life_context entries are time-bounded notes ("going to Tokyo for two weeks,
// back on the 30th"). expires_at is the read-time filter boundary. captured_at
// is required at the persisted boundary — the runtime stamps it on every
// merged entry.
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

// ===== PATCH shape (what the agent emits on contextUpdate.structured) =====
//
// TAC-300 slim shape — the only structured emission surface for the LLM.
//   - home_base / workplace are bare strings (collapsed from pre-TAC-300
//     objects). Free-form descriptive — "Bernal Heights", "marketing agency
//     near Union Square", whatever fits the share. The runtime stores the
//     string verbatim; the prompt block renders it on a single line.
//   - pronouns / date_of_birth: NOT in the patch shape. The model captures
//     these via the observation string shortcut on GuestContextUpdate
//     instead — single sentence appended to observations[] with a runtime-
//     stamped captured_at.
//   - life_context entries carry no captured_at (runtime always stamps).
//   - observations[]: NOT in the patch shape. The observation string
//     shortcut is the sole append path.
//
// Optional-field count contribution: 11 inside structured + 2 outer
// (structured + observation) = 13. Combined with the TAC-297 commitment (4)
// and arrivalCapture (3) emissions, GeneratedMessageSchema lands at 20
// optionals total — under Anthropic's 24-cap with 4 slots of headroom.
// See lib/ai/schema-budget.test.ts for the CI guardrail.
//
// Parse-permissive posture: every field optional, no .strict(), unknown keys
// silently stripped. A near-miss patch from the model (e.g. an extra slot the
// LLM hallucinated) doesn't fail validation — it just drops the unknown key.
// This preserves the regen loop's "schema failure doesn't poison the run"
// invariant established in TAC-296.

const GuestDetailsPatchSchema = z.object({
  first_name: z.string().optional(),
  last_name: z.string().optional(),
  home_base: z.string().optional(),
  workplace: z.string().optional(),
})

const LifeContextPatchEntrySchema = z.object({
  note: z.string(),
  expires_at: z.string().optional(),
})

export const GuestContextPatchSchema = z.object({
  guest_details: GuestDetailsPatchSchema.optional(),
  preferences: PreferencesSchema.optional(),
  life_context: z.array(LifeContextPatchEntrySchema).optional(),
})

export type GuestContextPatch = z.infer<typeof GuestContextPatchSchema>

// ===== Runtime projection (post-filter + normalize for prompt rendering) =====

// Runtime-ready shape: post-filterActiveLifeContext + observations truncated,
// home_base/workplace normalized from legacy objects to bare strings. Distinct
// from GuestContext (the persisted shape) so the prompt-rendering path can't
// accidentally see expired life_context entries or untouched legacy objects.
export interface ParsedGuestContext {
  guest_details?: {
    first_name?: string
    last_name?: string
    pronouns?: string
    date_of_birth?: string
    home_base?: string
    workplace?: string
  }
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

// Normalize a persisted home_base (string or legacy object) into a single
// string for the prompt block. Legacy object → "neighborhood, city, zip,
// address" with empties filtered. String → passthrough. Undefined → undefined.
// Empty string (or empty join) → undefined so the serializer skips the line.
function normalizeHomeBase(
  value: string | z.infer<typeof LegacyHomeBaseSchema> | undefined,
): string | undefined {
  if (value === undefined) return undefined
  if (typeof value === 'string') {
    const trimmed = value.trim()
    return trimmed.length > 0 ? trimmed : undefined
  }
  const parts = [value.neighborhood, value.city, value.zip, value.address].filter(
    (p): p is string => typeof p === 'string' && p.trim().length > 0,
  )
  return parts.length > 0 ? parts.join(', ') : undefined
}

// Mirror of normalizeHomeBase for workplace. Legacy fields are employer first
// (the more identifying piece) then neighborhood.
function normalizeWorkplace(
  value: string | z.infer<typeof LegacyWorkplaceSchema> | undefined,
): string | undefined {
  if (value === undefined) return undefined
  if (typeof value === 'string') {
    const trimmed = value.trim()
    return trimmed.length > 0 ? trimmed : undefined
  }
  const parts = [value.employer, value.neighborhood].filter(
    (p): p is string => typeof p === 'string' && p.trim().length > 0,
  )
  return parts.length > 0 ? parts.join(', ') : undefined
}

/**
 * Convert a persisted GuestContext into the runtime-ready ParsedGuestContext.
 * Applies filterActiveLifeContext (drops expired + malformed), truncates
 * observations to the last OBSERVATION_RENDER_LIMIT, and normalizes legacy
 * home_base / workplace object shapes into bare strings. Pure — no side
 * effects beyond the console.warn from the filter step.
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

  let normalizedGuestDetails: ParsedGuestContext['guest_details'] | undefined
  if (context.guest_details !== undefined) {
    const d = context.guest_details
    const normalized = {
      first_name: d.first_name,
      last_name: d.last_name,
      pronouns: d.pronouns,
      date_of_birth: d.date_of_birth,
      home_base: normalizeHomeBase(d.home_base),
      workplace: normalizeWorkplace(d.workplace),
    }
    // Drop the whole object if every renderable field is empty post-normalize.
    const anyPresent =
      normalized.first_name !== undefined ||
      normalized.last_name !== undefined ||
      normalized.pronouns !== undefined ||
      normalized.date_of_birth !== undefined ||
      normalized.home_base !== undefined ||
      normalized.workplace !== undefined
    normalizedGuestDetails = anyPresent ? normalized : undefined
  }

  return {
    guest_details: normalizedGuestDetails,
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
