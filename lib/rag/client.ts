import { VoyageAIClient } from 'voyageai'

export const EMBEDDING_MODEL = 'voyage-3-large'
export const EMBEDDING_DIMENSIONS = 1024

// TODO: when we want to support per-venue embedding model overrides
// (e.g. switch to voyage-3.5-lite for cost), accept config and read from
// venue_configs.

export function getVoyageClient(): VoyageAIClient {
  const apiKey = process.env.VOYAGE_API_KEY
  if (!apiKey) throw new Error('Missing env var: VOYAGE_API_KEY')
  return new VoyageAIClient({ apiKey })
}