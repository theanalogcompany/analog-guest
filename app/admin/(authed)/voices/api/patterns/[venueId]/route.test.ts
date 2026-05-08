import { NextResponse } from 'next/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/auth', () => ({
  requireVenueAdmin: vi.fn(),
}))
vi.mock('@/lib/voices', () => ({
  findActiveClusters: vi.fn(),
}))

import { requireVenueAdmin } from '@/lib/auth'
import { findActiveClusters } from '@/lib/voices'
import { GET } from './route'

const VENUE_ID = '11111111-1111-4111-8111-111111111111'
const OP_ID = '22222222-2222-4222-8222-222222222222'

function buildParams(venueId: string) {
  return { params: Promise.resolve({ venueId }) }
}

beforeEach(() => {
  vi.mocked(requireVenueAdmin).mockReset()
  vi.mocked(findActiveClusters).mockReset()
})

describe('GET /admin/voices/api/patterns/[venueId]', () => {
  it('200 + clusters on happy path', async () => {
    vi.mocked(requireVenueAdmin).mockResolvedValue({
      ok: true,
      operatorId: OP_ID,
      venueId: VENUE_ID,
    })
    vi.mocked(findActiveClusters).mockResolvedValue([
      {
        critiqueIds: ['a', 'b', 'c'],
        members: [
          { id: 'a', text: 'too eager', messageId: 'm1' },
          { id: 'b', text: 'sounds like marketing', messageId: 'm2' },
          { id: 'c', text: 'drop the exclamation', messageId: 'm3' },
        ],
        proposedRuleText: 'no marketing flourishes',
      },
    ])

    const res = await GET(
      new Request('http://test/admin/voices/api/patterns/x'),
      buildParams(VENUE_ID),
    )
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.clusters).toHaveLength(1)
    expect(json.clusters[0].proposedRuleText).toBe('no marketing flourishes')
  })

  it('200 + empty clusters when none exist', async () => {
    vi.mocked(requireVenueAdmin).mockResolvedValue({
      ok: true,
      operatorId: OP_ID,
      venueId: VENUE_ID,
    })
    vi.mocked(findActiveClusters).mockResolvedValue([])

    const res = await GET(
      new Request('http://test/admin/voices/api/patterns/x'),
      buildParams(VENUE_ID),
    )
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.clusters).toEqual([])
  })

  it('passes through auth helper response', async () => {
    vi.mocked(requireVenueAdmin).mockResolvedValue({
      ok: false,
      response: NextResponse.json({ error: 'unauthorized' }, { status: 401 }),
    })

    const res = await GET(
      new Request('http://test/admin/voices/api/patterns/x'),
      buildParams(VENUE_ID),
    )
    expect(res.status).toBe(401)
  })
})
