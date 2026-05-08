// Remove a venue rule from venue_configs.brand_persona.voiceAntiPatterns by
// exact text match. THE-237 — Voices command-center rules pane delete
// affordance.
//
// Exact match is intentional: operators delete what they see in the UI. The
// dedupe path (dedupeAndAppendAntiPatterns) uses normalized comparison for
// add-time dedup, but delete is a precise reversal of one specific entry.
// If casing or whitespace differs from what's stored, the operator's
// intent is unclear — return not_found and let them re-read the displayed
// text.
//
// Read-modify-write through BrandPersonaSchema; legacy string entries get
// in-place migrated to struct shape on the same write.

import type { Json } from '@/db/types'
import { createAdminClient } from '@/lib/db/admin'
import { BrandPersonaSchema } from '@/lib/schemas'

export type RemoveAntiPatternResult =
  | { ok: true; removed: true; remainingCount: number }
  | { ok: false; error: string; errorCode: 'not_found' | 'db_error' }

function toJson<T>(value: T): Json {
  return JSON.parse(JSON.stringify(value)) as Json
}

export async function removeAntiPattern(
  venueId: string,
  ruleText: string,
): Promise<RemoveAntiPatternResult> {
  const supabase = createAdminClient()
  const { data, error } = await supabase
    .from('venue_configs')
    .select('brand_persona')
    .eq('venue_id', venueId)
    .single()
  if (error || !data) {
    return {
      ok: false,
      error: `venue_configs lookup failed for ${venueId}: ${error?.message ?? 'no row'}`,
      errorCode: 'db_error',
    }
  }

  const personaParsed = BrandPersonaSchema.safeParse(data.brand_persona)
  if (!personaParsed.success) {
    return {
      ok: false,
      error: `brand_persona JSONB validation failed: ${personaParsed.error.message}`,
      errorCode: 'db_error',
    }
  }
  const persona = personaParsed.data

  const filtered = persona.voiceAntiPatterns.filter((p) => p.text !== ruleText)
  if (filtered.length === persona.voiceAntiPatterns.length) {
    return {
      ok: false,
      error: `rule not found: ${ruleText}`,
      errorCode: 'not_found',
    }
  }

  const updatedPersona = { ...persona, voiceAntiPatterns: filtered }
  const { error: updateErr } = await supabase
    .from('venue_configs')
    .update({ brand_persona: toJson(updatedPersona) })
    .eq('venue_id', venueId)
  if (updateErr) {
    return {
      ok: false,
      error: `update failed for ${venueId}: ${updateErr.message}`,
      errorCode: 'db_error',
    }
  }

  return { ok: true, removed: true, remainingCount: filtered.length }
}
