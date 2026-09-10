import { NextResponse } from 'next/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/auth', () => ({
  requireKnowledgeEntriesAdmin: vi.fn(),
}))
vi.mock('../../../../_lib/knowledge-corpus', () => ({
  mergeKnowledgeEntries: vi.fn(),
}))

import { requireKnowledgeEntriesAdmin } from '@/lib/auth'
import { mergeKnowledgeEntries } from '../../../../_lib/knowledge-corpus'
import { POST } from './route'

const VENUE_ID = '11111111-1111-4111-8111-111111111111'
const OPERATOR_ID = '22222222-2222-4222-8222-222222222222'
const SOURCE_1 = '33333333-3333-4333-8333-333333333333'
const SOURCE_2 = '44444444-4444-4444-8444-444444444444'
const NEW_ID = '55555555-5555-4555-8555-555555555555'

function buildRequest(body: unknown): Request {
  return new Request('http://test/admin/venues/api/knowledge/merge', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  })
}

beforeEach(() => {
  vi.mocked(requireKnowledgeEntriesAdmin).mockReset()
  vi.mocked(mergeKnowledgeEntries).mockReset()
})

describe('POST /admin/venues/api/knowledge/merge', () => {
  beforeEach(() => {
    vi.mocked(requireKnowledgeEntriesAdmin).mockResolvedValue({
      ok: true,
      operatorId: OPERATOR_ID,
      venueId: VENUE_ID,
      entryIds: [SOURCE_1, SOURCE_2],
    })
  })

  it('200 + newId on happy path, venueId + entryIds resolved from auth not trusted from the client', async () => {
    vi.mocked(mergeKnowledgeEntries).mockResolvedValue({ ok: true, newId: NEW_ID })
    const res = await POST(
      buildRequest({
        originalIds: [SOURCE_1, SOURCE_2],
        content: 'merged content',
        primaryTags: ['menu'],
        secondaryTags: [],
      }),
    )
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json).toMatchObject({ success: true, newId: NEW_ID })
    expect(mergeKnowledgeEntries).toHaveBeenCalledWith({
      originalIds: [SOURCE_1, SOURCE_2],
      venueId: VENUE_ID,
      content: 'merged content',
      primaryTags: ['menu'],
      secondaryTags: [],
    })
    expect(requireKnowledgeEntriesAdmin).toHaveBeenCalledWith([SOURCE_1, SOURCE_2])
  })

  it('400 on fewer than 2 originalIds — auth helper never called', async () => {
    const res = await POST(
      buildRequest({
        originalIds: [SOURCE_1],
        content: 'merged',
        primaryTags: ['menu'],
        secondaryTags: [],
      }),
    )
    expect(res.status).toBe(400)
    expect(requireKnowledgeEntriesAdmin).not.toHaveBeenCalled()
    expect(mergeKnowledgeEntries).not.toHaveBeenCalled()
  })

  it('400 on a non-canonical primary tag', async () => {
    const res = await POST(
      buildRequest({
        originalIds: [SOURCE_1, SOURCE_2],
        content: 'merged',
        primaryTags: ['personality'],
        secondaryTags: [],
      }),
    )
    expect(res.status).toBe(400)
    expect(mergeKnowledgeEntries).not.toHaveBeenCalled()
  })

  it('502 when embedding the merged row fails', async () => {
    vi.mocked(mergeKnowledgeEntries).mockResolvedValue({
      ok: false,
      error: 'voyage 502',
      errorCode: 'embed_failed',
    })
    const res = await POST(
      buildRequest({
        originalIds: [SOURCE_1, SOURCE_2],
        content: 'merged',
        primaryTags: ['menu'],
        secondaryTags: [],
      }),
    )
    expect(res.status).toBe(502)
  })

  it('passes through 400 from auth helper when entries span more than one venue', async () => {
    vi.mocked(requireKnowledgeEntriesAdmin).mockResolvedValue({
      ok: false,
      response: NextResponse.json({ error: 'entries span more than one venue' }, { status: 400 }),
    })
    const res = await POST(
      buildRequest({
        originalIds: [SOURCE_1, SOURCE_2],
        content: 'merged',
        primaryTags: ['menu'],
        secondaryTags: [],
      }),
    )
    expect(res.status).toBe(400)
    expect(mergeKnowledgeEntries).not.toHaveBeenCalled()
  })
})
