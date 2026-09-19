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
// What may and may not leave this module: the rules in graph.ts, which owns
// the request path since TAC-469 moved it there so the Send API shares it.
// The token goes in a header, and a failure never carries Meta's message.

import {
  graphRequest,
  isRecord,
  stringOrNull,
  type FetchLike,
  type GraphResult,
} from './graph'

// Re-exported so the names TAC-479 exported from here keep resolving.
export {
  GRAPH_CODE_TOKEN_REJECTED,
  INSTAGRAM_GRAPH_BASE_URL,
  INSTAGRAM_GRAPH_TIMEOUT_MS,
  isTokenRejected,
  type FetchLike,
  type GraphFailure,
  type GraphResult,
} from './graph'

export type InstagramProfile = {
  username: string
  /** The display name, or null when the guest has not set one. */
  name: string | null
}

/** A trimmed non-empty string, or null. Blank values are stored as NULL, never ''. */
function trimmedOrNull(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

function graphGet(path: string, token: string, fetchImpl: FetchLike): Promise<GraphResult<unknown>> {
  return graphRequest('GET', path, token, fetchImpl)
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
