import { NextResponse } from 'next/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/auth', () => ({
  requireVenueAdmin: vi.fn(),
}))
vi.mock('../../../../../_lib/knowledge-corpus', () => ({
  addKnowledgeEntry: vi.fn(),
}))

import { requireVenueAdmin } from '@/lib/auth'
import { addKnowledgeEntry } from '../../../../../_lib/knowledge-corpus'
import { POST } from './route'

const VENUE_ID = '11111111-1111-4111-8111-111111111111'
const OPERATOR_ID = '22222222-2222-4222-8222-222222222222'
const CORPUS_ID = '44444444-4444-4444-8444-444444444444'

function buildRequest(body: unknown): Request {
  return new Request('http://test/admin/venues/api/venues/x/knowledge', {
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
  vi.mocked(addKnowledgeEntry).mockReset()
})

describe('POST /admin/venues/api/venues/[venueId]/knowledge', () => {
  beforeEach(() => {
    vi.mocked(requireVenueAdmin).mockResolvedValue({
      ok: true,
      operatorId: OPERATOR_ID,
      venueId: VENUE_ID,
    })
  })

  it('200 + corpusId on happy path', async () => {
    vi.mocked(addKnowledgeEntry).mockResolvedValue({
      ok: true,
      corpusId: CORPUS_ID,
      embeddedChunkCount: 1,
    })
    const res = await POST(
      buildRequest({
        content: 'The espresso machine is a La Marzocco Linea.',
        primaryTags: ['sourcing'],
        secondaryTags: ['equipment'],
      }),
      buildParams(VENUE_ID),
    )
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json).toMatchObject({ success: true, corpusId: CORPUS_ID })
    expect(addKnowledgeEntry).toHaveBeenCalledWith({
      venueId: VENUE_ID,
      content: 'The espresso machine is a La Marzocco Linea.',
      primaryTags: ['sourcing'],
      secondaryTags: ['equipment'],
      addedByOperatorId: OPERATOR_ID,
    })
  })

  it('502 when embed fails', async () => {
    vi.mocked(addKnowledgeEntry).mockResolvedValue({
      ok: false,
      error: 'voyage 502',
      errorCode: 'embed_failed',
    })
    const res = await POST(
      buildRequest({ content: 'x', primaryTags: ['other'], secondaryTags: [] }),
      buildParams(VENUE_ID),
    )
    expect(res.status).toBe(502)
  })

  it('400 on a non-canonical primary tag', async () => {
    const res = await POST(
      buildRequest({ content: 'x', primaryTags: ['personality'], secondaryTags: [] }),
      buildParams(VENUE_ID),
    )
    expect(res.status).toBe(400)
    expect(addKnowledgeEntry).not.toHaveBeenCalled()
  })

  it('400 on empty primaryTags', async () => {
    const res = await POST(
      buildRequest({ content: 'x', primaryTags: [], secondaryTags: [] }),
      buildParams(VENUE_ID),
    )
    expect(res.status).toBe(400)
  })

  it('400 on empty content', async () => {
    const res = await POST(
      buildRequest({ content: '', primaryTags: ['other'], secondaryTags: [] }),
      buildParams(VENUE_ID),
    )
    expect(res.status).toBe(400)
  })
})

describe('POST /admin/venues/api/venues/[venueId]/knowledge — auth pass-through', () => {
  it('passes through 403 from auth helper', async () => {
    vi.mocked(requireVenueAdmin).mockResolvedValue({
      ok: false,
      response: NextResponse.json({ error: 'venue not allowed' }, { status: 403 }),
    })
    const res = await POST(
      buildRequest({ content: 'x', primaryTags: ['other'], secondaryTags: [] }),
      buildParams(VENUE_ID),
    )
    expect(res.status).toBe(403)
    expect(addKnowledgeEntry).not.toHaveBeenCalled()
  })
})
