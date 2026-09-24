// TAC-516: venue-level state for the operator app, which today is just
// whether Instagram is connected.
//
// THE CONTRACT IS THE AUTHORITY on every value here, including the 7-day
// `expiring` threshold. The sibling ticket (TAC-517) transcribes its tests
// from that Contract rather than from this file, which is what makes the two
// halves agree rather than merely look like they do.
//
// `expiring` IS NOT THE REFRESH WINDOW. The refresh job starts trying at 10
// days (refresh-tokens.ts); this tells an operator at 7. The gap is
// deliberate: by the time a human is told, automated refresh has already been
// failing for three days, so "expiring" means "something is wrong" rather
// than "this is routine". Retuning either number should preserve that order.
//
// `connected` REQUIRES THE VENUE POINTER, not just a credential. A venue can
// hold an active credential while `venues.instagram_account_id` is null — the
// callback writes the credential first, so any failure on the pointer write
// leaves exactly that. Reporting `connected` there told an operator their
// Instagram was working while every send refused with
// `venue_has_no_instagram_account` and every inbound was skipped as
// `venue_not_found` (found in code review). The callback now compensates that
// write, so this is the second of two independent guards rather than the only
// one; it also covers any other route to the same split state.
//
// DEAUTHORIZED IS `disconnected`, NOT ABSENT. A venue that was connected and
// had access revoked is a different thing from one that never connected, and
// the operator app says different things about them — but the STATUS is the
// same, because in both cases messages are not flowing and the fix is the
// same button.

import type { SupabaseClient } from '@supabase/supabase-js'

import type { Database } from '@/db/types'
import { loadInstagramCredential } from '@/lib/messaging/instagram/credentials-store'

type AdminSupabaseClient = SupabaseClient<Database>

/** The Contract's literal threshold. Not the refresh window. */
export const INSTAGRAM_EXPIRING_WINDOW_MS = 7 * 24 * 60 * 60 * 1000

export type InstagramConnectionStatus = 'connected' | 'disconnected' | 'expiring'

/**
 * Always present, never undefined, per the Contract. `username` and
 * `expiresAt` are null when not connected.
 */
export type VenueInstagramConnection = {
  status: InstagramConnectionStatus
  username: string | null
  expiresAt: string | null
}

export type VenueConnectionState = {
  instagram: VenueInstagramConnection
}

export type LoadVenueConnectionResult =
  | { ok: true; state: VenueConnectionState }
  | { ok: false; error: string }

const DISCONNECTED: VenueInstagramConnection = {
  status: 'disconnected',
  username: null,
  expiresAt: null,
}

/**
 * Venue-level state for one venue.
 *
 * The caller is responsible for the allowlist check; this takes a venue id it
 * has already been told is permitted. Keeping authorization at the route
 * rather than here means there is one place to read it, and it cannot be
 * skipped by a second caller that forgets to pass a scope.
 */
export async function loadVenueConnectionState(
  supabase: AdminSupabaseClient,
  venueId: string,
  now: Date = new Date(),
): Promise<LoadVenueConnectionResult> {
  const [loaded, venue] = await Promise.all([
    loadInstagramCredential(supabase, venueId),
    supabase.from('venues').select('instagram_account_id').eq('id', venueId).maybeSingle(),
  ])
  // A failed read is a failure, never "disconnected". Reporting a venue as
  // disconnected because a query timed out would tell an operator their
  // Instagram is down when it is working.
  if (!loaded.ok) return { ok: false, error: loaded.error }
  if (venue.error) return { ok: false, error: venue.error.message }

  const accountId = venue.data?.instagram_account_id ?? null
  const hasAccount = typeof accountId === 'string' && accountId.trim() !== ''

  const credential = loaded.credential
  if (credential === null || !credential.isActive || credential.deauthorizedAt !== null || !hasAccount) {
    return { ok: true, state: { instagram: DISCONNECTED } }
  }

  const remainingMs = credential.tokenExpiresAt.getTime() - now.getTime()
  // An already-expired token is `expiring` rather than a fourth status: the
  // Contract has three, and the operator's action is the same either way.
  const status: InstagramConnectionStatus =
    remainingMs < INSTAGRAM_EXPIRING_WINDOW_MS ? 'expiring' : 'connected'

  return {
    ok: true,
    state: {
      instagram: {
        status,
        username: credential.instagramUsername,
        expiresAt: credential.tokenExpiresAt.toISOString(),
      },
    },
  }
}
