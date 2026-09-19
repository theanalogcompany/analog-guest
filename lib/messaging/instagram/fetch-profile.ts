// TAC-479: the two Graph API reads the profile refresh makes, on the Instagram
// Login path (graph.instagram.com, an Instagram User token, never a Page token).
//
//   fetchInstagramProfile   GET /{igsid}?fields=username,name
//                           The guest's handle and display name. Meta grants
//                           access ("user consent") when the guest messages the
//                           account or taps an icebreaker.
//   fetchTokenAccountId     GET /me?fields=user_id
//                           Which account the token belongs to, as `user_id`
//                           (NOT `id`, which is app-scoped). The same value as
//                           venues.instagram_account_id and the webhook's
//                           entry.id.
//
// Only `username` and `name` are requested. profile_pic expires within days,
// and follower count or verified status have nothing to do with recognising a
// guest, so they are never asked for.
//
// Pure apart from the fetch, which is passed in, as is the token: nothing here
// reads the environment, so the tests need no network and no env. Neither
// function throws; each returns a profile, an account ID, or a failure.
//
// What may and may not leave this module, the same rules as the webhook's
// (TAC-458):
//   - The token goes in the Authorization header, never the URL. A URL ends up
//     in error messages and request logs; a header does not.
//   - A failure carries Meta's error code, subcode, type and fbtrace_id, and
//     NEVER Meta's error message. The message quotes the object it failed on
//     ("Object with ID '...' does not exist"), which here is the guest's scoped
//     ID. Dropping it here, rather than trusting every caller not to log it,
//     makes the leak impossible rather than merely avoided.
//   - A network failure carries the error's name and cause code, not its
//     message.

export const INSTAGRAM_GRAPH_BASE_URL = 'https://graph.instagram.com/v25.0'

/** A Graph call that takes longer than this is abandoned and retried later. */
export const INSTAGRAM_GRAPH_TIMEOUT_MS = 5_000

/** Meta's error code for an access token that is invalid or has expired. */
export const GRAPH_CODE_TOKEN_REJECTED = 190

export type InstagramProfile = {
  username: string
  /** The display name, or null when the guest has not set one. */
  name: string | null
}

export type GraphFailure =
  | { reason: 'timeout' }
  | { reason: 'network'; errorName: string; causeCode: string | null }
  | {
      reason: 'graph_error'
      httpStatus: number
      code: number | null
      subcode: number | null
      type: string | null
      fbtraceId: string | null
    }
  | { reason: 'malformed_response'; httpStatus: number }

export type GraphResult<T> = { ok: true; value: T } | { ok: false; failure: GraphFailure }

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>

/** True when Meta refused the token itself: expired, revoked or invalid. */
export function isTokenRejected(failure: GraphFailure): boolean {
  return failure.reason === 'graph_error' && failure.code === GRAPH_CODE_TOKEN_REJECTED
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

/** A trimmed non-empty string, or null. Blank values are stored as NULL, never ''. */
function trimmedOrNull(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

function graphErrorFrom(httpStatus: number, body: unknown): GraphFailure {
  const error = isRecord(body) && isRecord(body.error) ? body.error : {}
  // error.message is deliberately not read. See the file header.
  return {
    reason: 'graph_error',
    httpStatus,
    code: numberOrNull(error.code),
    subcode: numberOrNull(error.error_subcode),
    type: stringOrNull(error.type),
    fbtraceId: stringOrNull(error.fbtrace_id),
  }
}

function networkFailure(e: unknown): GraphFailure {
  const name = e instanceof Error ? e.name : typeof e
  if (name === 'TimeoutError' || name === 'AbortError') return { reason: 'timeout' }
  const cause = e instanceof Error && isRecord(e.cause) ? e.cause : null
  return { reason: 'network', errorName: name, causeCode: cause ? stringOrNull(cause.code) : null }
}

async function graphGet(path: string, token: string, fetchImpl: FetchLike): Promise<GraphResult<unknown>> {
  let response: Response
  try {
    response = await fetchImpl(`${INSTAGRAM_GRAPH_BASE_URL}${path}`, {
      method: 'GET',
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(INSTAGRAM_GRAPH_TIMEOUT_MS),
    })
  } catch (e) {
    return { ok: false, failure: networkFailure(e) }
  }

  let body: unknown
  try {
    body = await response.json()
  } catch (e) {
    // The body can time out mid-read as well as fail to parse.
    const failure = networkFailure(e)
    if (failure.reason === 'timeout') return { ok: false, failure }
    return { ok: false, failure: { reason: 'malformed_response', httpStatus: response.status } }
  }

  if (!response.ok || (isRecord(body) && body.error !== undefined)) {
    return { ok: false, failure: graphErrorFrom(response.status, body) }
  }
  return { ok: true, value: body }
}

/**
 * The guest's Instagram handle and display name. `igsid` goes into the URL
 * path encoded and unchecked: Meta documents no format or length for it, and
 * both 15- and 16-digit IDs have been seen.
 */
export async function fetchInstagramProfile(
  igsid: string,
  token: string,
  fetchImpl: FetchLike,
): Promise<GraphResult<InstagramProfile>> {
  const result = await graphGet(`/${encodeURIComponent(igsid)}?fields=username,name`, token, fetchImpl)
  if (!result.ok) return result

  const body = isRecord(result.value) ? result.value : {}
  const username = trimmedOrNull(body.username)
  // Meta always returns a username for someone who has messaged the account.
  // A 200 without one is not something to store over a good handle.
  if (username === null) return { ok: false, failure: { reason: 'malformed_response', httpStatus: 200 } }
  return { ok: true, value: { username, name: trimmedOrNull(body.name) } }
}

/**
 * The account the token belongs to. Only a string is accepted: account IDs
 * are 17 digits, past what a JSON number holds exactly, so a numeric user_id
 * could compare unequal to the stored one while being "the same" account.
 */
export async function fetchTokenAccountId(token: string, fetchImpl: FetchLike): Promise<GraphResult<string>> {
  const result = await graphGet('/me?fields=user_id', token, fetchImpl)
  if (!result.ok) return result

  const accountId = isRecord(result.value) ? stringOrNull(result.value.user_id) : null
  if (accountId === null) return { ok: false, failure: { reason: 'malformed_response', httpStatus: 200 } }
  return { ok: true, value: accountId }
}
