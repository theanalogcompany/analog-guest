// Embed + insert a single voice_critique row. Called from the commit
// endpoint regardless of `kind` — every committed critique persists; the
// pattern-detection cluster query filters at read time.
//
// Embedding is stored on the row directly (no separate embeddings table).
// Critiques are short and not chunked, so a single Voyage call yields the
// 1024-dim vector that lands in voice_critiques.embedding.
//
// On embed failure we never insert. On insert failure after a successful
// embed we lose the embed work — acceptable since embeds are cheap and
// the critique itself doesn't exist as a partial row.

import { createAdminClient } from '@/lib/db/admin'
import { embedText } from '@/lib/rag'

export interface PersistCritiqueInput {
  venueId: string
  messageId: string
  critiqueText: string
  kind: 'edit_only' | 'edit_and_rule'
  createdByOperatorId?: string
}

export type PersistCritiqueResult =
  | { ok: true; critiqueId: string; embedding: number[] }
  | {
      ok: false
      error: string
      errorCode: 'embed_failed' | 'db_error' | 'invalid_input'
    }

function toVectorLiteral(embedding: number[]): string {
  return `[${embedding.join(',')}]`
}

export async function persistCritique(
  input: PersistCritiqueInput,
): Promise<PersistCritiqueResult> {
  if (input.critiqueText.trim().length === 0) {
    return {
      ok: false,
      error: 'critiqueText is empty',
      errorCode: 'invalid_input',
    }
  }

  const embedResult = await embedText(input.critiqueText, 'document')
  if (!embedResult.ok) {
    return {
      ok: false,
      error: `embed failed: ${embedResult.error}${embedResult.errorCode ? ` (${embedResult.errorCode})` : ''}`,
      errorCode: 'embed_failed',
    }
  }

  const supabase = createAdminClient()
  const { data, error } = await supabase
    .from('voice_critiques')
    .insert({
      venue_id: input.venueId,
      message_id: input.messageId,
      critique_text: input.critiqueText,
      kind: input.kind,
      embedding: toVectorLiteral(embedResult.data.embedding),
      ...(input.createdByOperatorId
        ? { created_by_operator_id: input.createdByOperatorId }
        : {}),
    })
    .select('id')
    .single()
  if (error || !data) {
    return {
      ok: false,
      error: `insert failed: ${error?.message ?? 'no row'}`,
      errorCode: 'db_error',
    }
  }

  return {
    ok: true,
    critiqueId: data.id,
    embedding: embedResult.data.embedding,
  }
}
