import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  classifyContextEntry,
  filterActiveContext,
  type VenueContextNote,
  VenueInfoSchema, parseVenueLinks} from './venue-info'

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

describe('classifyContextEntry', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('classifies a strictly-future expiresAt as active', () => {
    const entry = note({ expiresAt: '2026-04-29T12:00:01Z' })
    expect(classifyContextEntry(entry, NOW)).toBe('active')
  })

  it('classifies no expiresAt as active (permanent)', () => {
    expect(classifyContextEntry(note(), NOW)).toBe('active')
  })

  it('classifies an expiresAt equal to now as expired', () => {
    const entry = note({ expiresAt: '2026-04-29T12:00:00Z' })
    expect(classifyContextEntry(entry, NOW)).toBe('expired')
  })

  it('classifies a past expiresAt as expired', () => {
    const entry = note({ expiresAt: '2026-04-29T11:59:59Z' })
    expect(classifyContextEntry(entry, NOW)).toBe('expired')
  })

  it('classifies a malformed expiresAt as malformed and warns once', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const entry = note({ id: 'bad', expiresAt: 'not-a-date' })
    expect(classifyContextEntry(entry, NOW)).toBe('malformed')
    expect(warnSpy).toHaveBeenCalledOnce()
    expect(warnSpy.mock.calls[0][0]).toContain('bad')
    expect(warnSpy.mock.calls[0][0]).toContain('not-a-date')
  })
})
// TAC-301 part 2.
describe('VenueInfoSchema — services', () => {
  const minimal = {
    address: { line1: '1 Test St', city: 'SF', region: 'CA', postalCode: '94109' },
  }

  it('parses a venue with no services key at all (every venue predating this)', () => {
    const r = VenueInfoSchema.safeParse(minimal)
    expect(r.success).toBe(true)
    if (r.success) expect(r.data.services).toBeUndefined()
  })

  it('preserves the three states distinctly', () => {
    const r = VenueInfoSchema.safeParse({
      ...minimal,
      services: { holds: false, reservations: true },
    })
    expect(r.success).toBe(true)
    if (!r.success) return
    expect(r.data.services?.holds).toBe(false)
    expect(r.data.services?.reservations).toBe(true)
    // Unstated must stay undefined, NOT default to false — the serializer
    // renders false as an explicit "NOT available" and absent as nothing.
    expect(r.data.services?.delivery).toBeUndefined()
  })

  it('defaults the free-form arrays so callers never handle undefined', () => {
    const r = VenueInfoSchema.safeParse({ ...minimal, services: { holds: false } })
    expect(r.success).toBe(true)
    if (r.success) {
      expect(r.data.services?.alsoOffers).toEqual([])
      expect(r.data.services?.alsoDoesNotOffer).toEqual([])
    }
  })

  // Permissive at the LIVE boundary, per CLAUDE.md. This field is hand-edited
  // in Studio today and buildRuntimeContext throws on a venue_info parse
  // failure, so a strict reject here would take down every agent run for the
  // venue over a typo. Degrading to "nobody said" renders nothing, which is
  // the same safe state as unconfigured.
  it('degrades a malformed services object to undefined instead of failing the venue', () => {
    const r = VenueInfoSchema.safeParse({ ...minimal, services: { holds: 'no' } })
    expect(r.success).toBe(true)
    if (r.success) expect(r.data.services).toBeUndefined()
  })

  it('does not let a malformed services object take the rest of venue_info with it', () => {
    const r = VenueInfoSchema.safeParse({
      ...minimal,
      hours: { monday: '7:00 AM – 3:00 PM' },
      services: 'walk-in only',
    })
    expect(r.success).toBe(true)
    if (r.success) {
      expect(r.data.services).toBeUndefined()
      expect(r.data.hours.monday).toBe('7:00 AM – 3:00 PM')
    }
  })
})

describe('VenueInfoSchema — links (TAC-509)', () => {
  function base(): Record<string, unknown> {
    return {
      address: { line1: '1 Main St', city: 'Someville', region: 'CA', postalCode: '00000' },
    }
  }

  it('parses a venue with no links key at all', () => {
    const r = VenueInfoSchema.safeParse(base())
    expect(r.success).toBe(true)
    if (r.success) expect(r.data.links).toBeUndefined()
  })

  it('stores entries untouched, so the admin write path round-trips them', () => {
    const stored = [{ label: 'Budan beans', url: 'https://lemils.com/products/budan' }]
    const r = VenueInfoSchema.safeParse({ ...base(), links: stored })
    expect(r.success).toBe(true)
    if (r.success) expect(r.data.links).toEqual(stored)
  })

  it('keeps a malformed entry in STORAGE rather than stripping it on write', () => {
    // The admin PATCH route writes back `validated.data`. If the schema
    // dropped a bad entry here, an admin editing an unrelated field would
    // silently delete what Jaipal typed. Validation belongs at the read
    // boundary instead - see parseVenueLinks.
    const stored = [{ label: 'Broken' }, 'not-an-object']
    const r = VenueInfoSchema.safeParse({ ...base(), links: stored })
    expect(r.success).toBe(true)
    if (r.success) expect(r.data.links).toEqual(stored)
  })

  it('never fails the whole venue on a malformed links value', () => {
    const r = VenueInfoSchema.safeParse({ ...base(), links: 'not-an-array' })
    expect(r.success).toBe(true)
    if (r.success) {
      expect(r.data.links).toBeUndefined()
      expect(r.data.address.line1).toBe('1 Main St')
    }
  })
})

describe('parseVenueLinks (TAC-509)', () => {
  it('returns [] for undefined, a non-array, and an empty array', () => {
    expect(parseVenueLinks(undefined)).toEqual([])
    expect(parseVenueLinks('nope')).toEqual([])
    expect(parseVenueLinks([])).toEqual([])
  })

  it('keeps a well-formed entry', () => {
    expect(
      parseVenueLinks([{ label: 'Budan beans', url: 'https://lemils.com/products/budan' }]),
    ).toEqual([{ label: 'Budan beans', url: 'https://lemils.com/products/budan' }])
  })

  it('drops a bad entry and KEEPS its siblings', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const out = parseVenueLinks([
      { label: 'Good', url: 'https://lemils.com/a' },
      { label: '', url: 'https://lemils.com/b' },
      { label: 'No url' },
      { label: 'Bad url', url: 'not a url' },
      'not-an-object',
      null,
      { label: 'Also good', url: 'https://lemils.com/c' },
    ])
    expect(out).toEqual([
      { label: 'Good', url: 'https://lemils.com/a' },
      { label: 'Also good', url: 'https://lemils.com/c' },
    ])
    expect(warn).toHaveBeenCalledTimes(5)
    warn.mockRestore()
  })

  it('trims whitespace around a stored url but normalizes nothing else', () => {
    expect(
      parseVenueLinks([{ label: 'X', url: '  https://lemils.com/Products/Budan?v=1  ' }]),
    ).toEqual([{ label: 'X', url: 'https://lemils.com/Products/Budan?v=1' }])
  })

  it('does not mutate the caller\'s stored array', () => {
    const stored = [{ label: 'X', url: '  https://lemils.com/a  ' }]
    parseVenueLinks(stored)
    expect(stored[0].url).toBe('  https://lemils.com/a  ')
  })
})
