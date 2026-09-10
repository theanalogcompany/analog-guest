import { afterEach, describe, expect, it, vi } from 'vitest'
import type { VenueContextNote } from '@/lib/schemas'
import { partitionCurrentContext } from './expiry-queue'

const NOW = new Date('2026-04-29T12:00:00Z')

const note = (overrides: Partial<VenueContextNote> = {}): VenueContextNote => ({
  id: 'n',
  content: 'note',
  source: 'text',
  addedAt: new Date('2026-01-01T00:00:00Z'),
  ...overrides,
})

describe('partitionCurrentContext', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('reuses classifyContextEntry semantics: strictly-future is active, equal-now is expired', () => {
    const future = note({ id: 'future', expiresAt: '2026-04-29T12:00:01Z' })
    const equalNow = note({ id: 'equal', expiresAt: '2026-04-29T12:00:00Z' })
    const { active, expired } = partitionCurrentContext([future, equalNow], NOW)
    expect(active.map((e) => e.id)).toEqual(['future'])
    expect(expired.map((e) => e.id)).toEqual(['equal'])
  })

  it('treats no expiresAt as active (permanent)', () => {
    const permanent = note({ id: 'permanent' })
    const { active } = partitionCurrentContext([permanent], NOW)
    expect(active.map((e) => e.id)).toEqual(['permanent'])
  })

  it('puts a past expiresAt in expired', () => {
    const past = note({ id: 'past', expiresAt: '2026-04-01T00:00:00Z' })
    const { expired } = partitionCurrentContext([past], NOW)
    expect(expired.map((e) => e.id)).toEqual(['past'])
  })

  it('puts a malformed expiresAt in its own malformed bucket, not expired', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const bad = note({ id: 'bad', expiresAt: 'not-a-date' })
    const { expired, malformed } = partitionCurrentContext([bad], NOW)
    expect(expired).toEqual([])
    expect(malformed.map((e) => e.id)).toEqual(['bad'])
  })

  it('partitions a mixed array into all three buckets, preserving order within each', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const entries = [
      note({ id: 'active1' }),
      note({ id: 'expired1', expiresAt: '2026-01-01T00:00:00Z' }),
      note({ id: 'active2', expiresAt: '2026-05-01T00:00:00Z' }),
      note({ id: 'bad1', expiresAt: 'garbage' }),
      note({ id: 'expired2', expiresAt: '2026-04-29T11:00:00Z' }),
    ]
    const { active, expired, malformed } = partitionCurrentContext(entries, NOW)
    expect(active.map((e) => e.id)).toEqual(['active1', 'active2'])
    expect(expired.map((e) => e.id)).toEqual(['expired1', 'expired2'])
    expect(malformed.map((e) => e.id)).toEqual(['bad1'])
  })

  it('returns empty buckets for an empty array', () => {
    expect(partitionCurrentContext([], NOW)).toEqual({ active: [], expired: [], malformed: [] })
  })
})
