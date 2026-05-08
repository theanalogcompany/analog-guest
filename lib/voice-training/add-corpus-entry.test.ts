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
import { addCorpusEntry } from './add-corpus-entry'

const VENUE_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const OPERATOR_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const NEW_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'

interface MockState {
  insertedRow: { id: string } | null
  insertError: { message: string } | null
  insertCalls: Array<Record<string, unknown>>
  deleteCalls: string[]
  deleteError: { message: string } | null
}

function newState(overrides: Partial<MockState> = {}): MockState {
  return {
    insertedRow: { id: NEW_ID },
    insertError: null,
    insertCalls: [],
    deleteCalls: [],
    deleteError: null,
    ...overrides,
  }
}

function makeSupabaseMock(state: MockState) {
  return {
    from: (_table: string) => ({
      insert: (row: Record<string, unknown>) => ({
        select: (_cols: string) => ({
          single: async () => {
            state.insertCalls.push(row)
            if (state.insertError) {
              return { data: null, error: state.insertError }
            }
            return { data: state.insertedRow, error: null }
          },
        }),
      }),
      delete: () => ({
        eq: async (_f: string, v: unknown) => {
          state.deleteCalls.push(String(v))
          return { error: state.deleteError }
        },
      }),
    }),
  }
}

beforeEach(() => {
  vi.mocked(createAdminClient).mockReset()
  vi.mocked(ingestCorpusEntry).mockReset()
})

describe('addCorpusEntry — happy path', () => {
  it('inserts row, embeds, returns the new corpus id + chunk count', async () => {
    const state = newState()
    vi.mocked(createAdminClient).mockReturnValue(
      makeSupabaseMock(state) as unknown as ReturnType<typeof createAdminClient>,
    )
    vi.mocked(ingestCorpusEntry).mockResolvedValue({
      ok: true,
      data: { embeddedChunkCount: 1 },
    })

    const result = await addCorpusEntry({
      venueId: VENUE_ID,
      content: "yeah. oat's on the bar.",
      sourceType: 'manual_entry',
      tags: ['menu_fact'],
      addedByOperatorId: OPERATOR_ID,
    })

    expect(result).toEqual({
      ok: true,
      corpusId: NEW_ID,
      embeddedChunkCount: 1,
    })
    expect(state.insertCalls).toHaveLength(1)
    expect(state.insertCalls[0]).toMatchObject({
      venue_id: VENUE_ID,
      source_type: 'manual_entry',
      content: "yeah. oat's on the bar.",
      tags: ['menu_fact'],
      added_by_operator_id: OPERATOR_ID,
    })
    expect(ingestCorpusEntry).toHaveBeenCalledWith(NEW_ID)
    expect(state.deleteCalls).toEqual([])
  })

  it('omits added_by_operator_id when not provided', async () => {
    const state = newState()
    vi.mocked(createAdminClient).mockReturnValue(
      makeSupabaseMock(state) as unknown as ReturnType<typeof createAdminClient>,
    )
    vi.mocked(ingestCorpusEntry).mockResolvedValue({
      ok: true,
      data: { embeddedChunkCount: 1 },
    })

    await addCorpusEntry({
      venueId: VENUE_ID,
      content: 'sample text',
      sourceType: 'sample_text',
      tags: [],
    })

    expect(state.insertCalls[0]).not.toHaveProperty('added_by_operator_id')
  })
})

describe('addCorpusEntry — embed failure rolls back row', () => {
  it('deletes the inserted row and returns embed_failed', async () => {
    const state = newState()
    vi.mocked(createAdminClient).mockReturnValue(
      makeSupabaseMock(state) as unknown as ReturnType<typeof createAdminClient>,
    )
    vi.mocked(ingestCorpusEntry).mockResolvedValue({
      ok: false,
      error: 'voyage 502',
      errorCode: 'voyage_api_error',
    })

    const result = await addCorpusEntry({
      venueId: VENUE_ID,
      content: 'x',
      sourceType: 'manual_entry',
      tags: [],
    })

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.errorCode).toBe('embed_failed')
      expect(result.error).toContain('voyage 502')
    }
    expect(state.deleteCalls).toEqual([NEW_ID])
  })
})

describe('addCorpusEntry — db error paths', () => {
  it('returns db_error on insert failure (no embed call, no rollback delete)', async () => {
    const state = newState({
      insertError: { message: 'connection lost' },
      insertedRow: null,
    })
    vi.mocked(createAdminClient).mockReturnValue(
      makeSupabaseMock(state) as unknown as ReturnType<typeof createAdminClient>,
    )

    const result = await addCorpusEntry({
      venueId: VENUE_ID,
      content: 'x',
      sourceType: 'manual_entry',
      tags: [],
    })

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.errorCode).toBe('db_error')
      expect(result.error).toContain('connection lost')
    }
    expect(ingestCorpusEntry).not.toHaveBeenCalled()
    expect(state.deleteCalls).toEqual([])
  })
})
