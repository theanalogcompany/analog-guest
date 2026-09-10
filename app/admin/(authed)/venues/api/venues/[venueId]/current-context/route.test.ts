import { NextResponse } from 'next/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/auth', () => ({
  requireVenueAdmin: vi.fn(),
}))
vi.mock('../../../../../_lib/current-context', () => ({
  addCurrentContextEntry: vi.fn(),
}))

import { requireVenueAdmin } from '@/lib/auth'
import { addCurrentContextEntry } from '../../../../../_lib/current-context'
import { POST } from './route'

const VENUE_ID = '11111111-1111-4111-8111-111111111111'
const OPERATOR_ID = '22222222-2222-4222-8222-222222222222'

function buildRequest(body: unknown): Request {
  return new Request('http://test/admin/venues/api/venues/x/current-context', {
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
  vi.mocked(addCurrentContextEntry).mockReset()
})

describe('POST /admin/venues/api/venues/[venueId]/current-context', () => {
  beforeEach(() => {
    vi.mocked(requireVenueAdmin).mockResolvedValue({
      ok: true,
      operatorId: OPERATOR_ID,
      venueId: VENUE_ID,
    })
  })

  it('200 + entry on happy path', async () => {
    vi.mocked(addCurrentContextEntry).mockResolvedValue({
      ok: true,
      entry: {
        id: 'x',
        content: 'Oat milk is out',
        source: 'manual_entry',
        addedAt: new Date(),
      },
    })
    const res = await POST(
      buildRequest({ content: 'Oat milk is out', expiresAt: '2026-06-01T00:00:00.000Z' }),
      buildParams(VENUE_ID),
    )
    expect(res.status).toBe(200)
    expect(addCurrentContextEntry).toHaveBeenCalledWith({
      venueId: VENUE_ID,
      content: 'Oat milk is out',
      expiresAt: '2026-06-01T00:00:00.000Z',
    })
  })

  it('400 on empty content', async () => {
    const res = await POST(buildRequest({ content: '' }), buildParams(VENUE_ID))
    expect(res.status).toBe(400)
    expect(addCurrentContextEntry).not.toHaveBeenCalled()
  })

  it('passes through 403 from auth helper', async () => {
    vi.mocked(requireVenueAdmin).mockResolvedValue({
      ok: false,
      response: NextResponse.json({ error: 'venue not allowed' }, { status: 403 }),
    })
    const res = await POST(buildRequest({ content: 'x' }), buildParams(VENUE_ID))
    expect(res.status).toBe(403)
    expect(addCurrentContextEntry).not.toHaveBeenCalled()
  })
})
