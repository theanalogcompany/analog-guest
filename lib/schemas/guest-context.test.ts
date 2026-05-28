import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  filterActiveLifeContext,
  GuestContextPatchSchema,
  GuestContextSchema,
  isEmptyGuestContext,
  OBSERVATION_RENDER_LIMIT,
  toParsedGuestContext,
} from './guest-context'

const NOW = new Date('2026-04-29T12:00:00Z')

describe('GuestContextSchema', () => {
  it('accepts the empty object (fresh guest, no captured context)', () => {
    const r = GuestContextSchema.safeParse({})
    expect(r.success).toBe(true)
    if (r.success) expect(r.data).toEqual({})
  })

  it('accepts a fully populated shape', () => {
    const r = GuestContextSchema.safeParse({
      guest_details: {
        first_name: 'Sarah',
        last_name: 'Chen',
        pronouns: 'she/her',
        date_of_birth: '1992-06-15',
        home_base: { neighborhood: 'Bernal Heights', zip: '94110', city: 'SF' },
        workplace: { neighborhood: 'SoMa', employer: 'Acme' },
      },
      preferences: {
        dietary: ['vegan'],
        favorites: ['oat latte'],
        dislikes: ['cilantro'],
      },
      life_context: [
        { note: 'Going to Tokyo', captured_at: '2026-04-15T10:00:00Z', expires_at: '2026-05-15T10:00:00Z' },
      ],
      observations: [{ note: 'Runs marathons', captured_at: '2026-04-20T08:00:00Z' }],
    })
    expect(r.success).toBe(true)
  })

  it('strips unknown keys silently (no .strict() so future migrations stay safe)', () => {
    const r = GuestContextSchema.safeParse({
      guest_details: { first_name: 'Sarah', some_future_field: 'ignore me' },
      another_top_level_extra: { whatever: true },
    })
    expect(r.success).toBe(true)
    if (r.success) {
      expect(r.data.guest_details).toEqual({ first_name: 'Sarah' })
      expect('another_top_level_extra' in r.data).toBe(false)
    }
  })

  it('rejects non-object input', () => {
    expect(GuestContextSchema.safeParse('not an object').success).toBe(false)
    expect(GuestContextSchema.safeParse(null).success).toBe(false)
    expect(GuestContextSchema.safeParse([]).success).toBe(false)
  })

  it('rejects an observation entry missing captured_at (persisted invariant)', () => {
    const r = GuestContextSchema.safeParse({
      observations: [{ note: 'no timestamp' }],
    })
    expect(r.success).toBe(false)
  })

  it('rejects life_context entry missing required note', () => {
    const r = GuestContextSchema.safeParse({
      life_context: [{ captured_at: '2026-04-29T12:00:00Z' }],
    })
    expect(r.success).toBe(false)
  })
})

describe('GuestContextPatchSchema', () => {
  it('accepts the empty object (the no-op emission shape)', () => {
    const r = GuestContextPatchSchema.safeParse({})
    expect(r.success).toBe(true)
  })

  it('accepts a DeepPartial — first_name only with no enclosing guest_details', () => {
    const r = GuestContextPatchSchema.safeParse({
      guest_details: { first_name: 'Sarah' },
    })
    expect(r.success).toBe(true)
  })

  it('accepts life_context patch entries without captured_at (runtime stamps)', () => {
    const r = GuestContextPatchSchema.safeParse({
      life_context: [{ note: 'going to Tokyo', expires_at: '2026-05-15T00:00:00Z' }],
    })
    expect(r.success).toBe(true)
  })

  it('accepts observations patch entries without captured_at (runtime stamps)', () => {
    const r = GuestContextPatchSchema.safeParse({
      observations: [{ note: 'a runner' }],
    })
    expect(r.success).toBe(true)
  })

  it('strips unknown keys (agent might emit near-misses)', () => {
    const r = GuestContextPatchSchema.safeParse({
      guest_details: { first_name: 'Sarah', unexpected_field: 'whatever' },
    })
    expect(r.success).toBe(true)
    if (r.success) {
      expect(r.data.guest_details).toEqual({ first_name: 'Sarah' })
    }
  })

  it('still requires note on life_context patch entries', () => {
    const r = GuestContextPatchSchema.safeParse({
      life_context: [{ expires_at: '2026-05-15T00:00:00Z' }],
    })
    expect(r.success).toBe(false)
  })
})

describe('filterActiveLifeContext', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('drops entries whose expires_at is strictly in the past', () => {
    const entries = [{ note: 'past', captured_at: '2026-04-01T00:00:00Z', expires_at: '2026-04-29T11:59:59Z' }]
    expect(filterActiveLifeContext(entries, NOW)).toEqual([])
  })

  it('keeps entries whose expires_at is strictly in the future', () => {
    const entry = { note: 'future', captured_at: '2026-04-01T00:00:00Z', expires_at: '2026-04-29T12:00:01Z' }
    expect(filterActiveLifeContext([entry], NOW)).toEqual([entry])
  })

  it('drops entries whose expires_at equals now (strictly-future semantics)', () => {
    const entries = [{ note: 'now', captured_at: '2026-04-01T00:00:00Z', expires_at: '2026-04-29T12:00:00Z' }]
    expect(filterActiveLifeContext(entries, NOW)).toEqual([])
  })

  it('keeps entries with no expires_at (permanent)', () => {
    const entry = { note: 'permanent', captured_at: '2026-04-01T00:00:00Z' }
    expect(filterActiveLifeContext([entry], NOW)).toEqual([entry])
  })

  it('drops malformed expires_at and logs a warning, without crashing', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const entries = [{ note: 'bad', captured_at: '2026-04-01T00:00:00Z', expires_at: 'not-a-date' }]
    expect(filterActiveLifeContext(entries, NOW)).toEqual([])
    expect(warnSpy).toHaveBeenCalledOnce()
    expect(warnSpy.mock.calls[0][0]).toContain('bad')
    expect(warnSpy.mock.calls[0][0]).toContain('not-a-date')
  })

  it('preserves only active + permanent entries from a mixed array, in original order', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const expired = { note: 'expired', captured_at: '2026-04-01T00:00:00Z', expires_at: '2026-04-28T00:00:00Z' }
    const active = { note: 'active', captured_at: '2026-04-01T00:00:00Z', expires_at: '2026-05-15T00:00:00Z' }
    const permanent = { note: 'permanent', captured_at: '2026-04-01T00:00:00Z' }
    const malformed = { note: 'malformed', captured_at: '2026-04-01T00:00:00Z', expires_at: 'garbage' }

    const out = filterActiveLifeContext([expired, active, permanent, malformed], NOW)
    expect(out.map((e) => e.note)).toEqual(['active', 'permanent'])
  })

  it('returns an empty array when given an empty array', () => {
    expect(filterActiveLifeContext([], NOW)).toEqual([])
  })
})

describe('toParsedGuestContext', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('returns an empty ParsedGuestContext when given empty input', () => {
    const out = toParsedGuestContext({}, NOW)
    expect(out).toEqual({
      guest_details: undefined,
      preferences: undefined,
      life_context: undefined,
      observations: undefined,
    })
    expect(isEmptyGuestContext(out)).toBe(true)
  })

  it('filters expired life_context entries while preserving structured details', () => {
    const out = toParsedGuestContext(
      {
        guest_details: { first_name: 'Sarah' },
        life_context: [
          { note: 'expired', captured_at: '2026-04-01T00:00:00Z', expires_at: '2026-04-28T00:00:00Z' },
          { note: 'active', captured_at: '2026-04-01T00:00:00Z', expires_at: '2026-05-15T00:00:00Z' },
        ],
      },
      NOW,
    )
    expect(out.guest_details).toEqual({ first_name: 'Sarah' })
    expect(out.life_context?.map((e) => e.note)).toEqual(['active'])
  })

  it(`truncates observations to the last ${OBSERVATION_RENDER_LIMIT}`, () => {
    const observations = Array.from({ length: 15 }, (_, i) => ({
      note: `obs-${i}`,
      captured_at: `2026-04-${String(i + 1).padStart(2, '0')}T00:00:00Z`,
    }))
    const out = toParsedGuestContext({ observations }, NOW)
    expect(out.observations).toHaveLength(OBSERVATION_RENDER_LIMIT)
    expect(out.observations?.[0].note).toBe('obs-5')
    expect(out.observations?.[OBSERVATION_RENDER_LIMIT - 1].note).toBe('obs-14')
  })

  it('normalizes empty arrays to undefined so isEmptyGuestContext sees absence consistently', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const out = toParsedGuestContext(
      {
        life_context: [
          { note: 'expired', captured_at: '2026-04-01T00:00:00Z', expires_at: '2026-04-28T00:00:00Z' },
        ],
        observations: [],
      },
      NOW,
    )
    expect(out.life_context).toBeUndefined()
    expect(out.observations).toBeUndefined()
    expect(isEmptyGuestContext(out)).toBe(true)
  })
})

describe('isEmptyGuestContext', () => {
  it('returns true for fully empty input', () => {
    expect(isEmptyGuestContext({})).toBe(true)
  })

  it('returns false when guest_details is present', () => {
    expect(isEmptyGuestContext({ guest_details: { first_name: 'Sarah' } })).toBe(false)
  })

  it('returns false when preferences is present', () => {
    expect(isEmptyGuestContext({ preferences: { dietary: ['vegan'] } })).toBe(false)
  })

  it('returns false when life_context is non-empty', () => {
    expect(
      isEmptyGuestContext({
        life_context: [{ note: 'x', captured_at: '2026-04-01T00:00:00Z' }],
      }),
    ).toBe(false)
  })

  it('returns false when observations is non-empty', () => {
    expect(
      isEmptyGuestContext({
        observations: [{ note: 'x', captured_at: '2026-04-01T00:00:00Z' }],
      }),
    ).toBe(false)
  })
})
