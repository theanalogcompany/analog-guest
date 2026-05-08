import { NextResponse } from 'next/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/auth', () => ({
  requireVenueAdmin: vi.fn(),
}))
vi.mock('@/lib/voice-training', () => ({
  addCorpusEntry: vi.fn(),
  ADD_CORPUS_SOURCE_TYPES: ['manual_entry', 'sample_text', 'past_message'] as const,
}))

import { requireVenueAdmin } from '@/lib/auth'
import { addCorpusEntry } from '@/lib/voice-training'
import { POST } from './route'

const VENUE_ID = '11111111-1111-4111-8111-111111111111'
const OPERATOR_ID = '22222222-2222-4222-8222-222222222222'
const CORPUS_ID = '44444444-4444-4444-8444-444444444444'

function buildRequest(body: unknown): Request {
  return new Request('http://test/admin/voices/api/venues/x/corpus', {
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
  vi.mocked(addCorpusEntry).mockReset()
})

describe('POST /admin/voices/api/venues/[venueId]/corpus', () => {
  beforeEach(() => {
    vi.mocked(requireVenueAdmin).mockResolvedValue({
      ok: true,
      operatorId: OPERATOR_ID,
      venueId: VENUE_ID,
    })
  })

  it('200 + corpusId on happy path', async () => {
    vi.mocked(addCorpusEntry).mockResolvedValue({
      ok: true,
      corpusId: CORPUS_ID,
      embeddedChunkCount: 1,
    })
    const res = await POST(
      buildRequest({
        content: "yeah. oat's on the bar.",
        sourceType: 'manual_entry',
        tags: ['menu_fact'],
      }),
      buildParams(VENUE_ID),
    )
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json).toMatchObject({ success: true, corpusId: CORPUS_ID })
    expect(addCorpusEntry).toHaveBeenCalledWith({
      venueId: VENUE_ID,
      content: "yeah. oat's on the bar.",
      sourceType: 'manual_entry',
      tags: ['menu_fact'],
      addedByOperatorId: OPERATOR_ID,
    })
  })

  it('502 when embed fails', async () => {
    vi.mocked(addCorpusEntry).mockResolvedValue({
      ok: false,
      error: 'voyage 502',
      errorCode: 'embed_failed',
    })
    const res = await POST(
      buildRequest({ content: 'x', sourceType: 'manual_entry', tags: [] }),
      buildParams(VENUE_ID),
    )
    expect(res.status).toBe(502)
  })

  it('400 on invalid sourceType', async () => {
    const res = await POST(
      buildRequest({ content: 'x', sourceType: 'operator_edit', tags: [] }),
      buildParams(VENUE_ID),
    )
    expect(res.status).toBe(400)
  })

  it('400 on empty content', async () => {
    const res = await POST(
      buildRequest({ content: '', sourceType: 'manual_entry', tags: [] }),
      buildParams(VENUE_ID),
    )
    expect(res.status).toBe(400)
  })
})

describe('POST /admin/voices/api/venues/[venueId]/corpus — auth pass-through', () => {
  it('passes through 401 from auth helper', async () => {
    vi.mocked(requireVenueAdmin).mockResolvedValue({
      ok: false,
      response: NextResponse.json({ error: 'unauthorized' }, { status: 401 }),
    })
    const res = await POST(
      buildRequest({ content: 'x', sourceType: 'manual_entry', tags: [] }),
      buildParams(VENUE_ID),
    )
    expect(res.status).toBe(401)
  })

  it('passes through 403 from auth helper', async () => {
    vi.mocked(requireVenueAdmin).mockResolvedValue({
      ok: false,
      response: NextResponse.json({ error: 'venue not allowed' }, { status: 403 }),
    })
    const res = await POST(
      buildRequest({ content: 'x', sourceType: 'manual_entry', tags: [] }),
      buildParams(VENUE_ID),
    )
    expect(res.status).toBe(403)
  })
})
