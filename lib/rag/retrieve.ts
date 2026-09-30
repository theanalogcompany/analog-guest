import { createAdminClient } from '@/lib/db/admin'
import { embedText } from './embed'
import type {
  KnowledgeCorpusChunk,
  RAGResult,
  RetrieveKnowledgeContextInput,
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

// Voice-corpus similarity retrieval (`retrieveContext` over
// `match_voice_corpus`) lived here until decision 0007 (2026-09-29): voice is
// a static per-venue pack now — see ./voice-pack.ts. The `match_voice_corpus`
// RPC (migration 004) and ingest-time voice embedding still exist; they are
// unused at runtime and removing them is a separate, optional cleanup.

/**
 * Retrieve the top-K most semantically similar knowledge-corpus chunks for a
 * query within a single venue's knowledge corpus.
 *
 * Voyage-embeds the query, filters at SIMILARITY_FLOOR, fails as a value on
 * error. Calls match_knowledge_corpus (migration 013, RPC shape updated by
 * 017) with three optional filters:
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