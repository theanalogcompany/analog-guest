/* eslint-disable @typescript-eslint/no-unused-vars */

import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/db/admin', () => ({
  createAdminClient: vi.fn(),
}))
vi.mock('@/lib/rag', () => ({
  ingestCorpusEntry: vi.fn(),
}))

import { createAdminClient } from '@/lib/db/admin'
import { ingestCorpusEntry } from '@/lib/rag'
import { editCorpusEntry } from './edit-corpus-entry'

const CORPUS_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'

interface MockState {
  updateCalls: Array<Record<string, unknown>>
  updateError: { message: string } | null
}

function newState(overrides: Partial<MockState> = {}): MockState {
  return {
    updateCalls: [],
    updateError: null,
    ...overrides,
  }
}

function makeSupabaseMock(state: MockState) {
  return {
    from: (_table: string) => ({
      update: (payload: Record<string, unknown>) => ({
        eq: async (_f: string, _v: unknown) => {
          state.updateCalls.push(payload)
          return { error: state.updateError }
        },
      }),
    }),
  }
}

beforeEach(() => {
  vi.mocked(createAdminClient).mockReset()
  vi.mocked(ingestCorpusEntry).mockReset()
})

describe('editCorpusEntry — content change', () => {
  it('updates content + flags is_processed=false then re-embeds', async () => {
    const state = newState()
    vi.mocked(createAdminClient).mockReturnValue(
      makeSupabaseMock(state) as unknown as ReturnType<typeof createAdminClient>,
    )
    vi.mocked(ingestCorpusEntry).mockResolvedValue({
      ok: true,
      data: { embeddedChunkCount: 2 },
    })

    const result = await editCorpusEntry({
      corpusId: CORPUS_ID,
      content: 'new content',
    })

    expect(result).toEqual({ ok: true, corpusId: CORPUS_ID, reEmbedded: true })
    expect(state.updateCalls[0]).toMatchObject({
      content: 'new content',
      is_processed: false,
    })
    expect(ingestCorpusEntry).toHaveBeenCalledWith(CORPUS_ID)
  })

  it('returns embed_failed when re-embed fails (row stays with stale embeddings + is_processed=false)', async () => {
    const state = newState()
    vi.mocked(createAdminClient).mockReturnValue(
      makeSupabaseMock(state) as unknown as ReturnType<typeof createAdminClient>,
    )
    vi.mocked(ingestCorpusEntry).mockResolvedValue({
      ok: false,
      error: 'voyage 502',
      errorCode: 'voyage_api_error',
    })

    const result = await editCorpusEntry({
      corpusId: CORPUS_ID,
      content: 'x',
    })

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.errorCode).toBe('embed_failed')
  })
})

describe('editCorpusEntry — tags-only change', () => {
  it('updates tags but does NOT re-embed (avoids Voyage spend)', async () => {
    const state = newState()
    vi.mocked(createAdminClient).mockReturnValue(
      makeSupabaseMock(state) as unknown as ReturnType<typeof createAdminClient>,
    )

    const result = await editCorpusEntry({
      corpusId: CORPUS_ID,
      tags: ['menu_fact', 'beverages'],
    })

    expect(result).toEqual({
      ok: true,
      corpusId: CORPUS_ID,
      reEmbedded: false,
    })
    expect(state.updateCalls[0]).toEqual({ tags: ['menu_fact', 'beverages'] })
    expect(state.updateCalls[0]).not.toHaveProperty('is_processed')
    expect(ingestCorpusEntry).not.toHaveBeenCalled()
  })
})

describe('editCorpusEntry — no-op input', () => {
  it('rejects when neither content nor tags is provided', async () => {
    const result = await editCorpusEntry({ corpusId: CORPUS_ID })

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.errorCode).toBe('no_op')
    expect(createAdminClient).not.toHaveBeenCalled()
  })
})

describe('editCorpusEntry — db error', () => {
  it('returns db_error on update failure (no embed call)', async () => {
    const state = newState({ updateError: { message: 'lost connection' } })
    vi.mocked(createAdminClient).mockReturnValue(
      makeSupabaseMock(state) as unknown as ReturnType<typeof createAdminClient>,
    )

    const result = await editCorpusEntry({
      corpusId: CORPUS_ID,
      content: 'x',
    })

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.errorCode).toBe('db_error')
      expect(result.error).toContain('lost connection')
    }
    expect(ingestCorpusEntry).not.toHaveBeenCalled()
  })
})
