export { retrieveKnowledgeContext } from './retrieve'
export { loadVoicePack, selectVoicePack } from './voice-pack'
export { ingestCorpusEntry, ingestKnowledgeCorpusEntry } from './ingest'
export { embedText } from './embed'
// Only `unknownKnowledgeSourceTypes` is exported: `retrieve.ts` imports
// RETRIEVABLE_SOURCE_TYPES by path, and nothing outside lib/rag needs the
// roles map itself. An export with no reader is the thing this repo keeps
// paying for, so the barrel stays narrow.
export {
  isRetrievableSourceType,
  unknownKnowledgeSourceTypes,
} from './knowledge-source-roles'

export type {
  EmbedTextResult,
  EmbeddingInputType,
  IngestResult,
  KnowledgeCorpusChunk,
  RAGResult,
  RetrieveKnowledgeContextInput,
  VoiceCorpusChunk,
} from './types'
