// TAC-479: keep an Instagram guest's handle and display name current.
//
// Runs AFTER the webhook has answered: the route hands it to waitUntil beside
// the agent hand-off, once per guest with a saved message or icebreaker tap in
// the delivery. Nothing here is on Meta's delivery deadline, and nothing here
// can affect the guest row or the message, which were saved before the 200.
//
// When a refresh is due (isProfileRefreshDue):
//   - never fetched, or the last SUCCESSFUL fetch is over 24 hours old, and
//   - no attempt in the last hour, so a profile fetch that keeps failing is
//     retried at most hourly while the guest is active. That throttle starts at
//     the claim (step 4): a failure before it, in the token or account check,
//     is tried again on the guest's next message.
// Only the guest's own action triggers one. There is no sweep of quiet guests:
// Meta grants profile access when the guest acts and doesn't say for how long,
// and nobody reads a quiet guest's handle until they come back, which
// refreshes it.
//
// The steps, each of which can stop the refresh:
//   1. Read the guest's profile times. Not due: stop, quietly.
//   2. Token. INSTAGRAM_ACCESS_TOKEN is the one theanalog.company token until
//      per-venue tokens exist (Phase 3, TAC-460); this module is its only
//      reader, so that change lands here. Unset: stop, loudly, before claiming,
//      so the first message after it is set still fetches.
//   3. Check the token belongs to this venue's account. A scoped ID only
//      resolves for the account it was issued to, so a token for another
//      account would fail every fetch for this venue's guests, and Meta's error
//      for that is not documented well enough to tell apart from a guest's
//      privacy refusal. So it is compared directly: the token's own account
//      (GET /me) against venues.instagram_account_id. A mismatch stops with its
//      own error-level event and no claim, so it is logged on every message
//      from that venue's guests until it is fixed. This is how the single token
//      breaks when a second venue connects: loudly, never silently.
//   4. Claim: set instagram_profile_attempted_at, only if it still holds the
//      value read in step 1. Two deliveries for one guest arriving together
//      both decide the refresh is due; only one wins the claim, and the other
//      stops. The same claim-before-side-effect shape as the knowledge-gap
//      timer.
//   5. Fetch the profile.
//   6. Write the handle, the display name and instagram_profile_fetched_at.
//
// A failure after the claim writes nothing else and KEEPS whatever handle was
// stored. Clearing a good handle on a transient error is worse than keeping an
// old one whose fetched_at shows its age.
//
// The Instagram display name is stored in instagram_name and NEVER copied into
// first_name or last_name (ruled 2026-09-18). It is free text the guest never
// gave the venue: in first_name the agent would greet them by it, and the
// learn_name intention closes on any string there.
//
// Never throws. Every outcome is logged here, since nothing awaits it. The log
// lines carry our row IDs, flags and Meta's error codes, and never the scoped
// ID, the handle, the name, the token or an account ID (TAC-458).

import type { SupabaseClient } from '@supabase/supabase-js'

import type { Database } from '@/db/types'

import {
  fetchInstagramProfile,
  fetchTokenAccountId,
  isTokenRejected,
  type FetchLike,
  type GraphFailure,
} from './fetch-profile'
import type { InstagramEventOutcome } from './handle-events'

type AdminSupabaseClient = SupabaseClient<Database>

const HOUR_MS = 60 * 60 * 1000

/**
 * A stored profile older than this is refreshed on the guest's next message.
 * A placeholder, not a measurement: handles rarely change, and a day keeps
 * one no older than the guest's most recent active day for one Graph call per
 * guest per active day.
 */
export const INSTAGRAM_PROFILE_STALE_AFTER_MS = 24 * HOUR_MS

/**
 * After any attempt, the next one waits at least this long. A placeholder:
 * it bounds retries of a fetch that keeps failing, while a transient failure
 * on a new guest's first message still recovers within the hour.
 */
export const INSTAGRAM_PROFILE_RETRY_AFTER_MS = HOUR_MS

export type RefreshTarget = { guestId: string; venueId: string }

export type RefreshDeps = {
  fetch: FetchLike
  now: () => Date
  /** Read at call time, never at module load (CLAUDE.md, "Environment variables"). */
  readToken: () => string | undefined
}

const DEFAULT_DEPS: RefreshDeps = {
  fetch: (input, init) => fetch(input, init),
  now: () => new Date(),
  readToken: () => process.env.INSTAGRAM_ACCESS_TOKEN,
}

export type ProfileRefreshStoreStage = 'guest_lookup' | 'venue_lookup' | 'claim' | 'write'

export type ProfileRefreshOutcome =
  | { status: 'refreshed'; hadProfile: boolean; usernameChanged: boolean; hasName: boolean }
  | { status: 'not_due' }
  /** Another delivery's refresh claimed this guest between our read and our claim. */
  | { status: 'claimed_elsewhere' }
  /** The guest has no scoped ID. Unreachable from the Instagram route. */
  | { status: 'not_instagram' }
  | { status: 'token_missing' }
  | { status: 'token_rejected'; step: 'token_account' | 'profile'; failure: GraphFailure }
  /** The token belongs to a different Instagram account than this venue's. */
  | { status: 'wrong_account'; venueAccountMissing: boolean }
  /** Graph failed or refused for this guest: privacy, a block, a timeout, a bad response. */
  | { status: 'fetch_failed'; step: 'token_account' | 'profile'; failure: GraphFailure }
  | { status: 'store_failed'; stage: ProfileRefreshStoreStage; error: string; code: string | null }
  | { status: 'unexpected'; error: string }

type ProfileTimes = { fetchedAt: string | null; attemptedAt: string | null }

function timeOf(value: string | null): number | null {
  if (value === null) return null
  const ms = Date.parse(value)
  return Number.isNaN(ms) ? null : ms
}

/**
 * Whether a refresh is due at `now`. Pure. An unparseable stored time reads as
 * absent, which makes the refresh due rather than blocking it forever.
 */
export function isProfileRefreshDue(times: ProfileTimes, now: Date): boolean {
  const at = now.getTime()
  const attempted = timeOf(times.attemptedAt)
  if (attempted !== null && at - attempted < INSTAGRAM_PROFILE_RETRY_AFTER_MS) return false
  const fetched = timeOf(times.fetchedAt)
  return fetched === null || at - fetched >= INSTAGRAM_PROFILE_STALE_AFTER_MS
}

/**
 * The guest to refresh for one webhook outcome, or null. Only a SAVED guest
 * message or icebreaker tap: the guest's own action is what grants Meta's
 * profile access, a duplicate was handled the first time, an echo is the
 * venue's, and a read receipt saves nothing.
 */
export function profileRefreshTargetFor(outcome: InstagramEventOutcome): RefreshTarget | null {
  if (outcome.status !== 'persisted') return null
  if (outcome.kind !== 'message' && outcome.kind !== 'postback') return null
  return { guestId: outcome.guestId, venueId: outcome.venueId }
}

// Only the message and code of a PostgREST error. Never `details`, which holds
// the failing row's values: here, the handle and name.
function storeFailed(
  stage: ProfileRefreshStoreStage,
  error: { message: string; code?: string } | null,
): ProfileRefreshOutcome {
  return { status: 'store_failed', stage, error: error?.message ?? 'no row returned', code: error?.code ?? null }
}

function graphFailed(step: 'token_account' | 'profile', failure: GraphFailure): ProfileRefreshOutcome {
  return isTokenRejected(failure)
    ? { status: 'token_rejected', step, failure }
    : { status: 'fetch_failed', step, failure }
}

async function refresh(
  supabase: AdminSupabaseClient,
  target: RefreshTarget,
  deps: RefreshDeps,
): Promise<ProfileRefreshOutcome> {
  const { guestId, venueId } = target

  // 1
  const guest = await supabase
    .from('guests')
    .select('instagram_scoped_id, instagram_username, instagram_profile_fetched_at, instagram_profile_attempted_at')
    .eq('id', guestId)
    .eq('venue_id', venueId)
    .maybeSingle()
  if (guest.error || !guest.data) return storeFailed('guest_lookup', guest.error)
  const igsid = guest.data.instagram_scoped_id
  if (igsid === null) return { status: 'not_instagram' }
  const attemptedAt = guest.data.instagram_profile_attempted_at
  const times = { fetchedAt: guest.data.instagram_profile_fetched_at, attemptedAt }
  if (!isProfileRefreshDue(times, deps.now())) return { status: 'not_due' }

  // 2
  const token = deps.readToken()
  if (!token) return { status: 'token_missing' }

  // 3
  const venue = await supabase.from('venues').select('instagram_account_id').eq('id', venueId).maybeSingle()
  if (venue.error || !venue.data) return storeFailed('venue_lookup', venue.error)
  const venueAccountId = venue.data.instagram_account_id
  const tokenAccount = await fetchTokenAccountId(token, deps.fetch)
  if (!tokenAccount.ok) return graphFailed('token_account', tokenAccount.failure)
  if (venueAccountId === null || tokenAccount.value !== venueAccountId) {
    return { status: 'wrong_account', venueAccountMissing: venueAccountId === null }
  }

  // 4
  const claim = supabase
    .from('guests')
    .update({ instagram_profile_attempted_at: deps.now().toISOString() })
    .eq('id', guestId)
    .eq('venue_id', venueId)
  const claimed = await (attemptedAt === null
    ? claim.is('instagram_profile_attempted_at', null)
    : claim.eq('instagram_profile_attempted_at', attemptedAt)
  ).select('id')
  if (claimed.error) return storeFailed('claim', claimed.error)
  if (!claimed.data || claimed.data.length === 0) return { status: 'claimed_elsewhere' }

  // 5
  const profile = await fetchInstagramProfile(igsid, token, deps.fetch)
  if (!profile.ok) return graphFailed('profile', profile.failure)

  // 6. Only the instagram_* columns: never first_name or last_name.
  const written = await supabase
    .from('guests')
    .update({
      instagram_username: profile.value.username,
      instagram_name: profile.value.name,
      instagram_profile_fetched_at: deps.now().toISOString(),
    })
    .eq('id', guestId)
    .eq('venue_id', venueId)
  if (written.error) return storeFailed('write', written.error)

  const previous = guest.data.instagram_username
  return {
    status: 'refreshed',
    hadProfile: previous !== null,
    usernameChanged: previous !== null && previous !== profile.value.username,
    hasName: profile.value.name !== null,
  }
}

function graphFields(failure: GraphFailure): Record<string, unknown> {
  switch (failure.reason) {
    case 'timeout':
      return { reason: 'timeout' }
    case 'network':
      return { reason: 'network', errorName: failure.errorName, causeCode: failure.causeCode }
    case 'malformed_response':
      return { reason: 'malformed_response', httpStatus: failure.httpStatus }
    case 'graph_error':
      return {
        reason: 'graph_error',
        httpStatus: failure.httpStatus,
        graphCode: failure.code,
        graphSubcode: failure.subcode,
        graphType: failure.type,
        fbtraceId: failure.fbtraceId,
      }
  }
}

/**
 * One log line per outcome that says something. `not_due` and
 * `claimed_elsewhere` are the normal case for an active guest and log nothing.
 * The three configuration failures each have their own event, at error level,
 * so a missing token, an expired one and a token for the wrong account are
 * never mistaken for one another or for a guest's privacy settings.
 */
export function logProfileRefresh(target: RefreshTarget, outcome: ProfileRefreshOutcome): void {
  const ids = { venueId: target.venueId, guestId: target.guestId }
  switch (outcome.status) {
    case 'not_due':
    case 'claimed_elsewhere':
      return
    case 'refreshed':
      console.log('instagram profile: refreshed', {
        event: 'instagram_profile_refreshed',
        ...ids,
        hadProfile: outcome.hadProfile,
        usernameChanged: outcome.usernameChanged,
        hasName: outcome.hasName,
      })
      return
    case 'not_instagram':
      console.warn('instagram profile: guest has no scoped ID; nothing to fetch', {
        event: 'instagram_profile_not_instagram',
        ...ids,
      })
      return
    case 'token_missing':
      console.error('instagram profile: INSTAGRAM_ACCESS_TOKEN not set; no profile fetched', {
        event: 'instagram_profile_token_missing',
        ...ids,
      })
      return
    case 'token_rejected':
      // Meta's code 190: the token is expired, revoked or invalid. It expires
      // every 60 days (TAC-460); this is the first place that shows it lapsed.
      console.error('instagram profile: access token rejected by Meta', {
        event: 'instagram_profile_token_rejected',
        ...ids,
        step: outcome.step,
        ...graphFields(outcome.failure),
      })
      return
    case 'wrong_account':
      // The token is for another Instagram account than this venue's, so no
      // guest of this venue can be looked up with it. With one token for the
      // whole app, this is what the second venue to connect will log.
      console.error("instagram profile: access token is not this venue's account; no profile fetched", {
        event: 'instagram_profile_wrong_account',
        ...ids,
        venueAccountMissing: outcome.venueAccountMissing,
      })
      return
    case 'fetch_failed':
      console.warn('instagram profile: fetch failed; guest kept as is', {
        event: 'instagram_profile_fetch_failed',
        ...ids,
        step: outcome.step,
        ...graphFields(outcome.failure),
      })
      return
    case 'store_failed':
      console.warn('instagram profile: database step failed; guest kept as is', {
        event: 'instagram_profile_store_failed',
        ...ids,
        stage: outcome.stage,
        error: outcome.error,
        code: outcome.code,
      })
      return
    case 'unexpected':
      console.error('instagram profile: unexpected error; guest kept as is', {
        event: 'instagram_profile_unexpected_error',
        ...ids,
        error: outcome.error,
      })
      return
    default: {
      // A new outcome must decide how it is logged; this fails tsc until it does.
      const unhandled: never = outcome
      return unhandled
    }
  }
}

/**
 * Refresh one guest's Instagram profile if it is due, and log what happened.
 * Never throws or rejects: it runs under waitUntil, where a rejection would
 * surface only as an unhandled-rejection line.
 */
export async function refreshInstagramProfile(
  supabase: AdminSupabaseClient,
  target: RefreshTarget,
  deps: RefreshDeps = DEFAULT_DEPS,
): Promise<ProfileRefreshOutcome> {
  let outcome: ProfileRefreshOutcome
  try {
    outcome = await refresh(supabase, target, deps)
  } catch (e) {
    // A throw here is a code bug: Graph failures and database errors come back
    // as values and never reach this catch. Same treatment as the handler's.
    outcome = { status: 'unexpected', error: e instanceof Error ? e.message : String(e) }
  }
  logProfileRefresh(target, outcome)
  return outcome
}
