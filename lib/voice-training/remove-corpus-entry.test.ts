/* eslint-disable @typescript-eslint/no-unused-vars */

import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/db/admin', () => ({
  createAdminClient: vi.fn(),
}))

import { createAdminClient } from '@/lib/db/admin'
import { removeCorpusEntry } from './remove-corpus-entry'

const CORPUS_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'

interface MockState {
  deletedRow: { id: string } | null
  deleteError: { message: string } | null
  deleteCalls: string[]
}

function newState(overrides: Partial<MockState> = {}): MockState {
  return {
    deletedRow: { id: CORPUS_ID },
    deleteError: null,
    deleteCalls: [],
    ...overrides,
  }
}

function makeSupabaseMock(state: MockState) {
  return {
    from: (_table: string) => ({
      delete: () => ({
        eq: (_f: string, v: unknown) => ({
          select: (_cols: string) => ({
            maybeSingle: async () => {
              state.deleteCalls.push(String(v))
              return { data: state.deletedRow, error: state.deleteError }
            },
          }),
        }),
      }),
    }),
  }
}

beforeEach(() => {
  vi.mocked(createAdminClient).mockReset()
})

describe('removeCorpusEntry', () => {
  it('returns ok with corpusId on successful delete', async () => {
    const state = newState()
    vi.mocked(createAdminClient).mockReturnValue(
      makeSupabaseMock(state) as unknown as ReturnType<typeof createAdminClient>,
    )

    const result = await removeCorpusEntry(CORPUS_ID)

    expect(result).toEqual({ ok: true, corpusId: CORPUS_ID })
    expect(state.deleteCalls).toEqual([CORPUS_ID])
  })

  it('returns not_found when no row matched', async () => {
    const state = newState({ deletedRow: null })
    vi.mocked(createAdminClient).mockReturnValue(
      makeSupabaseMock(state) as unknown as ReturnType<typeof createAdminClient>,
    )

    const result = await removeCorpusEntry(CORPUS_ID)

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.errorCode).toBe('not_found')
  })

  it('returns db_error on supabase failure', async () => {
    const state = newState({ deleteError: { message: 'connection lost' } })
    vi.mocked(createAdminClient).mockReturnValue(
      makeSupabaseMock(state) as unknown as ReturnType<typeof createAdminClient>,
    )

    const result = await removeCorpusEntry(CORPUS_ID)

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.errorCode).toBe('db_error')
      expect(result.error).toContain('connection lost')
    }
  })
})
