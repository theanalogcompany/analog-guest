// TAC-516: the three Meta calls the connect callback makes, plus the webhook
// subscription that makes a connected account actually deliver messages.
//
// WHY NOT ALL OF THIS THROUGH graph.ts. The code exchange happens against
// `api.instagram.com`, form-encoded, with the app secret in the BODY — a
// different host and a different shape from graph.ts's Bearer-header JSON
// convention. The other two are ordinary Graph calls and do go through it.
//
// A DEVIATION WORTH KNOWING, AND ITS LIMIT. Meta's own documentation shows
// `ig_exchange_token` and `refresh_access_token` with `access_token` in the
// QUERY STRING. This repo's rule (graph.ts) is that a token never goes in a
// URL, because URLs reach request logs and error messages. Both calls here
// send the token in the Authorization header instead, which graph.instagram.com
// accepts for ordinary Graph reads.
//
// That last clause is a META-SIDE FACT THIS REPO CANNOT VERIFY. If Meta
// refuses header auth on these two endpoints, the connect flow fails at the
// long-lived exchange and the refresh job fails at every attempt. Both fail
// LOUDLY rather than silently — the callback renders a failure page, and the
// refresh job alerts on every failure while leaving the old token working, so
// there is a ten-day margin to notice. It is on the ticket's UAT checklist.
// If it turns out header auth is refused, the fix is to move the token into
// the query for these two calls ONLY, and to make certain neither URL is ever
// logged. Do not "simplify" toward the query form without that second half.
//
// `client_secret` DOES ride in the query on the long-lived exchange, because
// Meta requires it there and it is not an auth token. No URL built in this
// module is ever logged, returned, or put in an error — which is what makes
// that acceptable rather than merely necessary.

import {
  INSTAGRAM_GRAPH_BASE_URL,
  INSTAGRAM_GRAPH_TIMEOUT_MS,
  graphRequest,
  isRecord,
  stringOrNull,
  type FetchLike,
  type GraphFailure,
  type GraphResult,
} from './graph'

/** Meta's OAuth host. Not graph.instagram.com, and not graph.facebook.com. */
const INSTAGRAM_OAUTH_BASE_URL = 'https://api.instagram.com'

/** The long-lived exchange and refresh live at the Graph host's root. */
const INSTAGRAM_GRAPH_ROOT_URL = 'https://graph.instagram.com'

/** What Meta grants when it does not say. Long-lived tokens are ~60 days. */
const DEFAULT_LONG_LIVED_MS = 60 * 24 * 60 * 60 * 1000

/**
 * The scopes the "Manage messaging & content on Instagram" use case needs.
 * Named once: the authorize URL and Meta's own app configuration must agree,
 * and a mismatch is refused at the approval screen rather than here.
 */
export const INSTAGRAM_OAUTH_SCOPES = [
  'instagram_business_basic',
  'instagram_business_manage_messages',
] as const

/**
 * The webhook fields a connected account is subscribed to.
 *
 * ONE constant, because this list must match what the app is already
 * subscribed to at the app level (the ticket's Background section records
 * them). Two copies would drift, and the symptom of drift is messages simply
 * not arriving for a venue that looks connected.
 */
export const INSTAGRAM_WEBHOOK_SUBSCRIBED_FIELDS = [
  'messages',
  'message_edit',
  'message_reactions',
  'messaging_handover',
  'messaging_optins',
  'messaging_postbacks',
  'comments',
  'live_comments',
] as const

export type ShortLivedToken = { token: string; userId: string }
export type LongLivedToken = { token: string; expiresAt: Date }
export type ConnectedAccount = { userId: string; username: string | null }

function malformed(httpStatus: number): { ok: false; failure: GraphFailure } {
  return { ok: false, failure: { reason: 'malformed_response', httpStatus } }
}

function networkFailure(e: unknown): GraphFailure {
  const name = e instanceof Error ? e.name : typeof e
  if (name === 'TimeoutError' || name === 'AbortError') return { reason: 'timeout' }
  const cause = e instanceof Error && isRecord(e.cause) ? e.cause : null
  return { reason: 'network', errorName: name, causeCode: cause ? stringOrNull(cause.code) : null }
}

/**
 * Step 1: the authorization code becomes a short-lived (~1 hour) token.
 *
 * POST, form-encoded, everything in the BODY — so neither the code nor the
 * app secret is ever in a URL. Meta's documented shape for this one.
 */
export async function exchangeInstagramCode(
  input: { code: string; redirectUri: string; appId: string; appSecret: string },
  fetchImpl: FetchLike,
): Promise<GraphResult<ShortLivedToken>> {
  const body = new URLSearchParams({
    client_id: input.appId,
    client_secret: input.appSecret,
    grant_type: 'authorization_code',
    redirect_uri: input.redirectUri,
    code: input.code,
  })

  let response: Response
  try {
    response = await fetchImpl(`${INSTAGRAM_OAUTH_BASE_URL}/oauth/access_token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
      signal: AbortSignal.timeout(INSTAGRAM_GRAPH_TIMEOUT_MS),
    })
  } catch (e) {
    return { ok: false, failure: networkFailure(e) }
  }

  let parsed: unknown
  try {
    parsed = await response.json()
  } catch {
    return malformed(response.status)
  }
  if (!response.ok || !isRecord(parsed)) {
    // Meta's error message is deliberately not read: on this endpoint it can
    // quote the code, and on a redirect-uri mismatch it quotes the URI.
    const error = isRecord(parsed) && isRecord(parsed.error) ? parsed.error : {}
    return {
      ok: false,
      failure: {
        reason: 'graph_error',
        httpStatus: response.status,
        code: typeof error.code === 'number' ? error.code : null,
        subcode: typeof error.error_subcode === 'number' ? error.error_subcode : null,
        type: stringOrNull(error.type),
        fbtraceId: stringOrNull(error.fbtrace_id),
      },
    }
  }

  const token = stringOrNull(parsed.access_token)
  // Meta returns this as `user_id`, a number on this endpoint. It is the
  // account id, NOT the app-scoped `id` (CLAUDE.md records that distinction).
  const rawUserId = parsed.user_id
  const userId =
    typeof rawUserId === 'number' ? String(rawUserId) : stringOrNull(rawUserId)
  if (token === null || userId === null) return malformed(response.status)
  return { ok: true, value: { token, userId } }
}

/**
 * Step 2: the short-lived token becomes a long-lived (~60 day) one.
 *
 * The token rides in the Authorization header; only `client_secret` is in the
 * query, because Meta requires it there and it is not an auth token. See the
 * deviation note in this file's header.
 */
export async function exchangeForLongLivedToken(
  input: { shortLivedToken: string; appSecret: string; now: Date },
  fetchImpl: FetchLike,
): Promise<GraphResult<LongLivedToken>> {
  const query = new URLSearchParams({
    grant_type: 'ig_exchange_token',
    client_secret: input.appSecret,
  })

  let response: Response
  try {
    response = await fetchImpl(`${INSTAGRAM_GRAPH_ROOT_URL}/access_token?${query.toString()}`, {
      method: 'GET',
      headers: { authorization: `Bearer ${input.shortLivedToken}` },
      signal: AbortSignal.timeout(INSTAGRAM_GRAPH_TIMEOUT_MS),
    })
  } catch (e) {
    return { ok: false, failure: networkFailure(e) }
  }

  let parsed: unknown
  try {
    parsed = await response.json()
  } catch {
    return malformed(response.status)
  }
  if (!response.ok || !isRecord(parsed)) {
    const error = isRecord(parsed) && isRecord(parsed.error) ? parsed.error : {}
    return {
      ok: false,
      failure: {
        reason: 'graph_error',
        httpStatus: response.status,
        code: typeof error.code === 'number' ? error.code : null,
        subcode: typeof error.error_subcode === 'number' ? error.error_subcode : null,
        type: stringOrNull(error.type),
        fbtraceId: stringOrNull(error.fbtrace_id),
      },
    }
  }

  const token = stringOrNull(parsed.access_token)
  if (token === null) return malformed(response.status)
  // A missing or nonsensical expires_in must never produce an expiry in the
  // past: that would make a brand new credential look unrecoverable on the
  // refresh job's very first pass.
  const seconds = typeof parsed.expires_in === 'number' && parsed.expires_in > 0 ? parsed.expires_in : null
  const expiresAt = new Date(
    input.now.getTime() + (seconds === null ? DEFAULT_LONG_LIVED_MS : seconds * 1000),
  )
  return { ok: true, value: { token, expiresAt } }
}

/**
 * Keeping a long-lived token alive. Same host, same shape and same deviation
 * as the exchange above, which is why it lives here rather than beside the
 * refresh job that calls it.
 *
 * IT USES THE GRAPH ROOT, NOT THE VERSIONED BASE. Meta documents
 * `refresh_access_token` at `graph.instagram.com/refresh_access_token`, and
 * this file's own constant says so. It went through `graphRequest` at first,
 * which prefixes `/v25.0`, so the code contradicted the comment stating the
 * fact — on the one call that has to run unattended for sixty days. Caught in
 * code review. Both tests now pin the full URL.
 */
export async function refreshInstagramLongLivedToken(
  token: string,
  fetchImpl: FetchLike,
  now: Date,
): Promise<GraphResult<LongLivedToken>> {
  const query = new URLSearchParams({ grant_type: 'ig_refresh_token' })

  let response: Response
  try {
    response = await fetchImpl(`${INSTAGRAM_GRAPH_ROOT_URL}/refresh_access_token?${query.toString()}`, {
      method: 'GET',
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(INSTAGRAM_GRAPH_TIMEOUT_MS),
    })
  } catch (e) {
    return { ok: false, failure: networkFailure(e) }
  }

  let parsed: unknown
  try {
    parsed = await response.json()
  } catch {
    return malformed(response.status)
  }
  if (!response.ok || !isRecord(parsed)) {
    const error = isRecord(parsed) && isRecord(parsed.error) ? parsed.error : {}
    return {
      ok: false,
      failure: {
        reason: 'graph_error',
        httpStatus: response.status,
        code: typeof error.code === 'number' ? error.code : null,
        subcode: typeof error.error_subcode === 'number' ? error.error_subcode : null,
        type: stringOrNull(error.type),
        fbtraceId: stringOrNull(error.fbtrace_id),
      },
    }
  }

  const refreshed = stringOrNull(parsed.access_token)
  if (refreshed === null) return malformed(response.status)
  const seconds = typeof parsed.expires_in === 'number' && parsed.expires_in > 0 ? parsed.expires_in : null
  return {
    ok: true,
    value: {
      token: refreshed,
      expiresAt: new Date(now.getTime() + (seconds === null ? DEFAULT_LONG_LIVED_MS : seconds * 1000)),
    },
  }
}

/**
 * Step 3: who this token belongs to.
 *
 * `user_id`, NOT `id` — CLAUDE.md records that `id` is app-scoped and is the
 * wrong value for `venues.instagram_account_id`. Getting this wrong routes
 * every inbound message to no venue.
 */
export async function fetchConnectedAccount(
  token: string,
  fetchImpl: FetchLike,
): Promise<GraphResult<ConnectedAccount>> {
  const result = await graphRequest('GET', '/me?fields=user_id,username', token, fetchImpl)
  if (!result.ok) return result
  if (!isRecord(result.value)) return malformed(200)

  const raw = result.value.user_id
  const userId = typeof raw === 'number' ? String(raw) : stringOrNull(raw)
  if (userId === null) return malformed(200)
  // A missing username costs the handle, not the connection: the operator app
  // shows it, nothing routes on it.
  return { ok: true, value: { userId, username: stringOrNull(result.value.username) } }
}

/**
 * Step 4: subscribe the connected account to this app's webhooks.
 *
 * Without this the venue looks connected and no message ever arrives, which
 * is the one failure in the whole flow where "Meta returned 200" and "it
 * works" can come apart. The caller alerts on failure rather than treating it
 * as fatal: the credential is already stored and a retry is a reconnect.
 */
export async function subscribeInstagramWebhooks(
  input: { accountId: string; token: string },
  fetchImpl: FetchLike,
): Promise<GraphResult<true>> {
  const fields = INSTAGRAM_WEBHOOK_SUBSCRIBED_FIELDS.join(',')
  const result = await graphRequest(
    'POST',
    `/${input.accountId}/subscribed_apps?subscribed_fields=${encodeURIComponent(fields)}`,
    input.token,
    fetchImpl,
  )
  if (!result.ok) return result
  // Meta answers {"success": true}. Anything else is not a subscription.
  if (!isRecord(result.value) || result.value.success !== true) return malformed(200)
  return { ok: true, value: true }
}

export { INSTAGRAM_GRAPH_BASE_URL, INSTAGRAM_OAUTH_BASE_URL, INSTAGRAM_GRAPH_ROOT_URL }
