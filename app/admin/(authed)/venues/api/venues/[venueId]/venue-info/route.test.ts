// Mock signatures mirror the supabase-js fluent builder; column names +
// filter args we don't inspect inside the test.
/* eslint-disable @typescript-eslint/no-unused-vars */

import { NextResponse } from 'next/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/auth', () => ({
  requireVenueAdmin: vi.fn(),
}))
vi.mock('@/lib/db/admin', () => ({
  createAdminClient: vi.fn(),
}))

import { requireVenueAdmin } from '@/lib/auth'
import { createAdminClient } from '@/lib/db/admin'
import { PATCH } from './route'

const VENUE_ID = '11111111-1111-4111-8111-111111111111'
const OPERATOR_ID = '22222222-2222-4222-8222-222222222222'

const validVenueInfo = {
  address: { line1: '1 Main St', city: 'Someville', region: 'CA', postalCode: '00000' },
  contact: { publicPhone: '+15551234567' },
  hours: { monday: '7am-3pm' },
  menu: { highlights: ['Try the cortado'], items: [], notes: 'Seasonal menu' },
  staff: ['Rayan', 'Kinani'],
  currentContext: [],
}

interface AdminMockState {
  venueInfo: Record<string, unknown> | null
  readError: { message: string } | null
  updateCalls: Array<{ payload: Record<string, unknown> }>
  updateError: { message: string } | null
}

function newAdminState(overrides: Partial<AdminMockState> = {}): AdminMockState {
  return {
    venueInfo: { ...validVenueInfo },
    readError: null,
    updateCalls: [],
    updateError: null,
    ...overrides,
  }
}

function makeAdminMock(state: AdminMockState) {
  return {
    from: (_table: string) => ({
      select: (_cols: string) => ({
        eq: (_f: string, _v: unknown) => ({
          single: async () => ({
            data: state.venueInfo ? { venue_info: state.venueInfo } : null,
            error: state.readError,
          }),
        }),
      }),
      update: (payload: Record<string, unknown>) => ({
        eq: async (_f: string, _v: unknown) => {
          state.updateCalls.push({ payload })
          return { error: state.updateError }
        },
      }),
    }),
  }
}

function buildRequest(body: unknown): Request {
  return new Request('http://test/admin/venues/api/venues/x/venue-info', {
    method: 'PATCH',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  })
}

function buildParams(venueId: string) {
  return { params: Promise.resolve({ venueId }) }
}

beforeEach(() => {
  vi.mocked(requireVenueAdmin).mockReset()
  vi.mocked(createAdminClient).mockReset()
})

describe('PATCH /admin/venues/api/venues/[venueId]/venue-info — auth', () => {
  it('returns the auth helper response when auth fails', async () => {
    vi.mocked(requireVenueAdmin).mockResolvedValue({
      ok: false,
      response: NextResponse.json({ error: 'unauthorized' }, { status: 401 }),
    })
    const res = await PATCH(
      buildRequest({ staff: ['Rayan'] }),
      buildParams(VENUE_ID),
    )
    expect(res.status).toBe(401)
  })
})

describe('PATCH /admin/venues/api/venues/[venueId]/venue-info — body validation', () => {
  beforeEach(() => {
    vi.mocked(requireVenueAdmin).mockResolvedValue({
      ok: true,
      operatorId: OPERATOR_ID,
      venueId: VENUE_ID,
    })
  })

  it('400 on an address missing a required field', async () => {
    const res = await PATCH(
      buildRequest({ address: { line1: '1 Main St' } }),
      buildParams(VENUE_ID),
    )
    expect(res.status).toBe(400)
  })

  it('400 on a menu item with neither price nor priceNote', async () => {
    const res = await PATCH(
      buildRequest({
        menu: {
          highlights: [],
          items: [{ name: 'Latte', category: 'drinks', isOffMenu: false }],
        },
      }),
      buildParams(VENUE_ID),
    )
    expect(res.status).toBe(400)
  })

  it('does not accept currentContext through this route', async () => {
    // currentContext isn't in PatchBodySchema at all — Zod's default object
    // parsing strips unknown keys, so this should succeed while silently
    // ignoring the extra key, not error. Confirms the boundary, not a crash.
    const state = newAdminState()
    vi.mocked(createAdminClient).mockReturnValue(
      makeAdminMock(state) as unknown as ReturnType<typeof createAdminClient>,
    )
    const res = await PATCH(
      buildRequest({ currentContext: [{ id: 'x', content: 'y', source: 'text', addedAt: new Date().toISOString() }] }),
      buildParams(VENUE_ID),
    )
    expect(res.status).toBe(200)
    const written = state.updateCalls[0].payload.venue_info as Record<string, unknown>
    // currentContext in the write is whatever was already on the row — [] —
    // never replaced by the stripped, ignored request field.
    expect(written.currentContext).toEqual([])
  })
})

describe('PATCH /admin/venues/api/venues/[venueId]/venue-info — happy path', () => {
  beforeEach(() => {
    vi.mocked(requireVenueAdmin).mockResolvedValue({
      ok: true,
      operatorId: OPERATOR_ID,
      venueId: VENUE_ID,
    })
  })

  it('merges a partial field onto the existing object and preserves siblings', async () => {
    const state = newAdminState()
    vi.mocked(createAdminClient).mockReturnValue(
      makeAdminMock(state) as unknown as ReturnType<typeof createAdminClient>,
    )
    const res = await PATCH(
      buildRequest({ qrEnrollmentMessage: 'Hi Sana!' }),
      buildParams(VENUE_ID),
    )
    expect(res.status).toBe(200)
    expect(state.updateCalls).toHaveLength(1)
    const written = state.updateCalls[0].payload.venue_info as Record<string, unknown>
    expect(written.qrEnrollmentMessage).toBe('Hi Sana!')
    // Untouched top-level keys preserved — this is the load-bearing property.
    expect(written.staff).toEqual(['Rayan', 'Kinani'])
    expect((written.address as Record<string, unknown>).city).toBe('Someville')
  })

  it('whole-array-replaces menu.items on a menu edit, not merging item-by-item', async () => {
    const state = newAdminState()
    vi.mocked(createAdminClient).mockReturnValue(
      makeAdminMock(state) as unknown as ReturnType<typeof createAdminClient>,
    )
    const res = await PATCH(
      buildRequest({
        menu: {
          highlights: ['New highlight'],
          items: [{ name: 'Cortado', category: 'drinks', price: 4.5, isOffMenu: false }],
        },
      }),
      buildParams(VENUE_ID),
    )
    expect(res.status).toBe(200)
    const written = state.updateCalls[0].payload.venue_info as {
      menu: { highlights: string[]; items: unknown[] }
    }
    expect(written.menu.highlights).toEqual(['New highlight'])
    expect(written.menu.items).toHaveLength(1)
  })

  it('500 with no write when the stored venue_info fails to parse', async () => {
    const state = newAdminState({ venueInfo: { staff: 'not an array' } })
    vi.mocked(createAdminClient).mockReturnValue(
      makeAdminMock(state) as unknown as ReturnType<typeof createAdminClient>,
    )
    const res = await PATCH(buildRequest({ staff: ['Rayan'] }), buildParams(VENUE_ID))
    expect(res.status).toBe(500)
    expect(state.updateCalls).toEqual([])
  })
})
