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
//
// TAC-395: the thread holds only messages that REACHED the guest. The query
// adds REACHED_GUEST_FILTER, the PostgREST form of
//
//   direction = 'inbound'
//   or (review_state is distinct from 'pending'
//       and status in (DELIVERED_OUTBOUND_STATUSES))
//
// which is the set `deriveDelivery` (lib/agent/group-responses.ts) calls
// `delivered`. Before it, a pending draft came back as an ordinary message, so
// the edit screen showed it both in the compose box and as a sent-looking
// bubble, and skipped drafts and replies that never sent read as sent too.
//
// Three things about the filter are deliberate:
//   - It lives in the query, so Postgres applies it before LIMIT 200. A JS
//     post-filter would return fewer than 200 rows when more qualify.
//   - It filters the thread rows only, never the messageId lookup: the edit
//     screen opens the thread with the pending draft's own id.
//   - `or(review_state.is.null,review_state.neq.pending)` is IS DISTINCT FROM.
//     A bare `neq` would drop outbound rows whose review_state is NULL.
//
// The same condition is written in migrations 043 and 044, so all three must
// move together. The Realtime channel
// is not filtered by any of this; the operator app applies the same rule to
// live rows (TAC-411).

import { DELIVERED_OUTBOUND_STATUSES } from '@/lib/agent/group-responses'
import { createAdminClient } from '@/lib/db/admin'
import { serveAttachments } from '@/lib/messaging/attachments/serve'
import { loadAttachmentsForMessages } from '@/lib/messaging/attachments/store'
import { THREAD_MESSAGE_LIMIT, type OperatorThreadMessage } from '@/lib/schemas'
import {
  bearerAllowsVenue,
  venueScopeDeniesAll,
  type VenueScope,
} from '@/lib/auth/venue-scope'

const REACHED_GUEST_FILTER = `direction.eq.inbound,and(status.in.(${[
  ...DELIVERED_OUTBOUND_STATUSES,
].join(',')}),or(review_state.is.null,review_state.neq.pending))`

// TAC-582: the rows `?attachments=1` adds to a thread. A message with no text
// is shown when it has media or when Meta flagged it unsupported. Everything
// else with an empty body stays out exactly as before: a reaction, a scan row
// and a blank card all have neither.
//
// It reads `messages` columns only, never a join to message_attachments, so
// the same three conditions can be applied to a live row by the operator app
// (TAC-583 counts a row with non-empty media_urls or unsupported_content).
const SHOWN_WITH_ATTACHMENTS_FILTER =
  'body.neq."",media_urls.neq.{},unsupported_content.is.true'

export interface ThreadOptions {
  /**
   * `?attachments=1`. Off, the thread is the rows it always was, each with
   * `attachments: []` and `unsupported: false`. On, media-only and unsupported
   * rows are included and every row carries its attachments. A flag, until
   * the operator app that can render them has shipped (TAC-583).
   */
  includeAttachments: boolean
}

/**
 * The thread options a request asked for. `?attachments=1` exactly; any other
 * value, and no value, is off. Shared by both thread routes and the
 * conversations list so the flag cannot mean two things.
 */
export function threadOptionsFromRequest(request: Request): ThreadOptions {
  return {
    includeAttachments:
      new URL(request.url).searchParams.get('attachments') === '1',
  }
}

export interface LoadGuestThreadInput {
  messageId: string
  venueScope: VenueScope
  options: ThreadOptions
}

export type LoadGuestThreadErrorCode =
  'message_not_found' | 'out_of_allowlist' | 'db_error'

export interface LoadGuestThreadSuccess {
  ok: true
  messages: OperatorThreadMessage[]
}

export interface LoadGuestThreadFailure {
  ok: false
  errorCode: LoadGuestThreadErrorCode
  error?: string
}

export type LoadGuestThreadResult =
  LoadGuestThreadSuccess | LoadGuestThreadFailure

/**
 * Fetches up to THREAD_MESSAGE_LIMIT messages that reached the guest, for a
 * resolved (venueId, guestId) pair, oldest→newest. Shared by loadGuestThread
 * (keyed off a messageId, resolves venue/guest first) and
 * loadGuestThreadByGuestId (lib/operator/guest-thread.ts, keyed directly off
 * guestId) so both thread endpoints run the identical query instead of
 * drifting independently.
 *
 * Without `includeAttachments` only non-empty-body rows are returned, as
 * before TAC-582.
 */
export async function fetchThreadMessagesForGuest(
  supabase: ReturnType<typeof createAdminClient>,
  venueId: string,
  guestId: string,
  options: ThreadOptions,
): Promise<
  { ok: true; messages: OperatorThreadMessage[] } | { ok: false; error: string }
> {
  const base = supabase
    .from('messages')
    .select('id, body, direction, created_at, unsupported_content')
    .eq('venue_id', venueId)
    .eq('guest_id', guestId)
  const shown = options.includeAttachments
    ? base.or(SHOWN_WITH_ATTACHMENTS_FILTER)
    : base.neq('body', '')
  const { data: rows, error: threadErr } = await shown
    .or(REACHED_GUEST_FILTER)
    .order('created_at', { ascending: false })
    .limit(THREAD_MESSAGE_LIMIT)

  if (threadErr) {
    return { ok: false, error: threadErr.message }
  }

  const recentDesc = rows ?? []

  // One query for every attachment in the window, then one signing call.
  // A failed read is a failed thread, not a thread with the media quietly
  // missing: the caller asked for attachments and would otherwise be told
  // there are none.
  let attachmentsByMessage: Awaited<ReturnType<typeof serveAttachments>> =
    new Map()
  if (options.includeAttachments) {
    const loaded = await loadAttachmentsForMessages(
      supabase,
      recentDesc.map((r) => r.id),
    )
    if (!loaded.ok) return { ok: false, error: loaded.error }
    attachmentsByMessage = await serveAttachments(supabase, loaded.data)
  }

  const messages: OperatorThreadMessage[] = []
  for (let i = recentDesc.length - 1; i >= 0; i--) {
    const r = recentDesc[i]!
    if (r.direction !== 'inbound' && r.direction !== 'outbound') continue
    messages.push({
      id: r.id,
      direction: r.direction,
      body: r.body,
      createdAt: r.created_at,
      unsupported: options.includeAttachments && r.unsupported_content === true,
      attachments: attachmentsByMessage.get(r.id) ?? [],
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
  if (venueScopeDeniesAll(input.venueScope)) {
    return { ok: false, errorCode: 'out_of_allowlist' }
  }

  const supabase = createAdminClient()

  // ---- 1. resolve (venue_id, guest_id) for the supplied messageId ----
  // Unfiltered on purpose (TAC-395): the edit screen opens the thread with a
  // pending draft's own id, which the thread query below then leaves out.
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
  if (!bearerAllowsVenue(input.venueScope, row.venue_id)) {
    return { ok: false, errorCode: 'out_of_allowlist' }
  }

  const result = await fetchThreadMessagesForGuest(
    supabase,
    row.venue_id,
    row.guest_id,
    input.options,
  )
  if (!result.ok) {
    return { ok: false, errorCode: 'db_error', error: result.error }
  }
  return { ok: true, messages: result.messages }
}
