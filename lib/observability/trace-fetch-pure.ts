// Pure: classifies why a Langfuse trace read failed. No `@/*` imports, no SDK
// import, so tests exercise it without a client.
//
// WHY THIS EXISTS. The SDK's defaults are hostile to a server render: a 60s
// per-request timeout and two retries that honor `Retry-After` up to 60s each,
// so one rate-limited read can hold a caller for minutes. The admin
// conversations page used to await five of these in parallel before sending any
// HTML. Interactive reads therefore pass `TRACE_FETCH_REQUEST_OPTIONS`, and a
// failure is classified here instead of being flattened to `null`: "the trace
// does not exist" and "Langfuse is rate limiting us" need different responses.

export const TRACE_FETCH_TIMEOUT_SECONDS = 8

// maxRetries 0: an operator can click again; a server render cannot wait.
export const TRACE_FETCH_REQUEST_OPTIONS = {
  timeoutInSeconds: TRACE_FETCH_TIMEOUT_SECONDS,
  maxRetries: 0,
} as const

export type TraceFetchFailure =
  | 'not_configured'
  | 'empty_id'
  | 'not_found'
  | 'rate_limited'
  | 'timeout'
  | 'error'

export interface ClassifiedTraceFetchError {
  error: TraceFetchFailure
  status: number | null
}

function statusOf(e: unknown): number | null {
  if (typeof e !== 'object' || e === null) return null
  const code = (e as { statusCode?: unknown }).statusCode
  return typeof code === 'number' ? code : null
}

function isTimeout(e: unknown): boolean {
  if (!(e instanceof Error)) return false
  return (
    e.name === 'AbortError' ||
    e.name === 'TimeoutError' ||
    e.constructor.name === 'LangfuseAPITimeoutError' ||
    /timeout/i.test(e.message)
  )
}

export function classifyTraceFetchError(e: unknown): ClassifiedTraceFetchError {
  const status = statusOf(e)
  if (status === 404) return { error: 'not_found', status }
  if (status === 429) return { error: 'rate_limited', status }
  if (isTimeout(e)) return { error: 'timeout', status }
  return { error: 'error', status }
}

// HTTP status the admin trace route answers with, per failure.
export function traceFailureHttpStatus(failure: TraceFetchFailure): number {
  switch (failure) {
    case 'not_found':
    case 'empty_id':
      return 404
    case 'rate_limited':
      return 429
    case 'timeout':
      return 504
    case 'not_configured':
      return 503
    case 'error':
      return 502
  }
}
