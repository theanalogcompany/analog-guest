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

export type RetrieveContextInput = {
  venueId: string
  query: string
  limit?: number
  sourceTypeFilter?: string[]
  minConfidence?: number
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