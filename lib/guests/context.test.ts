/* eslint-disable @typescript-eslint/no-unused-vars */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/db/admin', () => ({
  createAdminClient: vi.fn(),
}))

import { createAdminClient } from '@/lib/db/admin'
import type { GuestContext } from '@/lib/schemas/guest-context'
import {
  deepMergeContext,
  getGuestContext,
  isEmptyContextUpdate,
  updateGuestContext,
} from './context'

const GUEST_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const NOW = new Date('2026-04-29T12:00:00Z')

interface MockState {
  selectData: { context: unknown } | null
  selectError: { message: string } | null
  updateError: { message: string } | null
  selectCalls: string[]
  updateCalls: Record<string, unknown>[]
  updateEqCalls: string[]
}

function newState(overrides: Partial<MockState> = {}): MockState {
  return {
    selectData: { context: {} },
    selectError: null,
    updateError: null,
    selectCalls: [],
    updateCalls: [],
    updateEqCalls: [],
    ...overrides,
  }
}

function makeSupabaseMock(state: MockState) {
  return {
    from: (_table: string) => ({
      select: (_cols: string) => ({
        eq: (_f: string, v: unknown) => ({
          maybeSingle: async () => {
            state.selectCalls.push(String(v))
            return { data: state.selectData, error: state.selectError }
          },
        }),
      }),
      update: (payload: Record<string, unknown>) => ({
        eq: async (_f: string, v: unknown) => {
          state.updateCalls.push(payload)
          state.updateEqCalls.push(String(v))
          return { error: state.updateError }
        },
      }),
    }),
  }
}

beforeEach(() => {
  vi.mocked(createAdminClient).mockReset()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('isEmptyContextUpdate', () => {
  it('returns true for the empty emission shape', () => {
    expect(isEmptyContextUpdate({})).toBe(true)
  })

  it('returns true when structured is an empty object', () => {
    expect(isEmptyContextUpdate({ structured: {} })).toBe(true)
  })

  it('returns true when observation is whitespace-only', () => {
    expect(isEmptyContextUpdate({ observation: '   ' })).toBe(true)
  })

  it('returns false when structured has at least one field', () => {
    expect(isEmptyContextUpdate({ structured: { guest_details: { first_name: 'Sarah' } } })).toBe(false)
  })

  it('returns false when observation is a non-empty string', () => {
    expect(isEmptyContextUpdate({ observation: 'a runner' })).toBe(false)
  })
})

describe('deepMergeContext', () => {
  it('returns existing unchanged for an empty patch', () => {
    const existing: GuestContext = { guest_details: { first_name: 'Sarah' } }
    const out = deepMergeContext(existing, {}, NOW)
    expect(out).toEqual({ guest_details: { first_name: 'Sarah' } })
  })

  it('deep-merges guest_details fields without overwriting unmentioned ones', () => {
    const existing: GuestContext = { guest_details: { first_name: 'Sarah', pronouns: 'she/her' } }
    const out = deepMergeContext(existing, { guest_details: { last_name: 'Chen' } }, NOW)
    expect(out.guest_details).toEqual({
      first_name: 'Sarah',
      pronouns: 'she/her',
      last_name: 'Chen',
    })
  })

  it('deep-merges nested home_base + workplace without clobbering', () => {
    const existing: GuestContext = {
      guest_details: {
        home_base: { neighborhood: 'Bernal Heights', zip: '94110' },
        workplace: { employer: 'Acme' },
      },
    }
    const out = deepMergeContext(
      existing,
      { guest_details: { home_base: { city: 'SF' } } },
      NOW,
    )
    expect(out.guest_details?.home_base).toEqual({
      neighborhood: 'Bernal Heights',
      zip: '94110',
      city: 'SF',
    })
    expect(out.guest_details?.workplace).toEqual({ employer: 'Acme' })
  })

  it('REPLACES preferences.dietary array (arrays replaced, not appended)', () => {
    const existing: GuestContext = { preferences: { dietary: ['vegetarian'], favorites: ['oat latte'] } }
    const out = deepMergeContext(
      existing,
      { preferences: { dietary: ['vegan'] } },
      NOW,
    )
    expect(out.preferences?.dietary).toEqual(['vegan'])
    expect(out.preferences?.favorites).toEqual(['oat latte'])
  })

  it('REPLACES life_context array (arrays replaced, not appended)', () => {
    const existing: GuestContext = {
      life_context: [
        { note: 'old trip', captured_at: '2026-03-01T00:00:00Z' },
      ],
    }
    const out = deepMergeContext(
      existing,
      { life_context: [{ note: 'new trip' }] },
      NOW,
    )
    expect(out.life_context).toEqual([
      { note: 'new trip', captured_at: NOW.toISOString() },
    ])
  })

  it('stamps captured_at on life_context patch entries that lack it', () => {
    const out = deepMergeContext(
      {},
      { life_context: [{ note: 'going to Tokyo', expires_at: '2026-05-15T00:00:00Z' }] },
      NOW,
    )
    expect(out.life_context).toEqual([
      { note: 'going to Tokyo', expires_at: '2026-05-15T00:00:00Z', captured_at: NOW.toISOString() },
    ])
  })

  it('preserves captured_at when patch entry already has one', () => {
    const existingTimestamp = '2026-03-15T08:00:00Z'
    const out = deepMergeContext(
      {},
      { life_context: [{ note: 'pre-stamped', captured_at: existingTimestamp }] },
      NOW,
    )
    expect(out.life_context?.[0].captured_at).toBe(existingTimestamp)
  })

  it('replaces observations array via structured.observations (arrays replaced)', () => {
    const existing: GuestContext = {
      observations: [{ note: 'old', captured_at: '2026-03-01T00:00:00Z' }],
    }
    const out = deepMergeContext(
      existing,
      { observations: [{ note: 'new' }] },
      NOW,
    )
    expect(out.observations).toEqual([{ note: 'new', captured_at: NOW.toISOString() }])
  })
})

describe('getGuestContext', () => {
  it('returns parsed context on happy path', async () => {
    const state = newState({
      selectData: {
        context: { guest_details: { first_name: 'Sarah' } },
      },
    })
    vi.mocked(createAdminClient).mockReturnValue(
      makeSupabaseMock(state) as unknown as ReturnType<typeof createAdminClient>,
    )
    const r = await getGuestContext(GUEST_ID)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.data).toEqual({ guest_details: { first_name: 'Sarah' } })
    expect(state.selectCalls).toEqual([GUEST_ID])
  })

  it('returns empty context on malformed JSONB (fail-OPEN) with a warning', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const state = newState({
      // Persisted shape requires captured_at on observation entries — malformed here.
      selectData: { context: { observations: [{ note: 'no timestamp' }] } },
    })
    vi.mocked(createAdminClient).mockReturnValue(
      makeSupabaseMock(state) as unknown as ReturnType<typeof createAdminClient>,
    )
    const r = await getGuestContext(GUEST_ID)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.data).toEqual({})
    expect(warnSpy).toHaveBeenCalledOnce()
    expect(warnSpy.mock.calls[0][0]).toContain('malformed')
  })

  it('returns guest_not_found when no row matches', async () => {
    const state = newState({ selectData: null })
    vi.mocked(createAdminClient).mockReturnValue(
      makeSupabaseMock(state) as unknown as ReturnType<typeof createAdminClient>,
    )
    const r = await getGuestContext(GUEST_ID)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.errorCode).toBe('guest_not_found')
  })

  it('returns db_read_failed on supabase error', async () => {
    const state = newState({ selectError: { message: 'connection lost' } })
    vi.mocked(createAdminClient).mockReturnValue(
      makeSupabaseMock(state) as unknown as ReturnType<typeof createAdminClient>,
    )
    const r = await getGuestContext(GUEST_ID)
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.errorCode).toBe('db_read_failed')
      expect(r.error).toContain('connection lost')
    }
  })

  it('returns db_read_threw when createAdminClient throws', async () => {
    vi.mocked(createAdminClient).mockImplementation(() => {
      throw new Error('missing env var')
    })
    const r = await getGuestContext(GUEST_ID)
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.errorCode).toBe('db_read_threw')
      expect(r.error).toContain('missing env var')
    }
  })
})

describe('updateGuestContext', () => {
  it('short-circuits on empty update with no DB hit', async () => {
    // Don't mock createAdminClient — short-circuit must happen before the call
    const r = await updateGuestContext({ guestId: GUEST_ID, update: {}, now: NOW })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.data.hasStructured).toBe(false)
      expect(r.data.hasObservation).toBe(false)
      expect(r.data.identityColumnsChanged).toEqual([])
    }
    expect(vi.mocked(createAdminClient)).not.toHaveBeenCalled()
  })

  it('writes structured patch into the context column on happy path', async () => {
    const state = newState({ selectData: { context: {} } })
    vi.mocked(createAdminClient).mockReturnValue(
      makeSupabaseMock(state) as unknown as ReturnType<typeof createAdminClient>,
    )
    const r = await updateGuestContext({
      guestId: GUEST_ID,
      update: { structured: { preferences: { dietary: ['vegan'] } } },
      now: NOW,
    })
    expect(r.ok).toBe(true)
    expect(state.updateCalls).toHaveLength(1)
    expect(state.updateCalls[0].context).toEqual({ preferences: { dietary: ['vegan'] } })
    expect(state.updateCalls[0].first_name).toBeUndefined()
    expect(state.updateEqCalls).toEqual([GUEST_ID])
    if (r.ok) {
      expect(r.data.hasStructured).toBe(true)
      expect(r.data.hasObservation).toBe(false)
      expect(r.data.identityColumnsChanged).toEqual([])
    }
  })

  it('syncs first_name and last_name columns when patched in guest_details', async () => {
    const state = newState({ selectData: { context: {} } })
    vi.mocked(createAdminClient).mockReturnValue(
      makeSupabaseMock(state) as unknown as ReturnType<typeof createAdminClient>,
    )
    const r = await updateGuestContext({
      guestId: GUEST_ID,
      update: {
        structured: { guest_details: { first_name: 'Sarah', last_name: 'Chen' } },
      },
      now: NOW,
    })
    expect(r.ok).toBe(true)
    expect(state.updateCalls[0].first_name).toBe('Sarah')
    expect(state.updateCalls[0].last_name).toBe('Chen')
    if (r.ok) {
      expect(r.data.identityColumnsChanged.sort()).toEqual(['first_name', 'last_name'])
    }
  })

  it('does NOT include first_name in payload when patch did not touch it', async () => {
    const state = newState({
      selectData: { context: { guest_details: { first_name: 'Sarah' } } },
    })
    vi.mocked(createAdminClient).mockReturnValue(
      makeSupabaseMock(state) as unknown as ReturnType<typeof createAdminClient>,
    )
    await updateGuestContext({
      guestId: GUEST_ID,
      update: { structured: { preferences: { dietary: ['vegan'] } } },
      now: NOW,
    })
    expect('first_name' in state.updateCalls[0]).toBe(false)
    expect('last_name' in state.updateCalls[0]).toBe(false)
  })

  it('appends observation shortcut to observations[] with captured_at = now', async () => {
    const state = newState({
      selectData: { context: { observations: [{ note: 'old', captured_at: '2026-03-01T00:00:00Z' }] } },
    })
    vi.mocked(createAdminClient).mockReturnValue(
      makeSupabaseMock(state) as unknown as ReturnType<typeof createAdminClient>,
    )
    const r = await updateGuestContext({
      guestId: GUEST_ID,
      update: { observation: 'a runner' },
      now: NOW,
    })
    expect(r.ok).toBe(true)
    const writtenContext = state.updateCalls[0].context as GuestContext
    expect(writtenContext.observations).toEqual([
      { note: 'old', captured_at: '2026-03-01T00:00:00Z' },
      { note: 'a runner', captured_at: NOW.toISOString() },
    ])
    if (r.ok) {
      expect(r.data.hasObservation).toBe(true)
      expect(r.data.hasStructured).toBe(false)
    }
  })

  it('handles structured patch + observation shortcut on the same call', async () => {
    const state = newState({ selectData: { context: {} } })
    vi.mocked(createAdminClient).mockReturnValue(
      makeSupabaseMock(state) as unknown as ReturnType<typeof createAdminClient>,
    )
    const r = await updateGuestContext({
      guestId: GUEST_ID,
      update: {
        structured: { guest_details: { first_name: 'Sarah' } },
        observation: 'mentioned she is a runner',
      },
      now: NOW,
    })
    expect(r.ok).toBe(true)
    const writtenContext = state.updateCalls[0].context as GuestContext
    expect(writtenContext.guest_details?.first_name).toBe('Sarah')
    expect(writtenContext.observations).toEqual([
      { note: 'mentioned she is a runner', captured_at: NOW.toISOString() },
    ])
    if (r.ok) {
      expect(r.data.hasStructured).toBe(true)
      expect(r.data.hasObservation).toBe(true)
      expect(r.data.identityColumnsChanged).toEqual(['first_name'])
    }
  })

  it('trims observation before appending and treats whitespace-only as no-op', async () => {
    const state = newState({ selectData: { context: {} } })
    vi.mocked(createAdminClient).mockReturnValue(
      makeSupabaseMock(state) as unknown as ReturnType<typeof createAdminClient>,
    )
    const r = await updateGuestContext({
      guestId: GUEST_ID,
      update: { observation: '   ' },
      now: NOW,
    })
    expect(r.ok).toBe(true)
    // The empty-update short-circuit catches this before any DB hit.
    expect(state.updateCalls).toHaveLength(0)
  })

  it('bubbles up read failure without attempting a write', async () => {
    const state = newState({ selectError: { message: 'read failure' } })
    vi.mocked(createAdminClient).mockReturnValue(
      makeSupabaseMock(state) as unknown as ReturnType<typeof createAdminClient>,
    )
    const r = await updateGuestContext({
      guestId: GUEST_ID,
      update: { observation: 'something' },
      now: NOW,
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.errorCode).toBe('db_read_failed')
    expect(state.updateCalls).toHaveLength(0)
  })

  it('returns db_write_failed when the UPDATE errors', async () => {
    const state = newState({
      selectData: { context: {} },
      updateError: { message: 'unique violation' },
    })
    vi.mocked(createAdminClient).mockReturnValue(
      makeSupabaseMock(state) as unknown as ReturnType<typeof createAdminClient>,
    )
    const r = await updateGuestContext({
      guestId: GUEST_ID,
      update: { observation: 'something' },
      now: NOW,
    })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.errorCode).toBe('db_write_failed')
      expect(r.error).toContain('unique violation')
    }
  })
})
