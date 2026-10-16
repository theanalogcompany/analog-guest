// TAC-516: the three Meta calls the connect callback makes, plus the webhook
// subscription that makes a connected account actually deliver messages.
//
// WHY NOT ALL OF THIS THROUGH graph.ts. The code exchange happens against
// `api.instagram.com`, form-encoded, with the app secret in the BODY — a
// different host and a different shape from graph.ts's Bearer-header JSON
// convention. The long-lived exchange and the refresh live at the Graph root
// with the token in the query (below). Only the account read and the webhook
// subscription are ordinary Graph calls, and those go through graph.ts.
//
// THE TOKEN IS IN THE QUERY ON TWO CALLS, AND ONLY TWO. `ig_exchange_token`
// and `refresh_access_token` send `access_token` in the query string, which
// is Meta's documented shape for both. graph.ts's rule is that a token never
// goes in a URL, because URLs reach request logs and error messages, so these
// two first shipped with the token in the Authorization header instead.
// graph.instagram.com REFUSED that in production: the first real connect
// (2026-10-16 UTC, Le Mil's test venue) failed at the long-lived exchange with
// code 100, HTTP 400, fbtrace Am3ogLhjud8Bdg1cHm2TvJu. Refresh has the same
// shape and would have failed on every attempt. Every other Graph call still
// goes through graph.ts with header auth; do not widen the query form beyond
// `getGraphRoot` below.
//
// WHAT MAKES THAT ACCEPTABLE. No URL built in this module is ever logged,
// returned, or put in an error. `getGraphRoot` is the only place a token URL
// is built; a failure carries Meta's code, subcode, type and fbtrace_id, never
// its message (which can quote the token); and a network failure carries the
// error's name and cause code, each held to identifier shape, never its
// message - Node's fetch writes the full URL into the message of a TypeError
// ("Failed to parse URL from ...") and into `cause.input`.
// scripts/harness/instagram-token-urls/ fails if any of that stops being
// true, on every outcome of both calls including a network throw. Run it when
// you change this file.
//
// OUTSIDE THIS MODULE: `@vercel/otel` instruments `fetch` and names each span
// with the full URL. lib/observability/span-processor.ts drops fetch spans by
// instrumentation scope, so they never reach Langfuse, and that filter is now
// also what keeps these two tokens out of traces. Widening it leaks them.
//
// `client_secret` also rides in the query on the long-lived exchange, because
// Meta requires it there, under the same guarantee.

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

/**
 * A field from an error object, kept only when it looks like an identifier
 * (`TypeError`, `ECONNRESET`, `UND_ERR_CONNECT_TIMEOUT`). Anything else could
 * be carrying the URL, so it is replaced rather than passed on.
 */
function identifierOr(value: unknown, fallback: string): string {
  return typeof value === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(value)
    ? value
    : fallback
}

function networkFailure(e: unknown): GraphFailure {
  const name = e instanceof Error ? e.name : typeof e
  if (name === 'TimeoutError' || name === 'AbortError')
    return { reason: 'timeout' }
  const cause = e instanceof Error && isRecord(e.cause) ? e.cause : null
  return {
    reason: 'network',
    errorName: identifierOr(name, 'unknown'),
    causeCode:
      cause && cause.code !== undefined && cause.code !== null
        ? identifierOr(cause.code, 'unknown')
        : null,
  }
}

/**
 * Meta's error, without its message: on these endpoints it can quote the
 * code, the redirect URI or the token.
 */
function graphError(httpStatus: number, parsed: unknown): GraphFailure {
  const error = isRecord(parsed) && isRecord(parsed.error) ? parsed.error : {}
  return {
    reason: 'graph_error',
    httpStatus,
    code: typeof error.code === 'number' ? error.code : null,
    subcode:
      typeof error.error_subcode === 'number' ? error.error_subcode : null,
    type: stringOrNull(error.type),
    fbtraceId: stringOrNull(error.fbtrace_id),
  }
}

/**
 * A missing or nonsensical expires_in must never produce an expiry in the
 * past: that would make a brand new credential look unrecoverable on the
 * refresh job's very first pass.
 */
function expiresAtFrom(now: Date, expiresIn: unknown): Date {
  const seconds =
    typeof expiresIn === 'number' && expiresIn > 0 ? expiresIn : null
  return new Date(
    now.getTime() + (seconds === null ? DEFAULT_LONG_LIVED_MS : seconds * 1000),
  )
}

/**
 * One request, its JSON, and Meta's error shaped without its message. Never
 * logs, returns or embeds `url`: callers here put secrets in it.
 */
async function requestJson(
  url: string,
  init: RequestInit,
  fetchImpl: FetchLike,
): Promise<GraphResult<Record<string, unknown>>> {
  let response: Response
  try {
    response = await fetchImpl(url, {
      ...init,
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
  if (!response.ok || !isRecord(parsed))
    return { ok: false, failure: graphError(response.status, parsed) }
  return { ok: true, value: parsed }
}

/**
 * GET at the Graph root with `access_token` in the query — the ONLY place in
 * this repo a token is put in a URL (see the header).
 */
function getGraphRoot(
  path: '/access_token' | '/refresh_access_token',
  params: Record<string, string>,
  fetchImpl: FetchLike,
): Promise<GraphResult<Record<string, unknown>>> {
  const query = new URLSearchParams(params)
  return requestJson(
    `${INSTAGRAM_GRAPH_ROOT_URL}${path}?${query.toString()}`,
    { method: 'GET' },
    fetchImpl,
  )
}

/**
 * Step 1: the authorization code becomes a short-lived (~1 hour) token.
 *
 * POST, form-encoded, everything in the BODY — so neither the code nor the
 * app secret is ever in a URL. Meta's documented shape for this one.
 */
export async function exchangeInstagramCode(
  input: {
    code: string
    redirectUri: string
    appId: string
    appSecret: string
  },
  fetchImpl: FetchLike,
): Promise<GraphResult<ShortLivedToken>> {
  const body = new URLSearchParams({
    client_id: input.appId,
    client_secret: input.appSecret,
    grant_type: 'authorization_code',
    redirect_uri: input.redirectUri,
    code: input.code,
  })

  const result = await requestJson(
    `${INSTAGRAM_OAUTH_BASE_URL}/oauth/access_token`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    },
    fetchImpl,
  )
  if (!result.ok) return result
  const parsed = result.value

  const token = stringOrNull(parsed.access_token)
  // Meta returns this as `user_id`, a number on this endpoint. It is the
  // account id, NOT the app-scoped `id` (CLAUDE.md records that distinction).
  const rawUserId = parsed.user_id
  const userId =
    typeof rawUserId === 'number' ? String(rawUserId) : stringOrNull(rawUserId)
  if (token === null || userId === null) return malformed(200)
  return { ok: true, value: { token, userId } }
}

/**
 * Step 2: the short-lived token becomes a long-lived (~60 day) one.
 *
 * The token and `client_secret` both ride in the query, Meta's documented
 * shape; header auth was refused here in production. See this file's header.
 */
export async function exchangeForLongLivedToken(
  input: { shortLivedToken: string; appSecret: string; now: Date },
  fetchImpl: FetchLike,
): Promise<GraphResult<LongLivedToken>> {
  const result = await getGraphRoot(
    '/access_token',
    {
      grant_type: 'ig_exchange_token',
      client_secret: input.appSecret,
      access_token: input.shortLivedToken,
    },
    fetchImpl,
  )
  if (!result.ok) return result

  const token = stringOrNull(result.value.access_token)
  if (token === null) return malformed(200)
  return {
    ok: true,
    value: {
      token,
      expiresAt: expiresAtFrom(input.now, result.value.expires_in),
    },
  }
}

/**
 * Keeping a long-lived token alive. Same host, same shape and same query-string
 * token as the exchange above, which is why it lives here rather than beside
 * the refresh job that calls it.
 *
 * IT USES THE GRAPH ROOT, NOT THE VERSIONED BASE. Meta documents
 * `refresh_access_token` at `graph.instagram.com/refresh_access_token`, and
 * this file's own constant says so. It went through `graphRequest` at first,
 * which prefixes `/v25.0`, so the code contradicted the comment stating the
 * fact — on the one call that has to run unattended for sixty days. Caught in
 * code review.
 */
export async function refreshInstagramLongLivedToken(
  token: string,
  fetchImpl: FetchLike,
  now: Date,
): Promise<GraphResult<LongLivedToken>> {
  const result = await getGraphRoot(
    '/refresh_access_token',
    { grant_type: 'ig_refresh_token', access_token: token },
    fetchImpl,
  )
  if (!result.ok) return result

  const refreshed = stringOrNull(result.value.access_token)
  if (refreshed === null) return malformed(200)
  return {
    ok: true,
    value: {
      token: refreshed,
      expiresAt: expiresAtFrom(now, result.value.expires_in),
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
  const result = await graphRequest(
    'GET',
    '/me?fields=user_id,username',
    token,
    fetchImpl,
  )
  if (!result.ok) return result
  if (!isRecord(result.value)) return malformed(200)

  const raw = result.value.user_id
  const userId = typeof raw === 'number' ? String(raw) : stringOrNull(raw)
  if (userId === null) return malformed(200)
  // A missing username costs the handle, not the connection: the operator app
  // shows it, nothing routes on it.
  return {
    ok: true,
    value: { userId, username: stringOrNull(result.value.username) },
  }
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
  if (!isRecord(result.value) || result.value.success !== true)
    return malformed(200)
  return { ok: true, value: true }
}

export {
  INSTAGRAM_GRAPH_BASE_URL,
  INSTAGRAM_OAUTH_BASE_URL,
  INSTAGRAM_GRAPH_ROOT_URL,
}
