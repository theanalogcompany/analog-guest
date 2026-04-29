import { afterEach, describe, expect, it, vi } from 'vitest'
import { isStateAtLeast } from './state-bands'

describe('isStateAtLeast', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('returns true when current equals min', () => {
    expect(isStateAtLeast('new', 'new')).toBe(true)
    expect(isStateAtLeast('returning', 'returning')).toBe(true)
  })

  it('returns true when current is above min', () => {
    expect(isStateAtLeast('regular', 'new')).toBe(true)
    expect(isStateAtLeast('raving_fan', 'regular')).toBe(true)
  })

  it('returns false when current is below min', () => {
    expect(isStateAtLeast('new', 'regular')).toBe(false)
    expect(isStateAtLeast('returning', 'regular')).toBe(false)
  })

  it('treats undefined min as ungated (true)', () => {
    expect(isStateAtLeast('new', undefined)).toBe(true)
  })

  it('treats null min as ungated (true)', () => {
    expect(isStateAtLeast('new', null)).toBe(true)
  })

  it('treats empty-string min as ungated (true)', () => {
    expect(isStateAtLeast('new', '')).toBe(true)
  })

  it('logs and returns false for malformed min values', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(isStateAtLeast('new', 'newish')).toBe(false)
    expect(warnSpy).toHaveBeenCalledOnce()
    expect(warnSpy.mock.calls[0][0]).toContain('newish')
  })
})