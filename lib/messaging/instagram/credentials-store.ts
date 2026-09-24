// TAC-516: reading and writing a venue's own Instagram credential, and
// deciding which token a given venue sends with.
//
// WHY THIS IS NOT IN send-target.ts. `send-target` is one of four guarded
// INSTAGRAM_OUTBOUND_MODULES (window-import-guard.test.ts): only the two
// Instagram dispatch arms may import it from outside this folder, because
// Instagram's outbound constraints must never reach the SMS path. The connect
// route, the OAuth callback, the refresh cron and the operator venue endpoint
// all need credentials and none of them is an outbound arm, so putting the
// resolver in `send-target` would have forced four entries onto that
// allow-list and diluted what it means. A credential store is not an outbound
// constraint, so it lives here and stays unguarded.
//
// DIRECTION OF THE IMPORT. `readInstagramAccessToken` used to live in
// send-target.ts. It moved here and send-target re-exports it, so the arrow
// points one way (send-target -> credentials-store). The reverse would be a
// cycle, since send-target now needs the resolver.
//
// THE ENV FALLBACK IS THE CUTOVER MECHANISM, and it is why shipping this
// changes nothing on the day it deploys. A venue with no credential row
// resolves INSTAGRAM_ACCESS_TOKEN exactly as it did before TAC-516. A venue
// gains its own token only once a row exists for it.
//
// A CREDENTIAL THAT EXISTS BUT CANNOT BE DECRYPTED IS A HARD FAILURE, never a
// fallback to the env token. The venue is connected, and `venues
// .instagram_account_id` has been pointed at ITS account; sending with the
// shared theanalog.company token would be sending from one account with
// another account's credential, which Meta refuses and which would read as a
// mysterious token rejection rather than as the key problem it is.
//
// Nothing here logs a token, a ciphertext or the encryption key.

import type { SupabaseClient } from '@supabase/supabase-js'

import type { Database } from '@/db/types'

import { decryptInstagramToken, encryptInstagramToken } from './token-crypto'

type AdminSupabaseClient = SupabaseClient<Database>

/** Every column the credential readers need. Named once. */
const CREDENTIAL_COLUMNS =
  'venue_id, instagram_username, access_token_enc, token_expires_at, connected_at, last_refreshed_at, is_active, deauthorized_at'

export type InstagramCredential = {
  venueId: string
  instagramUsername: string | null
  accessTokenEnc: string
  tokenExpiresAt: Date
  connectedAt: Date
  lastRefreshedAt: Date | null
  isActive: boolean
  deauthorizedAt: Date | null
}

export type LoadInstagramCredentialResult =
  | { ok: true; credential: InstagramCredential | null }
  | { ok: false; error: string }

/**
 * The one token-bearing env var, read at call time and never at module load
 * (CI defines none of the Meta vars). Moved here from send-target.ts, which
 * re-exports it so its existing callers and tests are unchanged.
 */
export function readInstagramAccessToken(env: NodeJS.ProcessEnv = process.env): string | null {
  const token = env.INSTAGRAM_ACCESS_TOKEN
  return typeof token === 'string' && token.trim() !== '' ? token.trim() : null
}

function parseDate(value: unknown): Date | null {
  if (typeof value !== 'string') return null
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? null : date
}

/**
 * This venue's credential, or null when it has never connected. Does NOT
 * decrypt: callers that only need status (connected / expiring) must never
 * hold plaintext.
 *
 * A deauthorized or inactive row still comes back, so the operator endpoint
 * can tell "disconnected after being connected" from "never connected". The
 * token resolver is what treats inactive as absent.
 */
export async function loadInstagramCredential(
  supabase: AdminSupabaseClient,
  venueId: string,
): Promise<LoadInstagramCredentialResult> {
  const { data, error } = await supabase
    .from('instagram_credentials')
    .select(CREDENTIAL_COLUMNS)
    .eq('venue_id', venueId)
    .maybeSingle()
  if (error) return { ok: false, error: error.message }
  if (!data) return { ok: true, credential: null }

  const row = data as unknown as Record<string, unknown>
  const tokenExpiresAt = parseDate(row.token_expires_at)
  const connectedAt = parseDate(row.connected_at)
  // Both are NOT NULL in migration 060, so an unparseable value means the row
  // is corrupt rather than merely absent. Refusing beats guessing a date that
  // would put the credential in or out of the refresh window by accident.
  if (!tokenExpiresAt || !connectedAt) {
    return { ok: false, error: 'instagram_credentials row has an unreadable timestamp' }
  }

  return {
    ok: true,
    credential: {
      venueId: String(row.venue_id),
      instagramUsername: typeof row.instagram_username === 'string' ? row.instagram_username : null,
      accessTokenEnc: String(row.access_token_enc),
      tokenExpiresAt,
      connectedAt,
      lastRefreshedAt: parseDate(row.last_refreshed_at),
      isActive: row.is_active === true,
      deauthorizedAt: parseDate(row.deauthorized_at),
    },
  }
}

export type InstagramTokenSource = 'venue' | 'env'

export type ResolvedInstagramToken = {
  token: string
  source: InstagramTokenSource
  /** Null on the env fallback: the env var carries no expiry. */
  expiresAt: Date | null
}

export type ResolveInstagramTokenResult =
  | { ok: true; resolved: ResolvedInstagramToken | null }
  | { ok: false; error: string }

/**
 * Which token this venue sends with.
 *
 * An ACTIVE credential row wins, expired or not: an expired token surfaces as
 * Meta's own code 190 (`isTokenRejected`), which is a true and specific
 * signal, where refusing here would surface as `token_missing` and say
 * something false. Keeping a token alive is the refresh job's business, not
 * this function's.
 *
 * `null` (ok, nothing resolved) means the venue has no credential AND no env
 * var — the caller reports `token_missing`.
 */
export async function resolveInstagramAccessToken(
  supabase: AdminSupabaseClient,
  venueId: string,
  readEnvToken: () => string | null = readInstagramAccessToken,
): Promise<ResolveInstagramTokenResult> {
  const loaded = await loadInstagramCredential(supabase, venueId)
  if (!loaded.ok) return loaded

  const credential = loaded.credential
  if (credential && credential.isActive) {
    let token: string
    try {
      token = decryptInstagramToken(credential.accessTokenEnc)
    } catch (err) {
      // Never fall back to the env token here — see this file's header.
      return {
        ok: false,
        error: `could not decrypt the stored Instagram token: ${err instanceof Error ? err.name : 'unknown error'}`,
      }
    }
    return { ok: true, resolved: { token, source: 'venue', expiresAt: credential.tokenExpiresAt } }
  }

  const envToken = readEnvToken()
  if (envToken === null) return { ok: true, resolved: null }
  return { ok: true, resolved: { token: envToken, source: 'env', expiresAt: null } }
}

export type UpsertInstagramCredentialInput = {
  venueId: string
  accessToken: string
  tokenExpiresAt: Date
  instagramUsername: string | null
  connectedByOperatorId: string | null
  now: Date
}

export type UpsertInstagramCredentialResult = { ok: true } | { ok: false; error: string }

/**
 * Store (or replace) a venue's credential. One row per venue, so a reconnect
 * REPLACES rather than accumulating — there is never a question of which
 * credential is live.
 *
 * The reconnect path deliberately clears `deauthorized_at`, the refresh error
 * columns and `last_refreshed_at`: this is a brand new token, and carrying a
 * previous token's failure onto it would show an operator a stale error about
 * a credential that no longer exists.
 */
export async function upsertInstagramCredential(
  supabase: AdminSupabaseClient,
  input: UpsertInstagramCredentialInput,
): Promise<UpsertInstagramCredentialResult> {
  let accessTokenEnc: string
  try {
    accessTokenEnc = encryptInstagramToken(input.accessToken)
  } catch (err) {
    return {
      ok: false,
      error: `could not encrypt the Instagram token: ${err instanceof Error ? err.message : 'unknown error'}`,
    }
  }

  const { error } = await supabase.from('instagram_credentials').upsert(
    {
      venue_id: input.venueId,
      access_token_enc: accessTokenEnc,
      token_expires_at: input.tokenExpiresAt.toISOString(),
      instagram_username: input.instagramUsername,
      connected_by_operator_id: input.connectedByOperatorId,
      connected_at: input.now.toISOString(),
      is_active: true,
      deauthorized_at: null,
      last_refreshed_at: null,
      last_refresh_error: null,
      last_refresh_error_at: null,
    },
    { onConflict: 'venue_id' },
  )
  if (error) return { ok: false, error: error.message }
  return { ok: true }
}
