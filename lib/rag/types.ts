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

// Mirror of VoiceCorpusChunk with one addition: knowledge_corpus rows carry a
// topical `tags` array (sourcing, staff_<name>, mechanic_<slug>, etc.) that
// match_knowledge_corpus returns alongside the chunk. Voice corpus tags exist
// at the row level but aren't surfaced to the agent prompt — knowledge tags
// are, since topic disambiguation is part of grounding.
export type KnowledgeCorpusChunk = {
  id: string
  text: string
  sourceType: string
  confidence: number
  similarity: number
  knowledgeCorpusId: string
  tags: string[]
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
  // Optional topical filter (mechanic_<slug>, staff_<name>, etc.). Available
  // on the RPC but unused at the call sites today — let cosine similarity gate.
  tagFilter?: string[]
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