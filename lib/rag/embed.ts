import { EMBEDDING_DIMENSIONS, EMBEDDING_MODEL, getVoyageClient } from './client'
import type { EmbedTextResult, EmbeddingInputType, RAGResult } from './types'

/**
 * Embed a single text string via Voyage. Use inputType='document' when
 * indexing a corpus chunk and inputType='query' when embedding a search
 * query — Voyage tunes the embedding for the role.
 */
export async function embedText(
  text: string,
  inputType: EmbeddingInputType,
): Promise<RAGResult<EmbedTextResult>> {
  if (text.length === 0) {
    return { ok: false, error: 'empty_text' }
  }

  try {
    const client = getVoyageClient()
    const resp = await client.embed({
      input: text,
      model: EMBEDDING_MODEL,
      inputType,
      outputDimension: EMBEDDING_DIMENSIONS,
    })

    const embedding = resp.data?.[0]?.embedding
    if (!embedding) {
      return {
        ok: false,
        error: 'voyage_returned_no_embedding',
        errorCode: 'voyage_api_error',
      }
    }

    return {
      ok: true,
      data: { embedding, model: EMBEDDING_MODEL },
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    return { ok: false, error: message, errorCode: 'voyage_api_error' }
  }
}