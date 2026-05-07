// Shared corpus-write helper used by both the 08-flow onboarding ingestion
// (scripts/ingest-response-review.ts) and the cc-review live-edit flow
// (app/admin/(authed)/conversations/api/review/[messageId]/route.ts).
//
// Anti-corpus-poisoning rule: only the operator's `editedMessage` content is
// stored in voice_corpus. The original generated_message and inbound_message
// are NOT embedded — that would teach retrieval the rejected phrasing.
//
// On embed failure: deletes the just-inserted corpus row so we never leave an
// un-embedded entry behind. Both modes obey this. Callers see ok=false with
// errorCode='embed_failed' and surface a retry affordance to the operator.

import { createAdminClient } from '@/lib/db/admin'
import { ingestCorpusEntry } from '@/lib/rag'

export const DEFAULT_OPERATOR_EDIT_CONFIDENCE = 0.95

export type UpsertCorpusMode = 'skip-existing' | 'replace'

export interface UpsertEditInput {
  venueId: string
  /**
   * Idempotency key — stored on voice_corpus.source_ref under the partial
   * unique index (venue_id, source_ref) from migration 008. Channel-prefixed:
   *   - '08-review:{sample_id}' for the onboarding flow
   *   - 'cc-review:{message_id}' for the Command Center flow
   */
  sourceRef: string
  /** The ONLY content embedded into voice_corpus. See file-top comment. */
  editedMessage: string
  tags: string[]
}

export type UpsertEditResult =
  | {
      ok: true
      corpusId: string
      /** 'inserted' = no prior row; 'replaced' = existing row supplanted (replace mode);
       *  'skipped_existing' = prior row preserved (skip-existing mode, idempotent re-run). */
      outcome: 'inserted' | 'replaced' | 'skipped_existing'
    }
  | {
      ok: false
      error: string
      errorCode: 'embed_failed' | 'db_error'
    }

/**
 * Upsert an operator-edited message into voice_corpus + embed via Voyage.
 *
 * Mode 'skip-existing' (08-flow): if (venue_id, source_ref) row exists,
 * return outcome='skipped_existing' without modification or re-embed. Used by
 * the onboarding pipeline where re-running the script is a deliberate no-op.
 *
 * Mode 'replace' (cc-review): if existing row exists, delete it (FK-cascades
 * voice_embeddings) before inserting the new content. The previous edit is
 * retracted as part of starting the replace operation; if the new save fails
 * (Voyage error), the prior edit is also gone. Acceptable trade-off given
 * "don't persist un-embedded" — the alternative would be a multi-step
 * snapshot-and-restore that adds complexity for a single-operator surface.
 *
 * On embed failure (either mode), the just-inserted corpus row is deleted to
 * preserve the no-orphan invariant.
 */
export async function upsertCorpusEdit(
  input: UpsertEditInput,
  mode: UpsertCorpusMode,
): Promise<UpsertEditResult> {
  const supabase = createAdminClient()

  const { data: existing, error: lookupErr } = await supabase
    .from('voice_corpus')
    .select('id')
    .eq('venue_id', input.venueId)
    .eq('source_ref', input.sourceRef)
    .maybeSingle()
  if (lookupErr) {
    return {
      ok: false,
      error: `lookup failed for ${input.sourceRef}: ${lookupErr.message}`,
      errorCode: 'db_error',
    }
  }

  if (existing && mode === 'skip-existing') {
    return { ok: true, corpusId: existing.id, outcome: 'skipped_existing' }
  }

  const replacing = existing !== null
  if (replacing) {
    const { error: delErr } = await supabase
      .from('voice_corpus')
      .delete()
      .eq('id', existing.id)
    if (delErr) {
      return {
        ok: false,
        error: `delete-existing failed for ${input.sourceRef}: ${delErr.message}`,
        errorCode: 'db_error',
      }
    }
  }

  const { data: inserted, error: insertErr } = await supabase
    .from('voice_corpus')
    .insert({
      venue_id: input.venueId,
      source_type: 'operator_edit',
      source_ref: input.sourceRef,
      content: input.editedMessage,
      tags: input.tags,
      confidence_score: DEFAULT_OPERATOR_EDIT_CONFIDENCE,
    })
    .select('id')
    .single()
  if (insertErr || !inserted) {
    return {
      ok: false,
      error: `insert failed for ${input.sourceRef}: ${insertErr?.message ?? 'no row'}`,
      errorCode: 'db_error',
    }
  }

  const embedResult = await ingestCorpusEntry(inserted.id)
  if (!embedResult.ok) {
    // Clean up the orphan. Cascade kills any partial voice_embeddings rows.
    const { error: cleanupErr } = await supabase
      .from('voice_corpus')
      .delete()
      .eq('id', inserted.id)
    if (cleanupErr) {
      console.error(
        '[voice-training] cleanup-after-embed-failure failed; voice_corpus row stranded',
        {
          corpusId: inserted.id,
          sourceRef: input.sourceRef,
          embedError: embedResult.error,
          cleanupError: cleanupErr.message,
        },
      )
    }
    return {
      ok: false,
      error: `embed failed: ${embedResult.error}${embedResult.errorCode ? ` (${embedResult.errorCode})` : ''}`,
      errorCode: 'embed_failed',
    }
  }

  return {
    ok: true,
    corpusId: inserted.id,
    outcome: replacing ? 'replaced' : 'inserted',
  }
}
