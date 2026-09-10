import { NextResponse } from 'next/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/auth', () => ({
  requireVenueAdmin: vi.fn(),
}))
vi.mock('../../../../../../../_lib/current-context', () => ({
  promoteCurrentContextEntry: vi.fn(),
}))

import { requireVenueAdmin } from '@/lib/auth'
import { promoteCurrentContextEntry } from '../../../../../../../_lib/current-context'
import { POST } from './route'

const VENUE_ID = '11111111-1111-4111-8111-111111111111'
const OPERATOR_ID = '22222222-2222-4222-8222-222222222222'
const ENTRY_ID = '33333333-3333-4333-8333-333333333333'
const KNOWLEDGE_ID = '44444444-4444-4444-8444-444444444444'

function buildRequest(body: unknown): Request {
  return new Request('http://test/admin/venues/api/venues/x/current-context/y/promote', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  })
}

function buildParams() {
  return { params: Promise.resolve({ venueId: VENUE_ID, entryId: ENTRY_ID }) }
}

beforeEach(() => {
  vi.mocked(requireVenueAdmin).mockReset()
  vi.mocked(promoteCurrentContextEntry).mockReset()
})

describe('POST .../current-context/[entryId]/promote', () => {
  beforeEach(() => {
    vi.mocked(requireVenueAdmin).mockResolvedValue({
      ok: true,
      operatorId: OPERATOR_ID,
      venueId: VENUE_ID,
    })
  })

  it('200 + knowledgeCorpusId on happy path', async () => {
    vi.mocked(promoteCurrentContextEntry).mockResolvedValue({
      ok: true,
      knowledgeCorpusId: KNOWLEDGE_ID,
    })
    const res = await POST(
      buildRequest({ primaryTag: 'logistics', secondaryTags: [] }),
      buildParams(),
    )
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json).toMatchObject({ success: true, knowledgeCorpusId: KNOWLEDGE_ID })
    expect(promoteCurrentContextEntry).toHaveBeenCalledWith({
      venueId: VENUE_ID,
      entryId: ENTRY_ID,
      primaryTag: 'logistics',
      secondaryTags: [],
    })
  })

  it('400 on a non-canonical primary tag', async () => {
    const res = await POST(buildRequest({ primaryTag: 'personality' }), buildParams())
    expect(res.status).toBe(400)
    expect(promoteCurrentContextEntry).not.toHaveBeenCalled()
  })

  it('404 when the entry is gone', async () => {
    vi.mocked(promoteCurrentContextEntry).mockResolvedValue({
      ok: false,
      error: 'not found',
      errorCode: 'not_found',
    })
    const res = await POST(buildRequest({ primaryTag: 'logistics' }), buildParams())
    expect(res.status).toBe(404)
  })

  it('502 when the embed fails', async () => {
    vi.mocked(promoteCurrentContextEntry).mockResolvedValue({
      ok: false,
      error: 'voyage 502',
      errorCode: 'embed_failed',
    })
    const res = await POST(buildRequest({ primaryTag: 'logistics' }), buildParams())
    expect(res.status).toBe(502)
  })

  it('passes through 403 from auth helper', async () => {
    vi.mocked(requireVenueAdmin).mockResolvedValue({
      ok: false,
      response: NextResponse.json({ error: 'venue not allowed' }, { status: 403 }),
    })
    const res = await POST(buildRequest({ primaryTag: 'logistics' }), buildParams())
    expect(res.status).toBe(403)
    expect(promoteCurrentContextEntry).not.toHaveBeenCalled()
  })
})
