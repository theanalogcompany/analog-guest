import { describe, expect, it } from 'vitest'
import { formatLastRefined } from './format-last-refined'

const NOW = new Date('2026-05-08T12:00:00.000Z')

describe('formatLastRefined', () => {
  it('returns em-dash on null', () => {
    expect(formatLastRefined(null, NOW)).toBe('—')
  })

  it('returns "just now" within the first minute', () => {
    const recent = new Date(NOW.getTime() - 30_000)
    expect(formatLastRefined(recent, NOW)).toBe('just now')
  })

  it('renders minutes for under-an-hour deltas', () => {
    const t = new Date(NOW.getTime() - 12 * 60 * 1000)
    expect(formatLastRefined(t, NOW)).toBe('12m ago')
  })

  it('renders hours for under-a-day deltas', () => {
    const t = new Date(NOW.getTime() - 5 * 60 * 60 * 1000)
    expect(formatLastRefined(t, NOW)).toBe('5h ago')
  })

  it('renders days under 14d', () => {
    const t = new Date(NOW.getTime() - 3 * 24 * 60 * 60 * 1000)
    expect(formatLastRefined(t, NOW)).toBe('3d ago')
  })

  it('renders weeks for 14-55 day deltas', () => {
    const t = new Date(NOW.getTime() - 21 * 24 * 60 * 60 * 1000)
    expect(formatLastRefined(t, NOW)).toBe('3w ago')
  })

  it('renders months for older deltas', () => {
    const t = new Date(NOW.getTime() - 75 * 24 * 60 * 60 * 1000)
    expect(formatLastRefined(t, NOW)).toBe('2mo ago')
  })

  it('handles future timestamps gracefully', () => {
    const t = new Date(NOW.getTime() + 5 * 60_000)
    expect(formatLastRefined(t, NOW)).toBe('just now')
  })
})
