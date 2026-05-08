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
import { POST } from './route'

const VENUE_ID = '11111111-1111-4111-8111-111111111111'
const OP_ID = '22222222-2222-4222-8222-222222222222'
const CRIT_A = '33333333-3333-4333-8333-333333333333'
const CRIT_B = '44444444-4444-4444-8444-444444444444'

interface UpdateState {
  updateError: { message: string } | null
  updateCalls: Array<{ payload: Record<string, unknown> }>
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
  return new Request('http://test/admin/voices/api/patterns/x/dismiss', {
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
  vi.mocked(requireVenueAdmin).mockResolvedValue({
    ok: true,
    operatorId: OP_ID,
    venueId: VENUE_ID,
  })
})

describe('POST /admin/voices/api/patterns/[venueId]/dismiss', () => {
  it('marks members dismissed and returns count', async () => {
    const state: UpdateState = { updateError: null, updateCalls: [] }
    vi.mocked(createAdminClient).mockReturnValue(
      makeAdminMock(state) as unknown as ReturnType<typeof createAdminClient>,
    )

    const res = await POST(
      buildRequest({ critiqueIds: [CRIT_A, CRIT_B] }),
      buildParams(VENUE_ID),
    )
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.dismissed).toBe(2)
    expect(state.updateCalls[0].payload.dismissed_at).toBeDefined()
  })

  it('400 on empty critiqueIds', async () => {
    const res = await POST(
      buildRequest({ critiqueIds: [] }),
      buildParams(VENUE_ID),
    )
    expect(res.status).toBe(400)
  })
})
