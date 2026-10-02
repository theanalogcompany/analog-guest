import { describe, expect, it } from 'vitest'
import { classifyTraceFetchError } from './trace-fetch-pure'

describe('classifyTraceFetchError', () => {
  it('reads the SDK statusCode', () => {
    const e = (statusCode: number) =>
      Object.assign(new Error('x'), { statusCode })
    expect(classifyTraceFetchError(e(404))).toEqual({
      error: 'not_found',
      status: 404,
    })
    expect(classifyTraceFetchError(e(429))).toEqual({
      error: 'rate_limited',
      status: 429,
    })
    expect(classifyTraceFetchError(e(500))).toEqual({
      error: 'error',
      status: 500,
    })
  })

  it('recognises the SDK timeout and a fetch abort as timeouts', () => {
    class LangfuseAPITimeoutError extends Error {}
    expect(
      classifyTraceFetchError(new LangfuseAPITimeoutError('Timeout exceeded')),
    ).toMatchObject({ error: 'timeout' })
    expect(
      classifyTraceFetchError(new DOMException('aborted', 'AbortError')),
    ).toMatchObject({ error: 'timeout' })
  })

  it('does not call an unrecognised or non-Error throw a timeout', () => {
    expect(classifyTraceFetchError(new TypeError('fetch failed'))).toEqual({
      error: 'error',
      status: null,
    })
    expect(classifyTraceFetchError('boom')).toEqual({
      error: 'error',
      status: null,
    })
    expect(classifyTraceFetchError(null)).toEqual({
      error: 'error',
      status: null,
    })
  })
})
