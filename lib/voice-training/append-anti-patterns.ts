// Dedupe-and-append rules into venue_configs.brand_persona.voiceAntiPatterns.
// Shared by the 08-flow (onboarding ingestion) and the cc-review live-edit
// flow; identical semantics in both, so a single helper rather than a
// per-channel wrapper.
//
// Read-modify-write: single-operator at the moment; no concurrent writers.
// If/when concurrent admin edits become real, swap for a Postgres function
// using jsonb_path_query / jsonb_array_append — for now the round trip is fine.
//
// THE-236: writes the struct shape {text, source, authorOperatorId?, addedAt}
// to voiceAntiPatterns. Legacy string entries already in storage get
// normalized at parse time (BrandPersonaSchema accepts both forms) and
// rewritten as structs whenever this helper touches the row.
//
// TODO(THE-236 follow-up): the in-place migration is lazy — venues whose
// persona is never written by this helper or another writer stay in the
// legacy `string[]` shape indefinitely. That's fine for runtime behavior
// (the schema normalizes on read) but means fleet-level analytics that
// query `voice_antipattern_meta` (source mix, recency, authorship) will
// silently underrepresent the legacy half. Track this when fleet analytics
// land — either backfill on first read or run a one-shot migration script.
//
// TODO(Voices commit endpoint, PR-B): the AntiPatternUpdateResult shape
// returns `existing` and `added` as `string[]` because today's callers
// (08-flow CLI, cc-review API) only count or stringify them for markdown
// summaries. The Voices commit endpoint will want the full struct (source,
// addedAt, authorOperatorId) to render attribution back in the UI without a
// re-read. Widen the return type then; don't widen now and force unused
// fields through every caller.

import type { Json } from '@/db/types'
import { createAdminClient } from '@/lib/db/admin'
import {
  type AntiPatternSource,
  BrandPersonaSchema,
  type VoiceAntiPattern,
} from '@/lib/schemas'

export interface AntiPatternUpdateOpts {
  source: AntiPatternSource
  /** Operator UUID. Omit for unattended writers (CLI scripts, cron). */
  authorOperatorId?: string
}

export interface AntiPatternUpdateResult {
  /** Texts of voiceAntiPatterns as they were before this call. */
  existing: string[]
  /** Texts of net-new entries appended (post-dedupe, including intra-batch dedupe). */
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
 * net-new entries with source/author/addedAt metadata, and write back.
 * Returns the diff for caller logging.
 *
 * Throws on DB or schema-validation failure. Callers in route handlers
 * should wrap in try/catch and translate to a 500.
 */
export async function dedupeAndAppendAntiPatterns(
  venueId: string,
  candidateRules: string[],
  opts: AntiPatternUpdateOpts,
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
  const existingTexts = persona.voiceAntiPatterns.map((p) => p.text)
  const existingNormalized = new Set(existingTexts.map(normalizeAntiPattern))

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
    return { existing: existingTexts, added: [] }
  }

  const addedAt = new Date().toISOString()
  const newEntries: VoiceAntiPattern[] = added.map((text) => ({
    text,
    source: opts.source,
    addedAt,
    ...(opts.authorOperatorId ? { authorOperatorId: opts.authorOperatorId } : {}),
  }))

  const updatedPersona = {
    ...persona,
    voiceAntiPatterns: [...persona.voiceAntiPatterns, ...newEntries],
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
  return { existing: existingTexts, added }
}
