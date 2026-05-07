// Dedupe-and-append rules into venue_configs.brand_persona.voiceAntiPatterns.
// Shared by the 08-flow (onboarding ingestion) and the cc-review live-edit
// flow; identical semantics in both, so a single helper rather than a
// per-channel wrapper.
//
// Read-modify-write: single-operator at the moment; no concurrent writers.
// If/when concurrent admin edits become real, swap for a Postgres function
// using jsonb_path_query / jsonb_array_append — for now the round trip is fine.

import type { Json } from '@/db/types'
import { createAdminClient } from '@/lib/db/admin'
import { BrandPersonaSchema } from '@/lib/schemas'

export interface AntiPatternUpdateResult {
  /** voiceAntiPatterns array as it was before this call. */
  existing: string[]
  /** Net-new entries appended (post-dedupe, including intra-batch dedupe). */
  added: string[]
}

/**
 * Lowercase, collapse whitespace, trim. Used for dedupe equality only;
 * stored strings remain as-typed by the operator.
 */
export function normalizeAntiPattern(s: string): string {
  return s.toLowerCase().replace(/\s+/g, ' ').trim()
}

function toJson<T>(value: T): Json {
  return JSON.parse(JSON.stringify(value)) as Json
}

/**
 * Read venue_configs.brand_persona, dedupe candidates against the existing
 * voiceAntiPatterns (whitespace + case normalized comparison), append the
 * net-new entries, and write back. Returns the diff for caller logging.
 *
 * Throws on DB or schema-validation failure. Callers in route handlers
 * should wrap in try/catch and translate to a 500.
 */
export async function dedupeAndAppendAntiPatterns(
  venueId: string,
  candidateRules: string[],
): Promise<AntiPatternUpdateResult> {
  const supabase = createAdminClient()
  const { data, error } = await supabase
    .from('venue_configs')
    .select('brand_persona')
    .eq('venue_id', venueId)
    .single()
  if (error || !data) {
    throw new Error(
      `dedupeAndAppendAntiPatterns: venue_configs lookup failed for ${venueId}: ${error?.message ?? 'no row'}`,
    )
  }

  const personaParsed = BrandPersonaSchema.safeParse(data.brand_persona)
  if (!personaParsed.success) {
    throw new Error(
      `dedupeAndAppendAntiPatterns: brand_persona JSONB validation failed: ${personaParsed.error.message}`,
    )
  }
  const persona = personaParsed.data
  const existingNormalized = new Set(persona.voiceAntiPatterns.map(normalizeAntiPattern))

  // Dedupe candidates against existing AND against each other (in case the
  // same rule appears multiple times in one batch).
  const seen = new Set<string>()
  const added: string[] = []
  for (const candidate of candidateRules) {
    const norm = normalizeAntiPattern(candidate)
    if (norm.length === 0) continue
    if (existingNormalized.has(norm) || seen.has(norm)) continue
    seen.add(norm)
    added.push(candidate)
  }

  if (added.length === 0) {
    return { existing: persona.voiceAntiPatterns, added: [] }
  }

  const updatedPersona = {
    ...persona,
    voiceAntiPatterns: [...persona.voiceAntiPatterns, ...added],
  }
  const { error: updateError } = await supabase
    .from('venue_configs')
    .update({ brand_persona: toJson(updatedPersona) })
    .eq('venue_id', venueId)
  if (updateError) {
    throw new Error(
      `dedupeAndAppendAntiPatterns: update failed for ${venueId}: ${updateError.message}`,
    )
  }
  return { existing: persona.voiceAntiPatterns, added }
}
