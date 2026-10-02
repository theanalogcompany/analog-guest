import { describe, expect, it, vi } from 'vitest'
import { fetchWithTimeout } from './admin'

// A fetch that never answers on its own and only settles when aborted, like a
// stalled upstream.
function stalledFetch(): typeof fetch {
  return (_input, init) =>
    new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal!.reason))
    })
}

describe('fetchWithTimeout', () => {
  it('aborts a request that never answers', async () => {
    const wrapped = fetchWithTimeout(30, stalledFetch())
    const started = performance.now()
    await expect(wrapped('https://example.test')).rejects.toMatchObject({
      name: 'TimeoutError',
    })
    expect(performance.now() - started).toBeLessThan(2000)
  })

  it('still honours a caller-supplied abort', async () => {
    const wrapped = fetchWithTimeout(60_000, stalledFetch())
    const controller = new AbortController()
    const pending = wrapped('https://example.test', {
      signal: controller.signal,
    })
    controller.abort(new Error('caller gave up'))
    await expect(pending).rejects.toThrow('caller gave up')
  })

  it('passes the request through untouched when it answers in time', async () => {
    const base = vi.fn(async () => new Response('ok'))
    const wrapped = fetchWithTimeout(5_000, base as unknown as typeof fetch)
    const res = await wrapped('https://example.test', { method: 'POST' })
    expect(await res.text()).toBe('ok')
    expect(base).toHaveBeenCalledWith(
      'https://example.test',
      expect.objectContaining({ method: 'POST', signal: expect.anything() }),
    )
  })
})
