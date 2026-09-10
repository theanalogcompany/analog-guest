// TAC-343 Stage B: knowledge_corpus write helpers for the venue admin
// surface. Mirrors lib/voice-training/{add,edit,remove}-corpus-entry.ts 1:1
// for the single-row operations, extended with split/merge — operations
// voice_corpus has no equivalent of.
//
// Admin-route-scoped rather than a new lib/knowledge-training/ directory:
// nothing outside this admin surface needs single-row knowledge_corpus CRUD
// today (the onboarding seeder calls ingestKnowledgeCorpusEntry directly,
// not through a shared add/edit/remove layer) — see the TAC-343 plan review.

import { createAdminClient } from '@/lib/db/admin'
import { ingestKnowledgeCorpusEntry } from '@/lib/rag'

export interface AddKnowledgeEntryInput {
  venueId: string
  content: string
  primaryTags: string[]
  secondaryTags: string[]
  /** Defaults to 'manual_entry' — knowledge_corpus.source_type has no CHECK
   *  constraint (unlike voice_corpus), so this is a convention, not a schema
   *  requirement. */
  sourceType?: string
  addedByOperatorId?: string
}

export type AddKnowledgeEntryResult =
  | { ok: true; corpusId: string; embeddedChunkCount: number }
  | { ok: false; error: string; errorCode: 'embed_failed' | 'db_error' }

export async function addKnowledgeEntry(
  input: AddKnowledgeEntryInput,
): Promise<AddKnowledgeEntryResult> {
  const supabase = createAdminClient()

  const { data: inserted, error: insertErr } = await supabase
    .from('knowledge_corpus')
    .insert({
      venue_id: input.venueId,
      content: input.content,
      primary_tags: input.primaryTags,
      secondary_tags: input.secondaryTags,
      source_type: input.sourceType ?? 'manual_entry',
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

  const embedResult = await ingestKnowledgeCorpusEntry(inserted.id)
  if (!embedResult.ok) {
    const { error: cleanupErr } = await supabase
      .from('knowledge_corpus')
      .delete()
      .eq('id', inserted.id)
    if (cleanupErr) {
      console.error(
        '[knowledge-corpus] add: cleanup-after-embed-failure failed; row stranded',
        { corpusId: inserted.id, venueId: input.venueId, embedError: embedResult.error, cleanupError: cleanupErr.message },
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

export interface EditKnowledgeEntryInput {
  corpusId: string
  /** When provided, content is updated and embeddings are refreshed. */
  content?: string
  primaryTags?: string[]
  secondaryTags?: string[]
}

export type EditKnowledgeEntryResult =
  | { ok: true; corpusId: string; reEmbedded: boolean }
  | { ok: false; error: string; errorCode: 'embed_failed' | 'db_error' | 'no_op' }

/**
 * Editing an entry with content is the fix path for a knowledge_corpus row
 * stuck at is_processed=false (a prior embed failure, or a partial write) —
 * this optimistically flips is_processed to false while re-embedding (same
 * "stale while re-embedding" signal editCorpusEntry uses for voice_corpus),
 * and ingestKnowledgeCorpusEntry flips it back to true on success. There is
 * no separate "retry embed" action: submitting the (possibly unchanged)
 * content is the retry.
 */
export async function editKnowledgeEntry(
  input: EditKnowledgeEntryInput,
): Promise<EditKnowledgeEntryResult> {
  if (
    input.content === undefined &&
    input.primaryTags === undefined &&
    input.secondaryTags === undefined
  ) {
    return {
      ok: false,
      error: 'no_op: pass at least one of content, primaryTags, or secondaryTags',
      errorCode: 'no_op',
    }
  }

  const supabase = createAdminClient()

  const updatePayload: {
    content?: string
    primary_tags?: string[]
    secondary_tags?: string[]
    is_processed?: boolean
  } = {}
  if (input.content !== undefined) {
    updatePayload.content = input.content
    updatePayload.is_processed = false
  }
  if (input.primaryTags !== undefined) updatePayload.primary_tags = input.primaryTags
  if (input.secondaryTags !== undefined) updatePayload.secondary_tags = input.secondaryTags

  const { error: updateErr } = await supabase
    .from('knowledge_corpus')
    .update(updatePayload)
    .eq('id', input.corpusId)
  if (updateErr) {
    return {
      ok: false,
      error: `update failed: ${updateErr.message}`,
      errorCode: 'db_error',
    }
  }

  if (input.content === undefined) {
    return { ok: true, corpusId: input.corpusId, reEmbedded: false }
  }

  const embedResult = await ingestKnowledgeCorpusEntry(input.corpusId)
  if (!embedResult.ok) {
    return {
      ok: false,
      error: `embed failed: ${embedResult.error}${embedResult.errorCode ? ` (${embedResult.errorCode})` : ''}`,
      errorCode: 'embed_failed',
    }
  }

  return { ok: true, corpusId: input.corpusId, reEmbedded: true }
}

export type RemoveKnowledgeEntryResult =
  | { ok: true; corpusId: string }
  | { ok: false; error: string; errorCode: 'db_error' | 'not_found' }

export async function removeKnowledgeEntry(
  corpusId: string,
): Promise<RemoveKnowledgeEntryResult> {
  const supabase = createAdminClient()

  const { data, error } = await supabase
    .from('knowledge_corpus')
    .delete()
    .eq('id', corpusId)
    .select('id')
    .maybeSingle()
  if (error) {
    return { ok: false, error: error.message, errorCode: 'db_error' }
  }
  if (!data) {
    return { ok: false, error: `knowledge entry not found: ${corpusId}`, errorCode: 'not_found' }
  }
  return { ok: true, corpusId }
}

export interface SplitPieceInput {
  content: string
  primaryTags: string[]
  secondaryTags: string[]
}

export interface SplitKnowledgeEntryInput {
  originalId: string
  venueId: string
  pieces: SplitPieceInput[]
}

export type SplitKnowledgeEntryResult =
  | { ok: true; newIds: string[] }
  | { ok: false; error: string; errorCode: 'embed_failed' | 'db_error' | 'invalid_input' }

/**
 * Split one knowledge_corpus row into N. Atomicity without a transaction:
 * insert all N new rows, embed each in sequence, and only delete the
 * original after every embed succeeds. A failure partway through deletes
 * whatever new rows were already inserted (cascade clears their
 * embeddings) and leaves the original untouched — the original is never
 * deleted until N-for-N success is confirmed, so there is no window where
 * the split "loses" content. The one accepted residual: if the final
 * delete of the original itself fails after every embed succeeded, the
 * result is a duplicate (original + N new rows both live), not data loss —
 * logged loudly, still returned as ok:true, since the split's actual
 * deliverable (N retrievable rows) succeeded.
 */
export async function splitKnowledgeEntry(
  input: SplitKnowledgeEntryInput,
): Promise<SplitKnowledgeEntryResult> {
  if (input.pieces.length < 2) {
    return { ok: false, error: 'split requires at least 2 pieces', errorCode: 'invalid_input' }
  }

  const supabase = createAdminClient()

  const { data: original, error: fetchErr } = await supabase
    .from('knowledge_corpus')
    .select('source_type, venue_id')
    .eq('id', input.originalId)
    .single()
  if (fetchErr || !original) {
    return {
      ok: false,
      error: `original not found: ${fetchErr?.message ?? 'no row'}`,
      errorCode: 'db_error',
    }
  }
  // Defensive: today's only caller (the split route) derives venueId from
  // requireKnowledgeEntryAdmin, which reads it off this same row, so this
  // can never actually fire — but asserting it here means a future caller
  // that passes a mismatched venueId fails loudly instead of silently
  // creating new rows under the wrong venue while deleting the correctly-
  // scoped original. mergeKnowledgeEntries doesn't need an equivalent check
  // — requireKnowledgeEntriesAdmin already enforces single-venue span
  // across all sources before venueId is ever resolved.
  if (original.venue_id !== input.venueId) {
    return {
      ok: false,
      error: `original belongs to a different venue than requested`,
      errorCode: 'invalid_input',
    }
  }

  const { data: inserted, error: insertErr } = await supabase
    .from('knowledge_corpus')
    .insert(
      input.pieces.map((piece) => ({
        venue_id: input.venueId,
        content: piece.content,
        primary_tags: piece.primaryTags,
        secondary_tags: piece.secondaryTags,
        source_type: original.source_type,
        metadata: { splitFrom: input.originalId },
      })),
    )
    .select('id')
  if (insertErr || !inserted) {
    return {
      ok: false,
      error: `insert failed: ${insertErr?.message ?? 'no rows'}`,
      errorCode: 'db_error',
    }
  }

  const newIds = inserted.map((row) => row.id)
  for (const id of newIds) {
    const embedResult = await ingestKnowledgeCorpusEntry(id)
    if (!embedResult.ok) {
      const { error: cleanupErr } = await supabase
        .from('knowledge_corpus')
        .delete()
        .in('id', newIds)
      if (cleanupErr) {
        console.error(
          '[knowledge-corpus] split: cleanup-after-embed-failure failed; rows stranded',
          { originalId: input.originalId, newIds, embedError: embedResult.error, cleanupError: cleanupErr.message },
        )
      }
      return {
        ok: false,
        error: `embed failed on piece: ${embedResult.error}${embedResult.errorCode ? ` (${embedResult.errorCode})` : ''}`,
        errorCode: 'embed_failed',
      }
    }
  }

  const { error: deleteErr } = await supabase
    .from('knowledge_corpus')
    .delete()
    .eq('id', input.originalId)
  if (deleteErr) {
    console.error(
      '[knowledge-corpus] split: original delete failed after every piece embedded; original and new rows both live until manually cleaned up',
      { originalId: input.originalId, newIds, deleteError: deleteErr.message },
    )
  }

  return { ok: true, newIds }
}

export interface MergeKnowledgeEntriesInput {
  originalIds: string[]
  venueId: string
  content: string
  primaryTags: string[]
  secondaryTags: string[]
}

export type MergeKnowledgeEntriesResult =
  | { ok: true; newId: string }
  | { ok: false; error: string; errorCode: 'embed_failed' | 'db_error' | 'invalid_input' }

/**
 * Merge N knowledge_corpus rows into one. Same atomicity shape as split,
 * mirrored: insert the one new row, embed it, and only delete the N
 * originals after that single embed succeeds. Same accepted residual on a
 * final-delete failure — a duplicate, not a loss.
 */
export async function mergeKnowledgeEntries(
  input: MergeKnowledgeEntriesInput,
): Promise<MergeKnowledgeEntriesResult> {
  if (input.originalIds.length < 2) {
    return { ok: false, error: 'merge requires at least 2 source entries', errorCode: 'invalid_input' }
  }

  const supabase = createAdminClient()

  const { data: inserted, error: insertErr } = await supabase
    .from('knowledge_corpus')
    .insert({
      venue_id: input.venueId,
      content: input.content,
      primary_tags: input.primaryTags,
      secondary_tags: input.secondaryTags,
      source_type: 'manual_entry',
      metadata: { mergedFrom: input.originalIds },
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

  const embedResult = await ingestKnowledgeCorpusEntry(inserted.id)
  if (!embedResult.ok) {
    const { error: cleanupErr } = await supabase
      .from('knowledge_corpus')
      .delete()
      .eq('id', inserted.id)
    if (cleanupErr) {
      console.error(
        '[knowledge-corpus] merge: cleanup-after-embed-failure failed; row stranded',
        { originalIds: input.originalIds, newId: inserted.id, embedError: embedResult.error, cleanupError: cleanupErr.message },
      )
    }
    return {
      ok: false,
      error: `embed failed: ${embedResult.error}${embedResult.errorCode ? ` (${embedResult.errorCode})` : ''}`,
      errorCode: 'embed_failed',
    }
  }

  const { error: deleteErr } = await supabase
    .from('knowledge_corpus')
    .delete()
    .in('id', input.originalIds)
  if (deleteErr) {
    console.error(
      '[knowledge-corpus] merge: originals delete failed after the merged row embedded; originals and the new row both live until manually cleaned up',
      { originalIds: input.originalIds, newId: inserted.id, deleteError: deleteErr.message },
    )
  }

  return { ok: true, newId: inserted.id }
}
