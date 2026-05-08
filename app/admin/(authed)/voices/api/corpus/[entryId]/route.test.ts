import { NextResponse } from 'next/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/auth', () => ({
  requireCorpusEntryAdmin: vi.fn(),
}))
vi.mock('@/lib/voice-training', () => ({
  editCorpusEntry: vi.fn(),
  removeCorpusEntry: vi.fn(),
}))

import { requireCorpusEntryAdmin } from '@/lib/auth'
import { editCorpusEntry, removeCorpusEntry } from '@/lib/voice-training'
import { DELETE, PATCH } from './route'

const ENTRY_ID = '11111111-1111-4111-8111-111111111111'
const VENUE_ID = '22222222-2222-4222-8222-222222222222'
const OPERATOR_ID = '44444444-4444-4444-8444-444444444444'

function buildRequest(method: 'PATCH' | 'DELETE', body: unknown): Request {
  return new Request('http://test/admin/voices/api/corpus/x', {
    method,
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  })
}

function buildParams(entryId: string) {
  return { params: Promise.resolve({ entryId }) }
}

beforeEach(() => {
  vi.mocked(requireCorpusEntryAdmin).mockReset()
  vi.mocked(editCorpusEntry).mockReset()
  vi.mocked(removeCorpusEntry).mockReset()
  vi.mocked(requireCorpusEntryAdmin).mockResolvedValue({
    ok: true,
    operatorId: OPERATOR_ID,
    venueId: VENUE_ID,
    entryId: ENTRY_ID,
  })
})

describe('PATCH /admin/voices/api/corpus/[entryId]', () => {
  it('200 + reEmbedded:true on content change', async () => {
    vi.mocked(editCorpusEntry).mockResolvedValue({
      ok: true,
      corpusId: ENTRY_ID,
      reEmbedded: true,
    })
    const res = await PATCH(
      buildRequest('PATCH', { content: 'updated' }),
      buildParams(ENTRY_ID),
    )
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json).toMatchObject({ success: true, reEmbedded: true })
  })

  it('200 + reEmbedded:false on tags-only change', async () => {
    vi.mocked(editCorpusEntry).mockResolvedValue({
      ok: true,
      corpusId: ENTRY_ID,
      reEmbedded: false,
    })
    const res = await PATCH(
      buildRequest('PATCH', { tags: ['x'] }),
      buildParams(ENTRY_ID),
    )
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.reEmbedded).toBe(false)
  })

  it('502 on embed failure', async () => {
    vi.mocked(editCorpusEntry).mockResolvedValue({
      ok: false,
      error: 'voyage 502',
      errorCode: 'embed_failed',
    })
    const res = await PATCH(
      buildRequest('PATCH', { content: 'x' }),
      buildParams(ENTRY_ID),
    )
    expect(res.status).toBe(502)
  })

  it('400 on empty body (neither content nor tags)', async () => {
    const res = await PATCH(buildRequest('PATCH', {}), buildParams(ENTRY_ID))
    expect(res.status).toBe(400)
  })

  it('passes through 404 from auth helper when entry not found', async () => {
    vi.mocked(requireCorpusEntryAdmin).mockResolvedValue({
      ok: false,
      response: NextResponse.json({ error: 'corpus entry not found' }, { status: 404 }),
    })
    const res = await PATCH(
      buildRequest('PATCH', { content: 'x' }),
      buildParams(ENTRY_ID),
    )
    expect(res.status).toBe(404)
  })

  it('passes through 403 from auth helper when entry venue is out of scope', async () => {
    vi.mocked(requireCorpusEntryAdmin).mockResolvedValue({
      ok: false,
      response: NextResponse.json({ error: 'venue not allowed' }, { status: 403 }),
    })
    const res = await PATCH(
      buildRequest('PATCH', { content: 'x' }),
      buildParams(ENTRY_ID),
    )
    expect(res.status).toBe(403)
  })
})

describe('DELETE /admin/voices/api/corpus/[entryId]', () => {
  it('200 + deleted:true on happy path', async () => {
    vi.mocked(removeCorpusEntry).mockResolvedValue({
      ok: true,
      corpusId: ENTRY_ID,
    })
    const res = await DELETE(
      buildRequest('DELETE', {}),
      buildParams(ENTRY_ID),
    )
    expect(res.status).toBe(200)
  })

  it('404 when removal target was already gone', async () => {
    vi.mocked(removeCorpusEntry).mockResolvedValue({
      ok: false,
      error: 'not found',
      errorCode: 'not_found',
    })
    const res = await DELETE(
      buildRequest('DELETE', {}),
      buildParams(ENTRY_ID),
    )
    expect(res.status).toBe(404)
  })
})
