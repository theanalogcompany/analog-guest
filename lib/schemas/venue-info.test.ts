import { afterEach, describe, expect, it, vi } from 'vitest'
import { filterActiveContext, type VenueContextNote } from './venue-info'

const NOW = new Date('2026-04-29T12:00:00Z')

const note = (overrides: Partial<VenueContextNote> = {}): VenueContextNote => ({
  id: 'n',
  content: 'note',
  source: 'text',
  addedAt: new Date('2026-01-01T00:00:00Z'),
  ...overrides,
})

describe('filterActiveContext', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('drops entries whose expiresAt is strictly in the past', () => {
    const entries = [note({ id: 'past', expiresAt: '2026-04-29T11:59:59Z' })]
    expect(filterActiveContext(entries, NOW)).toEqual([])
  })

  it('keeps entries whose expiresAt is strictly in the future', () => {
    const entry = note({ id: 'future', expiresAt: '2026-04-29T12:00:01Z' })
    expect(filterActiveContext([entry], NOW)).toEqual([entry])
  })

  it('drops entries whose expiresAt equals now (strictly-future semantics)', () => {
    const entries = [note({ id: 'now', expiresAt: '2026-04-29T12:00:00Z' })]
    expect(filterActiveContext(entries, NOW)).toEqual([])
  })

  it('keeps entries with no expiresAt (permanent)', () => {
    const entry = note({ id: 'permanent' })
    expect(filterActiveContext([entry], NOW)).toEqual([entry])
  })

  it('drops malformed expiresAt and logs a warning, without crashing', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const entries = [note({ id: 'bad', expiresAt: 'not-a-date' })]
    expect(filterActiveContext(entries, NOW)).toEqual([])
    expect(warnSpy).toHaveBeenCalledOnce()
    expect(warnSpy.mock.calls[0][0]).toContain('bad')
    expect(warnSpy.mock.calls[0][0]).toContain('not-a-date')
  })

  it('preserves only active + permanent entries from a mixed array, in original order', () => {
    const expired = note({ id: 'expired', expiresAt: '2026-04-28T00:00:00Z' })
    const active = note({ id: 'active', expiresAt: '2026-05-15T00:00:00Z' })
    const permanent = note({ id: 'permanent' })
    const malformed = note({ id: 'malformed', expiresAt: 'garbage' })
    vi.spyOn(console, 'warn').mockImplementation(() => {})

    const out = filterActiveContext([expired, active, permanent, malformed], NOW)
    expect(out.map((e) => e.id)).toEqual(['active', 'permanent'])
  })

  it('returns an empty array when given an empty array', () => {
    expect(filterActiveContext([], NOW)).toEqual([])
  })
})