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
  addCurrentContextEntry,
  dropCurrentContextEntry,
  promoteCurrentContextEntry,
} from './current-context'

const VENUE_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const ENTRY_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const OTHER_ENTRY_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const NEW_KNOWLEDGE_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'

const baseVenueInfo = (overrides: Record<string, unknown> = {}) => ({
  address: { line1: '1 Main St', city: 'Someville', region: 'CA', postalCode: '00000' },
  contact: {},
  hours: {},
  menu: { highlights: [], items: [] },
  staff: [],
  currentContext: [
    {
      id: ENTRY_ID,
      content: 'The espresso machine is down until Friday.',
      source: 'text',
      addedAt: '2026-01-01T00:00:00.000Z',
      expiresAt: '2026-01-01T00:00:00.000Z', // expired relative to any "now" after this
    },
  ],
  ...overrides,
})

interface MockState {
  venueInfo: Record<string, unknown> | null
  readError: { message: string } | null
  updateCalls: Array<Record<string, unknown>>
  updateError: { message: string } | null
  insertedRow: { id: string } | null
  insertError: { message: string } | null
  insertCalls: Array<Record<string, unknown>>
  deleteCalls: string[]
  deleteError: { message: string } | null
}

function newState(overrides: Partial<MockState> = {}): MockState {
  return {
    venueInfo: baseVenueInfo(),
    readError: null,
    updateCalls: [],
    updateError: null,
    insertedRow: { id: NEW_KNOWLEDGE_ID },
    insertError: null,
    insertCalls: [],
    deleteCalls: [],
    deleteError: null,
    ...overrides,
  }
}

function makeSupabaseMock(state: MockState) {
  return {
    from: (table: string) => {
      if (table === 'venue_configs') {
        return {
          select: (_cols: string) => ({
            eq: (_f: string, _v: string) => ({
              single: async () => ({
                data: state.venueInfo ? { venue_info: state.venueInfo } : null,
                error: state.readError,
              }),
            }),
          }),
          update: (payload: Record<string, unknown>) => ({
            eq: async (_f: string, _v: string) => {
              state.updateCalls.push(payload)
              return { error: state.updateError }
            },
          }),
        }
      }
      // knowledge_corpus
      return {
        insert: (row: Record<string, unknown>) => ({
          select: (_cols: string) => ({
            single: async () => {
              state.insertCalls.push(row)
              if (state.insertError) return { data: null, error: state.insertError }
              return { data: state.insertedRow, error: null }
            },
          }),
        }),
        delete: () => ({
          eq: (_f: string, v: string) => ({
            then: (resolve: (r: { error: unknown }) => void) => {
              state.deleteCalls.push(v)
              resolve({ error: state.deleteError })
            },
          }),
        }),
      }
    },
  }
}

beforeEach(() => {
  vi.mocked(createAdminClient).mockReset()
  vi.mocked(ingestKnowledgeCorpusEntry).mockReset()
})

describe('addCurrentContextEntry', () => {
  it('appends a new entry and preserves the existing one', async () => {
    const state = newState()
    vi.mocked(createAdminClient).mockReturnValue(
      makeSupabaseMock(state) as unknown as ReturnType<typeof createAdminClient>,
    )

    const result = await addCurrentContextEntry({
      venueId: VENUE_ID,
      content: 'Oat milk is temporarily out.',
      expiresAt: '2026-06-01T00:00:00.000Z',
    })

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.entry.content).toBe('Oat milk is temporarily out.')
      expect(result.entry.source).toBe('manual_entry')
      expect(typeof result.entry.id).toBe('string')
    }
    const written = state.updateCalls[0].venue_info as { currentContext: Array<{ id: string }> }
    expect(written.currentContext).toHaveLength(2)
    expect(written.currentContext[0].id).toBe(ENTRY_ID)
  })

  it('returns db_error when venue_info fails to parse, without writing', async () => {
    const state = newState({ venueInfo: { staff: 'not an array' } })
    vi.mocked(createAdminClient).mockReturnValue(
      makeSupabaseMock(state) as unknown as ReturnType<typeof createAdminClient>,
    )

    const result = await addCurrentContextEntry({ venueId: VENUE_ID, content: 'x' })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.errorCode).toBe('db_error')
    expect(state.updateCalls).toEqual([])
  })
})

describe('dropCurrentContextEntry', () => {
  it('removes the matching entry and preserves others', async () => {
    const state = newState({
      venueInfo: baseVenueInfo({
        currentContext: [
          ...baseVenueInfo().currentContext,
          { id: OTHER_ENTRY_ID, content: 'Permanent note', source: 'text', addedAt: '2026-01-01T00:00:00.000Z' },
        ],
      }),
    })
    vi.mocked(createAdminClient).mockReturnValue(
      makeSupabaseMock(state) as unknown as ReturnType<typeof createAdminClient>,
    )

    const result = await dropCurrentContextEntry({ venueId: VENUE_ID, entryId: ENTRY_ID })
    expect(result).toEqual({ ok: true })
    const written = state.updateCalls[0].venue_info as { currentContext: Array<{ id: string }> }
    expect(written.currentContext).toEqual([{ id: OTHER_ENTRY_ID, content: 'Permanent note', source: 'text', addedAt: '2026-01-01T00:00:00.000Z' }])
  })

  it('returns not_found when the entry does not exist, without writing', async () => {
    const state = newState()
    vi.mocked(createAdminClient).mockReturnValue(
      makeSupabaseMock(state) as unknown as ReturnType<typeof createAdminClient>,
    )

    const result = await dropCurrentContextEntry({ venueId: VENUE_ID, entryId: 'nope' })
    expect(result).toEqual({ ok: false, error: 'entry not found: nope', errorCode: 'not_found' })
    expect(state.updateCalls).toEqual([])
  })
})

describe('promoteCurrentContextEntry — ordering', () => {
  it('happy path: inserts + embeds the knowledge row, THEN removes the currentContext entry', async () => {
    const state = newState()
    vi.mocked(createAdminClient).mockReturnValue(
      makeSupabaseMock(state) as unknown as ReturnType<typeof createAdminClient>,
    )
    vi.mocked(ingestKnowledgeCorpusEntry).mockResolvedValue({
      ok: true,
      data: { embeddedChunkCount: 1 },
    })

    const result = await promoteCurrentContextEntry({
      venueId: VENUE_ID,
      entryId: ENTRY_ID,
      primaryTag: 'logistics',
      secondaryTags: [],
    })

    expect(result).toEqual({ ok: true, knowledgeCorpusId: NEW_KNOWLEDGE_ID })
    expect(state.insertCalls[0]).toMatchObject({
      venue_id: VENUE_ID,
      content: 'The espresso machine is down until Friday.',
      primary_tags: ['logistics'],
      metadata: { promotedFromCurrentContext: ENTRY_ID },
    })
    expect(ingestKnowledgeCorpusEntry).toHaveBeenCalledWith(NEW_KNOWLEDGE_ID)
    const written = state.updateCalls[0].venue_info as { currentContext: unknown[] }
    expect(written.currentContext).toEqual([])
    expect(state.deleteCalls).toEqual([])
  })

  it('a failed embed leaves the currentContext entry untouched and cleans up the knowledge row', async () => {
    const state = newState()
    vi.mocked(createAdminClient).mockReturnValue(
      makeSupabaseMock(state) as unknown as ReturnType<typeof createAdminClient>,
    )
    vi.mocked(ingestKnowledgeCorpusEntry).mockResolvedValue({
      ok: false,
      error: 'voyage 502',
      errorCode: 'voyage_api_error',
    })

    const result = await promoteCurrentContextEntry({
      venueId: VENUE_ID,
      entryId: ENTRY_ID,
      primaryTag: 'logistics',
      secondaryTags: [],
    })

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.errorCode).toBe('embed_failed')
    // The knowledge row is cleaned up...
    expect(state.deleteCalls).toEqual([NEW_KNOWLEDGE_ID])
    // ...and venue_info is NEVER written — the entry is never touched, still in the queue.
    expect(state.updateCalls).toEqual([])
  })

  it('returns not_found without touching knowledge_corpus when the entry is gone', async () => {
    const state = newState()
    vi.mocked(createAdminClient).mockReturnValue(
      makeSupabaseMock(state) as unknown as ReturnType<typeof createAdminClient>,
    )

    const result = await promoteCurrentContextEntry({
      venueId: VENUE_ID,
      entryId: 'nope',
      primaryTag: 'logistics',
      secondaryTags: [],
    })

    expect(result).toEqual({ ok: false, error: 'entry not found: nope', errorCode: 'not_found' })
    expect(state.insertCalls).toEqual([])
  })

  it('re-reads venue_info fresh before the final write, not the pre-embed snapshot (TOCTOU)', async () => {
    const state = newState()
    vi.mocked(createAdminClient).mockReturnValue(
      makeSupabaseMock(state) as unknown as ReturnType<typeof createAdminClient>,
    )
    // The Voyage embed call is a slow network round trip. Simulate a
    // concurrent admin edit landing on venue_info while it's in flight.
    vi.mocked(ingestKnowledgeCorpusEntry).mockImplementation(async () => {
      state.venueInfo = baseVenueInfo({
        currentContext: [
          ...baseVenueInfo().currentContext,
          {
            id: OTHER_ENTRY_ID,
            content: 'Added mid-flight by another admin',
            source: 'text',
            addedAt: '2026-01-01T00:00:00.000Z',
          },
        ],
      })
      return { ok: true, data: { embeddedChunkCount: 1 } }
    })

    const result = await promoteCurrentContextEntry({
      venueId: VENUE_ID,
      entryId: ENTRY_ID,
      primaryTag: 'logistics',
      secondaryTags: [],
    })

    expect(result).toEqual({ ok: true, knowledgeCorpusId: NEW_KNOWLEDGE_ID })
    const written = state.updateCalls[0].venue_info as { currentContext: Array<{ id: string }> }
    // The promoted entry is gone, but the concurrently-added entry survives —
    // proving the write is based on a fresh read, not the stale pre-embed
    // snapshot (which would have silently dropped it).
    expect(written.currentContext).toEqual([
      {
        id: OTHER_ENTRY_ID,
        content: 'Added mid-flight by another admin',
        source: 'text',
        addedAt: '2026-01-01T00:00:00.000Z',
      },
    ])
  })

  it('returns db_error without deleting the knowledge row when the post-embed venue_info write fails', async () => {
    const state = newState({ updateError: { message: 'connection reset' } })
    vi.mocked(createAdminClient).mockReturnValue(
      makeSupabaseMock(state) as unknown as ReturnType<typeof createAdminClient>,
    )
    vi.mocked(ingestKnowledgeCorpusEntry).mockResolvedValue({
      ok: true,
      data: { embeddedChunkCount: 1 },
    })
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    const result = await promoteCurrentContextEntry({
      venueId: VENUE_ID,
      entryId: ENTRY_ID,
      primaryTag: 'logistics',
      secondaryTags: [],
    })

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.errorCode).toBe('db_error')
    // The knowledge row is already live and retrievable — a failure in the
    // FOLLOW-UP venue_info write must never delete it.
    expect(state.deleteCalls).toEqual([])
    expect(consoleErrorSpy).toHaveBeenCalled()

    consoleErrorSpy.mockRestore()
  })
})
