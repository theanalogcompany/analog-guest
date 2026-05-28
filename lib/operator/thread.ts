// Loads the full conversation thread (guest-at-venue) behind the operator-app
// edit screen for TAC-277. Powers GET /api/operator/messages/[id]/thread.
//
// Two-step lookup. First resolve (venue_id, guest_id) by the supplied
// messageId; this isolates the "does this message exist at all" question
// from the "does this operator own its venue" question so callers can log /
// alert on the distinction even though the wire flattens both to 404. Then
// pull up to THREAD_MESSAGE_LIMIT messages for that (venue, guest) pair.
//
// Ordering: returns oldest→newest, BUT capped at the MOST RECENT N. This is
// the inverse of `loadConversationData` in
// app/admin/(authed)/conversations/page.tsx, which uses ASC LIMIT 200 and
// thus returns the OLDEST 200 (a latent bug — for any guest with >200
// non-empty-body messages it silently drops the recent end of the
// conversation). The TAC-277 Contract specifies "200 most-recent entries,
// oldest→newest" — we get there with DESC LIMIT 200 + reverse. Don't
// back-port the CC fix here; that's a separate ticket.
//
// Anti-corpus-poisoning isn't a concern here (read-only endpoint, no
// embedding write), but the body != '' filter mirrors the rest of the app:
// empty-body messages are reactions / status pings / placeholders and don't
// belong in a rendered thread.

import { createAdminClient } from '@/lib/db/admin'
import { THREAD_MESSAGE_LIMIT, type ThreadMessage } from '@/lib/schemas'

export interface LoadGuestThreadInput {
  messageId: string
  allowedVenueIds: string[]
}

export type LoadGuestThreadErrorCode =
  | 'message_not_found'
  | 'out_of_allowlist'
  | 'db_error'

export interface LoadGuestThreadSuccess {
  ok: true
  messages: ThreadMessage[]
}

export interface LoadGuestThreadFailure {
  ok: false
  errorCode: LoadGuestThreadErrorCode
  error?: string
}

export type LoadGuestThreadResult = LoadGuestThreadSuccess | LoadGuestThreadFailure

export async function loadGuestThread(
  input: LoadGuestThreadInput,
): Promise<LoadGuestThreadResult> {
  // Empty allowlist → any messageId is out-of-reach. Short-circuit before
  // hitting the DB. Mirrors `listPendingQueue`'s empty-allowlist
  // short-circuit, but maps to a failure (the route will flatten to 404),
  // not a success-with-empty-array — there's no neutral "no thread" answer.
  if (input.allowedVenueIds.length === 0) {
    return { ok: false, errorCode: 'out_of_allowlist' }
  }

  const supabase = createAdminClient()

  // ---- 1. resolve (venue_id, guest_id) for the supplied messageId ----
  const { data: row, error: lookupErr } = await supabase
    .from('messages')
    .select('venue_id, guest_id')
    .eq('id', input.messageId)
    .maybeSingle()

  if (lookupErr) {
    return { ok: false, errorCode: 'db_error', error: lookupErr.message }
  }
  if (!row) {
    return { ok: false, errorCode: 'message_not_found' }
  }
  if (!input.allowedVenueIds.includes(row.venue_id)) {
    return { ok: false, errorCode: 'out_of_allowlist' }
  }

  // ---- 2. fetch the most-recent N non-empty-body messages, then reverse ----
  // DESC + LIMIT picks the right slice; the reverse makes the wire
  // ordering oldest→newest per the Contract.
  const { data: rows, error: threadErr } = await supabase
    .from('messages')
    .select('id, body, direction, created_at')
    .eq('venue_id', row.venue_id)
    .eq('guest_id', row.guest_id)
    .neq('body', '')
    .order('created_at', { ascending: false })
    .limit(THREAD_MESSAGE_LIMIT)

  if (threadErr) {
    return { ok: false, errorCode: 'db_error', error: threadErr.message }
  }

  const recentDesc = rows ?? []
  const messages: ThreadMessage[] = []
  // Reverse-iterate (DESC slice → ASC output) without an extra .reverse()
  // allocation. Drop any row whose direction isn't one of the two enum
  // values — the messages.direction CHECK constraint makes this defensive
  // rather than likely, but mirrors normalizeRecentContext's posture.
  for (let i = recentDesc.length - 1; i >= 0; i--) {
    const r = recentDesc[i]!
    if (r.direction !== 'inbound' && r.direction !== 'outbound') continue
    messages.push({
      id: r.id,
      direction: r.direction,
      body: r.body,
      createdAt: r.created_at,
    })
  }

  return { ok: true, messages }
}
