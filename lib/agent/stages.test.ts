import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { retrieveCorpusStage } from './stages'
import type { CorpusMatch, RuntimeContext } from './types'

// Mocks: retrieveContext (lib/rag) is the network call we don't want to make;
// captureCorpusRetrievalBelowThreshold is fire-and-forget observability —
// we mock it to assert it still fires on the followup path (regression
// guard for THE-231's "observability stays useful" invariant).
const retrieveContextMock = vi.fn()
const captureLowMock = vi.fn()

vi.mock('@/lib/rag', () => ({
  retrieveContext: (...args: unknown[]) => retrieveContextMock(...args),
}))

vi.mock('@/lib/analytics/posthog', () => ({
  // Real module exports several helpers + threshold constants. We need the
  // threshold here because retrieveCorpusStage compares against it; the rest
  // are stubs since stages.ts imports them at module load.
  captureClassificationLowConfidence: vi.fn(),
  captureCorpusRetrievalBelowThreshold: (...args: unknown[]) => captureLowMock(...args),
  captureDashViolationPersisted: vi.fn(),
  captureRegenerationTriggered: vi.fn(),
  captureVoiceFidelityLow: vi.fn(),
  CLASSIFICATION_CONFIDENCE_LOW_THRESHOLD: 0.7,
  CORPUS_TOP_SIMILARITY_LOW_THRESHOLD: 0.5,
  VOICE_FIDELITY_LOW_THRESHOLD: 0.5,
}))

// Minimal RuntimeContext factory. retrieveCorpusStage only reads venue.id,
// agentRunId, guest.{id,firstName}, currentMessage, followupTrigger — cast
// the rest as never to avoid hand-building VenueContext / RecognitionSnapshot
// / etc. for a focused test.
function makeCtx(overrides: Partial<RuntimeContext>): RuntimeContext {
  return {
    agentRunId: 'run-1',
    venue: { id: 'venue-1' } as RuntimeContext['venue'],
    guest: { id: 'guest-1', firstName: 'Sam' } as RuntimeContext['guest'],
    currentMessage: null,
    followupTrigger: null,
    recentMessages: [],
    recognition: {} as RuntimeContext['recognition'],
    mechanics: [],
    lastVisit: null,
    corpus: null,
    classification: null,
    trace: { id: '' } as RuntimeContext['trace'],
    ...overrides,
  }
}

function makeMatch(similarity: number, id = 'c1'): CorpusMatch {
  return {
    id,
    text: 'sample voice corpus chunk',
    sourceType: 'sample_text',
    similarity,
    // Type assertion: CorpusMatch is aliased to lib/rag's chunk shape; the
    // narrow set above is enough for the gate logic under test.
  } as CorpusMatch
}

describe('retrieveCorpusStage — inbound path (existing behavior)', () => {
  beforeEach(() => {
    retrieveContextMock.mockReset()
    captureLowMock.mockReset()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('throws insufficient_corpus_matches when no chunk crosses the strong-match floor', async () => {
    retrieveContextMock.mockResolvedValueOnce({
      ok: true,
      data: [makeMatch(0.2), makeMatch(0.15)], // none ≥ 0.3
    })
    const ctx = makeCtx({
      currentMessage: { id: 'm1', body: 'hi', providerMessageId: 'p1' } as RuntimeContext['currentMessage'],
    })
    await expect(retrieveCorpusStage(ctx)).rejects.toThrow(/insufficient_corpus_matches/)
  })

  it('returns matches when at least one crosses the strong-match floor', async () => {
    const matches = [makeMatch(0.45), makeMatch(0.2)]
    retrieveContextMock.mockResolvedValueOnce({ ok: true, data: matches })
    const ctx = makeCtx({
      currentMessage: { id: 'm1', body: 'hi', providerMessageId: 'p1' } as RuntimeContext['currentMessage'],
    })
    const out = await retrieveCorpusStage(ctx)
    expect(out).toEqual(matches)
  })
})

describe('retrieveCorpusStage — followup path (THE-231)', () => {
  beforeEach(() => {
    retrieveContextMock.mockReset()
    captureLowMock.mockReset()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('does NOT throw on zero strong matches when followup-triggered', async () => {
    retrieveContextMock.mockResolvedValueOnce({
      ok: true,
      data: [makeMatch(0.2)], // below floor, would have failed pre-THE-231
    })
    const ctx = makeCtx({
      followupTrigger: {
        reason: 'manual',
        triggeredAt: new Date(),
      } as RuntimeContext['followupTrigger'],
    })
    const out = await retrieveCorpusStage(ctx)
    expect(out).toHaveLength(1)
    expect(out[0].similarity).toBe(0.2)
  })

  it('returns empty array when followup query returns zero matches', async () => {
    retrieveContextMock.mockResolvedValueOnce({ ok: true, data: [] })
    const ctx = makeCtx({
      followupTrigger: {
        reason: 'manual',
        triggeredAt: new Date(),
      } as RuntimeContext['followupTrigger'],
    })
    const out = await retrieveCorpusStage(ctx)
    expect(out).toEqual([])
  })

  it('still fires the low-similarity observability event on the followup path', async () => {
    // Top similarity 0.2 (< CORPUS_TOP_SIMILARITY_LOW_THRESHOLD of 0.5) →
    // captureCorpusRetrievalBelowThreshold should fire. THE-231 invariant:
    // observability stays useful even when we don't fail closed.
    retrieveContextMock.mockResolvedValueOnce({
      ok: true,
      data: [makeMatch(0.2)],
    })
    const ctx = makeCtx({
      followupTrigger: {
        reason: 'manual',
        triggeredAt: new Date(),
      } as RuntimeContext['followupTrigger'],
    })
    await retrieveCorpusStage(ctx)
    expect(captureLowMock).toHaveBeenCalledTimes(1)
    const props = captureLowMock.mock.calls[0][0] as {
      strongMatchCount: number
      topSimilarity: number
      inboundBody: string | null
    }
    expect(props.strongMatchCount).toBe(0)
    expect(props.topSimilarity).toBe(0.2)
    // No inbound on the followup path — captured as null, as expected.
    expect(props.inboundBody).toBeNull()
  })

  it('still throws on rag-layer failure regardless of inbound vs followup', async () => {
    retrieveContextMock.mockResolvedValueOnce({ ok: false, error: 'voyage timeout' })
    const ctx = makeCtx({
      followupTrigger: {
        reason: 'manual',
        triggeredAt: new Date(),
      } as RuntimeContext['followupTrigger'],
    })
    await expect(retrieveCorpusStage(ctx)).rejects.toThrow(/voyage timeout/)
  })

  it('still throws on missing query (neither inbound nor followup)', async () => {
    const ctx = makeCtx({})
    await expect(retrieveCorpusStage(ctx)).rejects.toThrow(/no query available/)
  })
})
