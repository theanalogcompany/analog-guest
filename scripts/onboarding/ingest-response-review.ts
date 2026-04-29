// DB-touching layer for ingest-response-review (THE-178). Pure helpers and
// types live in ./ingest-response-review-pure so the test file's import
// chain doesn't transit @/* path aliases that vitest can't resolve.
import type { Json } from '@/db/types'
import { createAdminClient } from '@/lib/db/admin'
import { ingestCorpusEntry } from '@/lib/rag'
import { BrandPersonaSchema } from '@/lib/schemas'
import { normalizeForCompare, type ReviewRow, tagsForRow } from './ingest-response-review-pure'

export {
  appendPhase5Section,
  buildPhase5Subsection,
  classifyRow,
  type CorpusEntrySummary,
  normalizeForCompare,
  parseReviewSheet,
  type ReviewRow,
  type RowKind,
  rulePayloadFromComment,
  SHEET_HEADERS,
  tagsForRow,
} from './ingest-response-review-pure'

const CONFIDENCE_SCORE = 0.95
const SOURCE_TYPE = 'operator_edit'

export interface UpsertResult {
  inserted: boolean
  corpusId: string
  embedFailed?: boolean
}

/**
 * Upsert a voice_corpus row keyed on (venue_id, source_ref). Matches the
 * partial unique index added in migration 008. If the row already exists,
 * returns the existing id without re-embedding. If new, embeds via Voyage
 * (ingestCorpusEntry). Per-row Voyage failure does not throw — it sets
 * embedFailed: true and returns; caller decides what to do.
 */
export async function upsertCorpusEdit(
  venueId: string,
  row: ReviewRow,
): Promise<UpsertResult> {
  const supabase = createAdminClient()
  const sourceRef = `08-review:${row.sample_id}`

  const { data: existing, error: lookupError } = await supabase
    .from('voice_corpus')
    .select('id')
    .eq('venue_id', venueId)
    .eq('source_ref', sourceRef)
    .maybeSingle()
  if (lookupError) {
    throw new Error(`upsertCorpusEdit: lookup failed for ${sourceRef}: ${lookupError.message}`)
  }
  if (existing) {
    return { inserted: false, corpusId: existing.id }
  }

  const { data: inserted, error: insertError } = await supabase
    .from('voice_corpus')
    .insert({
      venue_id: venueId,
      source_type: SOURCE_TYPE,
      source_ref: sourceRef,
      content: row.edited_message,
      tags: tagsForRow(row),
      confidence_score: CONFIDENCE_SCORE,
    })
    .select('id')
    .single()
  if (insertError || !inserted) {
    throw new Error(
      `upsertCorpusEdit: insert failed for ${sourceRef}: ${insertError?.message ?? 'no row'}`,
    )
  }

  const embedResult = await ingestCorpusEntry(inserted.id)
  if (!embedResult.ok) {
    console.error(
      `[ingest-response-review] embed failed for ${row.sample_id}: ${embedResult.error}${embedResult.errorCode ? ` (${embedResult.errorCode})` : ''}`,
    )
    return { inserted: true, corpusId: inserted.id, embedFailed: true }
  }
  return { inserted: true, corpusId: inserted.id }
}

function toJson<T>(value: T): Json {
  return JSON.parse(JSON.stringify(value)) as Json
}

export interface AntiPatternUpdateResult {
  existing: string[]
  added: string[]
}

/**
 * Read venue_configs.brand_persona, dedupe candidate rules against the
 * existing voiceAntiPatterns array (whitespace + case normalized comparison),
 * write back if any new rules. Returns the diff for logging.
 *
 * Read-modify-write is acceptable here because the script is single-operator
 * and the JSONB blob is small. No concurrent writers expected.
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
  const existingNormalized = new Set(persona.voiceAntiPatterns.map(normalizeForCompare))

  // Dedupe candidates against existing AND against each other (in case the
  // same rule appears on multiple rows in one run).
  const seen = new Set<string>()
  const added: string[] = []
  for (const candidate of candidateRules) {
    const norm = normalizeForCompare(candidate)
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