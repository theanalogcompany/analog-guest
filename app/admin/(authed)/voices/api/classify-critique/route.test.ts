import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/db/server', () => ({
  createServerClient: vi.fn(),
}))
vi.mock('@/lib/auth', async () => {
  const actual =
    await vi.importActual<typeof import('@/lib/auth')>('@/lib/auth')
  return { ...actual, verifyAnalogAdminAccess: vi.fn() }
})
vi.mock('@/lib/voices', () => ({
  classifyCritique: vi.fn(),
}))

import { AuthError, verifyAnalogAdminAccess } from '@/lib/auth'
import { createServerClient } from '@/lib/db/server'
import { classifyCritique } from '@/lib/voices'
import { POST } from './route'

const AUTH_USER_ID = '11111111-1111-4111-8111-111111111111'
const OP_ID = '22222222-2222-4222-8222-222222222222'

function makeSessionMock(session: { user: { id: string } } | null) {
  return {
    auth: {
      getSession: async () => ({ data: { session }, error: null }),
    },
  }
}

function buildRequest(body: unknown): Request {
  return new Request('http://test/admin/voices/api/classify-critique', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  })
}

beforeEach(() => {
  vi.mocked(createServerClient).mockReset()
  vi.mocked(verifyAnalogAdminAccess).mockReset()
  vi.mocked(classifyCritique).mockReset()
})

describe('POST /admin/voices/api/classify-critique', () => {
  beforeEach(() => {
    vi.mocked(createServerClient).mockResolvedValue(
      makeSessionMock({ user: { id: AUTH_USER_ID } }) as unknown as Awaited<
        ReturnType<typeof createServerClient>
      >,
    )
    vi.mocked(verifyAnalogAdminAccess).mockResolvedValue({
      operatorId: OP_ID,
      allowedVenueIds: [],
      isAnalogAdmin: true,
    })
  })

  it('returns kind + ruleText on edit_and_rule', async () => {
    vi.mocked(classifyCritique).mockResolvedValue({
      ok: true,
      data: {
        kind: 'edit_and_rule',
        ruleText: 'no marketing flourishes',
        reasoning: 'r',
      },
    })

    const res = await POST(
      buildRequest({
        critique: 'too eager',
        badResponse: 'Hi!',
        goodResponse: 'morning',
      }),
    )
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.kind).toBe('edit_and_rule')
    expect(json.ruleText).toBe('no marketing flourishes')
  })

  it('returns kind only on edit_only', async () => {
    vi.mocked(classifyCritique).mockResolvedValue({
      ok: true,
      data: { kind: 'edit_only', reasoning: 'one-shot' },
    })

    const res = await POST(
      buildRequest({
        critique: 'wrong perk',
        badResponse: 'iced is on',
        goodResponse: 'no iced today',
      }),
    )
    const json = await res.json()
    expect(json.kind).toBe('edit_only')
    expect(json.ruleText).toBeUndefined()
  })

  it('502 when classifier throws', async () => {
    vi.mocked(classifyCritique).mockResolvedValue({
      ok: false,
      error: 'schema mismatch',
    })

    const res = await POST(
      buildRequest({
        critique: 'x',
        badResponse: 'y',
        goodResponse: 'z',
      }),
    )
    expect(res.status).toBe(502)
  })

  it('401 without session', async () => {
    vi.mocked(createServerClient).mockResolvedValue(
      makeSessionMock(null) as unknown as Awaited<
        ReturnType<typeof createServerClient>
      >,
    )

    const res = await POST(
      buildRequest({
        critique: 'x',
        badResponse: 'y',
        goodResponse: 'z',
      }),
    )
    expect(res.status).toBe(401)
  })

  it('403 when not an analog admin', async () => {
    vi.mocked(verifyAnalogAdminAccess).mockRejectedValue(
      new AuthError(403, 'not an analog admin'),
    )

    const res = await POST(
      buildRequest({
        critique: 'x',
        badResponse: 'y',
        goodResponse: 'z',
      }),
    )
    expect(res.status).toBe(403)
  })
})
