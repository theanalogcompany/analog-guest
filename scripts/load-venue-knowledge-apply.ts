// Phase 3 write path for the venue knowledge loader. Separated from the
// orchestrator so the read-only half stays readable and so nothing here is
// reachable without an explicit --apply.
//
// Shape follows app/admin/(authed)/_lib/knowledge-corpus.ts (addKnowledgeEntry
// / editKnowledgeEntry) rather than inventing one:
//   INSERT  -> ingestKnowledgeCorpusEntry -> on embed failure DELETE the row
//   UPDATE  -> is_processed=false -> ingestKnowledgeCorpusEntry
// The seeder precedent for calling ingestKnowledgeCorpusEntry directly from a
// script is scripts/onboarding/seed-supabase.ts. This adds the admin helper's
// cleanup-on-embed-failure, which the seeder lacks: the seeder warns and
// leaves an unembedded row, which is a row that exists and can never be
// retrieved.
//
// A failure ABORTS the whole run rather than continuing. Partial loads are
// resumable by design (see decideLoadAction), so aborting loses nothing and
// stops a systematic fault from repeating 50 times.

import type { SupabaseClient } from '@supabase/supabase-js'
import { ingestKnowledgeCorpusEntry } from '@/lib/rag'
import { decideLoadAction, type LoadableRow, type Proposal } from './load-venue-knowledge-pure'

/** source_type for rows this loader CREATES. A replacement keeps whatever
 *  source_type its target already had — the row's origin did not change
 *  because we corrected a sentence in it. */
export const NEW_ROW_SOURCE_TYPE = 'document_import'

export interface ApplyInput {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: SupabaseClient<any, any, any>
  venueId: string
  venueSlug: string
  proposalFile: string
  entries: readonly Proposal[]
  /** row_id -> resolved target uuid, for action='replace'. */
  resolvedTargets: ReadonlyMap<string, string>
  rows: readonly LoadableRow[]
  now: string
}

export type ApplyOutcome =
  | { rowId: string; kind: 'inserted'; id: string; chunks: number }
  | { rowId: string; kind: 'updated'; id: string; chunks: number; reason: string }
  | { rowId: string; kind: 'skipped'; id: string }

export interface ApplyResult {
  outcomes: ApplyOutcome[]
  inserted: number
  updated: number
  skipped: number
}

interface ExistingRowForUpdate {
  content: string
  metadata: Record<string, unknown> | null
}

export async function applyLoad(input: ApplyInput): Promise<ApplyResult> {
  const { supabase, venueId, proposalFile, entries, resolvedTargets, rows, now } = input
  const outcomes: ApplyOutcome[] = []

  for (const p of entries) {
    const targetId = resolvedTargets.get(p.row_id) ?? null
    const action = decideLoadAction(p, targetId, rows)

    if (action.kind === 'skip') {
      outcomes.push({ rowId: p.row_id, kind: 'skipped', id: action.id })
      continue
    }

    if (action.kind === 'insert') {
      const { data: insertedRow, error: insertErr } = await supabase
        .from('knowledge_corpus')
        .insert({
          venue_id: venueId,
          content: p.content,
          primary_tags: p.primary_tags,
          secondary_tags: p.secondary_tags,
          source_type: NEW_ROW_SOURCE_TYPE,
          source_ref: p.source_ref,
          // confidence_score deliberately omitted: the column default (0.85)
          // is the ruling, and naming it here would freeze a copy of it.
          metadata: { proposalRowId: p.row_id, proposalFile, loadedAt: now },
        })
        .select('id')
        .single()
      if (insertErr || !insertedRow) {
        throw new Error(`${p.row_id}: insert failed: ${insertErr?.message ?? 'no row returned'}`)
      }

      const embed = await ingestKnowledgeCorpusEntry(insertedRow.id)
      if (!embed.ok) {
        const { error: cleanupErr } = await supabase
          .from('knowledge_corpus')
          .delete()
          .eq('id', insertedRow.id)
        throw new Error(
          `${p.row_id}: embed failed (${embed.error}); ` +
            (cleanupErr
              ? `CLEANUP ALSO FAILED (${cleanupErr.message}) — row ${insertedRow.id} is stranded unembedded and must be deleted by hand`
              : `the row was deleted, so re-running resumes cleanly`),
        )
      }
      outcomes.push({
        rowId: p.row_id,
        kind: 'inserted',
        id: insertedRow.id,
        chunks: embed.data.embeddedChunkCount,
      })
      continue
    }

    // update: either a confirmed replacement or a resume of a stamped row
    // whose embedding never landed.
    const { data: currentRaw, error: readErr } = await supabase
      .from('knowledge_corpus')
      .select('content, metadata')
      .eq('id', action.id)
      .eq('venue_id', venueId)
      .single()
    if (readErr || !currentRaw) {
      throw new Error(
        `${p.row_id}: could not read target ${action.id} at this venue: ${readErr?.message ?? 'no row'}`,
      )
    }
    const current = currentRaw as ExistingRowForUpdate
    const priorMeta = (current.metadata ?? {}) as Record<string, unknown>

    // On a RESUME the row already holds the new content, so taking
    // current.content would overwrite the record of what was there before
    // with the replacement itself. Keep the first value ever captured.
    const replacedContent =
      typeof priorMeta.replacedContent === 'string' ? priorMeta.replacedContent : current.content

    const { error: updateErr } = await supabase
      .from('knowledge_corpus')
      .update({
        content: p.content,
        primary_tags: p.primary_tags,
        secondary_tags: p.secondary_tags,
        source_ref: p.source_ref,
        // source_type is NOT touched: correcting a sentence does not change
        // where the row came from.
        is_processed: false,
        metadata: {
          ...priorMeta,
          proposalRowId: p.row_id,
          proposalFile,
          loadedAt: now,
          replacedContent,
          replacedAt: priorMeta.replacedAt ?? now,
        },
      })
      .eq('id', action.id)
      .eq('venue_id', venueId)
    if (updateErr) throw new Error(`${p.row_id}: update failed: ${updateErr.message}`)

    const embed = await ingestKnowledgeCorpusEntry(action.id)
    if (!embed.ok) {
      // Deliberately NOT rolled back. The row is real reviewed content; the
      // prior text is preserved in metadata.replacedContent, and it is now
      // stamped-but-unprocessed, which decideLoadAction resumes on the next
      // run. Deleting it would destroy a venue fact to tidy up a retry.
      throw new Error(
        `${p.row_id}: embed failed after updating ${action.id} (${embed.error}). ` +
          'The row holds the new content with is_processed=false and its prior text in ' +
          'metadata.replacedContent. Re-run to retry; nothing was lost.',
      )
    }
    outcomes.push({
      rowId: p.row_id,
      kind: 'updated',
      id: action.id,
      chunks: embed.data.embeddedChunkCount,
      reason: action.reason,
    })
  }

  return {
    outcomes,
    inserted: outcomes.filter((o) => o.kind === 'inserted').length,
    updated: outcomes.filter((o) => o.kind === 'updated').length,
    skipped: outcomes.filter((o) => o.kind === 'skipped').length,
  }
}
