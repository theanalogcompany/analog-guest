/* eslint-disable @typescript-eslint/no-unused-vars */

import { NextResponse } from 'next/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/auth', () => ({
  requireVenueAdmin: vi.fn(),
}))
vi.mock('@/lib/db/admin', () => ({
  createAdminClient: vi.fn(),
}))
vi.mock('@/lib/voice-training', () => ({
  dedupeAndAppendAntiPatterns: vi.fn(),
}))

import { requireVenueAdmin } from '@/lib/auth'
import { createAdminClient } from '@/lib/db/admin'
import { dedupeAndAppendAntiPatterns } from '@/lib/voice-training'
import { POST } from './route'

const VENUE_ID = '11111111-1111-4111-8111-111111111111'
const OP_ID = '22222222-2222-4222-8222-222222222222'
const CRIT_A = '33333333-3333-4333-8333-333333333333'
const CRIT_B = '44444444-4444-4444-8444-444444444444'

interface UpdateState {
  updateError: { message: string } | null
  updateCalls: Array<{ payload: Record<string, unknown> }>
}

function newUpdateState(overrides: Partial<UpdateState> = {}): UpdateState {
  return {
    updateError: null,
    updateCalls: [],
    ...overrides,
  }
}

function makeAdminMock(state: UpdateState) {
  return {
    from: (_table: string) => ({
      update: (payload: Record<string, unknown>) => ({
        eq: (_f: string, _v: unknown) => ({
          in: async (_f2: string, _ids: unknown) => {
            state.updateCalls.push({ payload })
            return { error: state.updateError }
          },
        }),
      }),
    }),
  }
}

function buildRequest(body: unknown): Request {
  return new Request('http://test/admin/voices/api/patterns/x/promote', {
    method: 'POST',
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
  vi.mocked(dedupeAndAppendAntiPatterns).mockReset()
  vi.mocked(requireVenueAdmin).mockResolvedValue({
    ok: true,
    operatorId: OP_ID,
    venueId: VENUE_ID,
  })
})

describe('POST /admin/voices/api/patterns/[venueId]/promote', () => {
  it('appends rule with source=auto + operator UUID, marks members promoted', async () => {
    const state = newUpdateState()
    vi.mocked(createAdminClient).mockReturnValue(
      makeAdminMock(state) as unknown as ReturnType<typeof createAdminClient>,
    )
    vi.mocked(dedupeAndAppendAntiPatterns).mockResolvedValue({
      existing: [],
      added: ['no marketing flourishes'],
    })

    const res = await POST(
      buildRequest({
        critiqueIds: [CRIT_A, CRIT_B],
        ruleText: 'no marketing flourishes',
      }),
      buildParams(VENUE_ID),
    )
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.added).toEqual(['no marketing flourishes'])

    expect(dedupeAndAppendAntiPatterns).toHaveBeenCalledWith(
      VENUE_ID,
      ['no marketing flourishes'],
      { source: 'auto', authorOperatorId: OP_ID },
    )
    expect(state.updateCalls).toHaveLength(1)
    expect(state.updateCalls[0].payload.promoted_at).toBeDefined()
  })

  it('500 when critique update fails', async () => {
    const state = newUpdateState({ updateError: { message: 'lost' } })
    vi.mocked(createAdminClient).mockReturnValue(
      makeAdminMock(state) as unknown as ReturnType<typeof createAdminClient>,
    )
    vi.mocked(dedupeAndAppendAntiPatterns).mockResolvedValue({
      existing: [],
      added: ['x'],
    })

    const res = await POST(
      buildRequest({ critiqueIds: [CRIT_A], ruleText: 'x' }),
      buildParams(VENUE_ID),
    )
    expect(res.status).toBe(500)
  })

  it('passes through auth helper response', async () => {
    vi.mocked(requireVenueAdmin).mockResolvedValue({
      ok: false,
      response: NextResponse.json({ error: 'venue not allowed' }, { status: 403 }),
    })

    const res = await POST(
      buildRequest({ critiqueIds: [CRIT_A], ruleText: 'x' }),
      buildParams(VENUE_ID),
    )
    expect(res.status).toBe(403)
  })
})
