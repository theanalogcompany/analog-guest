/* eslint-disable @typescript-eslint/no-unused-vars */

import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/db/server', () => ({
  createServerClient: vi.fn(),
}))
vi.mock('@/lib/auth', async () => {
  const actual =
    await vi.importActual<typeof import('@/lib/auth')>('@/lib/auth')
  return { ...actual, verifyAnalogAdminAccess: vi.fn() }
})
// Don't use importActual here — `@/lib/voice-training` transitively loads the
// Voyage SDK at module init, which trips ERR_UNSUPPORTED_DIR_IMPORT under
// vitest's ESM resolution. List exactly the surface the route imports.
vi.mock('@/lib/voice-training', () => ({
  addCorpusEntry: vi.fn(),
  ADD_CORPUS_SOURCE_TYPES: ['manual_entry', 'sample_text', 'past_message'] as const,
}))

import { AuthError, verifyAnalogAdminAccess } from '@/lib/auth'
import { createServerClient } from '@/lib/db/server'
import { addCorpusEntry } from '@/lib/voice-training'
import { POST } from './route'

const VENUE_ID = '11111111-1111-4111-8111-111111111111'
const OPERATOR_ID = '22222222-2222-4222-8222-222222222222'
const AUTH_USER_ID = '33333333-3333-4333-8333-333333333333'
const CORPUS_ID = '44444444-4444-4444-8444-444444444444'

function makeSessionMock(session: { user: { id: string } } | null) {
  return {
    auth: {
      getSession: async () => ({ data: { session }, error: null }),
    },
  }
}

function buildRequest(body: unknown): Request {
  return new Request('http://test/admin/voices/api/corpus/x', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  })
}

function buildParams(venueId: string) {
  return { params: Promise.resolve({ venueId }) }
}

beforeEach(() => {
  vi.mocked(createServerClient).mockReset()
  vi.mocked(verifyAnalogAdminAccess).mockReset()
  vi.mocked(addCorpusEntry).mockReset()
})

describe('POST /admin/voices/api/corpus/[venueId]', () => {
  beforeEach(() => {
    vi.mocked(createServerClient).mockResolvedValue(
      makeSessionMock({ user: { id: AUTH_USER_ID } }) as unknown as Awaited<
        ReturnType<typeof createServerClient>
      >,
    )
    vi.mocked(verifyAnalogAdminAccess).mockResolvedValue({
      operatorId: OPERATOR_ID,
      allowedVenueIds: [],
      isAnalogAdmin: true,
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

  it('401 when no session', async () => {
    vi.mocked(createServerClient).mockResolvedValue(
      makeSessionMock(null) as unknown as Awaited<ReturnType<typeof createServerClient>>,
    )
    const res = await POST(
      buildRequest({ content: 'x', sourceType: 'manual_entry', tags: [] }),
      buildParams(VENUE_ID),
    )
    expect(res.status).toBe(401)
  })

  it('403 when venue is not in allowlist', async () => {
    vi.mocked(verifyAnalogAdminAccess).mockResolvedValue({
      operatorId: OPERATOR_ID,
      allowedVenueIds: ['55555555-5555-4555-8555-555555555555'],
      isAnalogAdmin: true,
    })
    const res = await POST(
      buildRequest({ content: 'x', sourceType: 'manual_entry', tags: [] }),
      buildParams(VENUE_ID),
    )
    expect(res.status).toBe(403)
  })
})
