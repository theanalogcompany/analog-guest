import { createAdminClient } from '@/lib/db/admin'
import { chunkText } from './chunk'
import { EMBEDDING_MODEL } from './client'
import { embedText } from './embed'
import type { IngestResult, RAGResult } from './types'

type CorpusKind = 'voice' | 'knowledge'

function toVectorLiteral(embedding: number[]): string {
  return `[${embedding.join(',')}]`
}

/**
 * Embed a corpus entry's content into the matching embeddings table. Shared
 * by voice_corpus + voice_embeddings (via ingestCorpusEntry) and
 * knowledge_corpus + knowledge_embeddings (via ingestKnowledgeCorpusEntry).
 *
 * The lifecycle is identical for both: fetch (id, venue_id, content), delete
 * any existing embeddings for idempotency, chunk + embed via Voyage, bulk
 * insert, flag is_processed. Per-chunk embed failures warn-and-skip; the call
 * still returns ok with the count of successfully embedded chunks. Branches
 * exist only at the four DB call sites because Supabase's typed query builder
 * needs string-literal table names.
 *
 * Server-only. Uses the admin DB client, which bypasses RLS.
 */
async function ingestCorpusInternal(
  corpusId: string,
  kind: CorpusKind,
): Promise<RAGResult<IngestResult>> {
  const supabase = createAdminClient()

  const fetchResult =
    kind === 'voice'
      ? await supabase
          .from('voice_corpus')
          .select('id, venue_id, content')
          .eq('id', corpusId)
          .single()
      : await supabase
          .from('knowledge_corpus')
          .select('id, venue_id, content')
          .eq('id', corpusId)
          .single()
  const { data: corpusEntry, error: fetchError } = fetchResult

  if (fetchError) {
    if (fetchError.code === 'PGRST116') {
      return { ok: false, error: 'corpus_entry_not_found' }
    }
    return { ok: false, error: fetchError.message, errorCode: 'db_lookup_failed' }
  }

  const deleteResult =
    kind === 'voice'
      ? await supabase.from('voice_embeddings').delete().eq('corpus_id', corpusId)
      : await supabase.from('knowledge_embeddings').delete().eq('corpus_id', corpusId)

  if (deleteResult.error) {
    return {
      ok: false,
      error: deleteResult.error.message,
      errorCode: 'embeddings_delete_failed',
    }
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
        kind,
        corpusId,
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

  const insertResult =
    kind === 'voice'
      ? await supabase.from('voice_embeddings').insert(rows)
      : await supabase.from('knowledge_embeddings').insert(rows)

  if (insertResult.error) {
    return {
      ok: false,
      error: insertResult.error.message,
      errorCode: 'embeddings_insert_failed',
    }
  }

  // TODO: monitor for orphaned ingest where embeddings succeeded but is_processed flag failed
  const flagPayload = { is_processed: true, processed_at: new Date().toISOString() }
  const updateResult =
    kind === 'voice'
      ? await supabase.from('voice_corpus').update(flagPayload).eq('id', corpusId)
      : await supabase.from('knowledge_corpus').update(flagPayload).eq('id', corpusId)

  if (updateResult.error) {
    console.error('rag ingest: is_processed flag update failed after embeddings insert', {
      kind,
      corpusId,
      venueId: corpusEntry.venue_id,
      embeddedChunkCount: rows.length,
      error: updateResult.error.message,
    })
  }

  return { ok: true, data: { embeddedChunkCount: rows.length } }
}

/**
 * Embed a voice_corpus entry's content into voice_embeddings rows.
 * Idempotent: existing voice_embeddings rows for this corpus entry are
 * deleted before inserting the new ones.
 */
export async function ingestCorpusEntry(
  voiceCorpusId: string,
): Promise<RAGResult<IngestResult>> {
  return ingestCorpusInternal(voiceCorpusId, 'voice')
}

/**
 * Embed a knowledge_corpus entry's content into knowledge_embeddings rows.
 * Same lifecycle as ingestCorpusEntry — see ingestCorpusInternal for the
 * shared mechanics. The two functions exist as separate exports so callers
 * stay self-documenting at the call site.
 */
export async function ingestKnowledgeCorpusEntry(
  knowledgeCorpusId: string,
): Promise<RAGResult<IngestResult>> {
  return ingestCorpusInternal(knowledgeCorpusId, 'knowledge')
}
