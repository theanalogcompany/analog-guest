// Ad-hoc voice_corpus addition path. Used by the Voices command-center
// "+ Add entry" affordance; distinct from `upsertCorpusEdit` which is keyed
// on source_ref for the cc-review / 08-review / voices-commit channels.
//
// Operator typed the entry — no inbound, no triggering message — so we
// don't store an in/out pair. source_type is the operator's choice
// ('manual_entry' is the most common for ad-hoc rail additions; 'sample_text'
// for pasted examples; 'past_message' for reproducing real venue replies).
//
// THE-237. Mirrors upsertCorpusEdit's no-orphan invariant: insert row →
// embed → if embed fails, delete the inserted row so we never leave un-
// embedded corpus entries behind.

import { createAdminClient } from '@/lib/db/admin'
import { ingestCorpusEntry } from '@/lib/rag'

// Subset of voice_corpus.source_type that the rail UI exposes. Not the
// full enum — `operator_edit` is reserved for cc-review / voices-commit
// channels (those go through upsertCorpusEdit, not this helper).
export const ADD_CORPUS_SOURCE_TYPES = [
  'manual_entry',
  'sample_text',
  'past_message',
] as const
export type AddCorpusSourceType = (typeof ADD_CORPUS_SOURCE_TYPES)[number]

const DEFAULT_CONFIDENCE = 0.85

export interface AddCorpusEntryInput {
  venueId: string
  content: string
  sourceType: AddCorpusSourceType
  tags: string[]
  /** Operator UUID. Stored on voice_corpus.added_by_operator_id. */
  addedByOperatorId?: string
}

export type AddCorpusEntryResult =
  | {
      ok: true
      corpusId: string
      embeddedChunkCount: number
    }
  | {
      ok: false
      error: string
      errorCode: 'embed_failed' | 'db_error'
    }

export async function addCorpusEntry(
  input: AddCorpusEntryInput,
): Promise<AddCorpusEntryResult> {
  const supabase = createAdminClient()

  const { data: inserted, error: insertErr } = await supabase
    .from('voice_corpus')
    .insert({
      venue_id: input.venueId,
      source_type: input.sourceType,
      content: input.content,
      tags: input.tags,
      confidence_score: DEFAULT_CONFIDENCE,
      ...(input.addedByOperatorId
        ? { added_by_operator_id: input.addedByOperatorId }
        : {}),
    })
    .select('id')
    .single()
  if (insertErr || !inserted) {
    return {
      ok: false,
      error: `insert failed: ${insertErr?.message ?? 'no row'}`,
      errorCode: 'db_error',
    }
  }

  const embedResult = await ingestCorpusEntry(inserted.id)
  if (!embedResult.ok) {
    // Clean up the orphan. Cascade kills any partial voice_embeddings rows.
    const { error: cleanupErr } = await supabase
      .from('voice_corpus')
      .delete()
      .eq('id', inserted.id)
    if (cleanupErr) {
      console.error(
        '[voice-training] add-corpus-entry: cleanup-after-embed-failure failed; voice_corpus row stranded',
        {
          corpusId: inserted.id,
          venueId: input.venueId,
          embedError: embedResult.error,
          cleanupError: cleanupErr.message,
        },
      )
    }
    return {
      ok: false,
      error: `embed failed: ${embedResult.error}${embedResult.errorCode ? ` (${embedResult.errorCode})` : ''}`,
      errorCode: 'embed_failed',
    }
  }

  return {
    ok: true,
    corpusId: inserted.id,
    embeddedChunkCount: embedResult.data.embeddedChunkCount,
  }
}
