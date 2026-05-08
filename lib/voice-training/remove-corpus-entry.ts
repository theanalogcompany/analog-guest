// Delete a voice_corpus row. THE-237 — Voices command-center "delete" affordance
// on the rail's corpus pane. The voice_embeddings rows are killed by FK cascade
// (ON DELETE CASCADE in migration 001).

import { createAdminClient } from '@/lib/db/admin'

export type RemoveCorpusEntryResult =
  | { ok: true; corpusId: string }
  | { ok: false; error: string; errorCode: 'db_error' | 'not_found' }

export async function removeCorpusEntry(
  corpusId: string,
): Promise<RemoveCorpusEntryResult> {
  const supabase = createAdminClient()

  const { data, error } = await supabase
    .from('voice_corpus')
    .delete()
    .eq('id', corpusId)
    .select('id')
    .maybeSingle()
  if (error) {
    return { ok: false, error: error.message, errorCode: 'db_error' }
  }
  if (!data) {
    return { ok: false, error: `corpus entry not found: ${corpusId}`, errorCode: 'not_found' }
  }
  return { ok: true, corpusId }
}
