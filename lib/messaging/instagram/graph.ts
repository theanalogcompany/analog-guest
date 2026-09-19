// TAC-469: the one place this repo talks HTTP to Meta's Graph API.
//
// Moved out of fetch-profile.ts (TAC-479) unchanged, so the profile reads and
// the Send API (send.ts) share one request path and one set of leak rules
// rather than two copies that could drift. fetch-profile.ts re-exports the
// names it used to own, so nothing that imported them changed.
//
// The rules, the same as the webhook's (TAC-458):
//   - The token goes in the Authorization header, never the URL. A URL ends up
//     in error messages and request logs; a header does not.
//   - A failure carries Meta's error code, subcode, type and fbtrace_id, and
//     NEVER Meta's error message. The message quotes the object it failed on
//     ("Object with ID '...' does not exist"), which here is a guest's scoped
//     ID. Dropping it here, rather than trusting every caller not to log it,
//     makes the leak impossible rather than merely avoided.
//   - A network failure carries the error's name and cause code, not its
//     message.
//
// Instagram Login path only: graph.instagram.com and an Instagram User token,
// never graph.facebook.com or a Page token.

export const INSTAGRAM_GRAPH_BASE_URL = 'https://graph.instagram.com/v25.0'

/** A Graph read that takes longer than this is abandoned and retried later. */
export const INSTAGRAM_GRAPH_TIMEOUT_MS = 5_000

/** Meta's error code for an access token that is invalid or has expired. */
export const GRAPH_CODE_TOKEN_REJECTED = 190

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

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

export function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
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

/**
 * One Graph request. `path` starts with '/'. A `body` is sent as JSON.
 * Never throws: every outcome is a value.
 */
export async function graphRequest(
  method: 'GET' | 'POST',
  path: string,
  token: string,
  fetchImpl: FetchLike,
  options: { body?: unknown; timeoutMs?: number } = {},
): Promise<GraphResult<unknown>> {
  const headers: Record<string, string> = { authorization: `Bearer ${token}` }
  if (options.body !== undefined) headers['content-type'] = 'application/json'

  let response: Response
  try {
    response = await fetchImpl(`${INSTAGRAM_GRAPH_BASE_URL}${path}`, {
      method,
      headers,
      ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
      signal: AbortSignal.timeout(options.timeoutMs ?? INSTAGRAM_GRAPH_TIMEOUT_MS),
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
