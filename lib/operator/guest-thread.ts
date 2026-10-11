// Powers GET /api/operator/guests/:guestId/thread. Same windowing/filtering
// as loadGuestThread (lib/operator/thread.ts) via the shared
// fetchThreadMessagesForGuest helper — the only difference is the lookup
// key: guestId directly, instead of resolving (venue_id, guest_id) from a
// messageId first.

import { createAdminClient } from '@/lib/db/admin'
import type { OperatorThreadMessage } from '@/lib/schemas'

import { fetchThreadMessagesForGuest, type ThreadOptions } from './thread'
import {
  bearerAllowsVenue,
  venueScopeDeniesAll,
  type VenueScope,
} from '@/lib/auth/venue-scope'

export interface LoadGuestThreadByGuestIdInput {
  guestId: string
  venueScope: VenueScope
  options: ThreadOptions
}

export type LoadGuestThreadByGuestIdErrorCode =
  'guest_not_found' | 'out_of_allowlist' | 'db_error'

export type LoadGuestThreadByGuestIdResult =
  | { ok: true; messages: OperatorThreadMessage[] }
  | { ok: false; errorCode: LoadGuestThreadByGuestIdErrorCode; error?: string }

export async function loadGuestThreadByGuestId(
  input: LoadGuestThreadByGuestIdInput,
): Promise<LoadGuestThreadByGuestIdResult> {
  if (venueScopeDeniesAll(input.venueScope)) {
    return { ok: false, errorCode: 'out_of_allowlist' }
  }

  const supabase = createAdminClient()

  const { data: row, error: lookupErr } = await supabase
    .from('guests')
    .select('venue_id')
    .eq('id', input.guestId)
    .maybeSingle()

  if (lookupErr) {
    return { ok: false, errorCode: 'db_error', error: lookupErr.message }
  }
  if (!row) {
    return { ok: false, errorCode: 'guest_not_found' }
  }
  if (!bearerAllowsVenue(input.venueScope, row.venue_id)) {
    return { ok: false, errorCode: 'out_of_allowlist' }
  }

  const result = await fetchThreadMessagesForGuest(
    supabase,
    row.venue_id,
    input.guestId,
    input.options,
  )
  if (!result.ok) {
    return { ok: false, errorCode: 'db_error', error: result.error }
  }
  return { ok: true, messages: result.messages }
}
