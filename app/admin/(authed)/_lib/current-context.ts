// TAC-343 Stage D: venue_info.currentContext write helpers. Entries are
// array elements inside one jsonb column, not their own DB rows, so every
// operation here is read-modify-write-validate-the-WHOLE-venue_info-object
// — same load-bearing pattern as the venue-info PATCH route (Stage C) and
// the same reason: venue_info renders into every prompt turn, so a
// partial/invalid write isn't a display bug, it's the agent losing a fact.

import { randomUUID } from 'node:crypto'
import { createAdminClient } from '@/lib/db/admin'
import { toJson } from '@/lib/db/json'
import { ingestKnowledgeCorpusEntry } from '@/lib/rag'
import { type VenueContextNote, VenueInfoSchema } from '@/lib/schemas'
import { loadVenueInfo } from './venue-info'

export type AddCurrentContextResult =
  | { ok: true; entry: VenueContextNote }
  | { ok: false; error: string; errorCode: 'db_error' | 'invalid_after_merge' }

export async function addCurrentContextEntry(input: {
  venueId: string
  content: string
  expiresAt?: string
}): Promise<AddCurrentContextResult> {
  const supabase = createAdminClient()

  const loaded = await loadVenueInfo(supabase, input.venueId)
  if (!loaded.ok) return { ok: false, error: loaded.error, errorCode: 'db_error' }

  const newEntry: VenueContextNote = {
    id: randomUUID(),
    content: input.content,
    source: 'manual_entry',
    addedAt: new Date(),
    expiresAt: input.expiresAt,
  }

  const merged = {
    ...loaded.venueInfo,
    currentContext: [...loaded.venueInfo.currentContext, newEntry],
  }
  const validated = VenueInfoSchema.safeParse(merged)
  if (!validated.success) {
    return {
      ok: false,
      error: `venue_info invalid after merge: ${validated.error.message}`,
      errorCode: 'invalid_after_merge',
    }
  }

  const { error: writeErr } = await supabase
    .from('venue_configs')
    .update({ venue_info: toJson(validated.data) })
    .eq('venue_id', input.venueId)
  if (writeErr) {
    return { ok: false, error: `write failed: ${writeErr.message}`, errorCode: 'db_error' }
  }

  return { ok: true, entry: newEntry }
}

export type DropCurrentContextResult =
  | { ok: true }
  | { ok: false; error: string; errorCode: 'db_error' | 'not_found' | 'invalid_after_merge' }

export async function dropCurrentContextEntry(input: {
  venueId: string
  entryId: string
}): Promise<DropCurrentContextResult> {
  const supabase = createAdminClient()

  const loaded = await loadVenueInfo(supabase, input.venueId)
  if (!loaded.ok) return { ok: false, error: loaded.error, errorCode: 'db_error' }

  if (!loaded.venueInfo.currentContext.some((e) => e.id === input.entryId)) {
    return { ok: false, error: `entry not found: ${input.entryId}`, errorCode: 'not_found' }
  }

  const merged = {
    ...loaded.venueInfo,
    currentContext: loaded.venueInfo.currentContext.filter((e) => e.id !== input.entryId),
  }
  const validated = VenueInfoSchema.safeParse(merged)
  if (!validated.success) {
    return { ok: false, error: `venue_info invalid after merge: ${validated.error.message}`, errorCode: 'db_error' }
  }

  const { error: writeErr } = await supabase
    .from('venue_configs')
    .update({ venue_info: toJson(validated.data) })
    .eq('venue_id', input.venueId)
  if (writeErr) {
    return { ok: false, error: `write failed: ${writeErr.message}`, errorCode: 'db_error' }
  }

  return { ok: true }
}

export type PromoteCurrentContextResult =
  | { ok: true; knowledgeCorpusId: string }
  | { ok: false; error: string; errorCode: 'db_error' | 'not_found' | 'embed_failed' }

/**
 * Convert an expired/malformed currentContext entry into a permanent
 * knowledge_corpus row. Same insert-then-embed-before-removing-source
 * ordering as split/merge (lib/admin/_lib/knowledge-corpus.ts): the new
 * row is inserted and embedded FIRST; only once that succeeds is the
 * currentContext entry removed. A failed embed leaves the entry sitting in
 * the queue, untouched — never destroyed with nothing to show for it.
 */
export async function promoteCurrentContextEntry(input: {
  venueId: string
  entryId: string
  primaryTag: string
  secondaryTags: string[]
}): Promise<PromoteCurrentContextResult> {
  const supabase = createAdminClient()

  const loaded = await loadVenueInfo(supabase, input.venueId)
  if (!loaded.ok) return { ok: false, error: loaded.error, errorCode: 'db_error' }

  const entry = loaded.venueInfo.currentContext.find((e) => e.id === input.entryId)
  if (!entry) {
    return { ok: false, error: `entry not found: ${input.entryId}`, errorCode: 'not_found' }
  }

  const { data: inserted, error: insertErr } = await supabase
    .from('knowledge_corpus')
    .insert({
      venue_id: input.venueId,
      content: entry.content,
      primary_tags: [input.primaryTag],
      secondary_tags: input.secondaryTags,
      source_type: 'manual_entry',
      metadata: { promotedFromCurrentContext: entry.id },
    })
    .select('id')
    .single()
  if (insertErr || !inserted) {
    return { ok: false, error: `insert failed: ${insertErr?.message ?? 'no row'}`, errorCode: 'db_error' }
  }

  const embedResult = await ingestKnowledgeCorpusEntry(inserted.id)
  if (!embedResult.ok) {
    const { error: cleanupErr } = await supabase.from('knowledge_corpus').delete().eq('id', inserted.id)
    if (cleanupErr) {
      console.error(
        '[current-context] promote: cleanup-after-embed-failure failed; row stranded',
        { venueId: input.venueId, entryId: input.entryId, knowledgeCorpusId: inserted.id, embedError: embedResult.error, cleanupError: cleanupErr.message },
      )
    }
    return {
      ok: false,
      error: `embed failed: ${embedResult.error}${embedResult.errorCode ? ` (${embedResult.errorCode})` : ''}`,
      errorCode: 'embed_failed',
    }
  }

  // Only now remove the currentContext entry — the knowledge row is live
  // and retrievable at this point regardless of what happens below. Re-read
  // venue_info fresh here rather than reusing `loaded` from the top of this
  // function: the Voyage embed call above is a slow network round trip, and
  // writing back the pre-embed snapshot would silently clobber any edit an
  // admin made to this venue's venue_info during that window. Filtering a
  // fresh read is also safe if another admin already dropped/promoted this
  // same entry — the filter is a no-op in that case, not an error.
  const reloaded = await loadVenueInfo(supabase, input.venueId)
  if (!reloaded.ok) {
    console.error(
      '[current-context] promote: venue_info re-read failed after promotion; entry left in queue, knowledge row already live',
      { venueId: input.venueId, entryId: input.entryId, knowledgeCorpusId: inserted.id, error: reloaded.error },
    )
    return { ok: false, error: reloaded.error, errorCode: 'db_error' }
  }
  const merged = {
    ...reloaded.venueInfo,
    currentContext: reloaded.venueInfo.currentContext.filter((e) => e.id !== input.entryId),
  }
  const validated = VenueInfoSchema.safeParse(merged)
  if (!validated.success) {
    // The promoted knowledge is already live; leaving the currentContext
    // entry in place too is a duplicate (queue shows an already-promoted
    // note), not a loss — same accepted failure direction as split/merge.
    console.error(
      '[current-context] promote: venue_info invalid after removing promoted entry; entry left in queue, knowledge row already live',
      { venueId: input.venueId, entryId: input.entryId, knowledgeCorpusId: inserted.id, error: validated.error.message },
    )
    return { ok: false, error: `venue_info invalid after merge: ${validated.error.message}`, errorCode: 'db_error' }
  }

  const { error: writeErr } = await supabase
    .from('venue_configs')
    .update({ venue_info: toJson(validated.data) })
    .eq('venue_id', input.venueId)
  if (writeErr) {
    console.error(
      '[current-context] promote: venue_info write failed after promotion; entry left in queue, knowledge row already live',
      { venueId: input.venueId, entryId: input.entryId, knowledgeCorpusId: inserted.id, error: writeErr.message },
    )
    return { ok: false, error: `venue_info write failed: ${writeErr.message}`, errorCode: 'db_error' }
  }

  return { ok: true, knowledgeCorpusId: inserted.id }
}
