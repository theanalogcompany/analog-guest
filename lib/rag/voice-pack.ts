/**
 * The static per-venue voice pack (decision 0008, 2026-09-29 owner ruling).
 *
 * Voice is one consistent style, loaded THE SAME WAY for every message. This
 * replaced per-message similarity retrieval (`retrieveContext` over
 * `match_voice_corpus`): a venue's voice does not change with the question,
 * so embedding the guest's message to pick "situationally apt" exemplars
 * bought reordering, not voice — and it cost a Voyage call plus an RPC on
 * every turn and an entire outage mode (embedding down = no reply, because
 * voice fails closed on inbound).
 *
 * Measured 2026-09-29 across all three live venues: whole corpora are 19-63
 * entries and 2,640-5,001 chars (~650-1,250 tokens). The budgets below hold
 * every venue's ENTIRE corpus; they exist as growth insurance, not as a
 * selection mechanism in practice. When a corpus does outgrow them, the
 * order below decides what survives: operator-reviewed entries first
 * (`operator_edit` — the owner's own corrections from response review), then
 * newest first, id as the deterministic tiebreak.
 *
 * `anti_pattern`-tagged entries are excluded. The onboarding tag vocabulary
 * allows them and they are examples of what NOT to sound like; rendering one
 * under "Examples of how the venue actually communicates" would train the
 * model on the exact wording the tag exists to ban. Zero exist in production
 * today — the filter is defensive, and cheap.
 *
 * Fail direction is the CALLER's decision (stages.ts throws on inbound,
 * proceeds on followups); this module only reports `{ok: false}` on a DB
 * failure and never throws.
 */

import { createAdminClient } from '@/lib/db/admin'
import type { RAGResult, VoiceCorpusChunk } from './types'

/** Growth ceilings, not practical limits — see header. */
export const VOICE_PACK_MAX_ENTRIES = 80
export const VOICE_PACK_CHAR_BUDGET = 12_000

export interface VoicePackRow {
  id: string
  content: string
  source_type: string
  confidence_score: number | null
  tags: string[]
  created_at: string
}

/**
 * Pure selection: operator_edit first, newest first, id tiebreak;
 * anti_pattern excluded; capped by entries and total chars. Exported for
 * tests — the DB read below is a thin shell around this.
 */
export function selectVoicePack(
  rows: VoicePackRow[],
  maxEntries: number = VOICE_PACK_MAX_ENTRIES,
  charBudget: number = VOICE_PACK_CHAR_BUDGET,
): VoiceCorpusChunk[] {
  const ordered = rows
    .filter((r) => !r.tags.includes('anti_pattern'))
    .sort((a, b) => {
      const aEdit = a.source_type === 'operator_edit' ? 1 : 0
      const bEdit = b.source_type === 'operator_edit' ? 1 : 0
      if (aEdit !== bEdit) return bEdit - aEdit
      if (a.created_at !== b.created_at)
        return a.created_at < b.created_at ? 1 : -1
      return a.id < b.id ? -1 : 1
    })

  const pack: VoiceCorpusChunk[] = []
  let chars = 0
  for (const row of ordered) {
    if (pack.length >= maxEntries) break
    if (chars + row.content.length > charBudget && pack.length > 0) break
    chars += row.content.length
    pack.push({
      id: row.id,
      voiceCorpusId: row.id,
      text: row.content,
      sourceType: row.source_type,
      confidence: row.confidence_score ?? 0,
      // The chunk type carries a similarity because retrieval used to. The
      // pack is not retrieved, so every entry reports 1 — the field survives
      // only so ragChunksToProse and CorpusMatch consumers need no change.
      similarity: 1,
    })
  }
  return pack
}

/** Load the venue's voice pack. Identical result for every message. */
export async function loadVoicePack(input: {
  venueId: string
}): Promise<RAGResult<VoiceCorpusChunk[]>> {
  if (input.venueId.length === 0) {
    return { ok: false, error: 'invalid_input' }
  }
  const supabase = createAdminClient()
  const { data, error } = await supabase
    .from('voice_corpus')
    .select('id, content, source_type, confidence_score, tags, created_at')
    .eq('venue_id', input.venueId)
  if (error) {
    return { ok: false, error: error.message, errorCode: 'db_query_failed' }
  }
  return { ok: true, data: selectVoicePack(data ?? []) }
}
