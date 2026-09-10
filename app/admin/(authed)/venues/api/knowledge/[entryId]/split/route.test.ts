import { NextResponse } from 'next/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/auth', () => ({
  requireKnowledgeEntryAdmin: vi.fn(),
}))
vi.mock('../../../../../_lib/knowledge-corpus', () => ({
  splitKnowledgeEntry: vi.fn(),
}))

import { requireKnowledgeEntryAdmin } from '@/lib/auth'
import { splitKnowledgeEntry } from '../../../../../_lib/knowledge-corpus'
import { POST } from './route'

const VENUE_ID = '11111111-1111-4111-8111-111111111111'
const OPERATOR_ID = '22222222-2222-4222-8222-222222222222'
const ENTRY_ID = '33333333-3333-4333-8333-333333333333'
const NEW_ID_1 = '44444444-4444-4444-8444-444444444444'
const NEW_ID_2 = '55555555-5555-4555-8555-555555555555'

function buildRequest(body: unknown): Request {
  return new Request('http://test/admin/venues/api/knowledge/x/split', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  })
}

function buildParams() {
  return { params: Promise.resolve({ entryId: ENTRY_ID }) }
}

const VALID_PIECES = [
  { content: 'piece one', primaryTags: ['menu'], secondaryTags: [] },
  { content: 'piece two', primaryTags: ['menu'], secondaryTags: [] },
]

beforeEach(() => {
  vi.mocked(requireKnowledgeEntryAdmin).mockReset()
  vi.mocked(splitKnowledgeEntry).mockReset()
})

describe('POST /admin/venues/api/knowledge/[entryId]/split', () => {
  beforeEach(() => {
    vi.mocked(requireKnowledgeEntryAdmin).mockResolvedValue({
      ok: true,
      operatorId: OPERATOR_ID,
      venueId: VENUE_ID,
      entryId: ENTRY_ID,
    })
  })

  it('200 + newIds on happy path, venueId resolved from auth not the client', async () => {
    vi.mocked(splitKnowledgeEntry).mockResolvedValue({
      ok: true,
      newIds: [NEW_ID_1, NEW_ID_2],
    })
    const res = await POST(buildRequest({ pieces: VALID_PIECES }), buildParams())
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json).toMatchObject({ success: true, newIds: [NEW_ID_1, NEW_ID_2] })
    expect(splitKnowledgeEntry).toHaveBeenCalledWith({
      originalId: ENTRY_ID,
      venueId: VENUE_ID,
      pieces: VALID_PIECES,
    })
  })

  it('400 on fewer than 2 pieces', async () => {
    const res = await POST(
      buildRequest({ pieces: [{ content: 'only one', primaryTags: ['other'], secondaryTags: [] }] }),
      buildParams(),
    )
    expect(res.status).toBe(400)
    expect(splitKnowledgeEntry).not.toHaveBeenCalled()
  })

  it('400 on a non-canonical primary tag in a piece', async () => {
    const res = await POST(
      buildRequest({
        pieces: [
          { content: 'a', primaryTags: ['personality'], secondaryTags: [] },
          { content: 'b', primaryTags: ['menu'], secondaryTags: [] },
        ],
      }),
      buildParams(),
    )
    expect(res.status).toBe(400)
    expect(splitKnowledgeEntry).not.toHaveBeenCalled()
  })

  it('502 when a piece fails to embed', async () => {
    vi.mocked(splitKnowledgeEntry).mockResolvedValue({
      ok: false,
      error: 'voyage 502',
      errorCode: 'embed_failed',
    })
    const res = await POST(buildRequest({ pieces: VALID_PIECES }), buildParams())
    expect(res.status).toBe(502)
  })

  it('passes through 404 from auth helper', async () => {
    vi.mocked(requireKnowledgeEntryAdmin).mockResolvedValue({
      ok: false,
      response: NextResponse.json({ error: 'knowledge entry not found' }, { status: 404 }),
    })
    const res = await POST(buildRequest({ pieces: VALID_PIECES }), buildParams())
    expect(res.status).toBe(404)
    expect(splitKnowledgeEntry).not.toHaveBeenCalled()
  })
})
