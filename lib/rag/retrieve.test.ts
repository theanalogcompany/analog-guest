import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Mock the Voyage embed call and the Supabase admin client so no network IO
// happens. Both are interceptable at the module boundary.
const embedTextMock = vi.fn()
const rpcMock = vi.fn()

vi.mock('./embed', () => ({
  embedText: (...args: unknown[]) => embedTextMock(...args),
}))

vi.mock('@/lib/db/admin', () => ({
  createAdminClient: () => ({
    rpc: (...args: unknown[]) => rpcMock(...args),
  }),
}))

import { retrieveKnowledgeContext, KNOWLEDGE_CONFIDENCE_FLOOR_DEFAULT } from './retrieve'

beforeEach(() => {
  embedTextMock.mockReset()
  rpcMock.mockReset()
  embedTextMock.mockResolvedValue({
    ok: true,
    data: { embedding: [0.1, 0.2, 0.3], model: 'voyage-3-large' },
  })
  rpcMock.mockResolvedValue({ data: [], error: null })
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('retrieveKnowledgeContext — RPC arg shape (TAC-242)', () => {
  it('passes default min_confidence (0.7) when caller omits it', async () => {
    await retrieveKnowledgeContext({ venueId: 'v-1', query: 'hi' })
    expect(rpcMock).toHaveBeenCalledTimes(1)
    const [fnName, args] = rpcMock.mock.calls[0]
    expect(fnName).toBe('match_knowledge_corpus')
    expect((args as { min_confidence: number }).min_confidence).toBe(
      KNOWLEDGE_CONFIDENCE_FLOOR_DEFAULT,
    )
  })

  it('forwards an explicit min_confidence override', async () => {
    await retrieveKnowledgeContext({ venueId: 'v-1', query: 'hi', minConfidence: 0.4 })
    const args = rpcMock.mock.calls[0][1] as { min_confidence: number }
    expect(args.min_confidence).toBe(0.4)
  })

  it('honors minConfidence: 0 (falsy but defined — does NOT collapse to default)', async () => {
    // Defensive lock: `?? KNOWLEDGE_CONFIDENCE_FLOOR_DEFAULT` only triggers
    // on undefined/null. A future refactor that switches to `||` would
    // silently coerce 0 to 0.7 and break the operator-override path.
    await retrieveKnowledgeContext({ venueId: 'v-1', query: 'hi', minConfidence: 0 })
    const args = rpcMock.mock.calls[0][1] as { min_confidence: number }
    expect(args.min_confidence).toBe(0)
  })

  it('forwards primaryTagPreference as primary_tag_filter when set', async () => {
    await retrieveKnowledgeContext({
      venueId: 'v-1',
      query: 'hi',
      primaryTagPreference: ['mechanic', 'menu'],
    })
    const args = rpcMock.mock.calls[0][1] as { primary_tag_filter?: string[] }
    expect(args.primary_tag_filter).toEqual(['mechanic', 'menu'])
  })

  it('omits primary_tag_filter from the RPC args when no preference is set', async () => {
    await retrieveKnowledgeContext({ venueId: 'v-1', query: 'hi' })
    const args = rpcMock.mock.calls[0][1] as Record<string, unknown>
    expect(args.primary_tag_filter).toBeUndefined()
    expect('primary_tag_filter' in args).toBe(false)
  })
})

describe('retrieveKnowledgeContext — chunk mapping (TAC-242)', () => {
  it('surfaces both primaryTags and secondaryTags on returned chunks', async () => {
    rpcMock.mockResolvedValueOnce({
      data: [
        {
          id: 'k1',
          corpus_id: 'kc1',
          chunk_text: 'flagship blend story',
          source_type: 'voicenote_transcript',
          confidence_score: 0.9,
          primary_tags: ['sourcing', 'menu'],
          secondary_tags: ['ethiopia', 'roaster'],
          similarity: 0.55,
        },
      ],
      error: null,
    })

    const r = await retrieveKnowledgeContext({ venueId: 'v-1', query: 'beans' })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.data).toHaveLength(1)
    expect(r.data[0].primaryTags).toEqual(['sourcing', 'menu'])
    expect(r.data[0].secondaryTags).toEqual(['ethiopia', 'roaster'])
    expect(r.data[0].knowledgeCorpusId).toBe('kc1')
  })

  it('defaults missing tag arrays to []', async () => {
    rpcMock.mockResolvedValueOnce({
      data: [
        {
          id: 'k1',
          corpus_id: 'kc1',
          chunk_text: 'fact',
          source_type: 'manual_entry',
          confidence_score: 0.85,
          primary_tags: null,
          secondary_tags: null,
          similarity: 0.5,
        },
      ],
      error: null,
    })

    const r = await retrieveKnowledgeContext({ venueId: 'v-1', query: 'q' })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.data[0].primaryTags).toEqual([])
    expect(r.data[0].secondaryTags).toEqual([])
  })

  it('drops chunks below SIMILARITY_FLOOR (0.3)', async () => {
    rpcMock.mockResolvedValueOnce({
      data: [
        {
          id: 'k1',
          corpus_id: 'kc1',
          chunk_text: 'strong',
          source_type: 'manual_entry',
          confidence_score: 0.9,
          primary_tags: ['menu'],
          secondary_tags: [],
          similarity: 0.45,
        },
        {
          id: 'k2',
          corpus_id: 'kc2',
          chunk_text: 'weak',
          source_type: 'manual_entry',
          confidence_score: 0.9,
          primary_tags: ['menu'],
          secondary_tags: [],
          similarity: 0.2,
        },
      ],
      error: null,
    })

    const r = await retrieveKnowledgeContext({ venueId: 'v-1', query: 'q' })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.data).toHaveLength(1)
    expect(r.data[0].id).toBe('k1')
  })
})

describe('retrieveKnowledgeContext — error paths', () => {
  it('returns invalid_input on empty venueId', async () => {
    const r = await retrieveKnowledgeContext({ venueId: '', query: 'q' })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error).toBe('invalid_input')
    expect(rpcMock).not.toHaveBeenCalled()
  })

  it('returns invalid_input on empty query', async () => {
    const r = await retrieveKnowledgeContext({ venueId: 'v-1', query: '' })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error).toBe('invalid_input')
  })

  it('surfaces embedding_failed when embedText fails', async () => {
    embedTextMock.mockResolvedValueOnce({ ok: false, error: 'voyage timeout' })
    const r = await retrieveKnowledgeContext({ venueId: 'v-1', query: 'q' })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.errorCode).toBe('embedding_failed')
  })

  it('surfaces db_query_failed when the RPC errors', async () => {
    rpcMock.mockResolvedValueOnce({ data: null, error: { message: 'rpc fail' } })
    const r = await retrieveKnowledgeContext({ venueId: 'v-1', query: 'q' })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.errorCode).toBe('db_query_failed')
  })
})
