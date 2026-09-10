// Destructuring-to-omit a field for a "missing required field" fixture
// leaves an intentionally-unused binding.
/* eslint-disable @typescript-eslint/no-unused-vars */

import { NextResponse } from 'next/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/auth', () => ({
  requireVenueAdmin: vi.fn(),
}))
vi.mock('../../../../../_lib/mechanics', () => ({
  addMechanic: vi.fn(),
}))

import { requireVenueAdmin } from '@/lib/auth'
import { addMechanic } from '../../../../../_lib/mechanics'
import { POST } from './route'

const VENUE_ID = '11111111-1111-4111-8111-111111111111'
const OPERATOR_ID = '22222222-2222-4222-8222-222222222222'
const MECHANIC_ID = '33333333-3333-4333-8333-333333333333'

const validMechanic = {
  type: 'perk',
  name: 'The Joey',
  description: 'A free drink for regulars',
  qualification: 'Any regular guest',
  rewardDescription: 'One free drink of choice',
  minState: 'regular',
  redemptionPolicy: 'one_time',
  redemptionWindowDays: null,
  requiresOperatorApproval: false,
  triggerType: 'guest_initiated_request',
  expirationRule: 'valid on next visit only',
}

function buildRequest(body: unknown): Request {
  return new Request('http://test/admin/venues/api/venues/x/mechanics', {
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
  vi.mocked(addMechanic).mockReset()
})

describe('POST /admin/venues/api/venues/[venueId]/mechanics', () => {
  beforeEach(() => {
    vi.mocked(requireVenueAdmin).mockResolvedValue({
      ok: true,
      operatorId: OPERATOR_ID,
      venueId: VENUE_ID,
    })
  })

  it('200 + mechanicId on happy path', async () => {
    vi.mocked(addMechanic).mockResolvedValue({ ok: true, mechanicId: MECHANIC_ID })
    const res = await POST(buildRequest(validMechanic), buildParams(VENUE_ID))
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json).toMatchObject({ success: true, mechanicId: MECHANIC_ID })
    expect(addMechanic).toHaveBeenCalledWith({ venueId: VENUE_ID, mechanic: validMechanic })
  })

  it('400 when a required field is missing', () => {
    const { requiresOperatorApproval: _drop, ...incomplete } = validMechanic
    return POST(buildRequest(incomplete), buildParams(VENUE_ID)).then((res) => {
      expect(res.status).toBe(400)
      expect(addMechanic).not.toHaveBeenCalled()
    })
  })

  it('400 on a redemption pairing violation (renewable with a null window)', async () => {
    const res = await POST(
      buildRequest({ ...validMechanic, redemptionPolicy: 'renewable', redemptionWindowDays: null }),
      buildParams(VENUE_ID),
    )
    expect(res.status).toBe(400)
    expect(addMechanic).not.toHaveBeenCalled()
  })

  it('500 when the write fails', async () => {
    vi.mocked(addMechanic).mockResolvedValue({
      ok: false,
      error: 'connection lost',
      errorCode: 'db_error',
    })
    const res = await POST(buildRequest(validMechanic), buildParams(VENUE_ID))
    expect(res.status).toBe(500)
  })

  it('passes through 403 from auth helper', async () => {
    vi.mocked(requireVenueAdmin).mockResolvedValue({
      ok: false,
      response: NextResponse.json({ error: 'venue not allowed' }, { status: 403 }),
    })
    const res = await POST(buildRequest(validMechanic), buildParams(VENUE_ID))
    expect(res.status).toBe(403)
    expect(addMechanic).not.toHaveBeenCalled()
  })
})
