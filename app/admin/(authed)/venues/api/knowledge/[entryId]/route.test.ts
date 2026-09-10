import { NextResponse } from 'next/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/auth', () => ({
  requireKnowledgeEntryAdmin: vi.fn(),
}))
vi.mock('../../../../_lib/knowledge-corpus', () => ({
  editKnowledgeEntry: vi.fn(),
  removeKnowledgeEntry: vi.fn(),
}))

import { requireKnowledgeEntryAdmin } from '@/lib/auth'
import { editKnowledgeEntry, removeKnowledgeEntry } from '../../../../_lib/knowledge-corpus'
import { DELETE, PATCH } from './route'

const VENUE_ID = '11111111-1111-4111-8111-111111111111'
const OPERATOR_ID = '22222222-2222-4222-8222-222222222222'
const ENTRY_ID = '33333333-3333-4333-8333-333333333333'

function buildRequest(body?: unknown): Request {
  return new Request('http://test/admin/venues/api/knowledge/x', {
    method: body === undefined ? 'DELETE' : 'PATCH',
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    headers: { 'content-type': 'application/json' },
  })
}

function buildParams() {
  return { params: Promise.resolve({ entryId: ENTRY_ID }) }
}

beforeEach(() => {
  vi.mocked(requireKnowledgeEntryAdmin).mockReset()
  vi.mocked(editKnowledgeEntry).mockReset()
  vi.mocked(removeKnowledgeEntry).mockReset()
})

describe('PATCH /admin/venues/api/knowledge/[entryId]', () => {
  beforeEach(() => {
    vi.mocked(requireKnowledgeEntryAdmin).mockResolvedValue({
      ok: true,
      operatorId: OPERATOR_ID,
      venueId: VENUE_ID,
      entryId: ENTRY_ID,
    })
  })

  it('200 on a content edit, and re-embeds — this is the is_processed=false fix path', async () => {
    vi.mocked(editKnowledgeEntry).mockResolvedValue({
      ok: true,
      corpusId: ENTRY_ID,
      reEmbedded: true,
    })
    const res = await PATCH(buildRequest({ content: 'updated' }), buildParams())
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json).toMatchObject({ success: true, reEmbedded: true })
    expect(editKnowledgeEntry).toHaveBeenCalledWith({
      corpusId: ENTRY_ID,
      content: 'updated',
      primaryTags: undefined,
      secondaryTags: undefined,
    })
  })

  it('200 + reEmbedded:false on a tags-only edit', async () => {
    vi.mocked(editKnowledgeEntry).mockResolvedValue({
      ok: true,
      corpusId: ENTRY_ID,
      reEmbedded: false,
    })
    const res = await PATCH(buildRequest({ primaryTags: ['events'] }), buildParams())
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json).toMatchObject({ success: true, reEmbedded: false })
  })

  it('400 when neither content nor tags are passed', async () => {
    const res = await PATCH(buildRequest({}), buildParams())
    expect(res.status).toBe(400)
    expect(editKnowledgeEntry).not.toHaveBeenCalled()
  })

  it('400 on a non-canonical primary tag', async () => {
    const res = await PATCH(buildRequest({ primaryTags: ['personality'] }), buildParams())
    expect(res.status).toBe(400)
    expect(editKnowledgeEntry).not.toHaveBeenCalled()
  })

  it('502 when re-embed fails', async () => {
    vi.mocked(editKnowledgeEntry).mockResolvedValue({
      ok: false,
      error: 'voyage 502',
      errorCode: 'embed_failed',
    })
    const res = await PATCH(buildRequest({ content: 'x' }), buildParams())
    expect(res.status).toBe(502)
  })

  it('passes through 404 from auth helper', async () => {
    vi.mocked(requireKnowledgeEntryAdmin).mockResolvedValue({
      ok: false,
      response: NextResponse.json({ error: 'knowledge entry not found' }, { status: 404 }),
    })
    const res = await PATCH(buildRequest({ content: 'x' }), buildParams())
    expect(res.status).toBe(404)
    expect(editKnowledgeEntry).not.toHaveBeenCalled()
  })
})

describe('DELETE /admin/venues/api/knowledge/[entryId]', () => {
  beforeEach(() => {
    vi.mocked(requireKnowledgeEntryAdmin).mockResolvedValue({
      ok: true,
      operatorId: OPERATOR_ID,
      venueId: VENUE_ID,
      entryId: ENTRY_ID,
    })
  })

  it('200 on successful delete', async () => {
    vi.mocked(removeKnowledgeEntry).mockResolvedValue({ ok: true, corpusId: ENTRY_ID })
    const res = await DELETE(buildRequest(), buildParams())
    expect(res.status).toBe(200)
    expect(removeKnowledgeEntry).toHaveBeenCalledWith(ENTRY_ID)
  })

  it('404 when the row is already gone', async () => {
    vi.mocked(removeKnowledgeEntry).mockResolvedValue({
      ok: false,
      error: 'not found',
      errorCode: 'not_found',
    })
    const res = await DELETE(buildRequest(), buildParams())
    expect(res.status).toBe(404)
  })

  it('passes through 403 from auth helper', async () => {
    vi.mocked(requireKnowledgeEntryAdmin).mockResolvedValue({
      ok: false,
      response: NextResponse.json({ error: 'venue not allowed' }, { status: 403 }),
    })
    const res = await DELETE(buildRequest(), buildParams())
    expect(res.status).toBe(403)
    expect(removeKnowledgeEntry).not.toHaveBeenCalled()
  })
})
