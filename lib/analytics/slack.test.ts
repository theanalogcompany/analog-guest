import { describe, expect, it } from 'vitest'
import { truncate } from './slack'

describe('truncate', () => {
  it('returns the original string when shorter than max', () => {
    expect(truncate('hello', 10)).toBe('hello')
  })

  it('returns the original string when exactly max length (no ellipsis)', () => {
    expect(truncate('exactly10!', 10)).toBe('exactly10!')
  })

  it('truncates and appends ellipsis when longer than max', () => {
    expect(truncate('this is a long string', 10)).toBe('this is a …')
  })

  it('returns empty string unchanged', () => {
    expect(truncate('', 10)).toBe('')
  })
})