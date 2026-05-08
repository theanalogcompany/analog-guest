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

import { AuthError, verifyAnalogAdminAccess } from '@/lib/auth'
import { createAdminClient } from '@/lib/db/admin'
import { createServerClient } from '@/lib/db/server'
import { PATCH } from './route'

const VENUE_ID = '11111111-1111-4111-8111-111111111111'
const OPERATOR_ID = '22222222-2222-4222-8222-222222222222'
const AUTH_USER_ID = '33333333-3333-4333-8333-333333333333'

const validPersona = {
  tone: 'warm and direct',
  formality: 'casual',
  speakerFraming: 'venue',
  emojiPolicy: 'never',
  lengthGuide: 'short — 1-2 sentences',
  signaturePhrases: [],
  bannedTopics: [],
  voiceTouchstones: [],
  voiceAntiPatterns: [],
}

interface AdminMockState {
  persona: Record<string, unknown> | null
  readError: { message: string } | null
  updateCalls: Array<{ payload: Record<string, unknown> }>
  updateError: { message: string } | null
}

function newAdminState(overrides: Partial<AdminMockState> = {}): AdminMockState {
  return {
    persona: { ...validPersona },
    readError: null,
    updateCalls: [],
    updateError: null,
    ...overrides,
  }
}

function makeAdminMock(state: AdminMockState) {
  return {
    from: (_table: string) => ({
      select: (_cols: string) => ({
        eq: (_f: string, _v: unknown) => ({
          single: async () => ({
            data: state.persona ? { brand_persona: state.persona } : null,
            error: state.readError,
          }),
        }),
      }),
      update: (payload: Record<string, unknown>) => ({
        eq: async (_f: string, _v: unknown) => {
          state.updateCalls.push({ payload })
          return { error: state.updateError }
        },
      }),
    }),
  }
}

function makeSessionMock(session: { user: { id: string } } | null) {
  return {
    auth: {
      getSession: async () => ({ data: { session }, error: null }),
    },
  }
}

function buildRequest(body: unknown): Request {
  return new Request('http://test/admin/voices/api/persona/x', {
    method: 'PATCH',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  })
}

function buildParams(venueId: string) {
  return { params: Promise.resolve({ venueId }) }
}

beforeEach(() => {
  vi.mocked(createServerClient).mockReset()
  vi.mocked(createAdminClient).mockReset()
  vi.mocked(verifyAnalogAdminAccess).mockReset()
})

describe('PATCH /admin/voices/api/persona/[venueId] — auth', () => {
  it('401 when no session', async () => {
    vi.mocked(createServerClient).mockResolvedValue(
      makeSessionMock(null) as unknown as Awaited<ReturnType<typeof createServerClient>>,
    )
    const res = await PATCH(buildRequest({ tone: 'x' }), buildParams(VENUE_ID))
    expect(res.status).toBe(401)
  })

  it('403 when operator is not an analog admin', async () => {
    vi.mocked(createServerClient).mockResolvedValue(
      makeSessionMock({ user: { id: AUTH_USER_ID } }) as unknown as Awaited<
        ReturnType<typeof createServerClient>
      >,
    )
    vi.mocked(verifyAnalogAdminAccess).mockRejectedValue(
      new AuthError(403, 'not an analog admin'),
    )
    const res = await PATCH(buildRequest({ tone: 'x' }), buildParams(VENUE_ID))
    expect(res.status).toBe(403)
  })

  it('403 when venue is not in operator allowlist', async () => {
    vi.mocked(createServerClient).mockResolvedValue(
      makeSessionMock({ user: { id: AUTH_USER_ID } }) as unknown as Awaited<
        ReturnType<typeof createServerClient>
      >,
    )
    vi.mocked(verifyAnalogAdminAccess).mockResolvedValue({
      operatorId: OPERATOR_ID,
      allowedVenueIds: ['44444444-4444-4444-8444-444444444444'],
      isAnalogAdmin: true,
    })
    const res = await PATCH(buildRequest({ tone: 'x' }), buildParams(VENUE_ID))
    expect(res.status).toBe(403)
  })
})

describe('PATCH /admin/voices/api/persona/[venueId] — body validation', () => {
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

  it('400 on invalid venueId', async () => {
    const res = await PATCH(buildRequest({ tone: 'x' }), buildParams('not-a-uuid'))
    expect(res.status).toBe(400)
  })

  it('400 on invalid emojiPolicy enum value', async () => {
    const res = await PATCH(
      buildRequest({ emojiPolicy: 'sometimes' }),
      buildParams(VENUE_ID),
    )
    expect(res.status).toBe(400)
  })
})

describe('PATCH /admin/voices/api/persona/[venueId] — happy path', () => {
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

  it('merges partial fields onto existing persona and writes back', async () => {
    const state = newAdminState()
    vi.mocked(createAdminClient).mockReturnValue(
      makeAdminMock(state) as unknown as ReturnType<typeof createAdminClient>,
    )
    const res = await PATCH(
      buildRequest({ voiceName: 'Sana', formality: 'formal' }),
      buildParams(VENUE_ID),
    )
    expect(res.status).toBe(200)
    expect(state.updateCalls).toHaveLength(1)
    const persona = state.updateCalls[0].payload.brand_persona as Record<string, unknown>
    expect(persona.voiceName).toBe('Sana')
    expect(persona.formality).toBe('formal')
    // Untouched fields preserved.
    expect(persona.tone).toBe('warm and direct')
  })

  it('migrates legacy string anti-patterns to struct on the same write', async () => {
    const state = newAdminState({
      persona: { ...validPersona, voiceAntiPatterns: ['legacy entry'] },
    })
    vi.mocked(createAdminClient).mockReturnValue(
      makeAdminMock(state) as unknown as ReturnType<typeof createAdminClient>,
    )
    const res = await PATCH(buildRequest({ tone: 'updated tone' }), buildParams(VENUE_ID))
    expect(res.status).toBe(200)
    const persona = state.updateCalls[0].payload.brand_persona as {
      voiceAntiPatterns: Array<Record<string, unknown>>
    }
    expect(persona.voiceAntiPatterns[0]).toEqual({
      text: 'legacy entry',
      source: 'manual',
    })
  })
})
