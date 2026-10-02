import { describe, expect, it } from 'vitest'
import { classifyTraceLoad, traceFailureCopy } from './trace-failure'

describe('classifyTraceLoad', () => {
  it('treats 404 as final, not a failure to retry', () => {
    expect(classifyTraceLoad(404)).toEqual({ kind: 'not_found' })
  })

  it('maps the route statuses to distinct transient failures', () => {
    expect(classifyTraceLoad(429)).toEqual({
      kind: 'failed',
      failure: 'rate_limited',
    })
    expect(classifyTraceLoad(504)).toEqual({
      kind: 'failed',
      failure: 'timeout',
    })
    expect(classifyTraceLoad(502)).toEqual({
      kind: 'failed',
      failure: 'unavailable',
    })
    expect(classifyTraceLoad(503)).toEqual({
      kind: 'failed',
      failure: 'unavailable',
    })
  })

  it('reads the client-side abort as a timeout, and other throws as unavailable', () => {
    const abort = new DOMException('signal timed out', 'TimeoutError')
    expect(classifyTraceLoad(null, abort)).toEqual({
      kind: 'failed',
      failure: 'timeout',
    })
    expect(classifyTraceLoad(null, new TypeError('fetch failed'))).toEqual({
      kind: 'failed',
      failure: 'unavailable',
    })
  })
})

describe('traceFailureCopy', () => {
  it('words each failure differently so they can be told apart on screen', () => {
    const copies = (['rate_limited', 'timeout', 'unavailable'] as const).map(
      traceFailureCopy,
    )
    expect(new Set(copies).size).toBe(3)
  })
})
