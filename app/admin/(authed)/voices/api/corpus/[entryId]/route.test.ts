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
vi.mock('@/lib/db/admin', () => ({
  createAdminClient: vi.fn(),
}))
// Don't use importActual here — `@/lib/voice-training` transitively loads the
// Voyage SDK at module init, which trips ERR_UNSUPPORTED_DIR_IMPORT under
// vitest's ESM resolution.
vi.mock('@/lib/voice-training', () => ({
  editCorpusEntry: vi.fn(),
  removeCorpusEntry: vi.fn(),
}))

import { AuthError, verifyAnalogAdminAccess } from '@/lib/auth'
import { createAdminClient } from '@/lib/db/admin'
import { createServerClient } from '@/lib/db/server'
import { editCorpusEntry, removeCorpusEntry } from '@/lib/voice-training'
import { DELETE, PATCH } from './route'

const ENTRY_ID = '11111111-1111-4111-8111-111111111111'
const VENUE_ID = '22222222-2222-4222-8222-222222222222'
const OTHER_VENUE_ID = '33333333-3333-4333-8333-333333333333'
const OPERATOR_ID = '44444444-4444-4444-8444-444444444444'

function makeSessionMock(session: { user: { id: string } } | null) {
  return {
    auth: {
      getSession: async () => ({ data: { session }, error: null }),
    },
  }
}

function makeAdminMock(row: { id: string; venue_id: string } | null) {
  return {
    from: (_table: string) => ({
      select: (_cols: string) => ({
        eq: (_f: string, _v: unknown) => ({
          maybeSingle: async () => ({ data: row, error: null }),
        }),
      }),
    }),
  }
}

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
  vi.mocked(createServerClient).mockReset()
  vi.mocked(verifyAnalogAdminAccess).mockReset()
  vi.mocked(createAdminClient).mockReset()
  vi.mocked(editCorpusEntry).mockReset()
  vi.mocked(removeCorpusEntry).mockReset()
  vi.mocked(createServerClient).mockResolvedValue(
    makeSessionMock({ user: { id: 'auth' } }) as unknown as Awaited<
      ReturnType<typeof createServerClient>
    >,
  )
  vi.mocked(verifyAnalogAdminAccess).mockResolvedValue({
    operatorId: OPERATOR_ID,
    allowedVenueIds: [],
    isAnalogAdmin: true,
  })
  vi.mocked(createAdminClient).mockReturnValue(
    makeAdminMock({ id: ENTRY_ID, venue_id: VENUE_ID }) as unknown as ReturnType<
      typeof createAdminClient
    >,
  )
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

  it('404 when corpus entry does not exist', async () => {
    vi.mocked(createAdminClient).mockReturnValue(
      makeAdminMock(null) as unknown as ReturnType<typeof createAdminClient>,
    )
    const res = await PATCH(
      buildRequest('PATCH', { content: 'x' }),
      buildParams(ENTRY_ID),
    )
    expect(res.status).toBe(404)
  })

  it('403 when entry belongs to a different venue than allowlist permits', async () => {
    vi.mocked(verifyAnalogAdminAccess).mockResolvedValue({
      operatorId: OPERATOR_ID,
      allowedVenueIds: [OTHER_VENUE_ID],
      isAnalogAdmin: true,
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
