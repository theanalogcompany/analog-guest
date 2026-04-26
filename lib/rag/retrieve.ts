import { createAdminClient } from '@/lib/db/admin'
import { embedText } from './embed'
import type { RAGResult, RetrieveContextInput, VoiceCorpusChunk } from './types'

const DEFAULT_LIMIT = 5
const SIMILARITY_FLOOR = 0.3

function toVectorLiteral(embedding: number[]): string {
  return `[${embedding.join(',')}]`
}

/**
 * Retrieve the top-K most semantically similar voice-corpus chunks for a
 * query within a single venue's corpus.
 *
 * Server-only. Uses the admin DB client, which bypasses RLS. Calls the
 * Postgres function match_voice_corpus (see migration 004) for cosine
 * similarity search via pgvector. Results below SIMILARITY_FLOOR (0.3) are
 * filtered out — an empty array is a valid result for a sparse corpus.
 */
export async function retrieveContext(
  input: RetrieveContextInput,
): Promise<RAGResult<VoiceCorpusChunk[]>> {
  if (input.venueId.length === 0 || input.query.length === 0) {
    return { ok: false, error: 'invalid_input' }
  }

  const queryEmbed = await embedText(input.query, 'query')
  if (!queryEmbed.ok) {
    return { ok: false, error: queryEmbed.error, errorCode: 'embedding_failed' }
  }

  const supabase = createAdminClient()
  const limit = input.limit ?? DEFAULT_LIMIT

  const { data, error } = await supabase.rpc('match_voice_corpus', {
    query_venue_id: input.venueId,
    query_embedding: toVectorLiteral(queryEmbed.data.embedding),
    match_count: limit,
    ...(input.sourceTypeFilter !== undefined && { source_type_filter: input.sourceTypeFilter }),
    ...(input.minConfidence !== undefined && { min_confidence: input.minConfidence }),
  })

  if (error) {
    return { ok: false, error: error.message, errorCode: 'db_query_failed' }
  }

  const rows = data ?? []
  const chunks: VoiceCorpusChunk[] = rows
    .filter((r) => r.similarity >= SIMILARITY_FLOOR)
    .map((r) => ({
      id: r.id,
      voiceCorpusId: r.corpus_id,
      text: r.chunk_text,
      sourceType: r.source_type,
      // null confidence_score is treated as untrusted (filter-friendly default); actual entries should always set this explicitly per CLAUDE.md convention.
      confidence: r.confidence_score ?? 0,
      similarity: r.similarity,
    }))

  return { ok: true, data: chunks }
}