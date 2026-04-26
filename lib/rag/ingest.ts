import { createAdminClient } from '@/lib/db/admin'
import { chunkText } from './chunk'
import { EMBEDDING_MODEL } from './client'
import { embedText } from './embed'
import type { IngestResult, RAGResult } from './types'

function toVectorLiteral(embedding: number[]): string {
  return `[${embedding.join(',')}]`
}

/**
 * Embed a voice_corpus entry's content into voice_embeddings rows.
 *
 * Server-only. Uses the admin DB client, which bypasses RLS. Idempotent:
 * existing voice_embeddings rows for this corpus entry are deleted before
 * inserting the new ones, so re-running overwrites rather than duplicates.
 * Per-chunk embedding failures are logged and skipped; the function still
 * returns ok: true with the count of successfully embedded chunks.
 */
export async function ingestCorpusEntry(
  voiceCorpusId: string,
): Promise<RAGResult<IngestResult>> {
  const supabase = createAdminClient()

  const { data: corpusEntry, error: fetchError } = await supabase
    .from('voice_corpus')
    .select('id, venue_id, content')
    .eq('id', voiceCorpusId)
    .single()

  if (fetchError) {
    if (fetchError.code === 'PGRST116') {
      return { ok: false, error: 'corpus_entry_not_found' }
    }
    return { ok: false, error: fetchError.message, errorCode: 'db_lookup_failed' }
  }

  const { error: deleteError } = await supabase
    .from('voice_embeddings')
    .delete()
    .eq('corpus_id', voiceCorpusId)

  if (deleteError) {
    return { ok: false, error: deleteError.message, errorCode: 'embeddings_delete_failed' }
  }

  const chunks = chunkText(corpusEntry.content)
  if (chunks.length === 0) {
    return { ok: false, error: 'corpus_entry_empty', errorCode: 'invalid_input' }
  }

  const rows: Array<{
    venue_id: string
    corpus_id: string
    chunk_text: string
    chunk_index: number
    embedding: string
    embedding_model: string
  }> = []

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i]
    const result = await embedText(chunk, 'document')
    if (!result.ok) {
      console.error('rag ingest: chunk embed failed', {
        voiceCorpusId,
        venueId: corpusEntry.venue_id,
        chunkIndex: i,
        error: result.error,
        errorCode: result.errorCode,
      })
      continue
    }
    rows.push({
      venue_id: corpusEntry.venue_id,
      corpus_id: corpusEntry.id,
      chunk_text: chunk,
      chunk_index: i,
      embedding: toVectorLiteral(result.data.embedding),
      embedding_model: EMBEDDING_MODEL,
    })
  }

  if (rows.length === 0) {
    return { ok: false, error: 'all_chunks_failed_to_embed', errorCode: 'voyage_api_error' }
  }

  const { error: insertError } = await supabase.from('voice_embeddings').insert(rows)
  if (insertError) {
    return { ok: false, error: insertError.message, errorCode: 'embeddings_insert_failed' }
  }

  // TODO: monitor for orphaned ingest where embeddings succeeded but is_processed flag failed
  const { error: updateError } = await supabase
    .from('voice_corpus')
    .update({ is_processed: true, processed_at: new Date().toISOString() })
    .eq('id', voiceCorpusId)
  if (updateError) {
    console.error('rag ingest: is_processed flag update failed after embeddings insert', {
      voiceCorpusId,
      venueId: corpusEntry.venue_id,
      embeddedChunkCount: rows.length,
      error: updateError.message,
    })
  }

  return { ok: true, data: { embeddedChunkCount: rows.length } }
}