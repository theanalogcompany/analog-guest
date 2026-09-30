import { afterEach, describe, expect, it, vi } from 'vitest'

import { logger } from './logger'

function lastLineFrom(spy: ReturnType<typeof vi.spyOn>): unknown {
  const calls = spy.mock.calls
  expect(calls.length).toBeGreaterThan(0)
  return JSON.parse(calls[calls.length - 1][0] as string)
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('logger', () => {
  it('emits a single JSON line with ts, level, event and fields', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {})
    logger.info('[test] something happened', { venueId: 'v1', count: 3 })
    const parsed = lastLineFrom(spy) as Record<string, unknown>
    expect(parsed.level).toBe('info')
    expect(parsed.event).toBe('[test] something happened')
    expect(parsed.venueId).toBe('v1')
    expect(parsed.count).toBe(3)
    expect(typeof parsed.ts).toBe('string')
    expect(Number.isNaN(Date.parse(parsed.ts as string))).toBe(false)
  })

  it('routes warn to console.warn and error to console.error', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    logger.warn('[test] warn')
    logger.error('[test] error')
    expect((lastLineFrom(warnSpy) as Record<string, unknown>).level).toBe(
      'warn',
    )
    expect((lastLineFrom(errorSpy) as Record<string, unknown>).level).toBe(
      'error',
    )
  })

  it('serializes Error fields with name, message and stack', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    logger.error('[test] failed', { error: new Error('boom') })
    const parsed = lastLineFrom(spy) as { error: Record<string, unknown> }
    expect(parsed.error.name).toBe('Error')
    expect(parsed.error.message).toBe('boom')
    expect(typeof parsed.error.stack).toBe('string')
  })

  it('does not throw on circular fields', () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const a: Record<string, unknown> = {}
    a.self = a
    expect(() => logger.warn('[test] circular', { a })).not.toThrow()
    const parsed = lastLineFrom(spy) as { a: { self: unknown } }
    expect(parsed.a.self).toBe('[circular]')
  })
})
