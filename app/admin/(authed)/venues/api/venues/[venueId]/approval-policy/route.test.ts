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

interface AdminMockState {
  updateCalls: Array<Record<string, unknown>>
  updateError: { message: string } | null
  count: number
}

function newAdminState(overrides: Partial<AdminMockState> = {}): AdminMockState {
  return { updateCalls: [], updateError: null, count: 1, ...overrides }
}

function makeAdminMock(state: AdminMockState) {
  return {
    from: (_table: string) => ({
      update: (payload: Record<string, unknown>, _opts?: unknown) => ({
        eq: async (_f: string, _v: unknown) => {
          state.updateCalls.push(payload)
          return { error: state.updateError, count: state.count }
        },
      }),
    }),
  }
}

function req(body: unknown): Request {
  return new Request('http://localhost/x', {
    method: 'PATCH',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  })
}

const params = Promise.resolve({ venueId: VENUE_ID })

let state: AdminMockState

beforeEach(() => {
  vi.clearAllMocks()
  state = newAdminState()
  vi.mocked(requireVenueAdmin).mockResolvedValue({
    ok: true,
    operatorId: OPERATOR_ID,
    venueId: VENUE_ID,
  })
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  vi.mocked(createAdminClient).mockReturnValue(makeAdminMock(state) as any)
})

describe('PATCH approval-policy (TAC-307)', () => {
  it('refuses when the caller is not an analog admin for this venue', async () => {
    vi.mocked(requireVenueAdmin).mockResolvedValue({
      ok: false,
      response: NextResponse.json({ error: 'venue not allowed' }, { status: 403 }),
    })
    const res = await PATCH(req({ default: 'auto_send', perCategory: {} }), { params })
    expect(res.status).toBe(403)
    expect(state.updateCalls).toHaveLength(0)
  })

  it('writes the whole policy object', async () => {
    const res = await PATCH(
      req({ default: 'auto_send', perCategory: { comp_complaint: 'operator_approval' } }),
      { params },
    )
    expect(res.status).toBe(200)
    expect(state.updateCalls).toHaveLength(1)
    expect(state.updateCalls[0].approval_policy).toEqual({
      default: 'auto_send',
      perCategory: { comp_complaint: 'operator_approval' },
    })
  })

  it('writes the master switch as default=operator_approval with an empty perCategory', async () => {
    const res = await PATCH(req({ default: 'operator_approval', perCategory: {} }), { params })
    expect(res.status).toBe(200)
    expect(state.updateCalls[0].approval_policy).toEqual({
      default: 'operator_approval',
      perCategory: {},
    })
  })

  it('rejects an unknown disposition', async () => {
    const res = await PATCH(req({ default: 'manual_review', perCategory: {} }), { params })
    expect(res.status).toBe(400)
    expect(state.updateCalls).toHaveLength(0)
  })

  it('rejects an unknown category key — stricter than the runtime reader, deliberately', async () => {
    // PerCategorySchema keys on a loose z.string() so a typo in a hand-edited
    // row degrades gracefully at the LIVE boundary. This is the admin write
    // boundary, where the same typo should fail loudly instead of being
    // persisted and silently never matching anything.
    const res = await PATCH(
      req({ default: 'auto_send', perCategory: { comp_complaints: 'operator_approval' } }),
      { params },
    )
    expect(res.status).toBe(400)
    expect(state.updateCalls).toHaveLength(0)
  })

  it('refuses to hold an exempt category rather than silently dropping it', async () => {
    const res = await PATCH(
      req({ default: 'auto_send', perCategory: { opt_out: 'operator_approval' } }),
      { params },
    )
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ error: 'category_exempt' })
    expect(state.updateCalls).toHaveLength(0)
  })

  it('allows an explicit auto_send on an exempt category — harmless, and already the truth', async () => {
    const res = await PATCH(
      req({ default: 'auto_send', perCategory: { opt_out: 'auto_send' } }),
      { params },
    )
    expect(res.status).toBe(200)
  })

  it('rejects a malformed body', async () => {
    const res = await PATCH(
      new Request('http://localhost/x', { method: 'PATCH', body: 'not json' }),
      { params },
    )
    expect(res.status).toBe(400)
    expect(state.updateCalls).toHaveLength(0)
  })

  it('404s when no venue_configs row matched', async () => {
    state.count = 0
    const res = await PATCH(req({ default: 'auto_send', perCategory: {} }), { params })
    expect(res.status).toBe(404)
  })

  it('500s on a database error', async () => {
    state.updateError = { message: 'boom' }
    const res = await PATCH(req({ default: 'auto_send', perCategory: {} }), { params })
    expect(res.status).toBe(500)
  })
})
