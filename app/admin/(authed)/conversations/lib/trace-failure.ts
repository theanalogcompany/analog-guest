// Pure: how the trace panel's fetch failures are told apart and worded.
//
// Before this, every failure of the trace read collapsed to one cached `null`
// and the panel said "Could be a fetch failure, or the trace hasn't flushed
// yet" - which is also what a rate limit looked like, and a cached null could
// not be retried without a reload. Not-found is final (cache it); the rest are
// transient (do not cache, offer a retry).

export type TraceLoadFailure = 'rate_limited' | 'timeout' | 'unavailable'

export type TraceLoadOutcome =
  { kind: 'not_found' } | { kind: 'failed'; failure: TraceLoadFailure }

// `status` is the trace route's HTTP status; null means the request itself
// failed (network error, or the client-side abort).
export function classifyTraceLoad(
  status: number | null,
  thrown?: unknown,
): TraceLoadOutcome {
  if (status === 404) return { kind: 'not_found' }
  if (status === 429) return { kind: 'failed', failure: 'rate_limited' }
  if (status === 504) return { kind: 'failed', failure: 'timeout' }
  if (status === null && thrown instanceof Error) {
    if (thrown.name === 'TimeoutError' || thrown.name === 'AbortError') {
      return { kind: 'failed', failure: 'timeout' }
    }
  }
  return { kind: 'failed', failure: 'unavailable' }
}

export function traceFailureCopy(failure: TraceLoadFailure): string {
  switch (failure) {
    case 'rate_limited':
      return 'Langfuse is rate limiting trace reads. Wait a few seconds, then retry.'
    case 'timeout':
      return 'Langfuse did not answer in time. Retry, or open the trace in Langfuse directly.'
    case 'unavailable':
      return 'The trace could not be loaded. Retry, or open the trace in Langfuse directly.'
  }
}
