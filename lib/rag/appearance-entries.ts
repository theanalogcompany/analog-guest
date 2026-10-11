// TAC-584: what a venue's drinks, packaging and space LOOK like.
//
// The describe step (lib/ai/describe-attachment.ts) names a drink only by
// matching a guest's picture against a note the venue wrote about that
// drink's appearance. Those notes are ordinary knowledge rows carrying the
// secondary tag `appearance`, and this is the read that fetches them.
//
// BY TAG, NOT BY SIMILARITY. Every other read of `knowledge_corpus` on the
// agent's path embeds a query and asks for the nearest rows. There is no
// query here: the model needs every appearance note the venue has, each time,
// because the note that matters is the one for a drink nobody has named yet.
// So this is a plain select, and it costs no embedding call.
//
// THEY ARE STILL KNOWLEDGE. A guest asking "what's the pink one?" can retrieve
// the same rows the usual way. Which is why they are written as description
// and never as instruction (scripts/CLAUDE.md's placement rule): the rule
// about when a drink may be named lives in the describe prompt.
//
// ONLY RETRIEVABLE SOURCE TYPES. A voice note is not a source of fact (owner
// ruling 2026-10-05, lib/rag/knowledge-source-roles.ts) and is excluded here
// for the same reason it is excluded from retrieval.
//
// FAILS TO AN ERROR VALUE. The caller reads a failure as "no notes", which
// names no drink and marks no venue: the safe direction for both rules.

import type { SupabaseClient } from '@supabase/supabase-js'

import type { Database } from '@/db/types'

import { RETRIEVABLE_SOURCE_TYPES } from './knowledge-source-roles'
import type { RAGResult } from './types'

type AdminSupabaseClient = SupabaseClient<Database>

/** The secondary tag that marks a knowledge row as an appearance note. */
export const APPEARANCE_TAG = 'appearance'

/** More notes than one venue's menu, packaging and room need. */
const MAX_APPEARANCE_ENTRIES = 40

/**
 * A venue's appearance notes, oldest first so the order is stable from call
 * to call (the notes sit in a prompt, and a reshuffled prompt is a different
 * prompt).
 */
export async function loadAppearanceEntries(
  supabase: AdminSupabaseClient,
  venueId: string,
): Promise<RAGResult<string[]>> {
  try {
    const { data, error } = await supabase
      .from('knowledge_corpus')
      .select('content')
      .eq('venue_id', venueId)
      .contains('secondary_tags', [APPEARANCE_TAG])
      .in('source_type', [...RETRIEVABLE_SOURCE_TYPES])
      .order('created_at', { ascending: true })
      .order('id', { ascending: true })
      .limit(MAX_APPEARANCE_ENTRIES)
    if (error) return { ok: false, error: error.message }
    return {
      ok: true,
      data: (data ?? [])
        .map((row) => row.content.replace(/\s+/g, ' ').trim())
        .filter((content) => content !== ''),
    }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}
