// Mock signatures mirror the supabase-js fluent builder; column names +
// filter args we don't inspect inside the test.
/* eslint-disable @typescript-eslint/no-unused-vars */

import { NextResponse } from 'next/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/auth', () => ({
  requireVenueAdmin: vi.fn(),
}))
vi.mock('@/lib/db/admin', () => ({
  createAdminClient: vi.fn(),
}))

import { requireVenueAdmin } from '@/lib/auth'
import { createAdminClient } from '@/lib/db/admin'
import { PATCH } from './route'

const VENUE_ID = '11111111-1111-4111-8111-111111111111'
const OPERATOR_ID = '22222222-2222-4222-8222-222222222222'

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
  vi.mocked(requireVenueAdmin).mockReset()
  vi.mocked(createAdminClient).mockReset()
})

describe('PATCH /admin/voices/api/persona/[venueId] — auth', () => {
  it('returns the auth helper response when auth fails', async () => {
    vi.mocked(requireVenueAdmin).mockResolvedValue({
      ok: false,
      response: NextResponse.json({ error: 'unauthorized' }, { status: 401 }),
    })
    const res = await PATCH(buildRequest({ tone: 'x' }), buildParams(VENUE_ID))
    expect(res.status).toBe(401)
  })
})

describe('PATCH /admin/voices/api/persona/[venueId] — body validation', () => {
  beforeEach(() => {
    vi.mocked(requireVenueAdmin).mockResolvedValue({
      ok: true,
      operatorId: OPERATOR_ID,
      venueId: VENUE_ID,
    })
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
    vi.mocked(requireVenueAdmin).mockResolvedValue({
      ok: true,
      operatorId: OPERATOR_ID,
      venueId: VENUE_ID,
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
