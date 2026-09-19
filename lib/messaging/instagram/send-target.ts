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
// INSTAGRAM_ACCESS_TOKEN is read at call time, never at module load (CI defines
// none of the Meta vars). It is the one theanalog.company token until per-venue
// tokens exist (TAC-460), shared with the profile refresh.

import type { SupabaseClient } from '@supabase/supabase-js'

import type { Database } from '@/db/types'

type AdminSupabaseClient = SupabaseClient<Database>

export type InstagramSendTarget = {
  accountId: string
  recipientId: string
  token: string
}

/** Why a send can't be attempted. None of these is the guest's doing. */
export type InstagramSendTargetProblem =
  | 'guest_has_no_instagram_id'
  | 'venue_has_no_instagram_account'
  | 'token_missing'
  | 'lookup_failed'

export type InstagramSendTargetResult =
  | { ok: true; target: InstagramSendTarget }
  | { ok: false; problem: InstagramSendTargetProblem; error?: string }

export function readInstagramAccessToken(env: NodeJS.ProcessEnv = process.env): string | null {
  const token = env.INSTAGRAM_ACCESS_TOKEN
  return typeof token === 'string' && token.trim() !== '' ? token.trim() : null
}

export async function loadInstagramSendTarget(
  supabase: AdminSupabaseClient,
  input: { venueId: string; guestId: string },
  readToken: () => string | null = readInstagramAccessToken,
): Promise<InstagramSendTargetResult> {
  const [venueResult, guestResult] = await Promise.all([
    supabase.from('venues').select('instagram_account_id').eq('id', input.venueId).maybeSingle(),
    supabase
      .from('guests')
      .select('instagram_scoped_id')
      .eq('id', input.guestId)
      .eq('venue_id', input.venueId)
      .maybeSingle(),
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
  const token = readToken()
  if (token === null) return { ok: false, problem: 'token_missing' }
  return { ok: true, target: { accountId, recipientId, token } }
}
