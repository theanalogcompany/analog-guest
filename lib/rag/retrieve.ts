import { createAdminClient } from '@/lib/db/admin'
import { embedText } from './embed'
import type {
  KnowledgeCorpusChunk,
  RAGResult,
  RetrieveContextInput,
  RetrieveKnowledgeContextInput,
  VoiceCorpusChunk,
} from './types'

export const DEFAULT_LIMIT = 5
export const SIMILARITY_FLOOR = 0.3
// Default confidence floor for knowledge_corpus retrieval (TAC-242). Excludes
// chunks with confidence_score below this from the returned set. Matches the
// classifier's low-confidence threshold for symmetry. Operators can override
// per-call via RetrieveKnowledgeContextInput.minConfidence.
export const KNOWLEDGE_CONFIDENCE_FLOOR_DEFAULT = 0.7

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

/**
 * Retrieve the top-K most semantically similar knowledge-corpus chunks for a
 * query within a single venue's knowledge corpus.
 *
 * Mirrors retrieveContext: same Voyage embed, same SIMILARITY_FLOOR, same
 * fail-on-error contract. Calls match_knowledge_corpus (migration 013, RPC
 * shape updated by 017) with three optional filters:
 *   - source_type_filter: surface-type narrowing (unused at call sites today).
 *   - min_confidence: defaults to KNOWLEDGE_CONFIDENCE_FLOOR_DEFAULT (0.7) so
 *     low-confidence chunks don't slip into the prompt.
 *   - primary_tag_filter: array-overlap routing preference derived per-call
 *     from the inbound's classification category (TAC-242).
 *
 * Returns chunks with both primary_tags and secondary_tags surfaced so the
 * prompt serializer can render them as separate lines for grounding clarity.
 */
export async function retrieveKnowledgeContext(
  input: RetrieveKnowledgeContextInput,
): Promise<RAGResult<KnowledgeCorpusChunk[]>> {
  if (input.venueId.length === 0 || input.query.length === 0) {
    return { ok: false, error: 'invalid_input' }
  }

  const queryEmbed = await embedText(input.query, 'query')
  if (!queryEmbed.ok) {
    return { ok: false, error: queryEmbed.error, errorCode: 'embedding_failed' }
  }

  const supabase = createAdminClient()
  const limit = input.limit ?? DEFAULT_LIMIT
  const minConfidence = input.minConfidence ?? KNOWLEDGE_CONFIDENCE_FLOOR_DEFAULT

  const { data, error } = await supabase.rpc('match_knowledge_corpus', {
    query_venue_id: input.venueId,
    query_embedding: toVectorLiteral(queryEmbed.data.embedding),
    match_count: limit,
    min_confidence: minConfidence,
    ...(input.sourceTypeFilter !== undefined && { source_type_filter: input.sourceTypeFilter }),
    ...(input.primaryTagPreference !== undefined && {
      primary_tag_filter: input.primaryTagPreference,
    }),
  })

  if (error) {
    return { ok: false, error: error.message, errorCode: 'db_query_failed' }
  }

  const rows = data ?? []
  const chunks: KnowledgeCorpusChunk[] = rows
    .filter((r) => r.similarity >= SIMILARITY_FLOOR)
    .map((r) => ({
      id: r.id,
      knowledgeCorpusId: r.corpus_id,
      text: r.chunk_text,
      sourceType: r.source_type,
      confidence: r.confidence_score ?? 0,
      similarity: r.similarity,
      primaryTags: r.primary_tags ?? [],
      secondaryTags: r.secondary_tags ?? [],
    }))

  return { ok: true, data: chunks }
}