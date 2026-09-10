/* eslint-disable @typescript-eslint/no-unused-vars */

import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/db/admin', () => ({
  createAdminClient: vi.fn(),
}))
vi.mock('@/lib/rag', () => ({
  ingestKnowledgeCorpusEntry: vi.fn(),
}))

import { createAdminClient } from '@/lib/db/admin'
import { ingestKnowledgeCorpusEntry } from '@/lib/rag'
import {
  addKnowledgeEntry,
  editKnowledgeEntry,
  mergeKnowledgeEntries,
  removeKnowledgeEntry,
  splitKnowledgeEntry,
} from './knowledge-corpus'

const VENUE_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const OPERATOR_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const NEW_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const ORIGINAL_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
const SPLIT_ID_1 = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
const SPLIT_ID_2 = 'ffffffff-ffff-4fff-8fff-ffffffffffff'
const MERGE_SOURCE_1 = '11111111-1111-4111-8111-111111111111'
const MERGE_SOURCE_2 = '22222222-2222-4222-8222-222222222222'

interface MockState {
  insertedRow: { id: string } | null
  insertedRows: Array<{ id: string }> | null
  insertError: { message: string } | null
  fetchedRow: Record<string, unknown> | null
  fetchError: { message: string } | null
  updateError: { message: string } | null
  insertCalls: Array<Record<string, unknown> | Array<Record<string, unknown>>>
  eqDeleteCalls: string[]
  inDeleteCalls: string[][]
  deleteError: { message: string } | null
  deletedRow: { id: string } | null
}

function newState(overrides: Partial<MockState> = {}): MockState {
  return {
    insertedRow: { id: NEW_ID },
    insertedRows: null,
    insertError: null,
    fetchedRow: null,
    fetchError: null,
    updateError: null,
    insertCalls: [],
    eqDeleteCalls: [],
    inDeleteCalls: [],
    deleteError: null,
    deletedRow: { id: NEW_ID },
    ...overrides,
  }
}

function makeSupabaseMock(state: MockState) {
  return {
    from: (_table: string) => ({
      insert: (row: Record<string, unknown> | Array<Record<string, unknown>>) => ({
        select: (_cols: string) => ({
          single: async () => {
            state.insertCalls.push(row)
            if (state.insertError) return { data: null, error: state.insertError }
            return { data: state.insertedRow, error: null }
          },
          // multi-row insert().select() without .single() — used by split
          then: undefined,
        }),
      }),
      update: (_payload: Record<string, unknown>) => ({
        eq: async (_f: string, _v: unknown) => {
          if (state.updateError) return { error: state.updateError }
          return { error: null }
        },
      }),
      delete: () => ({
        eq: (_f: string, v: string) => ({
          select: (_cols: string) => ({
            maybeSingle: async () => {
              state.eqDeleteCalls.push(v)
              if (state.deleteError) return { data: null, error: state.deleteError }
              return { data: state.deletedRow, error: null }
            },
          }),
          // bare .eq() awaited directly (no .select()) — used by add/merge/split cleanup
          then: (resolve: (v: { error: unknown }) => void) => {
            state.eqDeleteCalls.push(v)
            resolve({ error: state.deleteError })
          },
        }),
        in: (_f: string, values: string[]) => ({
          then: (resolve: (v: { error: unknown }) => void) => {
            state.inDeleteCalls.push(values)
            resolve({ error: state.deleteError })
          },
        }),
      }),
    }),
  }
}

// Split's multi-row insert needs .insert([...]).select('id') to resolve to
// {data, error} directly (no .single()) — a distinct shape from the
// single-row helpers above. Build a dedicated mock for split/merge-adjacent
// tests that exercise this path, rather than overloading makeSupabaseMock
// with a runtime shape switch.
function makeSplitSupabaseMock(state: MockState & { insertedRows: Array<{ id: string }> }) {
  return {
    from: (_table: string) => ({
      select: (_cols: string) => ({
        eq: (_f: string, _v: string) => ({
          single: async () => {
            if (state.fetchError) return { data: null, error: state.fetchError }
            return { data: state.fetchedRow, error: null }
          },
        }),
      }),
      insert: (rows: Array<Record<string, unknown>>) => ({
        select: async (_cols: string) => {
          state.insertCalls.push(rows)
          if (state.insertError) return { data: null, error: state.insertError }
          return { data: state.insertedRows, error: null }
        },
      }),
      delete: () => ({
        eq: (_f: string, v: string) => ({
          then: (resolve: (r: { error: unknown }) => void) => {
            state.eqDeleteCalls.push(v)
            resolve({ error: state.deleteError })
          },
        }),
        in: (_f: string, values: string[]) => ({
          then: (resolve: (r: { error: unknown }) => void) => {
            state.inDeleteCalls.push(values)
            resolve({ error: state.deleteError })
          },
        }),
      }),
    }),
  }
}

beforeEach(() => {
  vi.mocked(createAdminClient).mockReset()
  vi.mocked(ingestKnowledgeCorpusEntry).mockReset()
})

describe('addKnowledgeEntry', () => {
  it('inserts, embeds, returns the new id + chunk count', async () => {
    const state = newState()
    vi.mocked(createAdminClient).mockReturnValue(
      makeSupabaseMock(state) as unknown as ReturnType<typeof createAdminClient>,
    )
    vi.mocked(ingestKnowledgeCorpusEntry).mockResolvedValue({
      ok: true,
      data: { embeddedChunkCount: 2 },
    })

    const result = await addKnowledgeEntry({
      venueId: VENUE_ID,
      content: 'The espresso machine is a La Marzocco Linea.',
      primaryTags: ['sourcing'],
      secondaryTags: ['equipment'],
      addedByOperatorId: OPERATOR_ID,
    })

    expect(result).toEqual({ ok: true, corpusId: NEW_ID, embeddedChunkCount: 2 })
    expect(state.insertCalls[0]).toMatchObject({
      venue_id: VENUE_ID,
      primary_tags: ['sourcing'],
      secondary_tags: ['equipment'],
      source_type: 'manual_entry',
      added_by_operator_id: OPERATOR_ID,
    })
    expect(ingestKnowledgeCorpusEntry).toHaveBeenCalledWith(NEW_ID)
    expect(state.eqDeleteCalls).toEqual([])
  })

  it('rolls back the inserted row on embed failure', async () => {
    const state = newState()
    vi.mocked(createAdminClient).mockReturnValue(
      makeSupabaseMock(state) as unknown as ReturnType<typeof createAdminClient>,
    )
    vi.mocked(ingestKnowledgeCorpusEntry).mockResolvedValue({
      ok: false,
      error: 'voyage 502',
      errorCode: 'voyage_api_error',
    })

    const result = await addKnowledgeEntry({
      venueId: VENUE_ID,
      content: 'x',
      primaryTags: ['other'],
      secondaryTags: [],
    })

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.errorCode).toBe('embed_failed')
    expect(state.eqDeleteCalls).toEqual([NEW_ID])
  })

  it('returns db_error on insert failure without calling embed', async () => {
    const state = newState({ insertError: { message: 'connection lost' }, insertedRow: null })
    vi.mocked(createAdminClient).mockReturnValue(
      makeSupabaseMock(state) as unknown as ReturnType<typeof createAdminClient>,
    )

    const result = await addKnowledgeEntry({
      venueId: VENUE_ID,
      content: 'x',
      primaryTags: ['other'],
      secondaryTags: [],
    })

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.errorCode).toBe('db_error')
    expect(ingestKnowledgeCorpusEntry).not.toHaveBeenCalled()
  })
})

describe('editKnowledgeEntry', () => {
  it('re-embeds and reports reEmbedded=true when content is provided', async () => {
    const state = newState()
    vi.mocked(createAdminClient).mockReturnValue(
      makeSupabaseMock(state) as unknown as ReturnType<typeof createAdminClient>,
    )
    vi.mocked(ingestKnowledgeCorpusEntry).mockResolvedValue({
      ok: true,
      data: { embeddedChunkCount: 1 },
    })

    const result = await editKnowledgeEntry({ corpusId: ORIGINAL_ID, content: 'updated text' })

    expect(result).toEqual({ ok: true, corpusId: ORIGINAL_ID, reEmbedded: true })
    expect(ingestKnowledgeCorpusEntry).toHaveBeenCalledWith(ORIGINAL_ID)
  })

  it('skips the embed call for a tags-only edit', async () => {
    const state = newState()
    vi.mocked(createAdminClient).mockReturnValue(
      makeSupabaseMock(state) as unknown as ReturnType<typeof createAdminClient>,
    )

    const result = await editKnowledgeEntry({ corpusId: ORIGINAL_ID, primaryTags: ['events'] })

    expect(result).toEqual({ ok: true, corpusId: ORIGINAL_ID, reEmbedded: false })
    expect(ingestKnowledgeCorpusEntry).not.toHaveBeenCalled()
  })

  it('returns no_op when nothing is passed', async () => {
    const result = await editKnowledgeEntry({ corpusId: ORIGINAL_ID })
    expect(result).toEqual({
      ok: false,
      error: 'no_op: pass at least one of content, primaryTags, or secondaryTags',
      errorCode: 'no_op',
    })
  })

  it('surfaces embed_failed when re-embedding fails, matching the is_processed=false fix-path contract', async () => {
    const state = newState()
    vi.mocked(createAdminClient).mockReturnValue(
      makeSupabaseMock(state) as unknown as ReturnType<typeof createAdminClient>,
    )
    vi.mocked(ingestKnowledgeCorpusEntry).mockResolvedValue({
      ok: false,
      error: 'voyage 502',
      errorCode: 'voyage_api_error',
    })

    const result = await editKnowledgeEntry({ corpusId: ORIGINAL_ID, content: 'retry me' })

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.errorCode).toBe('embed_failed')
  })
})

describe('removeKnowledgeEntry', () => {
  it('deletes and returns ok on an existing row', async () => {
    const state = newState({ deletedRow: { id: ORIGINAL_ID } })
    vi.mocked(createAdminClient).mockReturnValue(
      makeSupabaseMock(state) as unknown as ReturnType<typeof createAdminClient>,
    )

    const result = await removeKnowledgeEntry(ORIGINAL_ID)
    expect(result).toEqual({ ok: true, corpusId: ORIGINAL_ID })
  })

  it('returns not_found when the row does not exist', async () => {
    const state = newState({ deletedRow: null })
    vi.mocked(createAdminClient).mockReturnValue(
      makeSupabaseMock(state) as unknown as ReturnType<typeof createAdminClient>,
    )

    const result = await removeKnowledgeEntry(ORIGINAL_ID)
    expect(result).toEqual({
      ok: false,
      error: `knowledge entry not found: ${ORIGINAL_ID}`,
      errorCode: 'not_found',
    })
  })
})

describe('splitKnowledgeEntry — atomicity', () => {
  it('rejects fewer than 2 pieces without touching the DB', async () => {
    const result = await splitKnowledgeEntry({
      originalId: ORIGINAL_ID,
      venueId: VENUE_ID,
      pieces: [{ content: 'only one', primaryTags: ['other'], secondaryTags: [] }],
    })
    expect(result).toEqual({
      ok: false,
      error: 'split requires at least 2 pieces',
      errorCode: 'invalid_input',
    })
    expect(createAdminClient).not.toHaveBeenCalled()
  })

  it('happy path: inserts N, embeds each, deletes the original last', async () => {
    const state = newState({
      fetchedRow: { source_type: 'interview_extraction', venue_id: VENUE_ID },
      insertedRows: [{ id: SPLIT_ID_1 }, { id: SPLIT_ID_2 }],
    })
    vi.mocked(createAdminClient).mockReturnValue(
      makeSplitSupabaseMock(
        state as MockState & { insertedRows: Array<{ id: string }> },
      ) as unknown as ReturnType<typeof createAdminClient>,
    )
    vi.mocked(ingestKnowledgeCorpusEntry).mockResolvedValue({
      ok: true,
      data: { embeddedChunkCount: 1 },
    })

    const result = await splitKnowledgeEntry({
      originalId: ORIGINAL_ID,
      venueId: VENUE_ID,
      pieces: [
        { content: 'piece one', primaryTags: ['menu'], secondaryTags: [] },
        { content: 'piece two', primaryTags: ['menu'], secondaryTags: [] },
      ],
    })

    expect(result).toEqual({ ok: true, newIds: [SPLIT_ID_1, SPLIT_ID_2] })
    expect(ingestKnowledgeCorpusEntry).toHaveBeenNthCalledWith(1, SPLIT_ID_1)
    expect(ingestKnowledgeCorpusEntry).toHaveBeenNthCalledWith(2, SPLIT_ID_2)
    // Original is deleted only AFTER both pieces embedded successfully.
    expect(state.eqDeleteCalls).toEqual([ORIGINAL_ID])
    expect(state.inDeleteCalls).toEqual([])
    // New rows inherit the original's source_type and carry split provenance.
    const insertedPayload = state.insertCalls[0] as Array<Record<string, unknown>>
    expect(insertedPayload[0]).toMatchObject({
      source_type: 'interview_extraction',
      metadata: { splitFrom: ORIGINAL_ID },
    })
  })

  it('a mid-split embed failure deletes the new rows and leaves the original intact', async () => {
    const state = newState({
      fetchedRow: { source_type: 'interview_extraction', venue_id: VENUE_ID },
      insertedRows: [{ id: SPLIT_ID_1 }, { id: SPLIT_ID_2 }],
    })
    vi.mocked(createAdminClient).mockReturnValue(
      makeSplitSupabaseMock(
        state as MockState & { insertedRows: Array<{ id: string }> },
      ) as unknown as ReturnType<typeof createAdminClient>,
    )
    vi.mocked(ingestKnowledgeCorpusEntry)
      .mockResolvedValueOnce({ ok: true, data: { embeddedChunkCount: 1 } })
      .mockResolvedValueOnce({ ok: false, error: 'voyage 502', errorCode: 'voyage_api_error' })

    const result = await splitKnowledgeEntry({
      originalId: ORIGINAL_ID,
      venueId: VENUE_ID,
      pieces: [
        { content: 'piece one', primaryTags: ['menu'], secondaryTags: [] },
        { content: 'piece two', primaryTags: ['menu'], secondaryTags: [] },
      ],
    })

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.errorCode).toBe('embed_failed')
    // Compensating cleanup: both new rows deleted via .in(), original NEVER touched.
    expect(state.inDeleteCalls).toEqual([[SPLIT_ID_1, SPLIT_ID_2]])
    expect(state.eqDeleteCalls).toEqual([])
  })

  it('returns db_error without inserting when the original cannot be fetched', async () => {
    const state = newState({ fetchError: { message: 'not found' } })
    vi.mocked(createAdminClient).mockReturnValue(
      makeSplitSupabaseMock(
        state as MockState & { insertedRows: Array<{ id: string }> },
      ) as unknown as ReturnType<typeof createAdminClient>,
    )

    const result = await splitKnowledgeEntry({
      originalId: ORIGINAL_ID,
      venueId: VENUE_ID,
      pieces: [
        { content: 'a', primaryTags: ['menu'], secondaryTags: [] },
        { content: 'b', primaryTags: ['menu'], secondaryTags: [] },
      ],
    })

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.errorCode).toBe('db_error')
    expect(state.insertCalls).toEqual([])
  })

  it('refuses without inserting when the original belongs to a different venue than requested', async () => {
    const state = newState({
      fetchedRow: { source_type: 'interview_extraction', venue_id: 'some-other-venue' },
    })
    vi.mocked(createAdminClient).mockReturnValue(
      makeSplitSupabaseMock(
        state as MockState & { insertedRows: Array<{ id: string }> },
      ) as unknown as ReturnType<typeof createAdminClient>,
    )

    const result = await splitKnowledgeEntry({
      originalId: ORIGINAL_ID,
      venueId: VENUE_ID,
      pieces: [
        { content: 'a', primaryTags: ['menu'], secondaryTags: [] },
        { content: 'b', primaryTags: ['menu'], secondaryTags: [] },
      ],
    })

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.errorCode).toBe('invalid_input')
    expect(state.insertCalls).toEqual([])
  })
})

describe('mergeKnowledgeEntries — atomicity', () => {
  it('rejects fewer than 2 source entries without touching the DB', async () => {
    const result = await mergeKnowledgeEntries({
      originalIds: [MERGE_SOURCE_1],
      venueId: VENUE_ID,
      content: 'merged',
      primaryTags: ['other'],
      secondaryTags: [],
    })
    expect(result).toEqual({
      ok: false,
      error: 'merge requires at least 2 source entries',
      errorCode: 'invalid_input',
    })
    expect(createAdminClient).not.toHaveBeenCalled()
  })

  it('happy path: inserts the merged row, embeds it, deletes both originals last', async () => {
    const state = newState()
    vi.mocked(createAdminClient).mockReturnValue(
      makeSupabaseMock(state) as unknown as ReturnType<typeof createAdminClient>,
    )
    vi.mocked(ingestKnowledgeCorpusEntry).mockResolvedValue({
      ok: true,
      data: { embeddedChunkCount: 1 },
    })

    const result = await mergeKnowledgeEntries({
      originalIds: [MERGE_SOURCE_1, MERGE_SOURCE_2],
      venueId: VENUE_ID,
      content: 'merged content',
      primaryTags: ['menu'],
      secondaryTags: [],
    })

    expect(result).toEqual({ ok: true, newId: NEW_ID })
    expect(ingestKnowledgeCorpusEntry).toHaveBeenCalledWith(NEW_ID)
    expect(state.inDeleteCalls).toEqual([[MERGE_SOURCE_1, MERGE_SOURCE_2]])
    expect(state.eqDeleteCalls).toEqual([])
    expect(state.insertCalls[0]).toMatchObject({
      metadata: { mergedFrom: [MERGE_SOURCE_1, MERGE_SOURCE_2] },
    })
  })

  it('a failed embed deletes the new row and leaves both originals intact', async () => {
    const state = newState()
    vi.mocked(createAdminClient).mockReturnValue(
      makeSupabaseMock(state) as unknown as ReturnType<typeof createAdminClient>,
    )
    vi.mocked(ingestKnowledgeCorpusEntry).mockResolvedValue({
      ok: false,
      error: 'voyage 502',
      errorCode: 'voyage_api_error',
    })

    const result = await mergeKnowledgeEntries({
      originalIds: [MERGE_SOURCE_1, MERGE_SOURCE_2],
      venueId: VENUE_ID,
      content: 'merged content',
      primaryTags: ['menu'],
      secondaryTags: [],
    })

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.errorCode).toBe('embed_failed')
    expect(state.eqDeleteCalls).toEqual([NEW_ID])
    expect(state.inDeleteCalls).toEqual([])
  })
})
