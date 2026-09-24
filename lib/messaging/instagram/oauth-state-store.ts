// TAC-516: the server-side half of the connect state — single use.
//
// The signature (oauth-state.ts) proves a state value is ours, unaltered and
// unexpired. It cannot prove the value has not been used BEFORE, because
// nothing about a correctly-signed value changes between presentations. This
// module is what refuses a replay.
//
// THE CLAIM IS THE GUARANTEE, not a check followed by a write. A conditional
// UPDATE gated on `consumed_at IS NULL AND expires_at > now()` returns one row
// to exactly one caller, so two callbacks racing the same state value resolve
// with one winner and no lock. Same shape as transitionToPendingAck, and the
// same reason: a read-then-write would leave a window where both see it free.
//
// The database ALSO checks expiry, which the signature already covers. That is
// deliberate belt and braces: the signature proves the deadline was not
// altered, the row proves it was not issued longer ago than we think. They
// cannot disagree unless something is wrong, and if they do, the stricter one
// wins by construction.

import type { SupabaseClient } from '@supabase/supabase-js'

import type { Database } from '@/db/types'

type AdminSupabaseClient = SupabaseClient<Database>

/**
 * How long an operator has to get through Meta's approval screen.
 *
 * A PLACEHOLDER, not a measurement: there is no data yet on how long this
 * takes in practice. If UAT shows operators hitting expired states, raise it.
 * Ten minutes is long enough to log in and approve, short enough that a state
 * captured from a browser history is useless by the time anyone finds it.
 */
export const INSTAGRAM_OAUTH_STATE_TTL_MS = 10 * 60 * 1000

export type IssueOAuthStateResult = { ok: true } | { ok: false; error: string }

export async function issueInstagramOAuthState(
  supabase: AdminSupabaseClient,
  input: { nonce: string; venueId: string; operatorId: string; expiresAt: Date },
): Promise<IssueOAuthStateResult> {
  const { error } = await supabase.from('instagram_oauth_states').insert({
    state_nonce: input.nonce,
    venue_id: input.venueId,
    operator_id: input.operatorId,
    expires_at: input.expiresAt.toISOString(),
  })
  if (error) return { ok: false, error: error.message }
  return { ok: true }
}

export type ClaimOAuthStateResult =
  | { ok: true; venueId: string; operatorId: string }
  /**
   * Not found, already consumed, or past its expiry in the database. All
   * three are ONE outcome on purpose: the callback's page must not tell an
   * unauthenticated caller which of them it was, and there is no branch that
   * would behave differently.
   */
  | { ok: false; reason: 'unclaimable' }
  | { ok: false; reason: 'error'; error: string }

/**
 * Consume a state nonce, exactly once.
 *
 * Returns the venue and operator the state was ISSUED for. The caller
 * cross-checks those against the signed payload: the two are written at the
 * same moment from the same values, so a disagreement means something is
 * wrong in a way worth refusing over.
 */
export async function claimInstagramOAuthState(
  supabase: AdminSupabaseClient,
  nonce: string,
  now: Date,
): Promise<ClaimOAuthStateResult> {
  const { data, error } = await supabase
    .from('instagram_oauth_states')
    .update({ consumed_at: now.toISOString() })
    .eq('state_nonce', nonce)
    .is('consumed_at', null)
    .gt('expires_at', now.toISOString())
    .select('venue_id, operator_id')

  if (error) return { ok: false, reason: 'error', error: error.message }
  const rows = (data ?? []) as unknown as Array<{ venue_id: string; operator_id: string }>
  // Zero rows is the replay, the expiry and the unknown nonce all at once.
  if (rows.length !== 1) return { ok: false, reason: 'unclaimable' }
  return { ok: true, venueId: rows[0].venue_id, operatorId: rows[0].operator_id }
}
