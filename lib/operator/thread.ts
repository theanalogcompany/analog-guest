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

/**
 * Fetches up to THREAD_MESSAGE_LIMIT non-empty-body messages for a resolved
 * (venueId, guestId) pair, oldest→newest. Shared by loadGuestThread (keyed
 * off a messageId, resolves venue/guest first) and loadGuestThreadByGuestId
 * (lib/operator/guest-thread.ts, keyed directly off guestId) so both thread
 * endpoints run the identical query instead of drifting independently.
 */
export async function fetchThreadMessagesForGuest(
  supabase: ReturnType<typeof createAdminClient>,
  venueId: string,
  guestId: string,
): Promise<{ ok: true; messages: ThreadMessage[] } | { ok: false; error: string }> {
  const { data: rows, error: threadErr } = await supabase
    .from('messages')
    .select('id, body, direction, created_at')
    .eq('venue_id', venueId)
    .eq('guest_id', guestId)
    .neq('body', '')
    .order('created_at', { ascending: false })
    .limit(THREAD_MESSAGE_LIMIT)

  if (threadErr) {
    return { ok: false, error: threadErr.message }
  }

  const recentDesc = rows ?? []
  const messages: ThreadMessage[] = []
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

  const result = await fetchThreadMessagesForGuest(supabase, row.venue_id, row.guest_id)
  if (!result.ok) {
    return { ok: false, errorCode: 'db_error', error: result.error }
  }
  return { ok: true, messages: result.messages }
}
