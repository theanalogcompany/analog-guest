import { describe, expect, it } from 'vitest'
import { buildRunRows, formatRetrievedChunks, RUN_ROW_HEADER, type RunRow } from './run-sheet'

/**
 * Every field carries a value equal to its own header name, so a
 * header/row misalignment shows up as a specific wrong pairing rather
 * than as a length mismatch that says nothing about which column moved.
 */
function makeRow(overrides: Partial<RunRow> = {}): RunRow {
  return {
    sampleId: 'sample_id',
    topic: 'topic',
    category: 'category',
    scenarioSource: 'scenario_source',
    mode: 'mode',
    guestState: 'guest_state',
    inboundMessage: 'inbound_message',
    outcome: 'outcome',
    route: 'route',
    primaryTrigger: 'primary_trigger',
    allTriggers: 'all_triggers',
    voiceFidelity: 'voice_fidelity',
    replyBody: 'reply',
    knowledgeVerdict: 'knowledge_verdict',
    knowledgeReason: 'knowledge_reason',
    voiceVerdict: 'voice_verdict',
    voiceReason: 'voice_reason',
    routingVerdict: 'routing_verdict',
    expectedRoute: 'expected_route',
    actualRoute: 'actual_route',
    expectedBehaviorVerdict: 'expected_behavior_verdict',
    expectedBehaviorReason: 'expected_behavior_reason',
    retrievedChunkIds: 'retrieved_chunk_ids',
    retrievedChunkScores: 'retrieved_chunk_scores',
    ...overrides,
  }
}

describe('buildRunRows', () => {
  it('emits the header as the first row', () => {
    expect(buildRunRows([])).toEqual([[...RUN_ROW_HEADER]])
  })

  it('emits one row per scenario', () => {
    const rows = buildRunRows([makeRow({ sampleId: 'a' }), makeRow({ sampleId: 'b' })])
    expect(rows).toHaveLength(3)
    expect(rows[1][0]).toBe('a')
    expect(rows[2][0]).toBe('b')
  })

  it('keeps every cell aligned with its header', () => {
    // The self-naming fixture means each cell must equal its own header.
    // Inserting, removing, or reordering a column in RUN_ROW_HEADER without
    // making the same edit in buildRunRows fails here, naming the column.
    const [, row] = buildRunRows([makeRow()])
    expect(row).toHaveLength(RUN_ROW_HEADER.length)
    for (let i = 0; i < RUN_ROW_HEADER.length; i++) {
      expect(row[i]).toBe(RUN_ROW_HEADER[i])
    }
  })

  it('places the TAC-358 retrieval columns last, so prior column positions are unchanged', () => {
    // Appending rather than inserting keeps every pre-existing column at the
    // index a saved filter or a historical tab already expects.
    expect(RUN_ROW_HEADER.slice(-2)).toEqual(['retrieved_chunk_ids', 'retrieved_chunk_scores'])
  })
})

describe('formatRetrievedChunks', () => {
  it('renders empty cells when nothing was retrieved', () => {
    expect(formatRetrievedChunks([])).toEqual({ ids: '', scores: '' })
  })

  it('renders a single corpus id and its score', () => {
    expect(formatRetrievedChunks([{ corpusId: '1f9dc70a', similarity: 0.6123 }])).toEqual({
      ids: '1f9dc70a',
      scores: '0.6123',
    })
  })

  it('preserves retrieval order across both columns', () => {
    expect(
      formatRetrievedChunks([
        { corpusId: 'first', similarity: 0.62 },
        { corpusId: 'second', similarity: 0.55 },
      ]),
    ).toEqual({ ids: 'first, second', scores: '0.6200, 0.5500' })
  })

  it('repeats an id when one corpus row contributed two chunks', () => {
    // Correct reading: the same source entry reached the prompt twice.
    const { ids } = formatRetrievedChunks([
      { corpusId: 'dup', similarity: 0.7 },
      { corpusId: 'dup', similarity: 0.66 },
    ])
    expect(ids).toBe('dup, dup')
  })

  it('renders four decimals, enough to separate a bare survivor from a comfortable match', () => {
    // Four decimals rather than two because the interesting distinction at the
    // low end is narrow: a chunk that cleared KNOWLEDGE_RELEVANCE_FLOOR by
    // three thousandths reads as 0.5012, where two decimals would render it
    // 0.50 and make it indistinguishable from the floor itself.
    //
    // Note the fixture is ABOVE the floor on purpose. Everything this column
    // can ever contain is a post-floor survivor — retrieveKnowledgeStage
    // returns filterByRelevance(...), so a sub-floor score is not a value the
    // pipeline can produce and must not be used here as though it were.
    expect(formatRetrievedChunks([{ corpusId: 'x', similarity: 0.50123 }]).scores).toBe('0.5012')
  })

  it('returns both columns from one call, so they cannot be built from different arrays', () => {
    // Index alignment is load-bearing (the nth id is the nth score). A single
    // function over a single array makes a mismatch unrepresentable rather
    // than relying on the caller to pass the same array twice.
    const { ids, scores } = formatRetrievedChunks([
      { corpusId: 'a', similarity: 0.6 },
      { corpusId: 'b', similarity: 0.55 },
    ])
    expect(ids.split(', ')).toHaveLength(scores.split(', ').length)
    expect(ids.split(', ')[1]).toBe('b')
    expect(scores.split(', ')[1]).toBe('0.5500')
  })
})
