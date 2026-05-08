/* eslint-disable @typescript-eslint/no-unused-vars */

import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/db/admin', () => ({
  createAdminClient: vi.fn(),
}))

import { createAdminClient } from '@/lib/db/admin'
import { removeAntiPattern } from './remove-anti-pattern'

const VENUE_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'

function makePersonaWithAntiPatterns(antiPatterns: unknown[]) {
  return {
    tone: 'warm and direct',
    formality: 'casual',
    speakerFraming: 'venue',
    emojiPolicy: 'never',
    lengthGuide: 'short — 1-2 sentences',
    signaturePhrases: [],
    bannedTopics: [],
    voiceTouchstones: [],
    voiceAntiPatterns: antiPatterns,
  }
}

interface MockState {
  persona: ReturnType<typeof makePersonaWithAntiPatterns>
  updateCalls: Array<{ payload: Record<string, unknown> }>
  selectError: { message: string } | null
  updateError: { message: string } | null
}

function newState(overrides: Partial<MockState> = {}): MockState {
  return {
    persona: makePersonaWithAntiPatterns([]),
    updateCalls: [],
    selectError: null,
    updateError: null,
    ...overrides,
  }
}

function makeSupabaseMock(state: MockState) {
  return {
    from: (_table: string) => ({
      select: (_cols: string) => ({
        eq: (_f: string, _v: unknown) => ({
          single: async () => ({
            data: state.selectError ? null : { brand_persona: state.persona },
            error: state.selectError,
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

beforeEach(() => {
  vi.mocked(createAdminClient).mockReset()
})

describe('removeAntiPattern — exact text match', () => {
  it('removes a struct entry whose text matches exactly', async () => {
    const state = newState({
      persona: makePersonaWithAntiPatterns([
        { text: 'no marketing flourishes', source: 'manual' },
        { text: 'no closing acknowledgments', source: 'auto' },
      ]),
    })
    vi.mocked(createAdminClient).mockReturnValue(
      makeSupabaseMock(state) as unknown as ReturnType<typeof createAdminClient>,
    )

    const result = await removeAntiPattern(VENUE_ID, 'no marketing flourishes')

    expect(result).toEqual({ ok: true, removed: true, remainingCount: 1 })
    const written = state.updateCalls[0].payload.brand_persona as {
      voiceAntiPatterns: Array<{ text: string }>
    }
    expect(written.voiceAntiPatterns).toHaveLength(1)
    expect(written.voiceAntiPatterns[0].text).toBe('no closing acknowledgments')
  })

  it('removes a legacy string entry by displayed text (post-normalization match)', async () => {
    const state = newState({
      persona: makePersonaWithAntiPatterns(['legacy entry']),
    })
    vi.mocked(createAdminClient).mockReturnValue(
      makeSupabaseMock(state) as unknown as ReturnType<typeof createAdminClient>,
    )

    const result = await removeAntiPattern(VENUE_ID, 'legacy entry')

    expect(result.ok).toBe(true)
    if (result.ok) expect(result.remainingCount).toBe(0)
  })
})

describe('removeAntiPattern — non-matches return not_found', () => {
  it('returns not_found when no entry matches the text', async () => {
    const state = newState({
      persona: makePersonaWithAntiPatterns([
        { text: 'no marketing flourishes', source: 'manual' },
      ]),
    })
    vi.mocked(createAdminClient).mockReturnValue(
      makeSupabaseMock(state) as unknown as ReturnType<typeof createAdminClient>,
    )

    const result = await removeAntiPattern(VENUE_ID, 'something else')

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.errorCode).toBe('not_found')
    expect(state.updateCalls).toEqual([])
  })

  it('returns not_found on case-different match (exact match required)', async () => {
    const state = newState({
      persona: makePersonaWithAntiPatterns([
        { text: 'no marketing flourishes', source: 'manual' },
      ]),
    })
    vi.mocked(createAdminClient).mockReturnValue(
      makeSupabaseMock(state) as unknown as ReturnType<typeof createAdminClient>,
    )

    const result = await removeAntiPattern(VENUE_ID, 'No Marketing Flourishes')

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.errorCode).toBe('not_found')
  })
})

describe('removeAntiPattern — db error paths', () => {
  it('returns db_error on lookup failure', async () => {
    const state = newState({ selectError: { message: 'lookup failed' } })
    vi.mocked(createAdminClient).mockReturnValue(
      makeSupabaseMock(state) as unknown as ReturnType<typeof createAdminClient>,
    )

    const result = await removeAntiPattern(VENUE_ID, 'x')

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.errorCode).toBe('db_error')
  })

  it('returns db_error on update failure', async () => {
    const state = newState({
      persona: makePersonaWithAntiPatterns([
        { text: 'remove me', source: 'manual' },
      ]),
      updateError: { message: 'write failed' },
    })
    vi.mocked(createAdminClient).mockReturnValue(
      makeSupabaseMock(state) as unknown as ReturnType<typeof createAdminClient>,
    )

    const result = await removeAntiPattern(VENUE_ID, 'remove me')

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.errorCode).toBe('db_error')
  })
})
