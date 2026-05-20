import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  applyApprovalPolicyStage,
  APPROVAL_TRIGGERS,
  classifyStage,
  findPendingDraft,
  retrieveCorpusStage,
  retrieveKnowledgeStage,
  shouldRetrieveKnowledge,
} from './stages'
import type { CorpusMatch, RuntimeContext } from './types'
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
  // import doesn't pull in real SDK init.
  generateMessage: vi.fn(),
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
  captureVoiceFidelityLow: vi.fn(),
  CLASSIFICATION_CONFIDENCE_LOW_THRESHOLD: 0.7,
  CLASSIFICATION_CONFIDENCE_REROUTE_THRESHOLD: 0.3,
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
    recentVisits: [],
    corpus: null,
    knowledgeCorpus: null,
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
    attempts: 1,
    attemptScores: [0.85],
    attemptHistory: [],
    systemPrompt: '',
    userPrompt: '',
    promptVersion: 'v1.14.0',
    dashViolationPersisted: false,
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
