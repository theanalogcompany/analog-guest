import { NextResponse } from 'next/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/auth', () => ({
  requireVenueAdmin: vi.fn(),
}))
vi.mock('../../../../../../_lib/current-context', () => ({
  dropCurrentContextEntry: vi.fn(),
}))

import { requireVenueAdmin } from '@/lib/auth'
import { dropCurrentContextEntry } from '../../../../../../_lib/current-context'
import { DELETE } from './route'

const VENUE_ID = '11111111-1111-4111-8111-111111111111'
const OPERATOR_ID = '22222222-2222-4222-8222-222222222222'
const ENTRY_ID = '33333333-3333-4333-8333-333333333333'

function buildRequest(): Request {
  return new Request('http://test/admin/venues/api/venues/x/current-context/y', {
    method: 'DELETE',
  })
}

function buildParams() {
  return { params: Promise.resolve({ venueId: VENUE_ID, entryId: ENTRY_ID }) }
}

beforeEach(() => {
  vi.mocked(requireVenueAdmin).mockReset()
  vi.mocked(dropCurrentContextEntry).mockReset()
})

describe('DELETE /admin/venues/api/venues/[venueId]/current-context/[entryId]', () => {
  beforeEach(() => {
    vi.mocked(requireVenueAdmin).mockResolvedValue({
      ok: true,
      operatorId: OPERATOR_ID,
      venueId: VENUE_ID,
    })
  })

  it('200 on successful drop', async () => {
    vi.mocked(dropCurrentContextEntry).mockResolvedValue({ ok: true })
    const res = await DELETE(buildRequest(), buildParams())
    expect(res.status).toBe(200)
    expect(dropCurrentContextEntry).toHaveBeenCalledWith({ venueId: VENUE_ID, entryId: ENTRY_ID })
  })

  it('404 when the entry is already gone', async () => {
    vi.mocked(dropCurrentContextEntry).mockResolvedValue({
      ok: false,
      error: 'not found',
      errorCode: 'not_found',
    })
    const res = await DELETE(buildRequest(), buildParams())
    expect(res.status).toBe(404)
  })

  it('passes through 403 from auth helper', async () => {
    vi.mocked(requireVenueAdmin).mockResolvedValue({
      ok: false,
      response: NextResponse.json({ error: 'venue not allowed' }, { status: 403 }),
    })
    const res = await DELETE(buildRequest(), buildParams())
    expect(res.status).toBe(403)
    expect(dropCurrentContextEntry).not.toHaveBeenCalled()
  })
})
