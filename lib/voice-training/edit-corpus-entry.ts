// Edit an existing voice_corpus row in place. THE-237 (Voices command-
// center). Two fields are editable from the rail: content + tags.
//
// Re-embed only when content changed — tags-only updates skip Voyage. The
// chunk text and embeddings are content-derived; voice corpus tags carry
// no runtime routing (voice retrieval is cosine-only). Knowledge corpus
// uses tag-aware routing as of TAC-242, but that's a separate table with
// its own edit path — this helper is voice-only.

import { createAdminClient } from '@/lib/db/admin'
import { ingestCorpusEntry } from '@/lib/rag'

export interface EditCorpusEntryInput {
  corpusId: string
  /** When provided, content is updated and embeddings are refreshed. */
  content?: string
  /** When provided, tags are replaced with this array. */
  tags?: string[]
}

export type EditCorpusEntryResult =
  | {
      ok: true
      corpusId: string
      reEmbedded: boolean
    }
  | {
      ok: false
      error: string
      errorCode: 'embed_failed' | 'db_error' | 'no_op'
    }

export async function editCorpusEntry(
  input: EditCorpusEntryInput,
): Promise<EditCorpusEntryResult> {
  if (input.content === undefined && input.tags === undefined) {
    return {
      ok: false,
      error: 'no_op: pass at least one of content or tags',
      errorCode: 'no_op',
    }
  }

  const supabase = createAdminClient()

  // Strongly-typed payload — supabase-js's RejectExcessProperties on .update()
  // rejects an unknown-keyed Record. Build the shape inline instead.
  const updatePayload: {
    content?: string
    tags?: string[]
    is_processed?: boolean
  } = {}
  if (input.content !== undefined) {
    updatePayload.content = input.content
    // is_processed=false up front signals "embeddings are stale" while we
    // re-embed; ingestCorpusEntry flips it back to true on success.
    updatePayload.is_processed = false
  }
  if (input.tags !== undefined) updatePayload.tags = input.tags

  const { error: updateErr } = await supabase
    .from('voice_corpus')
    .update(updatePayload)
    .eq('id', input.corpusId)
  if (updateErr) {
    return {
      ok: false,
      error: `update failed: ${updateErr.message}`,
      errorCode: 'db_error',
    }
  }

  if (input.content === undefined) {
    return { ok: true, corpusId: input.corpusId, reEmbedded: false }
  }

  const embedResult = await ingestCorpusEntry(input.corpusId)
  if (!embedResult.ok) {
    return {
      ok: false,
      error: `embed failed: ${embedResult.error}${embedResult.errorCode ? ` (${embedResult.errorCode})` : ''}`,
      errorCode: 'embed_failed',
    }
  }

  return { ok: true, corpusId: input.corpusId, reEmbedded: true }
}
