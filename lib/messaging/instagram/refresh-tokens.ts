// TAC-516 / TAC-460: keep every venue's Instagram token alive.
//
// A long-lived Instagram token lasts ~60 days and refreshes ITSELF: there is
// no refresh token. `grant_type=ig_refresh_token` returns a NEW token with a
// fresh 60 days. Two constraints make the timing matter, and both come from
// Meta:
//
//   1. A token must be at least 24 HOURS OLD to be refreshed. A freshly
//      connected venue is refused, which is why this scans on age as well as
//      expiry (`connected_at` / `last_refreshed_at` exist for exactly this).
//   2. AN EXPIRED TOKEN CANNOT BE REFRESHED, AT ALL. Miss the window and
//      there is no programmatic recovery: that venue must re-authorize by
//      hand. It is the one failure here that is permanent, so it alerts under
//      its own event rather than as one more refresh failure.
//
// TWO THRESHOLDS THAT DELIBERATELY DIFFER. This job starts trying at 10 days
// out; the operator app only says "expiring" at 7 (the Contract's own
// threshold). The three-day gap is the point: by the time a human is told,
// automated refresh has already been failing for three days, so "expiring"
// means "something is wrong" rather than "this is routine". Neither number is
// measured — there is no refresh history yet — but the ORDER between them is
// the designed part and must survive any retuning.
//
// A FAILED REFRESH LEAVES THE OLD TOKEN IN PLACE. It is still valid until it
// actually expires, and this job runs daily, so there are many more attempts
// before the window closes. Replacing a working token with nothing, or
// deactivating the credential, would turn a recoverable failure into the
// outage this job exists to prevent.
//
// TRIGGERED BY cron-job.org, not GitHub Actions (TAC-428: GH runs scheduled
// workflows hours late, and on most days not at all). A daily cadence against
// a ten-day margin tolerates that drift easily, which is why the GH workflow
// stays as a redundant net rather than the primary.
//
// THE GRAPH CALL ITSELF lives in oauth-exchange.ts beside the long-lived
// exchange: same host, same shape, and the same documented deviation about
// header auth. It uses the Graph ROOT, not the versioned base, because that
// is where Meta documents `refresh_access_token` — going through graphRequest
// prefixed /v25.0 and contradicted the comment stating the fact, on the one
// call that runs unattended for sixty days (found in code review).
//
// Nothing here logs a token, a ciphertext or Meta's error message.

import type { SupabaseClient } from '@supabase/supabase-js'

import type { Database } from '@/db/types'
import {
  captureInstagramTokenExpiredUnrecoverable,
  captureInstagramTokenRefreshFailed,
} from '@/lib/analytics/posthog'
import { createAdminClient } from '@/lib/db/admin'

import type { FetchLike } from './graph'
import { refreshInstagramLongLivedToken } from './oauth-exchange'
import { encryptInstagramToken, decryptInstagramToken } from './token-crypto'

type AdminSupabaseClient = SupabaseClient<Database>

const DAY_MS = 24 * 60 * 60 * 1000

/** Start trying this far before expiry. See the two-thresholds note above. */
export const INSTAGRAM_TOKEN_REFRESH_WINDOW_MS = 10 * DAY_MS

/** Meta refuses to refresh a token younger than this. Its rule, not ours. */
export const INSTAGRAM_TOKEN_MIN_AGE_MS = DAY_MS

/** What Meta grants when it does not say. Long-lived tokens are ~60 days. */
export const INSTAGRAM_LONG_LIVED_TOKEN_MS = 60 * DAY_MS

export type InstagramTokenRefreshSummary = {
  scanned: number
  refreshed: number
  /** Younger than 24 hours: Meta would refuse. Left for a later tick. */
  skippedTooYoung: number
  /** Past expiry. Unrecoverable without a re-authorization; alerts distinctly. */
  expiredUnrecoverable: number
  /** Meta refused or the call failed. The old token is left in place. */
  failed: number
  /** Could not decrypt, or could not write. Counted apart from a Meta refusal. */
  errored: number
}

export type RefreshTokensDeps = {
  fetch: FetchLike
  now: () => Date
}

const DEFAULT_DEPS: RefreshTokensDeps = {
  fetch: (input, init) => fetch(input, init),
  now: () => new Date(),
}

type CredentialRow = {
  venue_id: string
  access_token_enc: string
  token_expires_at: string
  connected_at: string
  last_refreshed_at: string | null
}

/** The token's age anchor: when we last acquired the value we hold now. */
export function tokenAcquiredAt(row: {
  connected_at: string
  last_refreshed_at: string | null
}): Date {
  const connected = new Date(row.connected_at)
  const refreshed = row.last_refreshed_at === null ? null : new Date(row.last_refreshed_at)
  if (refreshed === null || Number.isNaN(refreshed.getTime())) return connected
  return refreshed.getTime() > connected.getTime() ? refreshed : connected
}

async function recordFailure(
  supabase: AdminSupabaseClient,
  venueId: string,
  message: string,
  now: Date,
): Promise<void> {
  const { error } = await supabase
    .from('instagram_credentials')
    .update({ last_refresh_error: message, last_refresh_error_at: now.toISOString() })
    .eq('venue_id', venueId)
  if (error) {
    console.error('[cron instagram-token-refresh] could not record the refresh failure', {
      event: 'instagram_token_refresh_error_unrecorded',
      venueId,
      error: error.message,
    })
  }
}

/**
 * One tick. Never throws: every per-venue outcome is caught so one bad
 * credential cannot cost the rest of the fleet its refresh.
 */
export async function processInstagramTokenRefresh(
  now: Date = new Date(),
  deps: RefreshTokensDeps = DEFAULT_DEPS,
  client?: AdminSupabaseClient,
): Promise<InstagramTokenRefreshSummary> {
  const supabase = client ?? createAdminClient()
  const summary: InstagramTokenRefreshSummary = {
    scanned: 0,
    refreshed: 0,
    skippedTooYoung: 0,
    expiredUnrecoverable: 0,
    failed: 0,
    errored: 0,
  }

  const horizon = new Date(now.getTime() + INSTAGRAM_TOKEN_REFRESH_WINDOW_MS).toISOString()
  const { data, error } = await supabase
    .from('instagram_credentials')
    .select('venue_id, access_token_enc, token_expires_at, connected_at, last_refreshed_at')
    .eq('is_active', true)
    .lte('token_expires_at', horizon)
  if (error) {
    console.error('[cron instagram-token-refresh] scan failed', { error: error.message })
    return summary
  }

  const rows = (data ?? []) as unknown as CredentialRow[]
  summary.scanned = rows.length

  for (const row of rows) {
    try {
      const expiresAt = new Date(row.token_expires_at)

      // Past expiry. Meta will not refresh this at any price; only a human
      // re-authorizing recovers it. Its own alert, because the action it
      // needs is different from every other failure here.
      if (expiresAt.getTime() <= now.getTime()) {
        summary.expiredUnrecoverable += 1
        await recordFailure(supabase, row.venue_id, 'token expired before it could be refreshed', now)
        await captureInstagramTokenExpiredUnrecoverable({
          venueId: row.venue_id,
          expiredAt: row.token_expires_at,
        })
        continue
      }

      // Meta's 24-hour floor. Nearly unreachable behind a ten-day margin, but
      // a hand-inserted row can carry any expiry at all, and this is the one
      // case where trying would waste the attempt AND log a confusing refusal.
      if (now.getTime() - tokenAcquiredAt(row).getTime() < INSTAGRAM_TOKEN_MIN_AGE_MS) {
        summary.skippedTooYoung += 1
        continue
      }

      let token: string
      try {
        token = decryptInstagramToken(row.access_token_enc)
      } catch (err) {
        summary.errored += 1
        const message = `stored token could not be decrypted: ${err instanceof Error ? err.name : 'unknown'}`
        await recordFailure(supabase, row.venue_id, message, now)
        await captureInstagramTokenRefreshFailed({ venueId: row.venue_id, reason: message })
        continue
      }

      const refreshed = await refreshInstagramLongLivedToken(token, deps.fetch, now)
      if (!refreshed.ok) {
        summary.failed += 1
        // Meta's code and reason, never its message (graph.ts's rule).
        const reason =
          refreshed.failure.reason === 'graph_error'
            ? `meta refused: code ${refreshed.failure.code ?? 'none'} subcode ${refreshed.failure.subcode ?? 'none'}`
            : refreshed.failure.reason
        await recordFailure(supabase, row.venue_id, reason, now)
        await captureInstagramTokenRefreshFailed({
          venueId: row.venue_id,
          reason,
          expiresAt: row.token_expires_at,
        })
        continue
      }

      const { error: writeError } = await supabase
        .from('instagram_credentials')
        .update({
          access_token_enc: encryptInstagramToken(refreshed.value.token),
          token_expires_at: refreshed.value.expiresAt.toISOString(),
          last_refreshed_at: now.toISOString(),
          last_refresh_error: null,
          last_refresh_error_at: null,
        })
        .eq('venue_id', row.venue_id)
      if (writeError) {
        // The NEW token is live at Meta and we failed to store it. The stored
        // one still works until it expires, and the next tick refreshes again
        // from it, so this is recoverable — but it is an error, not a refusal.
        summary.errored += 1
        await captureInstagramTokenRefreshFailed({
          venueId: row.venue_id,
          reason: `refreshed at Meta but could not store the new token: ${writeError.message}`,
        })
        continue
      }

      summary.refreshed += 1
    } catch (err) {
      summary.errored += 1
      console.error('[cron instagram-token-refresh] unexpected error for one venue', {
        venueId: row.venue_id,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  return summary
}
