import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Mock the Supabase admin client so no network IO happens — same boundary
// retrieve.test.ts intercepts.
const queryResultMock = vi.fn()

vi.mock('@/lib/db/admin', () => ({
  createAdminClient: () => ({
    from: (table: string) => ({
      select: (columns: string) => ({
        eq: (column: string, value: string) => queryResultMock(table, columns, column, value),
      }),
    }),
  }),
}))

import {
  loadVoicePack,
  selectVoicePack,
  VOICE_PACK_CHAR_BUDGET,
  VOICE_PACK_MAX_ENTRIES,
  type VoicePackRow,
} from './voice-pack'

function row(overrides: Partial<VoicePackRow> & { id: string }): VoicePackRow {
  return {
    content: `content for ${overrides.id}`,
    source_type: 'sample_text',
    confidence_score: 0.9,
    tags: [],
    created_at: '2026-01-01T00:00:00Z',
    ...overrides,
  }
}

describe('selectVoicePack — ordering', () => {
  it('puts operator_edit entries first regardless of recency', () => {
    const pack = selectVoicePack([
      row({ id: 'a', source_type: 'sample_text', created_at: '2026-09-01T00:00:00Z' }),
      row({ id: 'b', source_type: 'operator_edit', created_at: '2026-01-01T00:00:00Z' }),
    ])
    expect(pack.map((c) => c.id)).toEqual(['b', 'a'])
  })

  it('sorts newest first within a source tier', () => {
    const pack = selectVoicePack([
      row({ id: 'old', created_at: '2026-01-01T00:00:00Z' }),
      row({ id: 'new', created_at: '2026-09-01T00:00:00Z' }),
      row({ id: 'mid', created_at: '2026-05-01T00:00:00Z' }),
    ])
    expect(pack.map((c) => c.id)).toEqual(['new', 'mid', 'old'])
  })

  it('breaks created_at ties deterministically by id, ascending', () => {
    const pack = selectVoicePack([
      row({ id: 'z', created_at: '2026-01-01T00:00:00Z' }),
      row({ id: 'a', created_at: '2026-01-01T00:00:00Z' }),
    ])
    expect(pack.map((c) => c.id)).toEqual(['a', 'z'])
  })
})

describe('selectVoicePack — exclusions and caps', () => {
  it('excludes anti_pattern-tagged entries', () => {
    const pack = selectVoicePack([
      row({ id: 'keep', tags: ['casual'] }),
      row({ id: 'ban', tags: ['casual', 'anti_pattern'] }),
    ])
    expect(pack.map((c) => c.id)).toEqual(['keep'])
  })

  it('caps at maxEntries', () => {
    const rows = Array.from({ length: 5 }, (_, i) => row({ id: `r${i}` }))
    expect(selectVoicePack(rows, 3, VOICE_PACK_CHAR_BUDGET)).toHaveLength(3)
  })

  it('stops before an entry that would exceed the char budget', () => {
    const pack = selectVoicePack(
      [
        row({ id: 'a', content: 'x'.repeat(60), created_at: '2026-03-01T00:00:00Z' }),
        row({ id: 'b', content: 'x'.repeat(60), created_at: '2026-02-01T00:00:00Z' }),
        row({ id: 'c', content: 'x'.repeat(60), created_at: '2026-01-01T00:00:00Z' }),
      ],
      VOICE_PACK_MAX_ENTRIES,
      130,
    )
    expect(pack.map((c) => c.id)).toEqual(['a', 'b'])
  })

  it('always admits the first entry even when it alone exceeds the budget', () => {
    // A venue whose single entry is oversized still gets a voice — a pack
    // emptied by its own budget would trip the inbound fail-closed throw.
    const pack = selectVoicePack([row({ id: 'big', content: 'x'.repeat(500) })], 80, 100)
    expect(pack.map((c) => c.id)).toEqual(['big'])
  })
})

describe('selectVoicePack — chunk mapping', () => {
  it('maps rows to VoiceCorpusChunk with constant similarity 1', () => {
    const pack = selectVoicePack([
      row({ id: 'a', content: 'hey!', source_type: 'operator_edit', confidence_score: 0.7 }),
    ])
    expect(pack).toEqual([
      {
        id: 'a',
        voiceCorpusId: 'a',
        text: 'hey!',
        sourceType: 'operator_edit',
        confidence: 0.7,
        similarity: 1,
      },
    ])
  })

  it('defaults a null confidence_score to 0', () => {
    const pack = selectVoicePack([row({ id: 'a', confidence_score: null })])
    expect(pack[0].confidence).toBe(0)
  })
})

describe('loadVoicePack', () => {
  beforeEach(() => {
    queryResultMock.mockReset()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('rejects an empty venueId without touching the DB', async () => {
    const r = await loadVoicePack({ venueId: '' })
    expect(r).toEqual({ ok: false, error: 'invalid_input' })
    expect(queryResultMock).not.toHaveBeenCalled()
  })

  it('queries voice_corpus by venue_id and returns the selected pack', async () => {
    queryResultMock.mockResolvedValueOnce({
      data: [
        row({ id: 'b', source_type: 'operator_edit' }),
        row({ id: 'a', tags: ['anti_pattern'] }),
      ],
      error: null,
    })
    const r = await loadVoicePack({ venueId: 'v-1' })
    expect(queryResultMock).toHaveBeenCalledWith(
      'voice_corpus',
      'id, content, source_type, confidence_score, tags, created_at',
      'venue_id',
      'v-1',
    )
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.data.map((c) => c.id)).toEqual(['b'])
  })

  it('returns the DB failure as a value, never throws', async () => {
    queryResultMock.mockResolvedValueOnce({ data: null, error: { message: 'boom' } })
    const r = await loadVoicePack({ venueId: 'v-1' })
    expect(r).toEqual({ ok: false, error: 'boom', errorCode: 'db_query_failed' })
  })

  it('treats a null data payload as an empty pack', async () => {
    queryResultMock.mockResolvedValueOnce({ data: null, error: null })
    const r = await loadVoicePack({ venueId: 'v-1' })
    expect(r).toEqual({ ok: true, data: [] })
  })
})
