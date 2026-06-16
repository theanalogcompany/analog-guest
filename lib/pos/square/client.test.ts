import { describe, expect, it } from 'vitest'

import { resolveSquareEnv } from './client'

describe('resolveSquareEnv', () => {
  it('defaults to sandbox when unset or empty', () => {
    expect(resolveSquareEnv(undefined)).toBe('sandbox')
    expect(resolveSquareEnv('')).toBe('sandbox')
  })

  it('passes through recognized values', () => {
    expect(resolveSquareEnv('sandbox')).toBe('sandbox')
    expect(resolveSquareEnv('production')).toBe('production')
  })

  it('throws on an unrecognized value rather than guessing', () => {
    expect(() => resolveSquareEnv('prod')).toThrow(/Invalid SQUARE_ENV/)
    expect(() => resolveSquareEnv('PRODUCTION')).toThrow(/Invalid SQUARE_ENV/)
  })
})
