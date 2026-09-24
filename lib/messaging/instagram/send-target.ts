// TAC-469: everything a send needs besides the text: the venue's Instagram
// account, the guest's scoped ID, and the token.
//
// Reads `venues.instagram_account_id` and `guests.instagram_scoped_id` only.
// It never reads `messaging_phone_number`: an Instagram-only venue has none
// (Le Mil's becomes one when its number is deleted), and an Instagram send
// that required it would fail there for no reason. Every Sendblue send reads
// the number in lib/messaging/venue-lookup.ts; this is the Instagram
// counterpart and shares nothing with it.
//
// The IGSID is loaded here, at send time, rather than carried on the runtime
// context: TAC-495 kept it out of the context on purpose, so it never reaches a
// prompt, a trace or a log line. Nothing here logs it, the account ID or the
// token.
//
// TAC-516: THE TOKEN IS NOW PER VENUE. It used to be INSTAGRAM_ACCESS_TOKEN
// read straight from env. It now comes from resolveInstagramAccessToken, which
// prefers the venue's own stored credential and falls back to that same env
// var for a venue that has not connected — so this file behaves exactly as it
// did until a venue has a credential row. The resolution joins the existing
// Promise.all rather than running after it, so a connected venue costs no
// extra latency, only one more parallel read.
//
// `tokenSource` rides on the target so a log line can say which credential a
// send actually used, WITHOUT the token itself. That is how the Le Mil's
// cutover is verified as having happened, rather than having silently stayed
// on the shared fallback.

import type { SupabaseClient } from '@supabase/supabase-js'

import type { Database } from '@/db/types'

import {
  type InstagramTokenSource,
  type ResolveInstagramTokenResult,
  readInstagramAccessToken,
  resolveInstagramAccessToken,
} from './credentials-store'

type AdminSupabaseClient = SupabaseClient<Database>

/**
 * Re-exported from credentials-store, which owns it now. The env read moved
 * there so the import points one way: this module needs the resolver, and the
 * resolver would otherwise need this module back.
 */
export { readInstagramAccessToken }

export type InstagramSendTarget = {
  accountId: string
  recipientId: string
  token: string
  /** Which credential the token came from. Never the token itself in a log. */
  tokenSource: InstagramTokenSource
}

/** Why a send can't be attempted. None of these is the guest's doing. */
export type InstagramSendTargetProblem =
  | 'guest_has_no_instagram_id'
  | 'venue_has_no_instagram_account'
  | 'token_missing'
  /**
   * The venue HAS a stored credential and it could not be decrypted — a wrong
   * or rotated INSTAGRAM_TOKEN_ENC_KEY. Distinct from `token_missing`, which
   * means nobody has connected and there is no env var either. Different
   * causes and different fixes, so collapsing them would send whoever is on
   * call looking in the wrong place.
   */
  | 'token_unreadable'
  | 'lookup_failed'

export type InstagramSendTargetResult =
  | { ok: true; target: InstagramSendTarget }
  | { ok: false; problem: InstagramSendTargetProblem; error?: string }

export type ResolveInstagramTokenFn = (
  supabase: AdminSupabaseClient,
  venueId: string,
) => Promise<ResolveInstagramTokenResult>

export async function loadInstagramSendTarget(
  supabase: AdminSupabaseClient,
  input: { venueId: string; guestId: string },
  resolveToken: ResolveInstagramTokenFn = resolveInstagramAccessToken,
): Promise<InstagramSendTargetResult> {
  const [venueResult, guestResult, tokenResult] = await Promise.all([
    supabase.from('venues').select('instagram_account_id').eq('id', input.venueId).maybeSingle(),
    supabase
      .from('guests')
      .select('instagram_scoped_id')
      .eq('id', input.guestId)
      .eq('venue_id', input.venueId)
      .maybeSingle(),
    resolveToken(supabase, input.venueId),
  ])
  if (venueResult.error) return { ok: false, problem: 'lookup_failed', error: venueResult.error.message }
  if (guestResult.error) return { ok: false, problem: 'lookup_failed', error: guestResult.error.message }

  const recipientId = guestResult.data?.instagram_scoped_id ?? null
  if (typeof recipientId !== 'string' || recipientId.trim() === '') {
    return { ok: false, problem: 'guest_has_no_instagram_id' }
  }
  const accountId = venueResult.data?.instagram_account_id ?? null
  if (typeof accountId !== 'string' || accountId.trim() === '') {
    return { ok: false, problem: 'venue_has_no_instagram_account' }
  }
  if (!tokenResult.ok) return { ok: false, problem: 'token_unreadable', error: tokenResult.error }
  const resolved = tokenResult.resolved
  if (resolved === null) return { ok: false, problem: 'token_missing' }
  return {
    ok: true,
    target: { accountId, recipientId, token: resolved.token, tokenSource: resolved.source },
  }
}
