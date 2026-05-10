export type EmbeddingInputType = 'document' | 'query'

// TODO: tighten to union from voice_corpus.source_type check constraint when
// corpus management UI ships.
export type VoiceCorpusChunk = {
  id: string
  text: string
  sourceType: string
  confidence: number
  similarity: number
  voiceCorpusId: string
}

// Mirror of VoiceCorpusChunk plus the knowledge_corpus tag split (TAC-242):
// `primaryTags` is a closed-enum routing signal (lib/schemas/knowledge-tags),
// `secondaryTags` is free-form descriptive context. Both render in the prompt
// for grounding; only primary is used by retrieval routing.
export type KnowledgeCorpusChunk = {
  id: string
  text: string
  sourceType: string
  confidence: number
  similarity: number
  knowledgeCorpusId: string
  primaryTags: string[]
  secondaryTags: string[]
}

export type RetrieveContextInput = {
  venueId: string
  query: string
  limit?: number
  sourceTypeFilter?: string[]
  minConfidence?: number
}

export type RetrieveKnowledgeContextInput = {
  venueId: string
  query: string
  limit?: number
  sourceTypeFilter?: string[]
  minConfidence?: number
  // Routing preference for primary_tag_filter on the RPC (TAC-242). Array
  // overlap (&&) — a chunk qualifies if it has ANY of the listed primary
  // tags. Derived from the inbound's classification category via
  // lib/agent/knowledge-tag-mapping. Omit for cosine-only retrieval.
  primaryTagPreference?: string[]
}

export type IngestResult = {
  embeddedChunkCount: number
}

export type EmbedTextResult = {
  embedding: number[]
  model: string
}

export type RAGResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: string; errorCode?: string }