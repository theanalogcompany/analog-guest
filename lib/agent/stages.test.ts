import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  applyApprovalPolicyStage,
  APPROVAL_TRIGGERS,
  buildAiRuntime,
  classifyStage,
  deriveFollowupContext,
  findPendingDraft,
  generateStage,
  isCommitmentTypeGated,
  isKnowledgeGapCard,
  isModelFlagged,
  KNOWLEDGE_RELEVANCE_FLOOR,
  knowledgeGapWillQueue,
  retrieveCorpusStage,
  retrieveKnowledgeStage,
  shouldRetrieveKnowledge,
  verifyGroundingStage,
  verifyMechanicOfferStage,
} from './stages'
import type { CorpusMatch, FollowupTrigger, RuntimeContext, Visit } from './types'
import type { GenerateMessageResult } from '@/lib/ai'

// Mocks: retrieveContext (lib/rag) is the network call we don't want to make;
// captureCorpusRetrievalBelowThreshold is fire-and-forget observability —
// we mock it to assert it still fires on the followup path (regression
// guard for THE-231's "observability stays useful" invariant). classifyMessage
// (lib/ai) is mocked for the classifyStage routing tests added in TAC-240.
const retrieveContextMock = vi.fn()
const captureLowMock = vi.fn()
const captureClassificationLowMock = vi.fn()
const classifyMessageMock = vi.fn()
const retrieveKnowledgeContextMock = vi.fn()
const generateMessageMock = vi.fn()
// TAC-350: verifyGrounding (lib/ai) is the grounding backstop's model call;
// captureUngroundedClaimCaught (posthog) fires when it catches something.
const verifyGroundingMock = vi.fn()
const captureUngroundedClaimCaughtMock = vi.fn()
// TAC-355: verifyMechanicOffer (lib/ai) is the mechanic-offer backstop's
// model call; captureMechanicOfferBackstopCaught (posthog) fires when it
// catches something.
const verifyMechanicOfferMock = vi.fn()
const captureMechanicOfferBackstopCaughtMock = vi.fn()
// TAC-284: applyApprovalPolicyStage fires captureDemoBypassedApprovalGate
// when a demo guest's bypass overrides a would-have-queued decision. Mocked
// so the demo-bypass tests can assert the payload without a PostHog call.
const captureDemoBypassMock = vi.fn()
// TAC-212 + TAC-264: findPendingDraft inside applyApprovalPolicyStage calls
// createAdminClient → supabase.from(...).select(...).limit(1).maybeSingle().
// We mock createAdminClient to return a chainable stub whose terminal
// maybeSingle() resolves with whatever the test sets via the per-test
// `pendingDraftMaybeSingleMock`. TAC-264 widened the select to `id, body`
// so tests assert against {id, body} shapes; the mock's return value is
// passed through to the stage decision's existingPendingDraftId field.
const pendingDraftMaybeSingleMock = vi.fn()
vi.mock('@/lib/db/admin', () => ({
  createAdminClient: () => ({
    from: () => ({
      select: () => ({
        eq: () => ({
          eq: () => ({
            eq: () => ({
              eq: () => ({
                limit: () => ({
                  maybeSingle: (...args: unknown[]) =>
                    pendingDraftMaybeSingleMock(...args),
                }),
              }),
            }),
          }),
        }),
      }),
    }),
  }),
}))

vi.mock('@/lib/rag', () => ({
  retrieveContext: (...args: unknown[]) => retrieveContextMock(...args),
  retrieveKnowledgeContext: (...args: unknown[]) => retrieveKnowledgeContextMock(...args),
}))

vi.mock('@/lib/ai', () => ({
  classifyMessage: (...args: unknown[]) => classifyMessageMock(...args),
  // generateMessage is referenced at module load by stages.ts; stub so the
  // import doesn't pull in real SDK init. TAC-309 gave it a named handle so
  // the fidelity-exemption tests can drive generateStage directly.
  generateMessage: (...args: unknown[]) => generateMessageMock(...args),
  // TAC-350: the grounding backstop's model call.
  verifyGrounding: (...args: unknown[]) => verifyGroundingMock(...args),
  // TAC-355: the mechanic-offer backstop's model call.
  verifyMechanicOffer: (...args: unknown[]) => verifyMechanicOfferMock(...args),
}))

vi.mock('@/lib/analytics/posthog', () => ({
  // Real module exports several helpers + threshold constants. We need the
  // thresholds here because retrieveCorpusStage and classifyStage compare
  // against them; the rest are stubs since stages.ts imports them at module
  // load.
  captureClassificationLowConfidence: (...args: unknown[]) =>
    captureClassificationLowMock(...args),
  captureCorpusRetrievalBelowThreshold: (...args: unknown[]) => captureLowMock(...args),
  captureDashViolationPersisted: vi.fn(),
  captureDemoBypassedApprovalGate: (...args: unknown[]) => captureDemoBypassMock(...args),
  captureRegenerationTriggered: vi.fn(),
  captureUngroundedClaimCaught: (...args: unknown[]) => captureUngroundedClaimCaughtMock(...args),
  captureMechanicOfferBackstopCaught: (...args: unknown[]) =>
    captureMechanicOfferBackstopCaughtMock(...args),
  captureVoiceFidelityLow: vi.fn(),
  // TAC-301: the invalid-timezone test reaches fireRedAlert (lib/agent/alerts.ts),
  // which calls this directly. Without the stub it throws as an UNHANDLED
  // REJECTION rather than a test failure — `vitest run` still prints "passed"
  // and only the trailing "Errors 1 error" line gives it away. Caught by the
  // pre-commit hook, not by the full-suite run.
  capturePostHogEvent: vi.fn(),
  CLASSIFICATION_CONFIDENCE_LOW_THRESHOLD: 0.7,
  CLASSIFICATION_CONFIDENCE_REROUTE_THRESHOLD: 0.3,
  CORPUS_TOP_SIMILARITY_LOW_THRESHOLD: 0.5,
  VOICE_FIDELITY_LOW_THRESHOLD: 0.5,
}))

// Minimal RuntimeContext factory. retrieveCorpusStage only reads venue.id,
// agentRunId, guest.{id,firstName}, currentMessage, followupTrigger — cast
// the rest as never to avoid hand-building VenueContext / RecognitionSnapshot
// / etc. for a focused test.
// TAC-301: buildAiRuntime reads venue.venueInfo.hours to resolve open/closed.
// Production always has it (buildRuntimeContext safeParses venue_info and
// throws on failure; `hours` carries a .default({})), but every fixture in
// this file casts `venue` partially, so makeCtx backfills it below. Hours are
// deliberately unparseable-by-omission here — an empty hours map resolves to
// 'unknown', which renders no status line, so none of the pre-existing
// assertions in this file shift. Tests that care about open/closed pass their
// own venueInfo and it wins.
const TEST_VENUE_INFO: RuntimeContext['venue']['venueInfo'] = {
  address: { line1: '1 Test St', city: 'Testville', region: 'CA', postalCode: '90000' },
  contact: {},
  hours: {},
  menu: { highlights: [], items: [] },
  staff: [],
  currentContext: [],
}

function makeCtx(overrides: Partial<RuntimeContext>): RuntimeContext {
  const ctx = {
    agentRunId: 'run-1',
    venue: { id: 'venue-1' } as RuntimeContext['venue'],
    guest: { id: 'guest-1', firstName: 'Sam' } as RuntimeContext['guest'],
    currentMessage: null,
    followupTrigger: null,
    pendingQuestion: null,
    recentMessages: [],
    recognition: {} as RuntimeContext['recognition'],
    mechanics: [],
    recentVisits: [],
    activeCommitments: [],
    openIntentions: [],
    corpus: null,
    knowledgeCorpus: null,
    classification: null,
    trace: { id: '' } as RuntimeContext['trace'],
    ...overrides,
  }
  // The `Partial` cast is the honest part: the type says venueInfo is always
  // present, and for production it is, but these fixtures cast `venue`
  // partially so at runtime it frequently isn't. Written as an explicit ??
  // rather than spread ordering so tsc doesn't (correctly) flag the default as
  // unreachable — TS2783.
  const venueInfo =
    (ctx.venue as Partial<RuntimeContext['venue']>).venueInfo ?? TEST_VENUE_INFO
  return { ...ctx, venue: { ...ctx.venue, venueInfo } }
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

describe('shouldRetrieveKnowledge', () => {
  it('returns true on the inbound path (currentMessage present)', () => {
    const ctx = makeCtx({
      currentMessage: { id: 'm1', body: 'hi', providerMessageId: 'p1' } as RuntimeContext['currentMessage'],
    })
    expect(shouldRetrieveKnowledge(ctx)).toBe(true)
  })

  it('returns true for followup reason="event" (substantive outbound)', () => {
    const ctx = makeCtx({
      followupTrigger: { reason: 'event', triggeredAt: new Date() } as RuntimeContext['followupTrigger'],
    })
    expect(shouldRetrieveKnowledge(ctx)).toBe(true)
  })

  it('returns true for followup reason="manual" (operator-authored)', () => {
    const ctx = makeCtx({
      followupTrigger: { reason: 'manual', triggeredAt: new Date() } as RuntimeContext['followupTrigger'],
    })
    expect(shouldRetrieveKnowledge(ctx)).toBe(true)
  })

  it('returns false for routine cron followups (day_1/day_3/day_7/day_14)', () => {
    for (const reason of ['day_1', 'day_3', 'day_7', 'day_14'] as const) {
      const ctx = makeCtx({
        followupTrigger: { reason, triggeredAt: new Date() } as RuntimeContext['followupTrigger'],
      })
      expect(shouldRetrieveKnowledge(ctx)).toBe(false)
    }
  })

  it('returns false when neither inbound nor followup is present', () => {
    const ctx = makeCtx({})
    expect(shouldRetrieveKnowledge(ctx)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// classifyStage — 3-tier confidence routing (TAC-240)
// ---------------------------------------------------------------------------

describe('classifyStage — 3-tier confidence routing (v1.11.0)', () => {
  beforeEach(() => {
    classifyMessageMock.mockReset()
    captureClassificationLowMock.mockReset()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  function makeClassifyCtx(
    overrides: Partial<RuntimeContext> = {},
  ): RuntimeContext {
    return makeCtx({
      currentMessage: {
        id: 'm1',
        body: 'do you have oat milk?',
        providerMessageId: 'p1',
      } as RuntimeContext['currentMessage'],
      recentMessages: [],
      recognition: { state: 'regular' } as RuntimeContext['recognition'],
      ...overrides,
    })
  }

  it('auto-routes to unknown when classifier confidence is below 0.3', async () => {
    classifyMessageMock.mockResolvedValueOnce({
      ok: true,
      data: {
        category: 'recommendation_request',
        classifierConfidence: 0.25,
        reasoning: 'too ambiguous',
        promptVersion: 'v1.13.0',
        crisisSafety: false,
      },
    })
    const out = await classifyStage(makeClassifyCtx())
    // Reroute: shipped category becomes 'unknown'.
    expect(out.category).toBe('unknown')
    // Original confidence + reasoning preserved on the result for observability.
    expect(out.classifierConfidence).toBe(0.25)
    expect(out.reasoning).toBe('too ambiguous')
    // Event fires with the classifier's ORIGINAL pick + autoRoutedToUnknown:true.
    expect(captureClassificationLowMock).toHaveBeenCalledTimes(1)
    const props = captureClassificationLowMock.mock.calls[0][0] as {
      category: string
      classifierConfidence: number
      autoRoutedToUnknown: boolean
    }
    expect(props.category).toBe('recommendation_request')
    expect(props.classifierConfidence).toBe(0.25)
    expect(props.autoRoutedToUnknown).toBe(true)
  })

  it('keeps classifier pick when confidence is between 0.3 and 0.7', async () => {
    classifyMessageMock.mockResolvedValueOnce({
      ok: true,
      data: {
        category: 'recommendation_request',
        classifierConfidence: 0.5,
        reasoning: 'ambiguous but defensible',
        promptVersion: 'v1.13.0',
        crisisSafety: false,
      },
    })
    const out = await classifyStage(makeClassifyCtx())
    expect(out.category).toBe('recommendation_request')
    expect(captureClassificationLowMock).toHaveBeenCalledTimes(1)
    const props = captureClassificationLowMock.mock.calls[0][0] as {
      autoRoutedToUnknown: boolean
    }
    expect(props.autoRoutedToUnknown).toBe(false)
  })

  it('keeps classifier pick and fires no event at confidence 0.7+', async () => {
    classifyMessageMock.mockResolvedValueOnce({
      ok: true,
      data: {
        category: 'recommendation_request',
        classifierConfidence: 0.85,
        reasoning: 'clear',
        promptVersion: 'v1.13.0',
        crisisSafety: false,
      },
    })
    const out = await classifyStage(makeClassifyCtx())
    expect(out.category).toBe('recommendation_request')
    expect(captureClassificationLowMock).not.toHaveBeenCalled()
  })

  it('passes recentMessages and guestState through to classifyMessage', async () => {
    classifyMessageMock.mockResolvedValueOnce({
      ok: true,
      data: {
        category: 'reply',
        classifierConfidence: 0.9,
        reasoning: 'r',
        promptVersion: 'v1.13.0',
        crisisSafety: false,
      },
    })
    const recent = [
      {
        direction: 'inbound' as const,
        body: 'hi',
        createdAt: new Date('2026-05-08T09:55:00Z'),
      },
    ]
    await classifyStage(
      makeClassifyCtx({
        recentMessages: recent,
        recognition: { state: 'raving_fan' } as RuntimeContext['recognition'],
      }),
    )
    expect(classifyMessageMock).toHaveBeenCalledTimes(1)
    const callArg = classifyMessageMock.mock.calls[0][0] as {
      recentMessages: typeof recent
      guestState: string
    }
    expect(callArg.recentMessages).toBe(recent)
    expect(callArg.guestState).toBe('raving_fan')
  })

  // TAC-348: crisisSafety is orthogonal to the confidence-based category
  // reroute above — it must pass through unmodified in all three tiers.
  it('passes crisisSafety=true through unmodified even when confidence triggers the unknown reroute', async () => {
    classifyMessageMock.mockResolvedValueOnce({
      ok: true,
      data: {
        category: 'casual_chatter',
        classifierConfidence: 0.2,
        reasoning: 'ambiguous',
        promptVersion: 'v1.45.0',
        crisisSafety: true,
      },
    })
    const out = await classifyStage(makeClassifyCtx())
    // Category still reroutes to unknown at this confidence tier...
    expect(out.category).toBe('unknown')
    // ...but the crisis signal is never suppressed by that reroute.
    expect(out.crisisSafety).toBe(true)
  })

  it('passes crisisSafety=false through unmodified at high confidence', async () => {
    classifyMessageMock.mockResolvedValueOnce({
      ok: true,
      data: {
        category: 'reply',
        classifierConfidence: 0.9,
        reasoning: 'clear',
        promptVersion: 'v1.45.0',
        crisisSafety: false,
      },
    })
    const out = await classifyStage(makeClassifyCtx())
    expect(out.crisisSafety).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// retrieveKnowledgeStage — tag-aware routing + zero-result fallback (TAC-242)
// ---------------------------------------------------------------------------

describe('retrieveKnowledgeStage — tag-aware routing (v1.12.0)', () => {
  beforeEach(() => {
    retrieveKnowledgeContextMock.mockReset()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  function makeKnowledgeCtx(): RuntimeContext {
    return makeCtx({
      currentMessage: {
        id: 'm1',
        body: 'do you have any free drink perks?',
        providerMessageId: 'p1',
      } as RuntimeContext['currentMessage'],
    })
  }

  function row(id: string, primary: string[]) {
    return {
      id,
      knowledgeCorpusId: `kc-${id}`,
      text: `chunk ${id}`,
      sourceType: 'voicenote_transcript',
      confidence: 0.9,
      similarity: 0.55,
      primaryTags: primary,
      secondaryTags: [],
    }
  }

  it('passes the mapped primaryTagPreference for mechanic_request', async () => {
    retrieveKnowledgeContextMock.mockResolvedValueOnce({
      ok: true,
      data: [row('k1', ['mechanic'])],
    })
    await retrieveKnowledgeStage(makeKnowledgeCtx(), 'mechanic_request')
    expect(retrieveKnowledgeContextMock).toHaveBeenCalledTimes(1)
    const args = retrieveKnowledgeContextMock.mock.calls[0][0] as {
      primaryTagPreference?: string[]
    }
    expect(args.primaryTagPreference).toEqual(['mechanic'])
  })

  it('passes undefined preference for an unmapped category (cosine-only)', async () => {
    retrieveKnowledgeContextMock.mockResolvedValueOnce({ ok: true, data: [] })
    await retrieveKnowledgeStage(makeKnowledgeCtx(), 'reply')
    const args = retrieveKnowledgeContextMock.mock.calls[0][0] as {
      primaryTagPreference?: string[]
    }
    expect(args.primaryTagPreference).toBeUndefined()
  })

  it('passes undefined preference when category is null', async () => {
    retrieveKnowledgeContextMock.mockResolvedValueOnce({ ok: true, data: [] })
    await retrieveKnowledgeStage(makeKnowledgeCtx(), null)
    const args = retrieveKnowledgeContextMock.mock.calls[0][0] as {
      primaryTagPreference?: string[]
    }
    expect(args.primaryTagPreference).toBeUndefined()
  })

  it('falls back to a no-filter retry when preference returns zero matches', async () => {
    // First call (with preference) returns []; second call (no preference)
    // returns a fallback row. The stage should return the fallback rows.
    retrieveKnowledgeContextMock
      .mockResolvedValueOnce({ ok: true, data: [] })
      .mockResolvedValueOnce({ ok: true, data: [row('fallback', ['menu'])] })

    const out = await retrieveKnowledgeStage(makeKnowledgeCtx(), 'mechanic_request')
    expect(retrieveKnowledgeContextMock).toHaveBeenCalledTimes(2)

    const firstArgs = retrieveKnowledgeContextMock.mock.calls[0][0] as {
      primaryTagPreference?: string[]
    }
    const secondArgs = retrieveKnowledgeContextMock.mock.calls[1][0] as {
      primaryTagPreference?: string[]
    }
    expect(firstArgs.primaryTagPreference).toEqual(['mechanic'])
    expect(secondArgs.primaryTagPreference).toBeUndefined()
    expect(out).toHaveLength(1)
    expect(out[0].id).toBe('fallback')
  })

  it('does NOT fall back when no preference was set even on zero matches', async () => {
    // No preference → no fallback retry. One call total.
    retrieveKnowledgeContextMock.mockResolvedValueOnce({ ok: true, data: [] })
    const out = await retrieveKnowledgeStage(makeKnowledgeCtx(), 'reply')
    expect(retrieveKnowledgeContextMock).toHaveBeenCalledTimes(1)
    expect(out).toEqual([])
  })

  it('returns [] and logs warn when the preferenced retrieval errors', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    retrieveKnowledgeContextMock.mockResolvedValueOnce({
      ok: false,
      error: 'voyage timeout',
      errorCode: 'embedding_failed',
    })
    const out = await retrieveKnowledgeStage(makeKnowledgeCtx(), 'mechanic_request')
    expect(out).toEqual([])
    expect(warnSpy).toHaveBeenCalled()
  })

  it('returns [] and logs warn when the fallback retrieval errors', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    retrieveKnowledgeContextMock
      .mockResolvedValueOnce({ ok: true, data: [] })
      .mockResolvedValueOnce({ ok: false, error: 'voyage timeout' })
    const out = await retrieveKnowledgeStage(makeKnowledgeCtx(), 'mechanic_request')
    expect(out).toEqual([])
    expect(warnSpy).toHaveBeenCalledTimes(1)
  })

  // TAC-350: relevance floor. Calibrated at 0.5 against real Le Mil's corpus
  // data — see KNOWLEDGE_RELEVANCE_FLOOR's own comment in stages.ts.
  describe('relevance floor (TAC-350)', () => {
    it('drops all chunks and renders as no-match when every chunk is below the floor', async () => {
      retrieveKnowledgeContextMock.mockResolvedValueOnce({
        ok: true,
        data: [row('weak1', ['other']), row('weak2', ['other'])].map((r) => ({
          ...r,
          similarity: KNOWLEDGE_RELEVANCE_FLOOR - 0.01,
        })),
      })
      const out = await retrieveKnowledgeStage(makeKnowledgeCtx(), 'reply')
      expect(out).toEqual([])
    })

    it('keeps chunks at or above the floor', async () => {
      retrieveKnowledgeContextMock.mockResolvedValueOnce({
        ok: true,
        data: [{ ...row('strong', ['menu']), similarity: KNOWLEDGE_RELEVANCE_FLOOR }],
      })
      const out = await retrieveKnowledgeStage(makeKnowledgeCtx(), 'reply')
      expect(out).toHaveLength(1)
      expect(out[0].id).toBe('strong')
    })

    it('drops only the weak chunks when a mix of strong and weak chunks is returned', async () => {
      retrieveKnowledgeContextMock.mockResolvedValueOnce({
        ok: true,
        data: [
          { ...row('strong', ['menu']), similarity: 0.68 },
          { ...row('weak', ['menu']), similarity: 0.35 },
        ],
      })
      const out = await retrieveKnowledgeStage(makeKnowledgeCtx(), 'reply')
      expect(out).toHaveLength(1)
      expect(out[0].id).toBe('strong')
    })

    it('falls back to the no-filter retry when preferenced results are all below the floor', async () => {
      retrieveKnowledgeContextMock
        .mockResolvedValueOnce({
          ok: true,
          data: [{ ...row('weak', ['mechanic']), similarity: 0.35 }],
        })
        .mockResolvedValueOnce({
          ok: true,
          data: [{ ...row('fallback-strong', ['menu']), similarity: 0.6 }],
        })
      const out = await retrieveKnowledgeStage(makeKnowledgeCtx(), 'mechanic_request')
      expect(retrieveKnowledgeContextMock).toHaveBeenCalledTimes(2)
      expect(out).toHaveLength(1)
      expect(out[0].id).toBe('fallback-strong')
    })

    it('filters the fallback result by the floor too, not just the preferenced call', async () => {
      retrieveKnowledgeContextMock
        .mockResolvedValueOnce({ ok: true, data: [] })
        .mockResolvedValueOnce({
          ok: true,
          data: [{ ...row('fallback-weak', ['menu']), similarity: 0.4 }],
        })
      const out = await retrieveKnowledgeStage(makeKnowledgeCtx(), 'mechanic_request')
      expect(out).toEqual([])
    })
  })
})

// ---------------------------------------------------------------------------
// applyApprovalPolicyStage (TAC-212)
// ---------------------------------------------------------------------------

function makeGenerationResult(
  overrides: Partial<GenerateMessageResult> = {},
): GenerateMessageResult {
  return {
    body: 'yeah, oat and almond.',
    voiceFidelity: 0.85,
    reasoning: 'matches the venue voice',
    requiresOperatorApproval: false,
    approvalReason: '',
    complaintIntent: 'none' as const,
    knowledgeGap: false,
    // TAC-296 / TAC-297: required schema fields. The no-op shapes are `{}`.
    // Stages tests for legacy triggers (fidelity / model_flagged / regex /
    // pending) override `commitment` to exercise the COMMITMENT_TYPE_GATED
    // trigger; leave the default at no-op here.
    contextUpdate: {},
    commitment: {},
    arrivalCapture: {},
    attempts: 1,
    attemptScores: [0.85],
    attemptHistory: [],
    systemPrompt: '',
    userPrompt: '',
    promptVersion: 'v1.16.0',
    dashViolationPersisted: false,
    selfTalkViolationPersisted: false,
    ...overrides,
  }
}

describe('applyApprovalPolicyStage (TAC-212)', () => {
  beforeEach(() => {
    pendingDraftMaybeSingleMock.mockReset()
    // Default: no prior pending draft. Per-test overrides where needed.
    pendingDraftMaybeSingleMock.mockResolvedValue({ data: null, error: null })
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('returns action=send when fidelity >= 0.6, no model flag, no comp match, no prior pending', async () => {
    const decision = await applyApprovalPolicyStage(
      makeCtx({}),
      makeGenerationResult({ voiceFidelity: 0.8 }),
    )
    expect(decision.action).toBe('send')
  })

  it('queues with fidelity_below_auto_send_floor when fidelity in [0.4, 0.6)', async () => {
    const decision = await applyApprovalPolicyStage(
      makeCtx({}),
      makeGenerationResult({ voiceFidelity: 0.45 }),
    )
    expect(decision.action).toBe('queue')
    if (decision.action !== 'queue') return
    expect(decision.triggers).toEqual([APPROVAL_TRIGGERS.FIDELITY_BELOW_AUTO_SEND_FLOOR])
    expect(decision.primaryTrigger).toBe(APPROVAL_TRIGGERS.FIDELITY_BELOW_AUTO_SEND_FLOOR)
    expect(decision.compMatchedPattern).toBeNull()
  })

  it('queues with model_flagged when the model self-flags', async () => {
    const decision = await applyApprovalPolicyStage(
      makeCtx({}),
      makeGenerationResult({
        voiceFidelity: 0.85,
        requiresOperatorApproval: true,
        approvalReason: 'drafted a comp for the burnt latte',
      }),
    )
    expect(decision.action).toBe('queue')
    if (decision.action !== 'queue') return
    expect(decision.triggers).toContain(APPROVAL_TRIGGERS.MODEL_FLAGGED)
    expect(decision.primaryTrigger).toBe(APPROVAL_TRIGGERS.MODEL_FLAGGED)
  })

  it('queues with comp_regex_backstop when body matches comp regex even with model_flagged=false', async () => {
    const decision = await applyApprovalPolicyStage(
      makeCtx({}),
      makeGenerationResult({
        voiceFidelity: 0.85,
        body: "anyway, that one's on us today",
        requiresOperatorApproval: false,
      }),
    )
    expect(decision.action).toBe('queue')
    if (decision.action !== 'queue') return
    expect(decision.triggers).toContain(APPROVAL_TRIGGERS.COMP_REGEX_BACKSTOP)
    expect(decision.primaryTrigger).toBe(APPROVAL_TRIGGERS.COMP_REGEX_BACKSTOP)
    expect(decision.compMatchedPattern).not.toBeNull()
  })

  it('picks comp_regex_backstop as primaryTrigger when both model_flagged AND comp regex fire', async () => {
    const decision = await applyApprovalPolicyStage(
      makeCtx({}),
      makeGenerationResult({
        voiceFidelity: 0.85,
        body: "no charge for this round",
        requiresOperatorApproval: true,
        approvalReason: 'comp for unhappy guest',
      }),
    )
    expect(decision.action).toBe('queue')
    if (decision.action !== 'queue') return
    expect(decision.triggers).toContain(APPROVAL_TRIGGERS.MODEL_FLAGGED)
    expect(decision.triggers).toContain(APPROVAL_TRIGGERS.COMP_REGEX_BACKSTOP)
    expect(decision.primaryTrigger).toBe(APPROVAL_TRIGGERS.COMP_REGEX_BACKSTOP)
  })

  it('queues with previous_pending_held and existingPendingDraftId when a prior pending draft exists', async () => {
    pendingDraftMaybeSingleMock.mockResolvedValueOnce({
      data: { id: 'existing-pending-id', body: 'earlier draft body' },
      error: null,
    })
    const decision = await applyApprovalPolicyStage(
      makeCtx({}),
      makeGenerationResult({ voiceFidelity: 0.85 }),
    )
    expect(decision.action).toBe('queue')
    if (decision.action !== 'queue') return
    expect(decision.triggers).toContain(APPROVAL_TRIGGERS.PREVIOUS_PENDING_HELD)
    // TAC-264: the existing pending row's id is surfaced on the decision so
    // the persist layer can route to UPDATE-in-place rather than INSERT.
    expect(decision.existingPendingDraftId).toBe('existing-pending-id')
  })

  it('returns existingPendingDraftId=null on the queue path when no prior pending exists', async () => {
    pendingDraftMaybeSingleMock.mockResolvedValueOnce({ data: null, error: null })
    const decision = await applyApprovalPolicyStage(
      makeCtx({}),
      makeGenerationResult({
        voiceFidelity: 0.45, // Low fidelity → queue, but no sticky-pending trigger.
      }),
    )
    expect(decision.action).toBe('queue')
    if (decision.action !== 'queue') return
    expect(decision.triggers).toEqual([APPROVAL_TRIGGERS.FIDELITY_BELOW_AUTO_SEND_FLOOR])
    expect(decision.existingPendingDraftId).toBeNull()
  })

  it('composes all four triggers when every condition fires', async () => {
    pendingDraftMaybeSingleMock.mockResolvedValueOnce({
      data: { id: 'existing-pending-id', body: 'earlier draft body' },
      error: null,
    })
    const decision = await applyApprovalPolicyStage(
      makeCtx({}),
      makeGenerationResult({
        voiceFidelity: 0.45,
        body: "the next round's on the house",
        requiresOperatorApproval: true,
        approvalReason: 'comp',
      }),
    )
    expect(decision.action).toBe('queue')
    if (decision.action !== 'queue') return
    expect(decision.triggers).toHaveLength(4)
    expect(decision.triggers).toContain(APPROVAL_TRIGGERS.FIDELITY_BELOW_AUTO_SEND_FLOOR)
    expect(decision.triggers).toContain(APPROVAL_TRIGGERS.MODEL_FLAGGED)
    expect(decision.triggers).toContain(APPROVAL_TRIGGERS.COMP_REGEX_BACKSTOP)
    expect(decision.triggers).toContain(APPROVAL_TRIGGERS.PREVIOUS_PENDING_HELD)
    // comp_regex_backstop wins primaryTrigger per PRIMARY_TRIGGER_PRIORITY.
    expect(decision.primaryTrigger).toBe(APPROVAL_TRIGGERS.COMP_REGEX_BACKSTOP)
    expect(decision.existingPendingDraftId).toBe('existing-pending-id')
  })

  it('fails OPEN when findPendingDraft errors — sends rather than refusing', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    pendingDraftMaybeSingleMock.mockResolvedValueOnce({
      data: null,
      error: { message: 'connection reset' },
    })
    const decision = await applyApprovalPolicyStage(
      makeCtx({}),
      makeGenerationResult({ voiceFidelity: 0.85 }),
    )
    // Clean draft + DB read failed → action=send (no triggers fired). The
    // previous_pending_held check is fail-open by design.
    expect(decision.action).toBe('send')
    expect(warnSpy).toHaveBeenCalled()
  })

  it('fails OPEN when findPendingDraft throws — sends rather than refusing', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    pendingDraftMaybeSingleMock.mockRejectedValueOnce(new Error('admin client init failed'))
    const decision = await applyApprovalPolicyStage(
      makeCtx({}),
      makeGenerationResult({ voiceFidelity: 0.85 }),
    )
    expect(decision.action).toBe('send')
    expect(warnSpy).toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// applyApprovalPolicyStage — per-venue hold_all_outbound (TAC-XXX)
// ---------------------------------------------------------------------------

describe('applyApprovalPolicyStage — hold_all_outbound (TAC-XXX)', () => {
  beforeEach(() => {
    pendingDraftMaybeSingleMock.mockReset()
    pendingDraftMaybeSingleMock.mockResolvedValue({ data: null, error: null })
    captureDemoBypassMock.mockReset()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  // makeCtx casts `venue`, so holdAllOutbound isn't set by default. These
  // helpers make the venue-flag + compliance-category intent explicit.
  function holdVenueCtx(overrides: Partial<RuntimeContext> = {}): RuntimeContext {
    return makeCtx({
      venue: { id: 'venue-1', holdAllOutbound: true } as RuntimeContext['venue'],
      ...overrides,
    })
  }

  function classification(category: string): RuntimeContext['classification'] {
    return {
      category,
      classifierConfidence: 0.95,
      reasoning: 'test',
    } as RuntimeContext['classification']
  }

  it('queues a clean high-fidelity message at a hold venue (the new behavior)', async () => {
    const decision = await applyApprovalPolicyStage(
      holdVenueCtx({ classification: classification('follow_up') }),
      makeGenerationResult({ voiceFidelity: 0.85 }),
    )
    expect(decision.action).toBe('queue')
    if (decision.action !== 'queue') return
    expect(decision.triggers).toEqual([APPROVAL_TRIGGERS.HOLD_ALL_OUTBOUND])
    expect(decision.primaryTrigger).toBe(APPROVAL_TRIGGERS.HOLD_ALL_OUTBOUND)
  })

  it('queues proactive sends when classification is null (no inbound on the followup path)', async () => {
    const decision = await applyApprovalPolicyStage(
      holdVenueCtx({ classification: null }),
      makeGenerationResult({ voiceFidelity: 0.85 }),
    )
    expect(decision.action).toBe('queue')
    if (decision.action !== 'queue') return
    expect(decision.triggers).toContain(APPROVAL_TRIGGERS.HOLD_ALL_OUTBOUND)
  })

  it('does NOT hold an opt_out compliance reply — it sends immediately', async () => {
    const decision = await applyApprovalPolicyStage(
      holdVenueCtx({ classification: classification('opt_out') }),
      makeGenerationResult({ voiceFidelity: 0.85 }),
    )
    expect(decision.action).toBe('send')
  })

  it('still sends a clean message at a non-hold venue (regression guard)', async () => {
    const decision = await applyApprovalPolicyStage(
      makeCtx({ classification: classification('follow_up') }),
      makeGenerationResult({ voiceFidelity: 0.85 }),
    )
    expect(decision.action).toBe('send')
  })

  it('composes with comp regex; a co-firing comp wins primaryTrigger (hold is ranked lowest)', async () => {
    const decision = await applyApprovalPolicyStage(
      holdVenueCtx({ classification: classification('reply') }),
      makeGenerationResult({ voiceFidelity: 0.85, body: "that one's on us today" }),
    )
    expect(decision.action).toBe('queue')
    if (decision.action !== 'queue') return
    expect(decision.triggers).toContain(APPROVAL_TRIGGERS.HOLD_ALL_OUTBOUND)
    expect(decision.triggers).toContain(APPROVAL_TRIGGERS.COMP_REGEX_BACKSTOP)
    expect(decision.primaryTrigger).toBe(APPROVAL_TRIGGERS.COMP_REGEX_BACKSTOP)
  })

  it('an opt_out reply still passes through existing triggers (comp still queues it)', async () => {
    // Carve-out bypasses ONLY the hold flag — the pre-existing triggers are
    // unchanged. A comp-bearing opt_out reply still queues, just not via hold.
    const decision = await applyApprovalPolicyStage(
      holdVenueCtx({ classification: classification('opt_out') }),
      makeGenerationResult({ voiceFidelity: 0.85, body: "no charge for this round" }),
    )
    expect(decision.action).toBe('queue')
    if (decision.action !== 'queue') return
    expect(decision.triggers).not.toContain(APPROVAL_TRIGGERS.HOLD_ALL_OUTBOUND)
    expect(decision.triggers).toContain(APPROVAL_TRIGGERS.COMP_REGEX_BACKSTOP)
  })

  it('preserves regen-in-place: composes with previous_pending_held + surfaces the row id', async () => {
    pendingDraftMaybeSingleMock.mockResolvedValueOnce({
      data: { id: 'existing-pending-id', body: 'earlier draft body' },
      error: null,
    })
    const decision = await applyApprovalPolicyStage(
      holdVenueCtx({ classification: classification('follow_up') }),
      makeGenerationResult({ voiceFidelity: 0.85 }),
    )
    expect(decision.action).toBe('queue')
    if (decision.action !== 'queue') return
    expect(decision.triggers).toContain(APPROVAL_TRIGGERS.HOLD_ALL_OUTBOUND)
    expect(decision.triggers).toContain(APPROVAL_TRIGGERS.PREVIOUS_PENDING_HELD)
    expect(decision.existingPendingDraftId).toBe('existing-pending-id')
  })

  it('demo guest at a hold venue still auto-sends (demo bypass wins)', async () => {
    const decision = await applyApprovalPolicyStage(
      holdVenueCtx({
        classification: classification('follow_up'),
        guest: { id: 'guest-1', firstName: 'Sam', isDemo: true } as RuntimeContext['guest'],
      }),
      makeGenerationResult({ voiceFidelity: 0.85 }),
    )
    expect(decision.action).toBe('send')
    if (decision.action !== 'send') return
    expect(decision.reason).toBe('demo_bypass')
    // The would-have-queued set still records the hold trigger for analytics.
    expect(captureDemoBypassMock).toHaveBeenCalledTimes(1)
    const payload = captureDemoBypassMock.mock.calls[0][0] as { wouldHaveQueuedTriggers: string[] }
    expect(payload.wouldHaveQueuedTriggers).toContain(APPROVAL_TRIGGERS.HOLD_ALL_OUTBOUND)
  })
})

// ---------------------------------------------------------------------------
// applyApprovalPolicyStage — demo guest bypass (TAC-284)
// ---------------------------------------------------------------------------

describe('applyApprovalPolicyStage — demo bypass (TAC-284)', () => {
  beforeEach(() => {
    pendingDraftMaybeSingleMock.mockReset()
    pendingDraftMaybeSingleMock.mockResolvedValue({ data: null, error: null })
    captureDemoBypassMock.mockReset()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  // makeCtx casts `guest`, so isDemo isn't set by default — these helpers
  // make the demo-flag intent explicit at each call site.
  function demoCtx(): RuntimeContext {
    return makeCtx({
      guest: { id: 'guest-1', firstName: 'Sam', isDemo: true } as RuntimeContext['guest'],
    })
  }

  it('short-circuits to send (reason=demo_bypass) when every trigger would have fired', async () => {
    // fidelity band + model flag + comp regex + sticky pending — all four.
    pendingDraftMaybeSingleMock.mockResolvedValueOnce({
      data: { id: 'existing-pending-id', body: 'earlier draft body' },
      error: null,
    })
    const decision = await applyApprovalPolicyStage(
      demoCtx(),
      makeGenerationResult({
        voiceFidelity: 0.45,
        body: "the next round's on the house",
        requiresOperatorApproval: true,
        approvalReason: 'comp',
      }),
    )
    expect(decision.action).toBe('send')
    if (decision.action !== 'send') return
    expect(decision.reason).toBe('demo_bypass')
  })

  it('fires demo_bypassed_approval_gate with the full would-have-queued trigger set', async () => {
    pendingDraftMaybeSingleMock.mockResolvedValueOnce({
      data: { id: 'existing-pending-id', body: 'earlier draft body' },
      error: null,
    })
    await applyApprovalPolicyStage(
      demoCtx(),
      makeGenerationResult({
        voiceFidelity: 0.45,
        body: "the next round's on the house",
        requiresOperatorApproval: true,
        approvalReason: 'comp',
      }),
    )
    expect(captureDemoBypassMock).toHaveBeenCalledTimes(1)
    const payload = captureDemoBypassMock.mock.calls[0][0] as {
      agentRunId: string
      venueId: string
      guestId: string
      wouldHaveQueuedTriggers: string[]
      voiceFidelity: number
      generatedBody: string
    }
    expect(payload.wouldHaveQueuedTriggers).toHaveLength(4)
    expect(payload.wouldHaveQueuedTriggers).toContain(
      APPROVAL_TRIGGERS.FIDELITY_BELOW_AUTO_SEND_FLOOR,
    )
    expect(payload.wouldHaveQueuedTriggers).toContain(APPROVAL_TRIGGERS.MODEL_FLAGGED)
    expect(payload.wouldHaveQueuedTriggers).toContain(APPROVAL_TRIGGERS.COMP_REGEX_BACKSTOP)
    expect(payload.wouldHaveQueuedTriggers).toContain(
      APPROVAL_TRIGGERS.PREVIOUS_PENDING_HELD,
    )
    expect(payload.agentRunId).toBe('run-1')
    expect(payload.venueId).toBe('venue-1')
    expect(payload.guestId).toBe('guest-1')
    expect(payload.voiceFidelity).toBe(0.45)
    expect(payload.generatedBody).toBe("the next round's on the house")
  })

  it('fires the event carrying comp_regex_backstop when only the comp regex would have fired', async () => {
    const decision = await applyApprovalPolicyStage(
      demoCtx(),
      makeGenerationResult({
        voiceFidelity: 0.85,
        body: "anyway, that one's on us today",
        requiresOperatorApproval: false,
      }),
    )
    expect(decision.action).toBe('send')
    expect(captureDemoBypassMock).toHaveBeenCalledTimes(1)
    const payload = captureDemoBypassMock.mock.calls[0][0] as {
      wouldHaveQueuedTriggers: string[]
    }
    expect(payload.wouldHaveQueuedTriggers).toContain(APPROVAL_TRIGGERS.COMP_REGEX_BACKSTOP)
  })

  it('does NOT fire the event for a clean demo reply that would have auto-sent anyway', async () => {
    const decision = await applyApprovalPolicyStage(
      demoCtx(),
      makeGenerationResult({ voiceFidelity: 0.85 }),
    )
    expect(decision.action).toBe('send')
    if (decision.action !== 'send') return
    // Still stamped demo_bypass — every demo send is, even untriggered ones.
    expect(decision.reason).toBe('demo_bypass')
    // ...but no event, because nothing would have queued.
    expect(captureDemoBypassMock).not.toHaveBeenCalled()
  })

  // Fail-closed: only the literal boolean `true` bypasses. Any other value
  // flows through the normal policy. One case per non-true value.
  it.each([
    ['undefined', undefined],
    ['null', null],
    ['false', false],
  ])('fails CLOSED — isDemo=%s with every trigger still queues', async (_label, isDemoValue) => {
    pendingDraftMaybeSingleMock.mockResolvedValueOnce({
      data: { id: 'existing-pending-id', body: 'earlier draft body' },
      error: null,
    })
    const ctx = makeCtx({
      guest: {
        id: 'guest-1',
        firstName: 'Sam',
        isDemo: isDemoValue,
      } as unknown as RuntimeContext['guest'],
    })
    const decision = await applyApprovalPolicyStage(
      ctx,
      makeGenerationResult({
        voiceFidelity: 0.45,
        body: "the next round's on the house",
        requiresOperatorApproval: true,
        approvalReason: 'comp',
      }),
    )
    expect(decision.action).toBe('queue')
    expect(captureDemoBypassMock).not.toHaveBeenCalled()
  })

  it('non-demo guest with every trigger still queues (TAC-212 regression guard)', async () => {
    pendingDraftMaybeSingleMock.mockResolvedValueOnce({
      data: { id: 'existing-pending-id', body: 'earlier draft body' },
      error: null,
    })
    const decision = await applyApprovalPolicyStage(
      makeCtx({
        guest: {
          id: 'guest-1',
          firstName: 'Sam',
          isDemo: false,
        } as RuntimeContext['guest'],
      }),
      makeGenerationResult({
        voiceFidelity: 0.45,
        body: "the next round's on the house",
        requiresOperatorApproval: true,
        approvalReason: 'comp',
      }),
    )
    expect(decision.action).toBe('queue')
    if (decision.action !== 'queue') return
    expect(decision.triggers).toHaveLength(4)
  })
})

// ---------------------------------------------------------------------------
// findPendingDraft (TAC-264 — renamed from hasPendingDraft, returns {id, body} | null)
// ---------------------------------------------------------------------------

describe('findPendingDraft (TAC-264)', () => {
  beforeEach(() => {
    pendingDraftMaybeSingleMock.mockReset()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('returns {id, body} when a pending row exists', async () => {
    pendingDraftMaybeSingleMock.mockResolvedValueOnce({
      data: { id: 'pending-1', body: 'draft body' },
      error: null,
    })
    const out = await findPendingDraft('venue-1', 'guest-1')
    expect(out).toEqual({ id: 'pending-1', body: 'draft body' })
  })

  it('returns null when no pending row exists', async () => {
    pendingDraftMaybeSingleMock.mockResolvedValueOnce({ data: null, error: null })
    const out = await findPendingDraft('venue-1', 'guest-1')
    expect(out).toBeNull()
  })

  it('returns null (fail-open) when the DB read errors', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    pendingDraftMaybeSingleMock.mockResolvedValueOnce({
      data: null,
      error: { message: 'connection reset' },
    })
    const out = await findPendingDraft('venue-1', 'guest-1')
    expect(out).toBeNull()
    expect(warnSpy).toHaveBeenCalled()
  })

  it('returns null (fail-open) when the DB read throws', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    pendingDraftMaybeSingleMock.mockRejectedValueOnce(new Error('client init failed'))
    const out = await findPendingDraft('venue-1', 'guest-1')
    expect(out).toBeNull()
    expect(warnSpy).toHaveBeenCalled()
  })
})

// TAC-244: deriveFollowupContext is the single mapping point between the
// agent's FollowupTrigger + visit data and the AI runtime's FollowupContext
// render payload. Tested directly (rather than through buildAiRuntime) so
// the assertions don't depend on `new Date()` inside buildAiRuntime —
// passing an explicit `now` lets us pin daysSinceLastVisit deterministically.
describe('deriveFollowupContext (TAC-244)', () => {
  const NOW_DERIVE = new Date('2026-04-29T18:30:00Z')
  const visit7 = (overrides: Partial<Visit> = {}): Visit => ({
    items: ['espresso', 'croissant'],
    visitedAt: new Date(NOW_DERIVE.getTime() - 7 * 24 * 60 * 60 * 1000),
    ...overrides,
  })
  const trigger = (reason: FollowupTrigger['reason']): FollowupTrigger => ({
    reason,
    triggeredAt: NOW_DERIVE,
  })

  it('returns undefined when followupTrigger is null (inbound path)', () => {
    expect(deriveFollowupContext(null, [], null, NOW_DERIVE)).toBeUndefined()
  })

  it('maps day_7 → post_visit_day_7 with recentVisits[0] as anchor', () => {
    const out = deriveFollowupContext(trigger('day_7'), [visit7()], null, NOW_DERIVE)
    expect(out).toEqual({
      reasons: ['post_visit_day_7'],
      daysSinceLastVisit: 7,
      anchorVisit: {
        visitedAt: visit7().visitedAt,
        items: ['espresso', 'croissant'],
      },
    })
  })

  it('maps day_1 / day_3 / day_14 correctly', () => {
    expect(deriveFollowupContext(trigger('day_1'), [visit7()], null, NOW_DERIVE)?.reasons).toEqual([
      'post_visit_day_1',
    ])
    expect(deriveFollowupContext(trigger('day_3'), [visit7()], null, NOW_DERIVE)?.reasons).toEqual([
      'post_visit_day_3',
    ])
    expect(deriveFollowupContext(trigger('day_14'), [visit7()], null, NOW_DERIVE)?.reasons).toEqual([
      'post_visit_day_14',
    ])
  })

  it('anchors cold_lapsed from lastVisitAt (items omitted, date-only)', () => {
    const lastVisitAt = new Date(NOW_DERIVE.getTime() - 60 * 24 * 60 * 60 * 1000)
    const out = deriveFollowupContext(trigger('cold_lapsed'), [], lastVisitAt, NOW_DERIVE)
    expect(out).toEqual({
      reasons: ['cold_lapsed'],
      daysSinceLastVisit: 60,
      anchorVisit: { visitedAt: lastVisitAt },
    })
    expect(out?.anchorVisit?.items).toBeUndefined()
  })

  it('cold_lapsed ignores recentVisits[0] (the deep-lapsed case may have stale recentVisits)', () => {
    const lastVisitAt = new Date(NOW_DERIVE.getTime() - 60 * 24 * 60 * 60 * 1000)
    // recentVisits is non-empty (a 7-day-old visit) but cold_lapsed still
    // anchors on lastVisitAt — the trigger reason is the source of truth for
    // which anchor to use.
    const out = deriveFollowupContext(trigger('cold_lapsed'), [visit7()], lastVisitAt, NOW_DERIVE)
    expect(out?.anchorVisit?.visitedAt).toEqual(lastVisitAt)
    expect(out?.daysSinceLastVisit).toBe(60)
  })

  it('returns context with no anchor (defensive) when cold_lapsed + lastVisitAt is null', () => {
    const out = deriveFollowupContext(trigger('cold_lapsed'), [], null, NOW_DERIVE)
    expect(out).toEqual({
      reasons: ['cold_lapsed'],
      daysSinceLastVisit: 0,
      anchorVisit: undefined,
    })
  })

  it('returns context with no anchor (defensive) when post_visit_* + recentVisits empty', () => {
    // The trigger fired (engine decided this guest was due) but recentVisits
    // came back empty for whatever reason. We still return the context — the
    // reason itself carries useful framing — and the serializer omits the
    // anchor line.
    const out = deriveFollowupContext(trigger('day_7'), [], null, NOW_DERIVE)
    expect(out).toEqual({
      reasons: ['post_visit_day_7'],
      daysSinceLastVisit: 0,
      anchorVisit: undefined,
    })
  })

  it('returns undefined for event trigger (dedicated eventBeingInvited surface)', () => {
    expect(deriveFollowupContext(trigger('event'), [visit7()], null, NOW_DERIVE)).toBeUndefined()
  })

  it('returns undefined for manual trigger (dedicated operatorInstruction surface)', () => {
    expect(deriveFollowupContext(trigger('manual'), [visit7()], null, NOW_DERIVE)).toBeUndefined()
  })

  // TAC-123: deriveFollowupContext gained array intake — the engine
  // aggregates multiple FollowupReasons for one guest on one pass.
  it('maps perk_unlock → perk_unlock with lastVisitAt as anchor (no items)', () => {
    const lastVisitAt = new Date(NOW_DERIVE.getTime() - 14 * 24 * 60 * 60 * 1000)
    const out = deriveFollowupContext(trigger('perk_unlock'), [], lastVisitAt, NOW_DERIVE)
    expect(out).toEqual({
      reasons: ['perk_unlock'],
      daysSinceLastVisit: 14,
      anchorVisit: { visitedAt: lastVisitAt },
    })
    expect(out?.anchorVisit?.items).toBeUndefined()
  })

  it('combines primary + additionalReasons into reasons[] in order', () => {
    const out = deriveFollowupContext(
      {
        reason: 'day_7',
        additionalReasons: ['perk_unlock'],
        triggeredAt: NOW_DERIVE,
      },
      [visit7()],
      null,
      NOW_DERIVE,
    )
    expect(out?.reasons).toEqual(['post_visit_day_7', 'perk_unlock'])
    // Mixed run with post_visit_* present → recentVisits[0] anchor wins
    // (carries items).
    expect(out?.anchorVisit?.items).toEqual(['espresso', 'croissant'])
  })

  it('dedups when additionalReasons accidentally includes the primary', () => {
    const out = deriveFollowupContext(
      {
        reason: 'day_7',
        additionalReasons: ['post_visit_day_7', 'perk_unlock'],
        triggeredAt: NOW_DERIVE,
      },
      [visit7()],
      null,
      NOW_DERIVE,
    )
    // post_visit_day_7 appears once (de-duped), perk_unlock after.
    expect(out?.reasons).toEqual(['post_visit_day_7', 'perk_unlock'])
  })

  it('cold_lapsed + perk_unlock anchors on lastVisitAt (no post_visit_* in the set)', () => {
    const lastVisitAt = new Date(NOW_DERIVE.getTime() - 30 * 24 * 60 * 60 * 1000)
    const out = deriveFollowupContext(
      {
        reason: 'cold_lapsed',
        additionalReasons: ['perk_unlock'],
        triggeredAt: NOW_DERIVE,
      },
      [visit7()], // present, but ignored — no post_visit_* in reasons
      lastVisitAt,
      NOW_DERIVE,
    )
    expect(out?.reasons).toEqual(['cold_lapsed', 'perk_unlock'])
    expect(out?.anchorVisit?.visitedAt).toEqual(lastVisitAt)
    expect(out?.anchorVisit?.items).toBeUndefined()
  })

  it('renders valid additionalReasons even when primary maps to null (event/manual)', () => {
    // Defensive: the engine shouldn't normally build a manual/event trigger
    // with additionalReasons attached, but if it does, render the additional
    // reasons rather than dropping the run.
    const out = deriveFollowupContext(
      {
        reason: 'manual',
        additionalReasons: ['perk_unlock'],
        triggeredAt: NOW_DERIVE,
      },
      [],
      null,
      NOW_DERIVE,
    )
    expect(out?.reasons).toEqual(['perk_unlock'])
  })
})

// TAC-301: integration check at the buildAiRuntime seam. Behavioural coverage
// of the resolver lives in lib/schemas/venue-hours.test.ts; this asserts
// buildAiRuntime actually CALLS it with the venue's OWN hours and timezone and
// threads the verdict onto today.openState. The bug this closes was precisely
// a join that nobody made, so the wiring is the thing worth pinning.
describe('buildAiRuntime — open/closed wiring (TAC-301)', () => {
  const LE_MILS_HOURS = {
    monday: '7:00 AM – 3:00 PM',
    tuesday: '7:00 AM – 3:00 PM',
    wednesday: '7:00 AM – 3:00 PM',
    thursday: '7:00 AM – 3:00 PM',
    friday: '7:00 AM – 3:00 PM',
    saturday: '7:00 AM – 3:00 PM',
    sunday: '7:00 AM – 3:00 PM',
  }

  function ctxWithHours(hours: Record<string, string>, timezone = 'America/Los_Angeles') {
    return makeCtx({
      venue: {
        id: 'venue-1',
        timezone,
        venueInfo: { ...TEST_VENUE_INFO, hours },
      } as RuntimeContext['venue'],
      currentMessage: { id: 'm1', body: 'omw' } as RuntimeContext['currentMessage'],
      recognition: { state: 'returning' } as RuntimeContext['recognition'],
    })
  }

  afterEach(() => {
    vi.useRealTimers()
  })

  it('resolves OPEN from the venue hours during business hours', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-11T17:30:00Z')) // Friday 10:30 LA
    const aiRuntime = buildAiRuntime(ctxWithHours(LE_MILS_HOURS))
    expect(aiRuntime.today?.openState).toEqual({ state: 'open', closesAt: '3:00 PM' })
  })

  it('resolves CLOSED after hours — the UAT repro moment', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-12T02:57:00Z')) // Friday 19:57 LA
    const aiRuntime = buildAiRuntime(ctxWithHours(LE_MILS_HOURS))
    expect(aiRuntime.today?.openState).toEqual({
      state: 'closed',
      opensAt: { day: 'tomorrow', time: '7:00 AM' },
    })
  })

  it("uses the venue's timezone, not the server's", () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-11T17:30:00Z'))
    // Same instant: 10:30 in LA (open), 03:30 in Berlin (closed).
    expect(buildAiRuntime(ctxWithHours(LE_MILS_HOURS)).today?.openState?.state).toBe('open')
    expect(
      buildAiRuntime(ctxWithHours(LE_MILS_HOURS, 'Europe/Berlin')).today?.openState?.state,
    ).toBe('closed')
  })

  it('suppresses the verdict entirely when the timezone was substituted', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-11T17:30:00Z'))
    // An invalid timezone falls back to America/Los_Angeles (and red-alerts).
    // Resolving open/closed against a SUBSTITUTED zone would state a confident
    // verdict for a venue that may be nowhere near it — the same wrong-CLOSED
    // the resolver's own governing rule exists to prevent, arriving through
    // the one input the resolver never gets to see is wrong.
    const aiRuntime = buildAiRuntime(ctxWithHours(LE_MILS_HOURS, 'Not/AZone'))
    expect(aiRuntime.today?.openState).toEqual({ state: 'unknown' })
  })

  it('resolves unknown when the venue has no usable hours', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-11T17:30:00Z'))
    const aiRuntime = buildAiRuntime(ctxWithHours({}))
    expect(aiRuntime.today?.openState).toEqual({ state: 'unknown' })
  })

  it('reports the clock and the verdict from the same instant', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-11T17:30:00Z'))
    const aiRuntime = buildAiRuntime(ctxWithHours(LE_MILS_HOURS))
    expect(aiRuntime.today?.venueLocalTime).toBe('10:30')
    expect(aiRuntime.today?.openState?.state).toBe('open')
  })
})

// TAC-244: integration check at the buildAiRuntime seam — wired correctly.
// Most behavioral coverage lives on deriveFollowupContext (deterministic now);
// this asserts buildAiRuntime actually CALLS the helper and threads its
// output onto the AI runtime under the expected field name.
describe('buildAiRuntime — followup field wiring (TAC-244)', () => {
  it('threads deriveFollowupContext output through to the AI runtime', () => {
    const visitedAt = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)
    const ctx = makeCtx({
      venue: {
        id: 'venue-1',
        timezone: 'America/New_York',
      } as RuntimeContext['venue'],
      guest: {
        id: 'guest-1',
        firstName: 'Sam',
        lastVisitAt: null,
      } as RuntimeContext['guest'],
      followupTrigger: { reason: 'day_7', triggeredAt: new Date() } as RuntimeContext['followupTrigger'],
      recentVisits: [{ items: ['espresso'], visitedAt }],
      recognition: { state: 'returning' } as RuntimeContext['recognition'],
    })
    const aiRuntime = buildAiRuntime(ctx)
    expect(aiRuntime.followup?.reasons).toEqual(['post_visit_day_7'])
    expect(aiRuntime.followup?.anchorVisit?.items).toEqual(['espresso'])
  })

  it('leaves followup undefined on the inbound path', () => {
    const ctx = makeCtx({
      venue: {
        id: 'venue-1',
        timezone: 'America/New_York',
      } as RuntimeContext['venue'],
      guest: {
        id: 'guest-1',
        firstName: 'Sam',
        lastVisitAt: null,
      } as RuntimeContext['guest'],
      currentMessage: {
        id: 'm1',
        body: 'hi',
        providerMessageId: 'p1',
      } as RuntimeContext['currentMessage'],
      recognition: { state: 'returning' } as RuntimeContext['recognition'],
    })
    const aiRuntime = buildAiRuntime(ctx)
    expect(aiRuntime.followup).toBeUndefined()
  })

  // TAC-123: when the engine attaches a perkMechanic to a perk_unlock
  // trigger, buildAiRuntime threads it onto the AI runtime as
  // `perkBeingUnlocked`. First production wiring of that field.
  it('threads followupTrigger.perkMechanic → aiRuntime.perkBeingUnlocked', () => {
    const ctx = makeCtx({
      venue: {
        id: 'venue-1',
        timezone: 'America/New_York',
      } as RuntimeContext['venue'],
      guest: {
        id: 'guest-1',
        firstName: 'Sam',
        lastVisitAt: null,
      } as RuntimeContext['guest'],
      followupTrigger: {
        reason: 'perk_unlock',
        triggeredAt: new Date(),
        perkMechanic: {
          id: 'mech-1',
          type: 'perk',
          name: 'The Joey',
          description: 'small black coffee',
          qualification: 'regulars who keep coming back',
          rewardDescription: 'one free Joey on us',
          minState: 'regular',
          requiresOperatorApproval: false,
        },
      } as RuntimeContext['followupTrigger'],
      recognition: { state: 'regular' } as RuntimeContext['recognition'],
    })
    const aiRuntime = buildAiRuntime(ctx)
    expect(aiRuntime.perkBeingUnlocked).toEqual({
      name: 'The Joey',
      qualification: 'regulars who keep coming back',
      rewardDescription: 'one free Joey on us',
    })
  })

  it('coerces null qualification / rewardDescription to empty strings for perkBeingUnlocked', () => {
    const ctx = makeCtx({
      venue: {
        id: 'venue-1',
        timezone: 'America/New_York',
      } as RuntimeContext['venue'],
      guest: {
        id: 'guest-1',
        firstName: 'Sam',
        lastVisitAt: null,
      } as RuntimeContext['guest'],
      followupTrigger: {
        reason: 'perk_unlock',
        triggeredAt: new Date(),
        perkMechanic: {
          id: 'mech-2',
          type: 'perk',
          name: 'Pastry on the house',
          description: null,
          qualification: null,
          rewardDescription: null,
          minState: null,
          requiresOperatorApproval: false,
        },
      } as RuntimeContext['followupTrigger'],
      recognition: { state: 'returning' } as RuntimeContext['recognition'],
    })
    const aiRuntime = buildAiRuntime(ctx)
    expect(aiRuntime.perkBeingUnlocked).toEqual({
      name: 'Pastry on the house',
      qualification: '',
      rewardDescription: '',
    })
  })

  it('leaves perkBeingUnlocked undefined when followupTrigger has no perkMechanic', () => {
    const ctx = makeCtx({
      venue: {
        id: 'venue-1',
        timezone: 'America/New_York',
      } as RuntimeContext['venue'],
      guest: {
        id: 'guest-1',
        firstName: 'Sam',
        lastVisitAt: null,
      } as RuntimeContext['guest'],
      followupTrigger: { reason: 'day_7', triggeredAt: new Date() } as RuntimeContext['followupTrigger'],
      recentVisits: [{ items: ['espresso'], visitedAt: new Date(Date.now() - 7 * 86_400_000) }],
      recognition: { state: 'returning' } as RuntimeContext['recognition'],
    })
    const aiRuntime = buildAiRuntime(ctx)
    expect(aiRuntime.perkBeingUnlocked).toBeUndefined()
  })
})

describe('buildAiRuntime — first-touch intentions wiring (TAC-324)', () => {
  const FRESH = new Date() // "now" for createdAt, well inside every window
  const STALE = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) // 30 days ago

  function qrScanCtx(overrides: Partial<RuntimeContext> = {}): RuntimeContext {
    return makeCtx({
      venue: { id: 'venue-1', timezone: 'America/New_York' } as RuntimeContext['venue'],
      guest: {
        id: 'guest-1',
        firstName: 'Sam',
        createdVia: 'qr_scan',
        createdAt: FRESH,
        lastVisitAt: null,
      } as RuntimeContext['guest'],
      currentMessage: {
        id: 'm1',
        body: 'hi',
        providerMessageId: 'p1',
      } as RuntimeContext['currentMessage'],
      recentMessages: [],
      recognition: { state: 'new' } as RuntimeContext['recognition'],
      ...overrides,
    })
  }

  it('is true for a fresh qr_scan guest\'s first inbound', () => {
    const aiRuntime = buildAiRuntime(qrScanCtx())
    expect(aiRuntime.firstTouchAfterQrScan).toBe(true)
  })

  it('is false on the followup path (no currentMessage)', () => {
    const aiRuntime = buildAiRuntime(qrScanCtx({ currentMessage: null }))
    expect(aiRuntime.firstTouchAfterQrScan).toBe(false)
  })

  it('is false when the guest was not created via qr_scan', () => {
    const ctx = qrScanCtx()
    const aiRuntime = buildAiRuntime({
      ...ctx,
      guest: { ...ctx.guest, createdVia: 'inbound_message' },
    })
    expect(aiRuntime.firstTouchAfterQrScan).toBe(false)
  })

  it('is false when the guest has other recent messages (not their first inbound)', () => {
    const aiRuntime = buildAiRuntime(
      qrScanCtx({
        recentMessages: [{ direction: 'inbound', body: 'earlier', createdAt: new Date() }],
      }),
    )
    expect(aiRuntime.firstTouchAfterQrScan).toBe(false)
  })

  it('is false once the guest is outside the freshness window, even with recentMessages still empty', () => {
    const ctx = qrScanCtx()
    const aiRuntime = buildAiRuntime({
      ...ctx,
      guest: { ...ctx.guest, createdAt: STALE },
    })
    expect(aiRuntime.firstTouchAfterQrScan).toBe(false)
  })

  it('maps ctx.openIntentions promptLines onto aiRuntime.openIntentions', () => {
    const ctx = qrScanCtx({
      openIntentions: [
        { key: 'learn_first_order', promptLine: "You haven't heard what this guest ordered yet." },
        { key: 'invite_contact_save', promptLine: "You haven't told them to save your number." },
      ],
    })
    const aiRuntime = buildAiRuntime(ctx)
    expect(aiRuntime.openIntentions).toEqual([
      "You haven't heard what this guest ordered yet.",
      "You haven't told them to save your number.",
    ])
  })

  it('leaves aiRuntime.openIntentions undefined when ctx.openIntentions is empty', () => {
    const aiRuntime = buildAiRuntime(qrScanCtx({ openIntentions: [] }))
    expect(aiRuntime.openIntentions).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// applyApprovalPolicyStage — complaint commitment floor (v1.23.0)
// ---------------------------------------------------------------------------
//
// Reproduces the 2026-08-07 production incident at the gate level. The pure
// predicate is covered in complaint-floor.test.ts against the full history of
// comp_complaint bodies; these tests cover the WIRING — that the floor fires
// independently of the model's self-assessment, and that its category scope
// keeps ordinary refusals out.

describe('applyApprovalPolicyStage — complaint_commitment_floor (v1.23.0)', () => {
  beforeEach(() => {
    pendingDraftMaybeSingleMock.mockReset()
    pendingDraftMaybeSingleMock.mockResolvedValue({ data: null, error: null })
    captureDemoBypassMock.mockReset()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  function complaintCtx(): RuntimeContext {
    return makeCtx({
      classification: {
        category: 'comp_complaint',
        classifierConfidence: 0.95,
        reasoning: 'quality complaint',
      } as RuntimeContext['classification'],
    })
  }

  // THE INCIDENT. Every field here is what production actually produced:
  // body verbatim, voiceFidelity 0.72, requiresOperatorApproval false,
  // commitment {} — the model reported no commitment and no need for
  // approval, and the draft auto-sent with review_reason NULL.
  it('queues the exact draft that shipped unreviewed on 2026-08-07', async () => {
    const decision = await applyApprovalPolicyStage(
      complaintCtx(),
      makeGenerationResult({
        body: "Matcha can be tricky to dial in. Come by and I'll have another made for you.",
        voiceFidelity: 0.72,
        requiresOperatorApproval: false,
        commitment: {},
      }),
    )
    expect(decision.action).toBe('queue')
    if (decision.action !== 'queue') return
    // v1.24.0: this draft now trips TWO independent gates — the content-based
    // floor AND category routing. Defence in depth: either alone would have
    // caught it. The floor still wins primaryTrigger because it names a
    // concrete promise in this specific message, which is more useful to an
    // operator than "the category is routed."
    expect(decision.triggers).toContain(APPROVAL_TRIGGERS.COMPLAINT_COMMITMENT_FLOOR)
    expect(decision.triggers).toContain(APPROVAL_TRIGGERS.CATEGORY_REQUIRES_APPROVAL)
    expect(decision.primaryTrigger).toBe(APPROVAL_TRIGGERS.COMPLAINT_COMMITMENT_FLOOR)
  })

  it('fires without consulting the model self-flag or the commitment emission', async () => {
    // Same assertion as above stated as an invariant: the model saying "I
    // committed nothing" must not be able to suppress the floor. If this ever
    // starts depending on generation state, the floor has stopped being a
    // floor.
    const decision = await applyApprovalPolicyStage(
      complaintCtx(),
      makeGenerationResult({
        body: "come in and I'll make it right",
        voiceFidelity: 0.95,
        requiresOperatorApproval: false,
        commitment: {},
      }),
    )
    expect(decision.action).toBe('queue')
  })

  // v1.24.0: a clarifying question still auto-sends, but it now requires the
  // model to SAY it is clarifying. Category routing queues comp_complaint by
  // default, and complaintIntent is the only exemption — the fixture default
  // of 'none' correctly queues, so this test states the intent explicitly.
  // Making a guest wait on an operator before you'll even ask what went wrong
  // is worse service than the cold reply v1.24.0 exists to fix.
  it('lets a declared clarifying question on a complaint auto-send', async () => {
    const decision = await applyApprovalPolicyStage(
      complaintCtx(),
      makeGenerationResult({
        body: 'What was off with it? I want to make sure I understand before we figure out next steps.',
        voiceFidelity: 0.82,
        complaintIntent: 'clarifying',
      }),
    )
    expect(decision.action).toBe('send')
  })

  it('queues that same question when the model does NOT declare it clarifying', async () => {
    const decision = await applyApprovalPolicyStage(
      complaintCtx(),
      makeGenerationResult({
        body: 'What was off with it? I want to make sure I understand before we figure out next steps.',
        voiceFidelity: 0.82,
        complaintIntent: 'resolving',
      }),
    )
    expect(decision.action).toBe('queue')
    if (decision.action !== 'queue') return
    expect(decision.primaryTrigger).toBe(APPROVAL_TRIGGERS.CATEGORY_REQUIRES_APPROVAL)
  })

  // The regression guard that matters most: a widened gate that queues
  // ordinary refusals is a worse bug than the one being fixed. Both bodies
  // are real production replies from the same UAT session.
  it('does not touch mechanic_request refusals, however they are worded', async () => {
    const refusalCtx = makeCtx({
      classification: {
        category: 'mechanic_request',
        classifierConfidence: 0.95,
        reasoning: 'perk request',
      } as RuntimeContext['classification'],
    })
    for (const body of [
      'Not something we do on request, sorry.',
      "We don't do holds on bags, but we're usually well stocked. Come by and it'll be there.",
    ]) {
      const decision = await applyApprovalPolicyStage(
        refusalCtx,
        makeGenerationResult({ body, voiceFidelity: 0.82 }),
      )
      expect(decision.action, `should auto-send: ${body}`).toBe('send')
    }
  })

  it('yields the label to commitment_type_gated when both fire', async () => {
    const decision = await applyApprovalPolicyStage(
      complaintCtx(),
      makeGenerationResult({
        body: "Come by and I'll have another made for you.",
        commitment: { type: 'comp', description: 'replacement matcha' },
      }),
    )
    expect(decision.action).toBe('queue')
    if (decision.action !== 'queue') return
    expect(decision.triggers).toContain(APPROVAL_TRIGGERS.COMPLAINT_COMMITMENT_FLOOR)
    expect(decision.triggers).toContain(APPROVAL_TRIGGERS.COMMITMENT_TYPE_GATED)
    // More specific signal wins the operator-facing review_reason.
    expect(decision.primaryTrigger).toBe(APPROVAL_TRIGGERS.COMMITMENT_TYPE_GATED)
  })

  it('outranks previous_pending_held so a regenerated promise still pushes', async () => {
    pendingDraftMaybeSingleMock.mockResolvedValue({
      data: { id: 'existing-draft' },
      error: null,
    })
    const decision = await applyApprovalPolicyStage(
      complaintCtx(),
      makeGenerationResult({ body: "come by and I'll make it right" }),
    )
    expect(decision.action).toBe('queue')
    if (decision.action !== 'queue') return
    expect(decision.primaryTrigger).toBe(APPROVAL_TRIGGERS.COMPLAINT_COMMITMENT_FLOOR)
  })
})

// ---------------------------------------------------------------------------
// TAC-308: knowledge-gap trigger + protected-card resolution
// ---------------------------------------------------------------------------

describe('applyApprovalPolicyStage — knowledge_gap trigger (TAC-308)', () => {
  beforeEach(() => {
    pendingDraftMaybeSingleMock.mockReset()
    pendingDraftMaybeSingleMock.mockResolvedValue({ data: null, error: null })
  })

  const inboundCtx = () =>
    makeCtx({
      currentMessage: {
        id: 'inbound-1',
        body: 'what grade is the matcha?',
        providerMessageId: 'p1',
        receivedAt: new Date(),
      },
      classification: {
        category: 'new_question',
        classifierConfidence: 0.9,
        reasoning: 'question',
        crisisSafety: false,
      },
    })

  it('queues and arms the clock when the model reports a knowledge gap', async () => {
    const decision = await applyApprovalPolicyStage(
      inboundCtx(),
      makeGenerationResult({ knowledgeGap: true }),
    )
    expect(decision.action).toBe('queue')
    if (decision.action !== 'queue') return
    expect(decision.triggers).toContain(APPROVAL_TRIGGERS.KNOWLEDGE_GAP)
    expect(decision.primaryTrigger).toBe(APPROVAL_TRIGGERS.KNOWLEDGE_GAP)
    // The clock is the whole point: without pendingUntil the card sits in the
    // queue forever and the guest never hears anything.
    expect(decision.pendingUntil).toBeInstanceOf(Date)
  })

  it('sends normally when the model reports no gap', async () => {
    const decision = await applyApprovalPolicyStage(
      inboundCtx(),
      makeGenerationResult({ knowledgeGap: false }),
    )
    expect(decision.action).toBe('send')
  })

  // A cron followup has no guest question outstanding. Arming a clock there
  // would produce a holding message for something nobody asked.
  it('does NOT fire on the outbound path even when the model sets the flag', async () => {
    const decision = await applyApprovalPolicyStage(
      makeCtx({
        currentMessage: null,
        followupTrigger: { reason: 'day_7', triggeredAt: new Date() },
      }),
      makeGenerationResult({ knowledgeGap: true }),
    )
    expect(decision.action).toBe('send')
  })

  // Ranked second, below commitment_type_gated. The ticket asked for "top",
  // but that was reasoning about the timer — and the timer anchors on
  // pending_until, not on this label. A comp losing its label is worse.
  it('yields the operator label to commitment_type_gated when both fire', async () => {
    const decision = await applyApprovalPolicyStage(
      inboundCtx(),
      makeGenerationResult({
        knowledgeGap: true,
        commitment: { type: 'comp', description: 'oat latte' },
      }),
    )
    expect(decision.action).toBe('queue')
    if (decision.action !== 'queue') return
    expect(decision.triggers).toContain(APPROVAL_TRIGGERS.KNOWLEDGE_GAP)
    expect(decision.primaryTrigger).toBe(APPROVAL_TRIGGERS.COMMITMENT_TYPE_GATED)
    // ...but it still gets a clock. The label and the timer are independent,
    // which is the entire reason the scan keys on pending_until.
    expect(decision.pendingUntil).toBeInstanceOf(Date)
  })

  it('outranks everything that is not a structured commitment', async () => {
    const decision = await applyApprovalPolicyStage(
      inboundCtx(),
      makeGenerationResult({
        knowledgeGap: true,
        voiceFidelity: 0.45,
        requiresOperatorApproval: true,
        approvalReason: 'unsure',
      }),
    )
    expect(decision.action).toBe('queue')
    if (decision.action !== 'queue') return
    expect(decision.primaryTrigger).toBe(APPROVAL_TRIGGERS.KNOWLEDGE_GAP)
  })
})

describe('applyApprovalPolicyStage — knowledge_gap_backstop trigger (TAC-350)', () => {
  beforeEach(() => {
    pendingDraftMaybeSingleMock.mockReset()
    pendingDraftMaybeSingleMock.mockResolvedValue({ data: null, error: null })
  })

  const inboundCtx = () =>
    makeCtx({
      currentMessage: {
        id: 'inbound-1',
        body: 'what are the four SoFi variations?',
        providerMessageId: 'p1',
        receivedAt: new Date(),
      },
      classification: {
        category: 'new_question',
        classifierConfidence: 0.9,
        reasoning: 'question',
        crisisSafety: false,
      },
    })

  it('queues, arms the clock, and blanks the body when the backstop catches an unverified claim', async () => {
    const decision = await applyApprovalPolicyStage(
      inboundCtx(),
      makeGenerationResult({ knowledgeGap: false }),
      { claims: ['invents four SoFi variation names not in the corpus'] },
    )
    expect(decision.action).toBe('queue')
    if (decision.action !== 'queue') return
    expect(decision.triggers).toContain(APPROVAL_TRIGGERS.KNOWLEDGE_GAP_BACKSTOP)
    expect(decision.primaryTrigger).toBe(APPROVAL_TRIGGERS.KNOWLEDGE_GAP_BACKSTOP)
    expect(decision.pendingUntil).toBeInstanceOf(Date)
    expect(decision.blankBody).toBe(true)
  })

  it('sends normally when there is no backstop finding (null)', async () => {
    const decision = await applyApprovalPolicyStage(
      inboundCtx(),
      makeGenerationResult({ knowledgeGap: false }),
      null,
    )
    expect(decision.action).toBe('send')
  })

  it('sends normally when the third argument is omitted (backward compatible default)', async () => {
    const decision = await applyApprovalPolicyStage(
      inboundCtx(),
      makeGenerationResult({ knowledgeGap: false }),
    )
    expect(decision.action).toBe('send')
  })

  // The two triggers are mutually exclusive by construction (the backstop is
  // only ever invoked by the orchestrator when knowledgeGap is false), but
  // the gate itself must not assume that — it should handle whatever it's
  // given. commitment_type_gated still outranks the backstop, same as it
  // outranks the self-reported trigger.
  it('yields the operator label to commitment_type_gated when both fire', async () => {
    const decision = await applyApprovalPolicyStage(
      inboundCtx(),
      makeGenerationResult({
        knowledgeGap: false,
        commitment: { type: 'comp', description: 'oat latte' },
      }),
      { claims: ['invents a fact'] },
    )
    expect(decision.action).toBe('queue')
    if (decision.action !== 'queue') return
    expect(decision.triggers).toContain(APPROVAL_TRIGGERS.KNOWLEDGE_GAP_BACKSTOP)
    expect(decision.primaryTrigger).toBe(APPROVAL_TRIGGERS.COMMITMENT_TYPE_GATED)
    expect(decision.pendingUntil).toBeInstanceOf(Date)
    // Blanking still fires — the comp detail survives on pending_commitment,
    // not on the body, same rule TAC-309 already established for the
    // self-reported case.
    expect(decision.blankBody).toBe(true)
  })

  it('outranks fidelity_below_auto_send_floor for the operator label', async () => {
    const decision = await applyApprovalPolicyStage(
      inboundCtx(),
      makeGenerationResult({ knowledgeGap: false, voiceFidelity: 0.45 }),
      { claims: ['invents a fact'] },
    )
    expect(decision.action).toBe('queue')
    if (decision.action !== 'queue') return
    expect(decision.primaryTrigger).toBe(APPROVAL_TRIGGERS.KNOWLEDGE_GAP_BACKSTOP)
  })

  // A backstop-caught turn must protect the card and preserve the clock on
  // regen, identically to a self-reported gap turn (TAC-308 case 3 / case 2
  // shape, now exercised via the backstop path).
  it('preserves an existing gap card\'s clock when regenerated via a fresh backstop catch', async () => {
    const gapCard = {
      id: 'gap-card-1',
      body: 'best guess at the answer',
      pending_until: new Date(Date.now() + 60_000).toISOString(),
      review_reason: APPROVAL_TRIGGERS.KNOWLEDGE_GAP_BACKSTOP,
    }
    pendingDraftMaybeSingleMock.mockResolvedValue({ data: gapCard, error: null })
    const decision = await applyApprovalPolicyStage(
      inboundCtx(),
      makeGenerationResult({ knowledgeGap: false }),
      { claims: ['invents a different fact this turn'] },
    )
    expect(decision.action).toBe('queue')
    if (decision.action !== 'queue') return
    expect(decision.existingPendingDraftId).toBe('gap-card-1')
    expect(decision.pendingUntil).toBeUndefined()
    expect(decision.blankBody).toBe(true)
  })

  // A self-reported gap card must not be dropped by a turn the BACKSTOP (not
  // self-report) catches — both are "gapping itself" from the card-
  // protection carve-out's point of view.
  it('does not drop an existing self-reported gap card when this turn is caught by the backstop instead', async () => {
    const gapCard = {
      id: 'gap-card-1',
      body: 'best guess at the answer',
      pending_until: new Date(Date.now() + 60_000).toISOString(),
      review_reason: APPROVAL_TRIGGERS.KNOWLEDGE_GAP,
    }
    pendingDraftMaybeSingleMock.mockResolvedValue({ data: gapCard, error: null })
    const decision = await applyApprovalPolicyStage(
      inboundCtx(),
      makeGenerationResult({ knowledgeGap: false }),
      { claims: ['a different unverified claim'] },
    )
    expect(decision.action).toBe('queue')
    if (decision.action !== 'queue') return
    expect(decision.existingPendingDraftId).toBe('gap-card-1')
  })
})

describe('verifyGroundingStage (TAC-350)', () => {
  beforeEach(() => {
    verifyGroundingMock.mockReset()
    captureUngroundedClaimCaughtMock.mockReset()
  })

  const inboundCtx = (overrides: Partial<RuntimeContext> = {}) =>
    makeCtx({
      currentMessage: {
        id: 'inbound-1',
        body: "what's the wifi password?",
        providerMessageId: 'p1',
        receivedAt: new Date(),
      },
      knowledgeCorpus: [],
      ...overrides,
    })

  function makeGen(overrides: { knowledgeGap?: boolean; body?: string } = {}) {
    return { knowledgeGap: false, body: 'Le Mils Guest', ...overrides }
  }

  it('returns null without calling the model on the outbound (followup) path', async () => {
    const ctx = makeCtx({ currentMessage: null, followupTrigger: { reason: 'day_7', triggeredAt: new Date() } })
    const result = await verifyGroundingStage(ctx, makeGen())
    expect(result).toBeNull()
    expect(verifyGroundingMock).not.toHaveBeenCalled()
  })

  it('returns null without calling the model for a demo guest', async () => {
    const ctx = inboundCtx({ guest: { id: 'guest-1', firstName: 'Sam', isDemo: true } as RuntimeContext['guest'] })
    const result = await verifyGroundingStage(ctx, makeGen())
    expect(result).toBeNull()
    expect(verifyGroundingMock).not.toHaveBeenCalled()
  })

  it('returns null without calling the model when the generation already self-reported a gap', async () => {
    const result = await verifyGroundingStage(inboundCtx(), makeGen({ knowledgeGap: true }))
    expect(result).toBeNull()
    expect(verifyGroundingMock).not.toHaveBeenCalled()
  })

  it('returns null and logs a warning when the model call degrades (fail-open)', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    verifyGroundingMock.mockResolvedValueOnce({ ok: false, error: 'model unavailable' })
    const result = await verifyGroundingStage(inboundCtx(), makeGen())
    expect(result).toBeNull()
    expect(warnSpy).toHaveBeenCalled()
  })

  it('returns null and does NOT fire the PostHog event when nothing is found', async () => {
    verifyGroundingMock.mockResolvedValueOnce({
      ok: true,
      data: { hasUngroundedClaim: false, ungroundedClaims: [], promptVersion: 'v1.0.0' },
    })
    const result = await verifyGroundingStage(inboundCtx(), makeGen())
    expect(result).toBeNull()
    expect(captureUngroundedClaimCaughtMock).not.toHaveBeenCalled()
  })

  it('returns the finding and fires the PostHog event when the backstop catches something', async () => {
    verifyGroundingMock.mockResolvedValueOnce({
      ok: true,
      data: {
        hasUngroundedClaim: true,
        ungroundedClaims: ['invents a wifi network name and password'],
        promptVersion: 'v1.0.0',
      },
    })
    const result = await verifyGroundingStage(inboundCtx(), makeGen())
    expect(result).toEqual({ claims: ['invents a wifi network name and password'] })
    expect(captureUngroundedClaimCaughtMock).toHaveBeenCalledTimes(1)
    const call = captureUngroundedClaimCaughtMock.mock.calls[0][0]
    expect(call.ungroundedClaims).toEqual(['invents a wifi network name and password'])
    expect(call.replyBody).toBe('Le Mils Guest')
  })

  it('passes ctx.knowledgeCorpus through to the verifier as knowledgeChunks', async () => {
    verifyGroundingMock.mockResolvedValueOnce({
      ok: true,
      data: { hasUngroundedClaim: false, ungroundedClaims: [], promptVersion: 'v1.0.0' },
    })
    const chunk = {
      id: 'k1',
      knowledgeCorpusId: 'kc1',
      text: 'chunk',
      sourceType: 'x',
      confidence: 0.9,
      primaryTags: [],
      secondaryTags: [],
      similarity: 0.6,
    }
    await verifyGroundingStage(inboundCtx({ knowledgeCorpus: [chunk] as RuntimeContext['knowledgeCorpus'] }), makeGen())
    expect(verifyGroundingMock).toHaveBeenCalledTimes(1)
    const args = verifyGroundingMock.mock.calls[0][0] as { knowledgeChunks?: unknown[] }
    expect(args.knowledgeChunks).toEqual([chunk])
  })
})

describe('isModelFlagged / isCommitmentTypeGated (TAC-355)', () => {
  it('isModelFlagged is true only when requiresOperatorApproval is true', () => {
    expect(isModelFlagged(makeGenerationResult({ requiresOperatorApproval: true }))).toBe(true)
    expect(isModelFlagged(makeGenerationResult({ requiresOperatorApproval: false }))).toBe(false)
  })

  it('isCommitmentTypeGated requires both a gated type AND a non-empty description', () => {
    expect(
      isCommitmentTypeGated(
        makeGenerationResult({ commitment: { type: 'comp', description: 'oat latte' } }),
      ),
    ).toBe(true)
    expect(
      isCommitmentTypeGated(makeGenerationResult({ commitment: { type: 'comp', description: '' } })),
    ).toBe(false)
    expect(
      isCommitmentTypeGated(
        makeGenerationResult({ commitment: { type: 'recommendation', description: 'the duck' } }),
      ),
    ).toBe(false)
    expect(isCommitmentTypeGated(makeGenerationResult({ commitment: {} }))).toBe(false)
  })
})

describe('applyApprovalPolicyStage — self_talk_detected trigger (TAC-355)', () => {
  beforeEach(() => {
    pendingDraftMaybeSingleMock.mockReset()
    pendingDraftMaybeSingleMock.mockResolvedValue({ data: null, error: null })
  })

  it('queues with self_talk_detected when the generation persisted self-talk', async () => {
    const decision = await applyApprovalPolicyStage(
      makeCtx({}),
      makeGenerationResult({ selfTalkViolationPersisted: true }),
    )
    expect(decision.action).toBe('queue')
    if (decision.action !== 'queue') return
    expect(decision.triggers).toContain(APPROVAL_TRIGGERS.SELF_TALK_DETECTED)
    expect(decision.primaryTrigger).toBe(APPROVAL_TRIGGERS.SELF_TALK_DETECTED)
  })

  it('does not queue for self-talk when the flag is false', async () => {
    const decision = await applyApprovalPolicyStage(
      makeCtx({}),
      makeGenerationResult({ selfTalkViolationPersisted: false }),
    )
    expect(decision.action).toBe('send')
  })

  it('ranks below model_flagged / comp_regex_backstop / commitment_type_gated for the operator label', async () => {
    const decision = await applyApprovalPolicyStage(
      makeCtx({}),
      makeGenerationResult({
        selfTalkViolationPersisted: true,
        commitment: { type: 'comp', description: 'oat latte' },
      }),
    )
    expect(decision.action).toBe('queue')
    if (decision.action !== 'queue') return
    expect(decision.triggers).toContain(APPROVAL_TRIGGERS.SELF_TALK_DETECTED)
    expect(decision.triggers).toContain(APPROVAL_TRIGGERS.COMMITMENT_TYPE_GATED)
    expect(decision.primaryTrigger).toBe(APPROVAL_TRIGGERS.COMMITMENT_TYPE_GATED)
  })
})

describe('applyApprovalPolicyStage — mechanic_offer_backstop trigger (TAC-355)', () => {
  beforeEach(() => {
    pendingDraftMaybeSingleMock.mockReset()
    pendingDraftMaybeSingleMock.mockResolvedValue({ data: null, error: null })
  })

  it('queues with mechanic_offer_backstop when the stage result is "flagged"', async () => {
    const decision = await applyApprovalPolicyStage(
      makeCtx({}),
      makeGenerationResult({}),
      null,
      { status: 'flagged', mechanicId: 'mech-1' },
    )
    expect(decision.action).toBe('queue')
    if (decision.action !== 'queue') return
    expect(decision.triggers).toContain(APPROVAL_TRIGGERS.MECHANIC_OFFER_BACKSTOP)
    expect(decision.primaryTrigger).toBe(APPROVAL_TRIGGERS.MECHANIC_OFFER_BACKSTOP)
  })

  it('FAILS CLOSED — queues with mechanic_offer_backstop when the stage result is "check_failed"', async () => {
    const decision = await applyApprovalPolicyStage(
      makeCtx({}),
      makeGenerationResult({}),
      null,
      { status: 'check_failed' },
    )
    expect(decision.action).toBe('queue')
    if (decision.action !== 'queue') return
    expect(decision.triggers).toContain(APPROVAL_TRIGGERS.MECHANIC_OFFER_BACKSTOP)
  })

  it('does not queue when the stage result is "clean"', async () => {
    const decision = await applyApprovalPolicyStage(
      makeCtx({}),
      makeGenerationResult({}),
      null,
      { status: 'clean' },
    )
    expect(decision.action).toBe('send')
  })

  it('does not queue when the stage result is "skipped" (default when omitted)', async () => {
    const decision = await applyApprovalPolicyStage(makeCtx({}), makeGenerationResult({}))
    expect(decision.action).toBe('send')
  })

  it('outranks comp_regex_backstop and model_flagged for the operator label, but not commitment_type_gated', async () => {
    const decision = await applyApprovalPolicyStage(
      makeCtx({}),
      makeGenerationResult({
        body: "that one's on us today",
        requiresOperatorApproval: true,
      }),
      null,
      { status: 'flagged', mechanicId: 'mech-1' },
    )
    expect(decision.action).toBe('queue')
    if (decision.action !== 'queue') return
    expect(decision.primaryTrigger).toBe(APPROVAL_TRIGGERS.MECHANIC_OFFER_BACKSTOP)

    const decisionWithCommitment = await applyApprovalPolicyStage(
      makeCtx({}),
      makeGenerationResult({
        commitment: { type: 'comp', description: 'oat latte' },
      }),
      null,
      { status: 'flagged', mechanicId: 'mech-1' },
    )
    expect(decisionWithCommitment.action).toBe('queue')
    if (decisionWithCommitment.action !== 'queue') return
    expect(decisionWithCommitment.primaryTrigger).toBe(APPROVAL_TRIGGERS.COMMITMENT_TYPE_GATED)
  })
})

describe('verifyMechanicOfferStage (TAC-355)', () => {
  beforeEach(() => {
    verifyMechanicOfferMock.mockReset()
    captureMechanicOfferBackstopCaughtMock.mockReset()
  })

  const gatedMechanic = {
    id: 'mech-1',
    type: 'perk' as const,
    name: 'Referral Surprise',
    description: null,
    qualification: 'A regular brings a friend in for the first time.',
    rewardDescription: 'A complimentary item for the first-time guest.',
    minState: 'regular' as const,
    requiresOperatorApproval: true,
  }

  it('skips without calling the model when no eligible mechanic requires approval', async () => {
    const ctx = makeCtx({ mechanics: [] })
    const result = await verifyMechanicOfferStage(ctx, makeGenerationResult({}))
    expect(result).toEqual({ status: 'skipped' })
    expect(verifyMechanicOfferMock).not.toHaveBeenCalled()
  })

  it('skips without calling the model for a demo guest', async () => {
    const ctx = makeCtx({
      mechanics: [gatedMechanic],
      guest: { id: 'guest-1', firstName: 'Sam', isDemo: true } as RuntimeContext['guest'],
    })
    const result = await verifyMechanicOfferStage(ctx, makeGenerationResult({}))
    expect(result).toEqual({ status: 'skipped' })
    expect(verifyMechanicOfferMock).not.toHaveBeenCalled()
  })

  it('skips without calling the model when the generation already self-flagged', async () => {
    const ctx = makeCtx({ mechanics: [gatedMechanic] })
    const result = await verifyMechanicOfferStage(
      ctx,
      makeGenerationResult({ requiresOperatorApproval: true }),
    )
    expect(result).toEqual({ status: 'skipped' })
    expect(verifyMechanicOfferMock).not.toHaveBeenCalled()
  })

  it('skips without calling the model when commitment_type_gated already applies', async () => {
    const ctx = makeCtx({ mechanics: [gatedMechanic] })
    const result = await verifyMechanicOfferStage(
      ctx,
      makeGenerationResult({ commitment: { type: 'comp', description: 'oat latte' } }),
    )
    expect(result).toEqual({ status: 'skipped' })
    expect(verifyMechanicOfferMock).not.toHaveBeenCalled()
  })

  it('returns "clean" when the model finds nothing', async () => {
    verifyMechanicOfferMock.mockResolvedValueOnce({
      ok: true,
      data: { offersGatedMechanic: false, mechanicId: 'none', promptVersion: 'v1.0.0' },
    })
    const ctx = makeCtx({ mechanics: [gatedMechanic] })
    const result = await verifyMechanicOfferStage(ctx, makeGenerationResult({}))
    expect(result).toEqual({ status: 'clean' })
    expect(captureMechanicOfferBackstopCaughtMock).not.toHaveBeenCalled()
  })

  it('returns "flagged" with the mechanicId and fires the PostHog event when the model catches an offer', async () => {
    verifyMechanicOfferMock.mockResolvedValueOnce({
      ok: true,
      data: { offersGatedMechanic: true, mechanicId: 'mech-1', promptVersion: 'v1.0.0' },
    })
    const ctx = makeCtx({ mechanics: [gatedMechanic] })
    const result = await verifyMechanicOfferStage(
      ctx,
      makeGenerationResult({ body: 'since your friend came in, something special is on us' }),
    )
    expect(result).toEqual({ status: 'flagged', mechanicId: 'mech-1' })
    expect(captureMechanicOfferBackstopCaughtMock).toHaveBeenCalledTimes(1)
    const call = captureMechanicOfferBackstopCaughtMock.mock.calls[0][0]
    expect(call.mechanicId).toBe('mech-1')
  })

  // [CODE REVIEW / operator follow-up] Defense-in-depth against the exact bug
  // that was found and fixed: even if the AI-module layer's own defensive
  // substitution (lib/ai/verify-mechanic-offer.ts) were ever removed or
  // regressed, this stage's own check is keyed on `offersGatedMechanic`
  // alone, so an ambiguous raw response (flagged=true, no identified
  // mechanic) still resolves to 'flagged' here, never 'clean'.
  it('still resolves to "flagged" (not "clean") on the ambiguous raw shape offersGatedMechanic=true + mechanicId="none"', async () => {
    verifyMechanicOfferMock.mockResolvedValueOnce({
      ok: true,
      data: { offersGatedMechanic: true, mechanicId: 'none', promptVersion: 'v1.0.0' },
    })
    const ctx = makeCtx({ mechanics: [gatedMechanic] })
    const result = await verifyMechanicOfferStage(ctx, makeGenerationResult({}))
    expect(result.status).toBe('flagged')
  })

  it('FAILS CLOSED — returns "check_failed" and logs a warning when the model call degrades', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    verifyMechanicOfferMock.mockResolvedValueOnce({ ok: false, error: 'model unavailable' })
    const ctx = makeCtx({ mechanics: [gatedMechanic] })
    const result = await verifyMechanicOfferStage(ctx, makeGenerationResult({}))
    expect(result).toEqual({ status: 'check_failed' })
    expect(warnSpy).toHaveBeenCalled()
  })

  it('only passes requires_operator_approval mechanics to the verifier, not the full eligible set', async () => {
    verifyMechanicOfferMock.mockResolvedValueOnce({
      ok: true,
      data: { offersGatedMechanic: false, mechanicId: 'none', promptVersion: 'v1.0.0' },
    })
    const ungatedMechanic = { ...gatedMechanic, id: 'mech-2', requiresOperatorApproval: false }
    const ctx = makeCtx({ mechanics: [gatedMechanic, ungatedMechanic] })
    await verifyMechanicOfferStage(ctx, makeGenerationResult({}))
    const args = verifyMechanicOfferMock.mock.calls[0][0] as {
      eligibleGatedMechanics: Array<{ id: string }>
    }
    expect(args.eligibleGatedMechanics).toHaveLength(1)
    expect(args.eligibleGatedMechanics[0].id).toBe('mech-1')
  })
})

describe('applyApprovalPolicyStage — knowledge-gap card protection (TAC-308)', () => {
  const gapCard = {
    id: 'gap-card-1',
    body: 'best guess at the answer',
    pending_until: new Date(Date.now() + 60_000).toISOString(),
    review_reason: APPROVAL_TRIGGERS.KNOWLEDGE_GAP,
  }

  const inboundCtx = () =>
    makeCtx({
      currentMessage: {
        id: 'inbound-2',
        body: 'are you open till 6?',
        providerMessageId: 'p2',
        receivedAt: new Date(),
      },
      classification: {
        category: 'new_question',
        classifierConfidence: 0.9,
        reasoning: 'question',
        crisisSafety: false,
      },
    })

  beforeEach(() => {
    pendingDraftMaybeSingleMock.mockReset()
  })

  // CASE 1 — the carve-out. This is the behavior TAC-264's no-demotion
  // invariant would otherwise block: the guest asks a SECOND, answerable
  // question while a gap card is pending, and today that reply is both
  // silenced AND allowed to overwrite the card. Narrowed to gap cards only.
  it('sends an independently sendable reply instead of evicting the card', async () => {
    pendingDraftMaybeSingleMock.mockResolvedValue({ data: gapCard, error: null })
    const decision = await applyApprovalPolicyStage(
      inboundCtx(),
      makeGenerationResult({ knowledgeGap: false, voiceFidelity: 0.9 }),
    )
    expect(decision.action).toBe('send')
  })

  // CASE 2 — the card wins, the new draft is discarded. The guest is silent
  // on this turn, which is the accepted cost of not losing the question.
  it('drops a draft that would queue for some other reason', async () => {
    pendingDraftMaybeSingleMock.mockResolvedValue({ data: gapCard, error: null })
    const decision = await applyApprovalPolicyStage(
      inboundCtx(),
      makeGenerationResult({
        knowledgeGap: false,
        commitment: { type: 'comp', description: 'oat latte' },
      }),
    )
    expect(decision.action).toBe('drop')
    if (decision.action !== 'drop') return
    expect(decision.reason).toBe('knowledge_gap_card_protected')
    expect(decision.protectedDraftId).toBe('gap-card-1')
  })

  // CASE 3 — a second unanswerable question updates the card in place and
  // must NOT push the deadline out, or a chatty guest could defer the
  // holding message indefinitely.
  it('regenerates in place and preserves the original clock when the new turn also gaps', async () => {
    pendingDraftMaybeSingleMock.mockResolvedValue({ data: gapCard, error: null })
    const decision = await applyApprovalPolicyStage(
      inboundCtx(),
      makeGenerationResult({ knowledgeGap: true }),
    )
    expect(decision.action).toBe('queue')
    if (decision.action !== 'queue') return
    expect(decision.existingPendingDraftId).toBe('gap-card-1')
    // undefined = "don't touch the column", which preserves the running clock.
    expect(decision.pendingUntil).toBeUndefined()
  })

  // A card whose holding message already fired has pending_until cleared, so
  // it is recognized by review_reason alone. Without this the card would
  // silently lose its protection five minutes after being created.
  it('still protects a card whose clock has already fired', async () => {
    pendingDraftMaybeSingleMock.mockResolvedValue({
      data: { ...gapCard, pending_until: null },
      error: null,
    })
    const decision = await applyApprovalPolicyStage(
      inboundCtx(),
      makeGenerationResult({ knowledgeGap: false, voiceFidelity: 0.9 }),
    )
    expect(decision.action).toBe('send')
  })

  // An ORDINARY pending draft keeps pre-TAC-308 behavior exactly: it queues
  // and regenerates in place. The carve-out must not leak.
  it('leaves non-gap pending drafts on the old path', async () => {
    pendingDraftMaybeSingleMock.mockResolvedValue({
      data: {
        id: 'ordinary-draft',
        body: 'earlier draft',
        pending_until: null,
        review_reason: APPROVAL_TRIGGERS.COMP_REGEX_BACKSTOP,
      },
      error: null,
    })
    const decision = await applyApprovalPolicyStage(
      inboundCtx(),
      makeGenerationResult({ knowledgeGap: false, voiceFidelity: 0.9 }),
    )
    expect(decision.action).toBe('queue')
    if (decision.action !== 'queue') return
    expect(decision.triggers).toContain(APPROVAL_TRIGGERS.PREVIOUS_PENDING_HELD)
    expect(decision.existingPendingDraftId).toBe('ordinary-draft')
  })
})

describe('isKnowledgeGapCard (TAC-308)', () => {
  it('identifies a card by a running clock', () => {
    expect(
      isKnowledgeGapCard({ pending_until: new Date().toISOString(), review_reason: 'anything' }),
    ).toBe(true)
  })

  it('identifies a fired card by its review_reason', () => {
    expect(
      isKnowledgeGapCard({ pending_until: null, review_reason: APPROVAL_TRIGGERS.KNOWLEDGE_GAP }),
    ).toBe(true)
  })

  // TAC-350: a card the backstop caught must get identical eviction
  // protection to a self-reported one — otherwise a regen could silently
  // lose its clock the moment the label won by a co-firing trigger changed.
  it('identifies a fired backstop card by its review_reason', () => {
    expect(
      isKnowledgeGapCard({
        pending_until: null,
        review_reason: APPROVAL_TRIGGERS.KNOWLEDGE_GAP_BACKSTOP,
      }),
    ).toBe(true)
  })

  it('treats an ordinary pending draft as not a card', () => {
    expect(isKnowledgeGapCard({ pending_until: null, review_reason: 'model_flagged' })).toBe(false)
  })

  // The direction here is the safe one, and it is the point of the test:
  // an ABSENT field means "we don't know", and unknown must fall back to
  // pre-TAC-308 behavior. The opposite default would classify every ordinary
  // pending draft as protected and start silently dropping sendable replies.
  it('treats a MISSING pending_until as not-a-card, not as a running clock', () => {
    expect(isKnowledgeGapCard({})).toBe(false)
    expect(isKnowledgeGapCard({ review_reason: 'model_flagged' })).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// TAC-309: blank gap cards + the fidelity-floor exemption
// ---------------------------------------------------------------------------

describe('applyApprovalPolicyStage — blankBody (TAC-309)', () => {
  beforeEach(() => {
    pendingDraftMaybeSingleMock.mockReset()
    pendingDraftMaybeSingleMock.mockResolvedValue({ data: null, error: null })
  })

  const inboundCtx = () =>
    makeCtx({
      currentMessage: {
        id: 'inbound-1',
        body: 'what grade is the matcha?',
        providerMessageId: 'p1',
        receivedAt: new Date(),
      },
      classification: {
        category: 'new_question',
        classifierConfidence: 0.9,
        reasoning: 'question',
        crisisSafety: false,
      },
    })

  it('sets blankBody on a knowledge-gap queue', async () => {
    const decision = await applyApprovalPolicyStage(
      inboundCtx(),
      makeGenerationResult({ knowledgeGap: true }),
    )
    expect(decision.action).toBe('queue')
    if (decision.action !== 'queue') return
    expect(decision.blankBody).toBe(true)
  })

  it('leaves blankBody false for every other trigger', async () => {
    const decision = await applyApprovalPolicyStage(
      inboundCtx(),
      makeGenerationResult({ knowledgeGap: false, voiceFidelity: 0.45 }),
    )
    expect(decision.action).toBe('queue')
    if (decision.action !== 'queue') return
    expect(decision.blankBody).toBe(false)
  })

  // No exceptions, including the co-fire case. The comp detail survives on
  // pending_commitment; a model that couldn't ground the answer has no
  // business pre-writing one.
  it('still blanks when knowledge_gap co-fires with commitment_type_gated', async () => {
    const decision = await applyApprovalPolicyStage(
      inboundCtx(),
      makeGenerationResult({
        knowledgeGap: true,
        commitment: { type: 'comp', description: 'oat latte' },
      }),
    )
    expect(decision.action).toBe('queue')
    if (decision.action !== 'queue') return
    expect(decision.primaryTrigger).toBe(APPROVAL_TRIGGERS.COMMITMENT_TYPE_GATED)
    expect(decision.blankBody).toBe(true)
  })
})

describe('generateStage — fidelity floor exemption on knowledge gaps (TAC-309)', () => {
  const inbound = {
    id: 'inbound-1',
    body: 'what grade is the matcha?',
    providerMessageId: 'p1',
    receivedAt: new Date(),
  }
  const subFloorGap = () => ({
    ok: true,
    data: makeGenerationResult({ voiceFidelity: 0.2, knowledgeGap: true }),
  })

  // THE SILENT-DROP DOOR THIS CLOSES: the refused branch in handle-inbound
  // returns with NO card, so a low-fidelity gap turn produced silence — the
  // guest got nothing and no operator learned they'd asked. Gating card
  // creation on the voice quality of a body TAC-309 then discards is
  // incoherent; nothing on this path reaches the guest.
  it('does NOT refuse a sub-floor body on an inbound knowledge-gap turn', async () => {
    generateMessageMock.mockResolvedValue(subFloorGap())
    const out = await generateStage(
      makeCtx({ corpus: [], currentMessage: inbound }),
      'new_question',
    )
    expect(out.status).toBe('success')
  })

  // THE SAFETY PROPERTY, not the mechanism. The exemption is only sound
  // where the turn is guaranteed to be queued. These two are the paths where
  // it isn't, and where the text WOULD reach a guest — unblanked, because
  // blanking is also the gate's job. Asserting them here is what stops the
  // exemption widening back out by accident.
  it('STILL refuses on the outbound path — a manual followup skips the gate entirely', async () => {
    generateMessageMock.mockResolvedValue(subFloorGap())
    const out = await generateStage(
      makeCtx({
        corpus: [],
        currentMessage: null,
        followupTrigger: { reason: 'manual', triggeredAt: new Date() },
      }),
      'manual',
    )
    expect(out.status).toBe('refused')
  })

  it('STILL refuses for a demo guest — TAC-284 bypasses the gate unconditionally', async () => {
    generateMessageMock.mockResolvedValue(subFloorGap())
    const out = await generateStage(
      makeCtx({
        corpus: [],
        currentMessage: inbound,
        guest: { id: 'guest-1', firstName: 'Sam', isDemo: true } as RuntimeContext['guest'],
      }),
      'new_question',
    )
    expect(out.status).toBe('refused')
  })

  // The floor still protects every path where text actually reaches a guest.
  it('still refuses a sub-floor body when knowledgeGap is false', async () => {
    generateMessageMock.mockResolvedValue({
      ok: true,
      data: makeGenerationResult({ voiceFidelity: 0.2, knowledgeGap: false }),
    })
    const out = await generateStage(
      makeCtx({ corpus: [], currentMessage: inbound }),
      'new_question',
    )
    expect(out.status).toBe('refused')
  })

  it('leaves above-floor behavior unchanged either way', async () => {
    generateMessageMock.mockResolvedValue({
      ok: true,
      data: makeGenerationResult({ voiceFidelity: 0.9, knowledgeGap: true }),
    })
    expect(
      (await generateStage(makeCtx({ corpus: [], currentMessage: inbound }), 'new_question'))
        .status,
    ).toBe('success')
  })
})

describe('knowledgeGapWillQueue (TAC-309)', () => {
  const g = (isDemo = false) => ({ id: 'g', isDemo }) as RuntimeContext['guest']
  const inbound = { id: 'i' } as RuntimeContext['currentMessage']

  it('is true only for a non-demo inbound gap turn', () => {
    expect(knowledgeGapWillQueue({ currentMessage: inbound, guest: g() }, true)).toBe(true)
  })

  it('is false on the outbound path', () => {
    expect(knowledgeGapWillQueue({ currentMessage: null, guest: g() }, true)).toBe(false)
  })

  it('is false for a demo guest', () => {
    expect(knowledgeGapWillQueue({ currentMessage: inbound, guest: g(true) }, true)).toBe(false)
  })

  it('is false when the model did not report a gap', () => {
    expect(knowledgeGapWillQueue({ currentMessage: inbound, guest: g() }, false)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// TAC-307: approval policy is absolute
// ---------------------------------------------------------------------------

describe('applyApprovalPolicyStage — policy subordination (TAC-307)', () => {
  // makeCtx casts `venue`, so approvalPolicy isn't set by default. These build
  // it explicitly, the same way the holdAllOutbound tests above do.
  function ctxWithPolicy(
    policy: unknown,
    category: string = 'comp_complaint',
  ): RuntimeContext {
    return makeCtx({
      venue: { id: 'venue-1', approvalPolicy: policy } as RuntimeContext['venue'],
      classification: {
        category,
        classifierConfidence: 0.95,
        reasoning: 'test',
      } as RuntimeContext['classification'],
    })
  }

  const CLARIFYING = {
    body: 'What was off with it? I want to understand before we figure out next steps.',
    voiceFidelity: 0.82,
    complaintIntent: 'clarifying' as const,
  }

  it('keeps the clarifying-question carve-out when the hold is the fleet-wide code default', async () => {
    // The no-op case: every venue in production stores an empty perCategory,
    // so this is today's behaviour and must not change.
    const decision = await applyApprovalPolicyStage(
      ctxWithPolicy({ default: 'auto_send', perCategory: {} }),
      makeGenerationResult(CLARIFYING),
    )
    expect(decision.action).toBe('send')
  })

  it('queues that same clarifying question when the venue stored the hold explicitly', async () => {
    // The behaviour this ticket exists to add: a box a human ticked is
    // ABSOLUTE. A control with exceptions is not a control.
    const decision = await applyApprovalPolicyStage(
      ctxWithPolicy({ default: 'auto_send', perCategory: { comp_complaint: 'operator_approval' } }),
      makeGenerationResult(CLARIFYING),
    )
    expect(decision.action).toBe('queue')
    if (decision.action !== 'queue') return
    expect(decision.triggers).toContain('category_requires_approval')
  })

  it('queues that same clarifying question under the master switch', async () => {
    const decision = await applyApprovalPolicyStage(
      ctxWithPolicy({ default: 'operator_approval', perCategory: {} }),
      makeGenerationResult(CLARIFYING),
    )
    expect(decision.action).toBe('queue')
  })

  it('holds an ordinary category under the master switch', async () => {
    const decision = await applyApprovalPolicyStage(
      ctxWithPolicy({ default: 'operator_approval', perCategory: {} }, 'casual_chatter'),
      makeGenerationResult({ body: 'ha, fair enough', voiceFidelity: 0.95 }),
    )
    expect(decision.action).toBe('queue')
    if (decision.action !== 'queue') return
    expect(decision.triggers).toContain('category_requires_approval')
  })

  it('never holds opt_out, even under the master switch', async () => {
    // TCPA. The exemption is enforced in the resolver, so it holds regardless
    // of what the UI does or does not render.
    const decision = await applyApprovalPolicyStage(
      ctxWithPolicy({ default: 'operator_approval', perCategory: {} }, 'opt_out'),
      makeGenerationResult({ body: "You're unsubscribed. No more texts.", voiceFidelity: 0.95 }),
    )
    expect(decision.action).toBe('send')
  })

  it('never holds opt_out even when a hand-edited row stores a hold for it', async () => {
    const decision = await applyApprovalPolicyStage(
      ctxWithPolicy(
        { default: 'auto_send', perCategory: { opt_out: 'operator_approval' } },
        'opt_out',
      ),
      makeGenerationResult({ body: "You're unsubscribed. No more texts.", voiceFidelity: 0.95 }),
    )
    expect(decision.action).toBe('send')
  })

  it('still auto-sends an unheld category when the venue holds a different one', async () => {
    const decision = await applyApprovalPolicyStage(
      ctxWithPolicy(
        { default: 'auto_send', perCategory: { comp_complaint: 'operator_approval' } },
        'casual_chatter',
      ),
      makeGenerationResult({ body: 'ha, fair enough', voiceFidelity: 0.95 }),
    )
    expect(decision.action).toBe('send')
  })
})

describe('manual followups keep pending-detection bypassed (TAC-307)', () => {
  // Removing the manual gate bypass brought that path under approval POLICY,
  // which was the point. The bypass was doing a second, unrelated job though —
  // keeping the Follow Up button away from pending-draft detection — and
  // losing that would let a Follow Up click regen-in-place over a draft an
  // operator was about to approve. These pin the two halves apart.
  function manualCtx(policy?: unknown): RuntimeContext {
    return makeCtx({
      venue: { id: 'venue-1', approvalPolicy: policy } as RuntimeContext['venue'],
      followupTrigger: { reason: 'manual', triggeredAt: new Date() } as RuntimeContext['followupTrigger'],
    })
  }

  it('does not fire previous_pending_held for a manual followup', async () => {
    const decision = await applyApprovalPolicyStage(
      manualCtx(),
      makeGenerationResult({ body: 'checking in', voiceFidelity: 0.95 }),
    )
    expect(decision.action).toBe('send')
  })

  it('still applies approval policy to a manual followup', async () => {
    // The half that TAC-307 deliberately changed: a venue holding everything
    // holds the Follow Up button's draft too.
    const decision = await applyApprovalPolicyStage(
      manualCtx({ default: 'operator_approval', perCategory: {} }),
      makeGenerationResult({ body: 'checking in', voiceFidelity: 0.95 }),
    )
    expect(decision.action).toBe('queue')
    if (decision.action !== 'queue') return
    expect(decision.triggers).toContain('category_requires_approval')
    // Crucially NOT routed at an existing pending row — nothing to clobber.
    expect(decision.existingPendingDraftId).toBeNull()
  })

  it('still fires previous_pending_held for a CRON followup', async () => {
    // Guard against the skip being written too broadly. day_7 is not manual.
    const decision = await applyApprovalPolicyStage(
      makeCtx({
        venue: { id: 'venue-1' } as RuntimeContext['venue'],
        followupTrigger: { reason: 'day_7', triggeredAt: new Date() } as RuntimeContext['followupTrigger'],
      }),
      makeGenerationResult({ body: 'checking in', voiceFidelity: 0.95 }),
    )
    // findPendingDraft is unmocked here and resolves null in this fixture, so
    // the assertion that matters is that the lookup was not short-circuited by
    // the manual check — a send with no triggers is the correct outcome.
    expect(decision.action).toBe('send')
  })
})

describe('willBeReviewed is scoped to complaint categories (TAC-307)', () => {
  // The master switch this ticket ships sets default:'operator_approval',
  // which before scoping made willBeReviewed true on EVERY turn and switched
  // formatMechanicEligibility to its generosity-inviting branch venue-wide.
  function ctxFor(category: string, policy: unknown): RuntimeContext {
    return makeCtx({
      venue: { id: 'venue-1', approvalPolicy: policy } as RuntimeContext['venue'],
      classification: {
        category,
        classifierConfidence: 0.95,
        reasoning: 'test',
      } as RuntimeContext['classification'],
    })
  }

  it('is true for a held complaint turn', () => {
    const runtime = buildAiRuntime(
      ctxFor('comp_complaint', { default: 'auto_send', perCategory: {} }),
    )
    expect(runtime.willBeReviewed).toBe(true)
  })

  it('is FALSE for a non-complaint turn under the master switch', () => {
    const runtime = buildAiRuntime(
      ctxFor('new_question', { default: 'operator_approval', perCategory: {} }),
    )
    expect(runtime.willBeReviewed).toBe(false)
  })

  it('is false for a complaint turn the venue does not hold', () => {
    const runtime = buildAiRuntime(
      ctxFor('comp_complaint', { default: 'auto_send', perCategory: { comp_complaint: 'auto_send' } }),
    )
    expect(runtime.willBeReviewed).toBe(false)
  })
})
