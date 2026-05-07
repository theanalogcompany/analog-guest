// Mock signatures mirror the supabase-js fluent builder, which passes
// column names + filter args we don't inspect inside the test.
/* eslint-disable @typescript-eslint/no-unused-vars */

import { beforeEach, describe, expect, it, vi } from 'vitest'

// Mocks must be hoisted before importing the module under test.
vi.mock('@/lib/db/admin', () => ({
  createAdminClient: vi.fn(),
}))
vi.mock('@/lib/rag', () => ({
  ingestCorpusEntry: vi.fn(),
}))

import { createAdminClient } from '@/lib/db/admin'
import { ingestCorpusEntry } from '@/lib/rag'
import { upsertCorpusEdit } from './upsert-edit'

const VENUE_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const SOURCE_REF = 'cc-review:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const EXISTING_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const NEW_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'

interface MockState {
  existingRow: { id: string } | null
  insertedId: string
  lookupError: { message: string } | null
  insertError: { message: string } | null
  deleteCalls: string[]
  deleteError: { message: string } | null
  insertCalls: number
  // Tracks which delete call we're on. Replace mode does delete-existing
  // then potentially delete-cleanup; we don't want either to fail by default.
  deleteErrorAfterCallN: number | null
}

function newState(overrides: Partial<MockState> = {}): MockState {
  return {
    existingRow: null,
    insertedId: NEW_ID,
    lookupError: null,
    insertError: null,
    deleteCalls: [],
    deleteError: null,
    insertCalls: 0,
    deleteErrorAfterCallN: null,
    ...overrides,
  }
}

function makeSupabaseMock(state: MockState) {
  return {
    from: (_table: string) => ({
      select: (_cols: string) => ({
        eq: (_f1: string, _v1: unknown) => ({
          eq: (_f2: string, _v2: unknown) => ({
            maybeSingle: async () => ({
              data: state.existingRow,
              error: state.lookupError,
            }),
          }),
        }),
      }),
      insert: (_row: unknown) => ({
        select: (_cols: string) => ({
          single: async () => {
            state.insertCalls++
            if (state.insertError) {
              return { data: null, error: state.insertError }
            }
            return { data: { id: state.insertedId }, error: null }
          },
        }),
      }),
      delete: () => ({
        eq: async (_f: string, v: unknown) => {
          state.deleteCalls.push(String(v))
          if (
            state.deleteErrorAfterCallN !== null &&
            state.deleteCalls.length > state.deleteErrorAfterCallN
          ) {
            return { error: state.deleteError ?? { message: 'delete error' } }
          }
          return { error: null }
        },
      }),
    }),
  }
}

beforeEach(() => {
  vi.mocked(createAdminClient).mockReset()
  vi.mocked(ingestCorpusEntry).mockReset()
})

describe('upsertCorpusEdit — skip-existing mode', () => {
  it('returns skipped_existing when row exists; no insert, no embed', async () => {
    const state = newState({ existingRow: { id: EXISTING_ID } })
    vi.mocked(createAdminClient).mockReturnValue(
      makeSupabaseMock(state) as unknown as ReturnType<typeof createAdminClient>,
    )

    const result = await upsertCorpusEdit(
      { venueId: VENUE_ID, sourceRef: SOURCE_REF, editedMessage: 'edit', tags: ['cc_review'] },
      'skip-existing',
    )

    expect(result).toEqual({ ok: true, corpusId: EXISTING_ID, outcome: 'skipped_existing' })
    expect(state.insertCalls).toBe(0)
    expect(state.deleteCalls).toEqual([])
    expect(ingestCorpusEntry).not.toHaveBeenCalled()
  })

  it('inserts and embeds when no existing row', async () => {
    const state = newState({ existingRow: null })
    vi.mocked(createAdminClient).mockReturnValue(
      makeSupabaseMock(state) as unknown as ReturnType<typeof createAdminClient>,
    )
    vi.mocked(ingestCorpusEntry).mockResolvedValue({ ok: true, data: { embeddedChunkCount: 1 } })

    const result = await upsertCorpusEdit(
      { venueId: VENUE_ID, sourceRef: SOURCE_REF, editedMessage: 'edit', tags: ['cc_review'] },
      'skip-existing',
    )

    expect(result).toEqual({ ok: true, corpusId: NEW_ID, outcome: 'inserted' })
    expect(state.insertCalls).toBe(1)
    expect(state.deleteCalls).toEqual([])
    expect(ingestCorpusEntry).toHaveBeenCalledWith(NEW_ID)
  })

  it('rolls back the new row on embed failure (skip-existing path)', async () => {
    const state = newState({ existingRow: null })
    vi.mocked(createAdminClient).mockReturnValue(
      makeSupabaseMock(state) as unknown as ReturnType<typeof createAdminClient>,
    )
    vi.mocked(ingestCorpusEntry).mockResolvedValue({
      ok: false,
      error: 'voyage 502',
      errorCode: 'voyage_api_error',
    })

    const result = await upsertCorpusEdit(
      { venueId: VENUE_ID, sourceRef: SOURCE_REF, editedMessage: 'edit', tags: ['cc_review'] },
      'skip-existing',
    )

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.errorCode).toBe('embed_failed')
      expect(result.error).toContain('voyage 502')
    }
    expect(state.deleteCalls).toEqual([NEW_ID])
  })
})

describe('upsertCorpusEdit — replace mode', () => {
  it('deletes existing row, inserts new, embeds', async () => {
    const state = newState({ existingRow: { id: EXISTING_ID } })
    vi.mocked(createAdminClient).mockReturnValue(
      makeSupabaseMock(state) as unknown as ReturnType<typeof createAdminClient>,
    )
    vi.mocked(ingestCorpusEntry).mockResolvedValue({ ok: true, data: { embeddedChunkCount: 1 } })

    const result = await upsertCorpusEdit(
      { venueId: VENUE_ID, sourceRef: SOURCE_REF, editedMessage: 'new', tags: ['cc_review'] },
      'replace',
    )

    expect(result).toEqual({ ok: true, corpusId: NEW_ID, outcome: 'replaced' })
    expect(state.deleteCalls).toEqual([EXISTING_ID])
    expect(state.insertCalls).toBe(1)
    expect(ingestCorpusEntry).toHaveBeenCalledWith(NEW_ID)
  })

  it('inserts when no existing row (replace falls through to insert path)', async () => {
    const state = newState({ existingRow: null })
    vi.mocked(createAdminClient).mockReturnValue(
      makeSupabaseMock(state) as unknown as ReturnType<typeof createAdminClient>,
    )
    vi.mocked(ingestCorpusEntry).mockResolvedValue({ ok: true, data: { embeddedChunkCount: 1 } })

    const result = await upsertCorpusEdit(
      { venueId: VENUE_ID, sourceRef: SOURCE_REF, editedMessage: 'edit', tags: ['cc_review'] },
      'replace',
    )

    expect(result).toEqual({ ok: true, corpusId: NEW_ID, outcome: 'inserted' })
    expect(state.deleteCalls).toEqual([])
  })

  it('rolls back the new row on embed failure (replace path)', async () => {
    const state = newState({ existingRow: { id: EXISTING_ID } })
    vi.mocked(createAdminClient).mockReturnValue(
      makeSupabaseMock(state) as unknown as ReturnType<typeof createAdminClient>,
    )
    vi.mocked(ingestCorpusEntry).mockResolvedValue({
      ok: false,
      error: 'voyage timeout',
      errorCode: 'voyage_api_error',
    })

    const result = await upsertCorpusEdit(
      { venueId: VENUE_ID, sourceRef: SOURCE_REF, editedMessage: 'new', tags: ['cc_review'] },
      'replace',
    )

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.errorCode).toBe('embed_failed')
    }
    // First delete: pre-insert clear of existing row. Second delete: cleanup
    // of the failed new row. The prior edit is gone — documented trade-off.
    expect(state.deleteCalls).toEqual([EXISTING_ID, NEW_ID])
  })
})

describe('upsertCorpusEdit — error paths', () => {
  it('returns db_error on lookup failure', async () => {
    const state = newState({ lookupError: { message: 'connection lost' } })
    vi.mocked(createAdminClient).mockReturnValue(
      makeSupabaseMock(state) as unknown as ReturnType<typeof createAdminClient>,
    )

    const result = await upsertCorpusEdit(
      { venueId: VENUE_ID, sourceRef: SOURCE_REF, editedMessage: 'edit', tags: ['cc_review'] },
      'replace',
    )

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.errorCode).toBe('db_error')
      expect(result.error).toContain('connection lost')
    }
    expect(state.insertCalls).toBe(0)
    expect(ingestCorpusEntry).not.toHaveBeenCalled()
  })

  it('returns db_error on insert failure (no embed call, no rollback delete)', async () => {
    const state = newState({
      existingRow: null,
      insertError: { message: 'unique violation' },
    })
    vi.mocked(createAdminClient).mockReturnValue(
      makeSupabaseMock(state) as unknown as ReturnType<typeof createAdminClient>,
    )

    const result = await upsertCorpusEdit(
      { venueId: VENUE_ID, sourceRef: SOURCE_REF, editedMessage: 'edit', tags: ['cc_review'] },
      'skip-existing',
    )

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.errorCode).toBe('db_error')
      expect(result.error).toContain('unique violation')
    }
    expect(ingestCorpusEntry).not.toHaveBeenCalled()
    expect(state.deleteCalls).toEqual([])
  })
})
