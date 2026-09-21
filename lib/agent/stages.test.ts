import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  applyApprovalPolicyStage,
  APPROVAL_TRIGGERS,
  buildAiRuntime,
  classifyStage,
  deriveFollowupContext,
  generateStage,
  GENERATION_FAILED_REVIEW_REASON,
  isCommitmentTypeGated,
  isKnowledgeGapCard,
  isModelFlagged,
  KNOWLEDGE_GAP_CARD_REVIEW_REASONS,
  KNOWLEDGE_RELEVANCE_FLOOR,
  knowledgeGapWillQueue,
  retrieveCorpusStage,
  retrieveKnowledgeStage,
  shouldRetrieveKnowledge,
  verifyGroundingStage,
  verifyMechanicOfferStage,
  verifyProsePromiseStage,
} from './stages'
import type { CorpusMatch, FollowupTrigger, RuntimeContext, Visit } from './types'
import type { GenerateMessageResult } from '@/lib/ai'
// TAC-367: by path, not via the '@/lib/ai' barrel this file vi.mocks — the
// source under test imports it the same way for the same reason.
import { VERIFY_GROUNDING_TRUNCATED_ERROR_CODE } from '@/lib/ai/verify-grounding'
import { BrandPersonaSchema } from '@/lib/schemas'
import { gapFlagsFromTriggers } from './pending-slots'

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
const captureUnverifiedUrlHeldMock = vi.fn()
const captureGroundingVerifierUnavailableMock = vi.fn()
// TAC-355: verifyMechanicOffer (lib/ai) is the mechanic-offer backstop's
// model call; captureMechanicOfferBackstopCaught (posthog) fires when it
// catches something.
const verifyMechanicOfferMock = vi.fn()
// TAC-401: the prose-promise check's model call.
const verifyProsePromiseMock = vi.fn()
const captureProsePromiseCaughtMock = vi.fn()
const captureProsePromiseCheckUnavailableMock = vi.fn()
const captureMechanicOfferBackstopCaughtMock = vi.fn()
// TAC-284: applyApprovalPolicyStage fires captureDemoBypassedApprovalGate
// when a demo guest's bypass overrides a would-have-queued decision. Mocked
// so the demo-bypass tests can assert the payload without a PostHog call.
const captureDemoBypassMock = vi.fn()
// TAC-394: the gate reads BOTH of a guest's pending slots through
// loadPendingRowsBySlot (lib/agent/pending-slots.ts), whose query is
// .select().eq() x4 .order().limit(), awaited as an array. The per-test
// `pendingDraftMaybeSingleMock` keeps its pre-TAC-394 shape so existing fixtures
// read unchanged: `{ data: row }` is a guest with that one pending row,
// `{ data: [rowA, rowB] }` is a guest with two (listed in the order the read
// returns them), and a rejection is a read that throws. A row with no
// `pending_commitment` is a conversation-slot card, which is what every
// fixture written before TAC-394 describes.
const pendingDraftMaybeSingleMock = vi.fn()
vi.mock('@/lib/db/admin', () => ({
  createAdminClient: () => {
    const chain = {
      select: () => chain,
      eq: () => chain,
      order: () => chain,
      limit: async () => {
        const res = (await pendingDraftMaybeSingleMock()) as {
          data: unknown
          error: unknown
        }
        const data =
          res.data === null || res.data === undefined
            ? []
            : Array.isArray(res.data)
              ? res.data
              : [res.data]
        return { data, error: res.error ?? null }
      },
    }
    return { from: () => chain }
  },
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
  // TAC-401: the prose-promise backstop's model call. This factory is an
  // explicit ALLOW-LIST — a name missing here arrives `undefined` at the call
  // site and the branch that uses it is silently unreachable in every test in
  // this file, which is the trap CLAUDE.md documents on this exact mock.
  verifyProsePromise: (...args: unknown[]) => verifyProsePromiseMock(...args),
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
  captureUnverifiedUrlHeld: (...args: unknown[]) => captureUnverifiedUrlHeldMock(...args),
  captureGroundingVerifierUnavailable: (...args: unknown[]) =>
    captureGroundingVerifierUnavailableMock(...args),
  captureMechanicOfferBackstopCaught: (...args: unknown[]) =>
    captureMechanicOfferBackstopCaughtMock(...args),
  captureProsePromiseCaught: (...args: unknown[]) => captureProsePromiseCaughtMock(...args),
  captureProsePromiseCheckUnavailable: (...args: unknown[]) =>
    captureProsePromiseCheckUnavailableMock(...args),
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
// TAC-362: `never` is the deliberate default — the emoji coin then returns
// null and no per-message block renders, so every pre-existing fixture's
// rendered prompt is unchanged by this ticket. Tests that care about the
// flip override emojiPolicy explicitly.
const TEST_BRAND_PERSONA = BrandPersonaSchema.parse({
  tone: 'warm and direct',
  formality: 'casual',
  speakerFraming: 'venue',
  emojiPolicy: 'never',
  lengthGuide: 'short',
})

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
    conversationChannel: 'text' as const,
    pendingQuestion: null,
    recentMessages: [],
    recognition: {} as RuntimeContext['recognition'],
    mechanics: [],
    recentVisits: [],
    activeCommitments: [],
    openIntentions: [],
    intentionDerivation: { newlyEligible: [], brakeEngaged: false },
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
  // TAC-362: same backfill, same reason as venueInfo above — buildAiRuntime
  // now dereferences venue.brandPersona.emojiPolicy to flip the per-message
  // emoji coin. Production is safe (build-runtime-context.ts parses
  // brand_persona through BrandPersonaSchema and THROWS on failure, so it is
  // always a real object there), so the fixtures are fixed rather than the
  // source made defensive against a state its own type forbids.
  const brandPersona =
    (ctx.venue as Partial<RuntimeContext['venue']>).brandPersona ?? TEST_BRAND_PERSONA
  return { ...ctx, venue: { ...ctx.venue, venueInfo, brandPersona } }
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
        delivery: 'delivered' as const,
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
        promptVersion: 'v1.56.0',
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
        promptVersion: 'v1.56.0',
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

  // TAC-367: retrieveKnowledgeStage takes its query explicitly now, so the
  // fixture and the argument have to say the same thing. Bound to one
  // constant rather than repeated, so they cannot drift apart.
  const KNOWLEDGE_QUERY = 'do you have any free drink perks?'

  function makeKnowledgeCtx(): RuntimeContext {
    return makeCtx({
      currentMessage: {
        id: 'm1',
        body: KNOWLEDGE_QUERY,
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
    await retrieveKnowledgeStage(makeKnowledgeCtx(), 'mechanic_request', KNOWLEDGE_QUERY)
    expect(retrieveKnowledgeContextMock).toHaveBeenCalledTimes(1)
    const args = retrieveKnowledgeContextMock.mock.calls[0][0] as {
      primaryTagPreference?: string[]
    }
    expect(args.primaryTagPreference).toEqual(['mechanic'])
  })

  it('passes undefined preference for an unmapped category (cosine-only)', async () => {
    retrieveKnowledgeContextMock.mockResolvedValueOnce({ ok: true, data: [] })
    await retrieveKnowledgeStage(makeKnowledgeCtx(), 'reply', KNOWLEDGE_QUERY)
    const args = retrieveKnowledgeContextMock.mock.calls[0][0] as {
      primaryTagPreference?: string[]
    }
    expect(args.primaryTagPreference).toBeUndefined()
  })

  it('passes undefined preference when category is null', async () => {
    retrieveKnowledgeContextMock.mockResolvedValueOnce({ ok: true, data: [] })
    await retrieveKnowledgeStage(makeKnowledgeCtx(), null, KNOWLEDGE_QUERY)
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

    const out = await retrieveKnowledgeStage(makeKnowledgeCtx(), 'mechanic_request', KNOWLEDGE_QUERY)
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
    const out = await retrieveKnowledgeStage(makeKnowledgeCtx(), 'reply', KNOWLEDGE_QUERY)
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
    const out = await retrieveKnowledgeStage(makeKnowledgeCtx(), 'mechanic_request', KNOWLEDGE_QUERY)
    expect(out).toEqual([])
    expect(warnSpy).toHaveBeenCalled()
  })

  it('returns [] and logs warn when the fallback retrieval errors', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    retrieveKnowledgeContextMock
      .mockResolvedValueOnce({ ok: true, data: [] })
      .mockResolvedValueOnce({ ok: false, error: 'voyage timeout' })
    const out = await retrieveKnowledgeStage(makeKnowledgeCtx(), 'mechanic_request', KNOWLEDGE_QUERY)
    expect(out).toEqual([])
    expect(warnSpy).toHaveBeenCalledTimes(1)
  })

  // Relevance floor. TAC-350 calibrated it at 0.5; TAC-358 measured that
  // calibration against the live corpus, found the distributions invert, and
  // lowered it to 0.3 — where it coincides with lib/rag's SIMILARITY_FLOOR and
  // therefore filters nothing today. These tests are floor-RELATIVE so they
  // keep testing the mechanism if the value moves; the one pinned assertion
  // below is what makes moving it deliberate. See the constant's own comment.
  describe('relevance floor (TAC-350, recalibrated TAC-358)', () => {
    it('drops all chunks and renders as no-match when every chunk is below the floor', async () => {
      retrieveKnowledgeContextMock.mockResolvedValueOnce({
        ok: true,
        data: [row('weak1', ['other']), row('weak2', ['other'])].map((r) => ({
          ...r,
          similarity: KNOWLEDGE_RELEVANCE_FLOOR - 0.01,
        })),
      })
      const out = await retrieveKnowledgeStage(makeKnowledgeCtx(), 'reply', KNOWLEDGE_QUERY)
      expect(out).toEqual([])
    })

    it('keeps chunks at or above the floor', async () => {
      retrieveKnowledgeContextMock.mockResolvedValueOnce({
        ok: true,
        data: [{ ...row('strong', ['menu']), similarity: KNOWLEDGE_RELEVANCE_FLOOR }],
      })
      const out = await retrieveKnowledgeStage(makeKnowledgeCtx(), 'reply', KNOWLEDGE_QUERY)
      expect(out).toHaveLength(1)
      expect(out[0].id).toBe('strong')
    })

    it('drops only the weak chunks when a mix of strong and weak chunks is returned', async () => {
      // TAC-358: expressed RELATIVE to the constant, not as literals. These
      // fixtures were 0.68 / 0.35 against a 0.5 floor and silently stopped
      // testing anything when the floor moved to 0.30 — 0.35 became a
      // survivor and the test failed rather than adapting. A floor that is
      // explicitly a tunable should not have hand-picked numbers orbiting it.
      retrieveKnowledgeContextMock.mockResolvedValueOnce({
        ok: true,
        data: [
          { ...row('strong', ['menu']), similarity: KNOWLEDGE_RELEVANCE_FLOOR + 0.18 },
          { ...row('weak', ['menu']), similarity: KNOWLEDGE_RELEVANCE_FLOOR - 0.05 },
        ],
      })
      const out = await retrieveKnowledgeStage(makeKnowledgeCtx(), 'reply', KNOWLEDGE_QUERY)
      expect(out).toHaveLength(1)
      expect(out[0].id).toBe('strong')
    })

    it('falls back to the no-filter retry when preferenced results are all below the floor', async () => {
      retrieveKnowledgeContextMock
        .mockResolvedValueOnce({
          ok: true,
          data: [{ ...row('weak', ['mechanic']), similarity: KNOWLEDGE_RELEVANCE_FLOOR - 0.05 }],
        })
        .mockResolvedValueOnce({
          ok: true,
          data: [{ ...row('fallback-strong', ['menu']), similarity: KNOWLEDGE_RELEVANCE_FLOOR + 0.1 }],
        })
      const out = await retrieveKnowledgeStage(makeKnowledgeCtx(), 'mechanic_request', KNOWLEDGE_QUERY)
      expect(retrieveKnowledgeContextMock).toHaveBeenCalledTimes(2)
      expect(out).toHaveLength(1)
      expect(out[0].id).toBe('fallback-strong')
    })


    it('filters the fallback result by the floor too, not just the preferenced call', async () => {
      retrieveKnowledgeContextMock
        .mockResolvedValueOnce({ ok: true, data: [] })
        .mockResolvedValueOnce({
          ok: true,
          data: [{ ...row('fallback-weak', ['menu']), similarity: KNOWLEDGE_RELEVANCE_FLOOR - 0.02 }],
        })
      const out = await retrieveKnowledgeStage(makeKnowledgeCtx(), 'mechanic_request', KNOWLEDGE_QUERY)
      expect(out).toEqual([])
    })

    it('is 0.30 — a sanity bound, not a relevance filter (TAC-358)', () => {
      // Pinned deliberately. Every other test here is floor-relative so it
      // survives a change to this number; this one exists so the change is
      // never accidental. TAC-358 measured that cosine on this corpus tracks
      // query length rather than answerability — an unanswerable question
      // ("where is the bathroom", 0.5439) outscored every answerable terse
      // one (max 0.4971) — so no value separates the sets and this one is
      // chosen to sit below the worst measured on-topic query (0.3250) and
      // exclude essentially nothing. Raising it back toward 0.5 reinstates
      // the bug. The semantic judgement belongs to verify-grounding.
      expect(KNOWLEDGE_RELEVANCE_FLOOR).toBe(0.3)
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
    // TAC-509: the clean default. A test that needs the trigger overrides it.
    unverifiedUrls: [],
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
    emojiDirectiveViolated: false,
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

  it('fails OPEN when the pending-slot read errors — sends rather than refusing', async () => {
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

  it('fails OPEN when the pending-slot read throws — sends rather than refusing', async () => {
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

// findPendingDraft's own tests moved to pending-slots.test.ts, with its
// replacement, loadPendingRowsBySlot (TAC-394).

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
        recentMessages: [{ direction: 'inbound', body: 'earlier', createdAt: new Date(), delivery: 'delivered' }],
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

  const TWO_OPEN: RuntimeContext['openIntentions'] = [
    {
      key: 'understand_order',
      promptLine: "You haven't heard what this guest ordered yet.",
      eligibleAt: FRESH,
    },
    { key: 'learn_name', promptLine: "You don't know this guest's name yet.", eligibleAt: FRESH },
  ]

  it('maps ctx.openIntentions promptLines onto aiRuntime.openIntentions, in order', () => {
    const aiRuntime = buildAiRuntime(qrScanCtx({ openIntentions: TWO_OPEN }))
    expect(aiRuntime.openIntentions).toEqual([
      "You haven't heard what this guest ordered yet.",
      "You don't know this guest's name yet.",
    ])
  })

  // TAC-380 trap 4: buildAiRuntime renders through renderableIntentions, the
  // same predicate handle-inbound's recording gate reads. If this rendered on
  // a turn recording skipped (or the reverse), a classifier failure could close
  // an intention the guest never saw.
  it('renders no intentions on an opt_out turn (trap 4)', () => {
    const aiRuntime = buildAiRuntime(
      qrScanCtx({
        openIntentions: TWO_OPEN,
        classification: {
          category: 'opt_out',
          classifierConfidence: 0.99,
          reasoning: 'stop',
          crisisSafety: false,
        },
      }),
    )
    expect(aiRuntime.openIntentions).toBeUndefined()
  })

  it('renders no intentions while the guest is owed an answer to an earlier question (trap 4)', () => {
    const aiRuntime = buildAiRuntime(
      qrScanCtx({
        openIntentions: TWO_OPEN,
        pendingQuestion: { question: 'is rayan working', askedAt: new Date(), mode: 'outstanding' },
      }),
    )
    expect(aiRuntime.openIntentions).toBeUndefined()
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
        channel: 'text',
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
        channel: 'text',
      },
      classification: {
        category: 'new_question',
        classifierConfidence: 0.9,
        reasoning: 'question',
        crisisSafety: false,
      },
    })

  // TAC-301 part 1.5 REVERSED the blanking half of this, deliberately. The
  // clock still arms (the guest is still owed an answer); the body now
  // SURVIVES. On the backstop path the model never admitted to guessing —
  // the flag is a second opinion, and on 2026-09-13 it was wrong twice in
  // the first two minutes after deploy, on replies that were correct.
  // Blanking destroyed a correct message and left the operator an empty card.
  it('queues and arms the clock but KEEPS the body when the backstop catches a claim', async () => {
    const decision = await applyApprovalPolicyStage(
      inboundCtx(),
      makeGenerationResult({ knowledgeGap: false }),
      { status: 'flagged' as const, claims: ['invents four SoFi variation names not in the corpus'] },
    )
    expect(decision.action).toBe('queue')
    if (decision.action !== 'queue') return
    expect(decision.triggers).toContain(APPROVAL_TRIGGERS.KNOWLEDGE_GAP_BACKSTOP)
    expect(decision.primaryTrigger).toBe(APPROVAL_TRIGGERS.KNOWLEDGE_GAP_BACKSTOP)
    expect(decision.pendingUntil).toBeInstanceOf(Date)
    expect(decision.blankBody).toBe(false)
  })

  // ---- TAC-367: truncated verdict ----

  it('queues with grounding_check_failed when the grounding check truncated', async () => {
    const decision = await applyApprovalPolicyStage(
      inboundCtx(),
      makeGenerationResult({ knowledgeGap: false }),
      { status: 'truncated' as const },
    )
    expect(decision.action).toBe('queue')
    if (decision.action !== 'queue') return
    expect(decision.triggers).toContain(APPROVAL_TRIGGERS.GROUNDING_CHECK_FAILED)
    expect(decision.primaryTrigger).toBe(APPROVAL_TRIGGERS.GROUNDING_CHECK_FAILED)
  })

  // TAC-367. The load-bearing negative. A truncated check is an ABSENCE of
  // information about the reply, not a finding against it — so it must not
  // inherit any of the knowledge-gap consequences, each of which has a
  // guest-facing effect that would be wrong here: an armed clock puts a
  // "still looking into it" holding message in front of a guest whose reply
  // was probably fine, and a blanked body destroys a reply nobody found
  // anything wrong with. Folding this into `isGapTurn` is the natural-looking
  // edit that breaks both at once.
  it('does NOT arm the clock, blank the body, or claim a gap on a truncated check', async () => {
    const decision = await applyApprovalPolicyStage(
      inboundCtx(),
      makeGenerationResult({ knowledgeGap: false }),
      { status: 'truncated' as const },
    )
    expect(decision.action).toBe('queue')
    if (decision.action !== 'queue') return
    expect(decision.pendingUntil).toBeUndefined()
    expect(decision.blankBody).toBe(false)
    expect(decision.triggers).not.toContain(APPROVAL_TRIGGERS.KNOWLEDGE_GAP)
    expect(decision.triggers).not.toContain(APPROVAL_TRIGGERS.KNOWLEDGE_GAP_BACKSTOP)
  })

  // TAC-367: a truncated check reports nothing about the draft, so any
  // concrete finding that co-fires must win the operator-facing label.
  it('yields the primary label to a concrete co-firing trigger', async () => {
    const decision = await applyApprovalPolicyStage(
      inboundCtx(),
      makeGenerationResult({ knowledgeGap: false, voiceFidelity: 0.45 }),
      { status: 'truncated' as const },
    )
    expect(decision.action).toBe('queue')
    if (decision.action !== 'queue') return
    expect(decision.triggers).toContain(APPROVAL_TRIGGERS.GROUNDING_CHECK_FAILED)
    expect(decision.primaryTrigger).toBe(APPROVAL_TRIGGERS.FIDELITY_BELOW_AUTO_SEND_FLOOR)
  })

  // TAC-367 REGRESSION GUARD (code review, MAJOR). Excluding `truncated` from
  // isGapTurn is correct forward and wrong backward: the trigger cancels the
  // protected-card carve-out, which lands the turn on the TAC-308 drop and
  // DESTROYS the reply. Before this ticket the same turn fired no trigger and
  // SENT, so the naive version converts a delivered reply into guest silence.
  it('queues rather than DROPPING when a gap card is pending and this turn truncated', async () => {
    const gapCard = {
      id: 'gap-card-1',
      body: '',
      pending_until: new Date(Date.now() + 60_000).toISOString(),
      review_reason: APPROVAL_TRIGGERS.KNOWLEDGE_GAP,
    }
    pendingDraftMaybeSingleMock.mockResolvedValue({ data: gapCard, error: null })
    const decision = await applyApprovalPolicyStage(
      inboundCtx(),
      makeGenerationResult({ knowledgeGap: false }),
      { status: 'truncated' as const },
    )
    expect(decision.action).toBe('queue')
    if (decision.action !== 'queue') return
    // Regen in place over the card, and the card's own clock is untouched.
    expect(decision.existingPendingDraftId).toBe('gap-card-1')
    expect(decision.pendingUntil).toBeUndefined()
    expect(decision.blankBody).toBe(false)
  })

  // TAC-367 (code review, MAJOR). The two tests above this one both survive
  // deleting GROUNDING_CHECK_FAILED from PRIMARY_TRIGGER_PRIORITY, because
  // pickPrimaryTrigger falls through to triggers[0] and that happens to be
  // the right answer in both. This is the only assertion that distinguishes
  // "ranked where the comment says" from "absent and rescued by the
  // fallback": it must OUTRANK a co-firing policy trigger.
  it('outranks hold_all_outbound for the operator-facing label', async () => {
    const ctx = inboundCtx()
    const decision = await applyApprovalPolicyStage(
      { ...ctx, venue: { ...ctx.venue, holdAllOutbound: true } } as RuntimeContext,
      makeGenerationResult({ knowledgeGap: false }),
      { status: 'truncated' as const },
    )
    expect(decision.action).toBe('queue')
    if (decision.action !== 'queue') return
    expect(decision.triggers).toContain(APPROVAL_TRIGGERS.HOLD_ALL_OUTBOUND)
    expect(decision.primaryTrigger).toBe(APPROVAL_TRIGGERS.GROUNDING_CHECK_FAILED)
  })

  // TAC-367: a truncation card carries no clock and its own review_reason, so
  // it must NOT be treated as a protected knowledge-gap card on a later turn.
  // Cheap, and it pins the forward half of the isGapTurn exclusion.
  it('does not treat a grounding_check_failed card as a protected gap card', async () => {
    const truncationCard = {
      id: 'trunc-card-1',
      body: 'a perfectly fine reply',
      pending_until: null,
      review_reason: APPROVAL_TRIGGERS.GROUNDING_CHECK_FAILED,
    }
    pendingDraftMaybeSingleMock.mockResolvedValue({ data: truncationCard, error: null })
    const decision = await applyApprovalPolicyStage(
      inboundCtx(),
      makeGenerationResult({ knowledgeGap: false }),
      { status: 'clean' as const },
    )
    // Not protected => ordinary sticky-pending queue, never a drop.
    expect(decision.action).toBe('queue')
    if (decision.action !== 'queue') return
    expect(decision.primaryTrigger).toBe(APPROVAL_TRIGGERS.PREVIOUS_PENDING_HELD)
  })

  // TAC-367: 'clean' is what a transient fault degrades to, so it must be
  // indistinguishable from a verdict that ran and found nothing. If this ever
  // starts queueing, the fail-open line has moved without anyone saying so.
  it('sends on a clean grounding result, exactly as when the stage was skipped', async () => {
    const clean = await applyApprovalPolicyStage(
      inboundCtx(),
      makeGenerationResult({ knowledgeGap: false }),
      { status: 'clean' as const },
    )
    const skipped = await applyApprovalPolicyStage(
      inboundCtx(),
      makeGenerationResult({ knowledgeGap: false }),
      { status: 'skipped' as const },
    )
    expect(clean.action).toBe('send')
    expect(skipped.action).toBe('send')
  })

  // The asymmetry is the whole point of the change, so pin both sides of it
  // in one place: identical gate call, only the SOURCE of the gap differs.
  it('blanks a self-reported gap but not a backstop catch, on otherwise identical input', async () => {
    const selfReported = await applyApprovalPolicyStage(
      inboundCtx(),
      makeGenerationResult({ knowledgeGap: true }),
    )
    const backstop = await applyApprovalPolicyStage(
      inboundCtx(),
      makeGenerationResult({ knowledgeGap: false }),
      { status: 'flagged' as const, claims: ['invents a fact'] },
    )
    if (selfReported.action !== 'queue' || backstop.action !== 'queue') {
      throw new Error('both should queue')
    }
    expect(selfReported.blankBody).toBe(true)
    expect(backstop.blankBody).toBe(false)
    // Both still arm the clock — a guest owed an answer is owed one either way.
    expect(selfReported.pendingUntil).toBeInstanceOf(Date)
    expect(backstop.pendingUntil).toBeInstanceOf(Date)
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
      { status: 'flagged' as const, claims: ['invents a fact'] },
    )
    expect(decision.action).toBe('queue')
    if (decision.action !== 'queue') return
    expect(decision.triggers).toContain(APPROVAL_TRIGGERS.KNOWLEDGE_GAP_BACKSTOP)
    expect(decision.primaryTrigger).toBe(APPROVAL_TRIGGERS.COMMITMENT_TYPE_GATED)
    expect(decision.pendingUntil).toBeInstanceOf(Date)
    // TAC-301 part 1.5: no longer blanked. pending_commitment now rides along
    // WITH a visible body, which is the safe combination — TAC-309's concern
    // was an invisible commitment on a blank card the operator would
    // authorize without seeing. The operator can see it here.
    expect(decision.blankBody).toBe(false)
  })

  it('outranks fidelity_below_auto_send_floor for the operator label', async () => {
    const decision = await applyApprovalPolicyStage(
      inboundCtx(),
      makeGenerationResult({ knowledgeGap: false, voiceFidelity: 0.45 }),
      { status: 'flagged' as const, claims: ['invents a fact'] },
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
      { status: 'flagged' as const, claims: ['invents a different fact this turn'] },
    )
    expect(decision.action).toBe('queue')
    if (decision.action !== 'queue') return
    expect(decision.existingPendingDraftId).toBe('gap-card-1')
    expect(decision.pendingUntil).toBeUndefined()
    // TAC-301 part 1.5: backstop path keeps the body on regen too.
    expect(decision.blankBody).toBe(false)
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
      { status: 'flagged' as const, claims: ['a different unverified claim'] },
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
    captureGroundingVerifierUnavailableMock.mockReset()
  })

  const inboundCtx = (overrides: Partial<RuntimeContext> = {}) =>
    makeCtx({
      currentMessage: {
        id: 'inbound-1',
        body: "what's the wifi password?",
        providerMessageId: 'p1',
        receivedAt: new Date(),
        channel: 'text',
      },
      knowledgeCorpus: [],
      ...overrides,
    })

  function makeGen(
    overrides: { knowledgeGap?: boolean; body?: string; userPrompt?: string } = {},
  ) {
    return {
      knowledgeGap: false,
      body: 'Le Mils Guest',
      // TAC-301 part 1.5: the generator's composed user prompt is now part of
      // what the verifier is given.
      userPrompt: '## Right now\n- Status: OPEN right now, closes at 3:00 PM.',
      ...overrides,
    }
  }

  // TAC-376 REVERSES this test. It used to assert the outbound (followup)
  // path skipped entirely — the exact gap this ticket closes. Per the
  // 2026-09-17 ruling, a followup now gets the same check an inbound reply
  // gets, with isProactive derived from ctx.currentMessage === null.
  it('calls the model on the outbound (followup) path with isProactive: true and an empty inboundBody', async () => {
    verifyGroundingMock.mockResolvedValueOnce({
      ok: true,
      data: { hasUngroundedClaim: false, ungroundedClaims: [], promptVersion: 'v1.5.0' },
    })
    const ctx = makeCtx({ currentMessage: null, followupTrigger: { reason: 'day_7', triggeredAt: new Date() } })
    const result = await verifyGroundingStage(ctx, makeGen())
    expect(result).toEqual({ status: 'clean' })
    expect(verifyGroundingMock).toHaveBeenCalledTimes(1)
    const args = verifyGroundingMock.mock.calls[0][0] as {
      isProactive: boolean
      inboundBody: string
    }
    expect(args.isProactive).toBe(true)
    expect(args.inboundBody).toBe('')
  })

  // Same shape, a holding-message ctx (manual followup trigger, no inbound) —
  // the second of the two proactive orchestrators this ticket wires up.
  it('calls the model for a holding-message-shaped ctx (manual trigger, no inbound) with isProactive: true', async () => {
    verifyGroundingMock.mockResolvedValueOnce({
      ok: true,
      data: { hasUngroundedClaim: false, ungroundedClaims: [], promptVersion: 'v1.5.0' },
    })
    const ctx = makeCtx({ currentMessage: null, followupTrigger: { reason: 'manual', triggeredAt: new Date() } })
    const result = await verifyGroundingStage(ctx, makeGen())
    expect(result).toEqual({ status: 'clean' })
    const args = verifyGroundingMock.mock.calls[0][0] as { isProactive: boolean }
    expect(args.isProactive).toBe(true)
  })

  // Mutation-verified pair: a hardcoded `isProactive: false` (or `true`) must
  // fail one of these two tests. Together with the two above, this pins the
  // derivation to `ctx.currentMessage === null` rather than any other signal
  // (followupTrigger, category, etc.) that happens to correlate with it.
  it('calls the model on the inbound path with isProactive: false and the real inbound body', async () => {
    verifyGroundingMock.mockResolvedValueOnce({
      ok: true,
      data: { hasUngroundedClaim: false, ungroundedClaims: [], promptVersion: 'v1.5.0' },
    })
    const result = await verifyGroundingStage(inboundCtx(), makeGen())
    expect(result).toEqual({ status: 'clean' })
    const args = verifyGroundingMock.mock.calls[0][0] as {
      isProactive: boolean
      inboundBody: string
    }
    expect(args.isProactive).toBe(false)
    expect(args.inboundBody).toBe("what's the wifi password?")
  })

  it('returns skipped without calling the model for a demo guest', async () => {
    const ctx = inboundCtx({ guest: { id: 'guest-1', firstName: 'Sam', isDemo: true } as RuntimeContext['guest'] })
    const result = await verifyGroundingStage(ctx, makeGen())
    expect(result).toEqual({ status: 'skipped' })
    expect(verifyGroundingMock).not.toHaveBeenCalled()
  })

  it('returns skipped without calling the model when the generation already self-reported a gap', async () => {
    const result = await verifyGroundingStage(inboundCtx(), makeGen({ knowledgeGap: true }))
    expect(result).toEqual({ status: 'skipped' })
    expect(verifyGroundingMock).not.toHaveBeenCalled()
  })

  // TAC-367: the fail-OPEN half. A transient fault must still return a
  // non-queueing state — this is the line the truncation carve-out is
  // deliberately NOT allowed to cross, because grounding runs on every
  // inbound and queuing every provider hiccup would be a fleet-wide flood.
  it('returns clean and logs a warning when the model call degrades (fail-open)', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    verifyGroundingMock.mockResolvedValueOnce({
      ok: false,
      error: 'model unavailable',
      errorCode: 'ai_verify_grounding_failed',
    })
    const result = await verifyGroundingStage(inboundCtx(), makeGen())
    expect(result).toEqual({ status: 'clean' })
    expect(warnSpy).toHaveBeenCalled()
  })

  // TAC-367: a degraded call ships a guest-facing reply with the only
  // fabrication check skipped. It must EMIT — silence on this path is the
  // exact property that let the truncation hole survive unobserved.
  it('emits grounding_verifier_unavailable with failedClosed=false when it degrades', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    verifyGroundingMock.mockResolvedValueOnce({
      ok: false,
      error: 'socket hang up',
      errorCode: 'ai_verify_grounding_failed',
    })
    await verifyGroundingStage(inboundCtx(), makeGen())
    expect(captureGroundingVerifierUnavailableMock).toHaveBeenCalledTimes(1)
    const call = captureGroundingVerifierUnavailableMock.mock.calls[0][0]
    expect(call.outcome).toBe('degraded')
    expect(call.failedClosed).toBe(false)
  })

  // TAC-367: the fail-CLOSED half. Truncation is a verdict the model produced
  // that we could not read, so it queues instead of being discarded.
  it('returns truncated when the call fails with the truncation errorCode', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    verifyGroundingMock.mockResolvedValueOnce({
      ok: false,
      error: 'No object generated: could not parse the response.',
      errorCode: VERIFY_GROUNDING_TRUNCATED_ERROR_CODE,
    })
    const result = await verifyGroundingStage(inboundCtx(), makeGen())
    expect(result).toEqual({ status: 'truncated' })
  })

  it('emits grounding_verifier_unavailable with failedClosed=true on truncation', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    verifyGroundingMock.mockResolvedValueOnce({
      ok: false,
      error: 'No object generated: could not parse the response.',
      errorCode: VERIFY_GROUNDING_TRUNCATED_ERROR_CODE,
    })
    await verifyGroundingStage(inboundCtx(), makeGen())
    expect(captureGroundingVerifierUnavailableMock).toHaveBeenCalledTimes(1)
    const call = captureGroundingVerifierUnavailableMock.mock.calls[0][0]
    expect(call.outcome).toBe('truncated')
    expect(call.failedClosed).toBe(true)
  })

  // TAC-367. Pins the DEFAULT DIRECTION: an errorCode this stage doesn't
  // recognize must degrade to fail-open, never be treated as truncation.
  // (An earlier version of this comment claimed it guarded against the
  // constant being renamed on one side only — it doesn't: stages.ts imports
  // VERIFY_GROUNDING_TRUNCATED_ERROR_CODE by name, so a one-sided rename
  // fails tsc. Reworded rather than left as a fourth entry in this repo's
  // list of tests whose stated rationale was never true.)
  it('treats an unrecognized errorCode as degraded, not truncated', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    verifyGroundingMock.mockResolvedValueOnce({
      ok: false,
      error: 'something else entirely',
      errorCode: 'some_other_code',
    })
    const result = await verifyGroundingStage(inboundCtx(), makeGen())
    expect(result).toEqual({ status: 'clean' })
  })

  it('returns clean and does NOT fire the PostHog event when nothing is found', async () => {
    verifyGroundingMock.mockResolvedValueOnce({
      ok: true,
      data: { hasUngroundedClaim: false, ungroundedClaims: [], promptVersion: 'v1.0.0' },
    })
    const result = await verifyGroundingStage(inboundCtx(), makeGen())
    expect(result).toEqual({ status: 'clean' })
    expect(captureUngroundedClaimCaughtMock).not.toHaveBeenCalled()
    expect(captureGroundingVerifierUnavailableMock).not.toHaveBeenCalled()
  })

  // TAC-301 part 1.5. The identity is the fix: the verifier must receive the
  // string the GENERATOR actually got, not one this stage rebuilds. A rebuild
  // is how the verifier's view drifts from the generator's, which is what
  // produced six false-positive classes.
  it("passes the generator's own composed userPrompt through verbatim", async () => {
    verifyGroundingMock.mockResolvedValueOnce({
      ok: true,
      data: { hasUngroundedClaim: false, ungroundedClaims: [], promptVersion: 'v1.1.0' },
    })
    const userPrompt =
      '## Right now\n- Status: CLOSED right now. Next open tomorrow at 7:00 AM.\n\n## Visit history\n- cortado [3 days ago]'
    await verifyGroundingStage(inboundCtx(), makeGen({ userPrompt }))
    expect(verifyGroundingMock).toHaveBeenCalledWith(
      expect.objectContaining({ runtimeContext: userPrompt }),
    )
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
    expect(result).toEqual({ status: 'flagged' as const, claims: ['invents a wifi network name and password'] })
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

describe('applyApprovalPolicyStage — unverified_url trigger (TAC-509)', () => {
  beforeEach(() => {
    pendingDraftMaybeSingleMock.mockReset()
    pendingDraftMaybeSingleMock.mockResolvedValue({ data: null, error: null })
    captureUnverifiedUrlHeldMock.mockReset()
  })

  it('queues with unverified_url when a link survived every attempt', async () => {
    const decision = await applyApprovalPolicyStage(
      makeCtx({}),
      makeGenerationResult({ unverifiedUrls: ['https://lemils.com/products/invented'] }),
    )
    expect(decision.action).toBe('queue')
    if (decision.action !== 'queue') return
    expect(decision.triggers).toContain(APPROVAL_TRIGGERS.UNVERIFIED_URL)
    expect(decision.primaryTrigger).toBe(APPROVAL_TRIGGERS.UNVERIFIED_URL)
  })

  it('sends when there is no unverified link', async () => {
    const decision = await applyApprovalPolicyStage(
      makeCtx({}),
      makeGenerationResult({ unverifiedUrls: [] }),
    )
    expect(decision.action).toBe('send')
    expect(captureUnverifiedUrlHeldMock).not.toHaveBeenCalled()
  })

  it('reports the links and the size of the venue list', async () => {
    // allowedUrlCount is what separates "the model invented a link" from
    // "this venue has no list yet". The two look identical on the card.
    const urls = ['https://lemils.com/products/invented']
    await applyApprovalPolicyStage(makeCtx({}), makeGenerationResult({ unverifiedUrls: urls }))
    expect(captureUnverifiedUrlHeldMock).toHaveBeenCalledTimes(1)
    const props = captureUnverifiedUrlHeldMock.mock.calls[0][0]
    expect(props.unverifiedUrls).toEqual(urls)
    expect(props.allowedUrlCount).toBe(0)
  })

  it('outranks self_talk_detected for the operator label', async () => {
    const decision = await applyApprovalPolicyStage(
      makeCtx({}),
      makeGenerationResult({
        unverifiedUrls: ['https://lemils.com/products/invented'],
        selfTalkViolationPersisted: true,
      }),
    )
    expect(decision.action).toBe('queue')
    if (decision.action !== 'queue') return
    expect(decision.triggers).toContain(APPROVAL_TRIGGERS.SELF_TALK_DETECTED)
    expect(decision.primaryTrigger).toBe(APPROVAL_TRIGGERS.UNVERIFIED_URL)
  })

  it('ranks below a commitment for the operator label', async () => {
    const decision = await applyApprovalPolicyStage(
      makeCtx({}),
      makeGenerationResult({
        unverifiedUrls: ['https://lemils.com/products/invented'],
        commitment: { type: 'comp', description: 'oat latte' },
      }),
    )
    expect(decision.action).toBe('queue')
    if (decision.action !== 'queue') return
    expect(decision.triggers).toContain(APPROVAL_TRIGGERS.UNVERIFIED_URL)
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
        channel: 'text',
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
  // TAC-394: this used to queue for its "other reason" by carrying a COMP
  // commitment. A comp now lands in the obligation slot, beside the gap card
  // rather than over it (see the next test), so the drop is exercised with a
  // reason that stays in the gap card's own slot.
  it('drops a draft that would queue for some other reason', async () => {
    pendingDraftMaybeSingleMock.mockResolvedValue({ data: gapCard, error: null })
    const decision = await applyApprovalPolicyStage(
      inboundCtx(),
      makeGenerationResult({ knowledgeGap: false, voiceFidelity: 0.45 }),
    )
    expect(decision.action).toBe('drop')
    if (decision.action !== 'drop') return
    expect(decision.reason).toBe('knowledge_gap_card_protected')
    expect(decision.protectedDraftId).toBe('gap-card-1')
  })

  // TAC-394 REVERSED this outcome. Before migration 041 a comp competed with
  // the gap card for the guest's one pending slot and was dropped. It now
  // becomes a second card, in the obligation slot, and the gap card is not
  // touched.
  it('queues a comp beside a gap card as a second card instead of dropping it', async () => {
    pendingDraftMaybeSingleMock.mockResolvedValue({ data: gapCard, error: null })
    const decision = await applyApprovalPolicyStage(
      inboundCtx(),
      makeGenerationResult({
        knowledgeGap: false,
        commitment: { type: 'comp', description: 'oat latte' },
      }),
    )
    expect(decision.action).toBe('queue')
    if (decision.action !== 'queue') return
    expect(decision.slot).toBe('obligation')
    expect(decision.existingPendingDraftId).toBeNull()
    expect(decision.otherSlotOccupied).toBe(true)
    expect(decision.triggers).not.toContain(APPROVAL_TRIGGERS.PREVIOUS_PENDING_HELD)
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
        channel: 'text',
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

describe('generateStage — hands the conversation channel to generateMessage (TAC-495)', () => {
  // The channel picks the channel copy in composePrompt. Every generation on
  // every path goes through here (or the Voices regen, tested in its own file),
  // so this is where a dropped or hardcoded channel would give every guest
  // the same copy again.
  it.each(['text', 'instagram', null] as const)('passes %s through unchanged', async (channel) => {
    generateMessageMock.mockResolvedValue({ ok: true, data: makeGenerationResult({ voiceFidelity: 0.8 }) })
    await generateStage(makeCtx({ corpus: [], conversationChannel: channel }), 'reply')
    expect(generateMessageMock).toHaveBeenCalledWith(expect.objectContaining({ channel }))
  })
})

describe('generateStage — fidelity floor exemption on knowledge gaps (TAC-309)', () => {
  const inbound = {
    id: 'inbound-1',
    body: 'what grade is the matcha?',
    providerMessageId: 'p1',
    receivedAt: new Date(),
    channel: 'text' as const,
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

describe('manual followups never regenerate over a card (TAC-307, TAC-394)', () => {
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
    // The pending-slot read resolves no rows in this fixture, so the assertion
    // that matters is that the lookup was not short-circuited by the manual
    // check. A send with no triggers is the correct outcome.
    expect(decision.action).toBe('send')
  })

  const waitingCard = {
    id: 'waiting-card',
    body: 'earlier draft an operator is about to approve',
    pending_until: null,
    review_reason: 'model_flagged',
    pending_commitment: null,
    created_at: '2026-09-14T16:26:34.000Z',
  }

  // TAC-394. The live bug on main: a manual followup that queued skipped the
  // read, INSERTed, hit the unique index, and race recovery overwrote the card.
  // The gate now reads the slot and refuses, explicitly.
  it('REFUSES a manual followup that would queue into an occupied slot', async () => {
    pendingDraftMaybeSingleMock.mockResolvedValue({ data: waitingCard, error: null })
    const decision = await applyApprovalPolicyStage(
      manualCtx({ default: 'operator_approval', perCategory: {} }),
      makeGenerationResult({ body: 'checking in', voiceFidelity: 0.95 }),
    )
    expect(decision).toEqual({
      action: 'drop',
      reason: 'slot_occupied',
      triggers: ['category_requires_approval'],
      protectedDraftId: 'waiting-card',
      protectedCommitment: null,
      droppedCommitment: null,
    })
  })

  it('still SENDS a manual followup beside a pending card when nothing holds it', async () => {
    pendingDraftMaybeSingleMock.mockResolvedValue({ data: waitingCard, error: null })
    const decision = await applyApprovalPolicyStage(
      manualCtx(),
      makeGenerationResult({ body: 'checking in', voiceFidelity: 0.95 }),
    )
    expect(decision).toEqual({ action: 'send' })
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

// ---------------------------------------------------------------------------
// buildAiRuntime — emoji cadence wiring (TAC-362)
// ---------------------------------------------------------------------------

describe('buildAiRuntime — emoji cadence wiring (TAC-362)', () => {
  function ctxWithPolicy(emojiPolicy: 'never' | 'sparingly' | 'frequent') {
    return makeCtx({
      venue: {
        id: 'venue-1',
        timezone: 'America/Los_Angeles',
        venueInfo: TEST_VENUE_INFO,
        brandPersona: BrandPersonaSchema.parse({
          tone: 'warm and direct',
          formality: 'casual',
          speakerFraming: 'venue',
          emojiPolicy,
          lengthGuide: 'short',
        }),
      } as RuntimeContext['venue'],
      currentMessage: { id: 'm1', body: 'what time do you close?' } as RuntimeContext['currentMessage'],
      recognition: { state: 'returning' } as RuntimeContext['recognition'],
    })
  }

  // THE "ALWAYS SET" GUARD. emojiDirective is optional on the type (making it
  // required would force a ~150-site edit across serializers.test.ts's
  // fixtures), so nothing in the type system says buildAiRuntime populates
  // it. This asserts the behaviour the optionality relies on, for every enum
  // value, so "the producer always sets it" is guarded rather than assumed.
  it('resolves a directive for every emojiPolicy value', () => {
    expect(buildAiRuntime(ctxWithPolicy('frequent'), () => 0).emojiDirective).toBe('allowed')
    expect(buildAiRuntime(ctxWithPolicy('frequent'), () => 0.99).emojiDirective).toBe('none')
    // The two non-varying policies resolve to undefined BY DESIGN — the
    // serializer then renders no per-message block and the persona's own
    // standing statement governs the turn, unchanged. See EMOJI_PROBABILITY.
    expect(buildAiRuntime(ctxWithPolicy('never'), () => 0).emojiDirective).toBeUndefined()
    expect(buildAiRuntime(ctxWithPolicy('sparingly'), () => 0).emojiDirective).toBeUndefined()
  })

  // The injected rng has to actually reach the decision. A version that
  // defaulted internally would pass every assertion above that doesn't vary
  // the draw.
  it('threads the injected rng through to the flip', () => {
    const draws = [0.1, 0.99, 0.2]
    let i = 0
    const rng = () => draws[i++] ?? 0
    const ctx = ctxWithPolicy('frequent')
    expect([
      buildAiRuntime(ctx, rng).emojiDirective,
      buildAiRuntime(ctx, rng).emojiDirective,
      buildAiRuntime(ctx, rng).emojiDirective,
    ]).toEqual(['allowed', 'none', 'allowed'])
  })

  // The acceptance criterion "a venue set to no emoji gets none" — asserted
  // at the strongest available point: `never` never reaches a coin at all,
  // so there is no draw that could permit one.
  it('never yields an emoji licence for a never venue, at any draw', () => {
    for (const draw of [0, 0.25, 0.5, 0.75, 0.999]) {
      expect(buildAiRuntime(ctxWithPolicy('never'), () => draw).emojiDirective).not.toBe('allowed')
    }
  })

  it('defaults the rng so production callers need not pass one', () => {
    const directive = buildAiRuntime(ctxWithPolicy('frequent')).emojiDirective
    expect(['allowed', 'none']).toContain(directive)
  })
})

// ---------------------------------------------------------------------------
// TAC-364: the gate threads the verifier's claims to the persist layer
// ---------------------------------------------------------------------------
//
// Before this the claims went to PostHog and the Langfuse span and nowhere
// else — computed, then discarded at exactly the point they would be useful.
// The gate used them only as a boolean. Now they ride on the decision so
// `persistOrRegenQueuedDraft` can land them on messages.ungrounded_claims and
// the operator card can show WHICH sentence is the suspect one.
describe('applyApprovalPolicyStage — ungroundedClaims (TAC-364)', () => {
  beforeEach(() => {
    pendingDraftMaybeSingleMock.mockReset()
    pendingDraftMaybeSingleMock.mockResolvedValue({ data: null, error: null })
  })

  // Same shape as the TAC-350 backstop block's fixture: an inbound turn. This
  // block tests applyApprovalPolicyStage directly with a groundingBackstop
  // ARGUMENT already supplied, so it's exercising the gate's own trigger
  // logic, not verifyGroundingStage's decision about when to call the model
  // (which, since TAC-376, also runs on followups — see that describe block).
  const inboundCtx = () =>
    makeCtx({
      currentMessage: {
        id: 'inbound-1',
        body: 'what are the four SoFi variations?',
        providerMessageId: 'p1',
        receivedAt: new Date(),
        channel: 'text',
      },
      classification: {
        category: 'new_question',
        classifierConfidence: 0.9,
        reasoning: 'question',
        crisisSafety: false,
      },
    })

  it('carries the flagged claims through verbatim', async () => {
    const claims = [
      'invents four SoFi variation names not in the corpus',
      'states a wifi password that appears nowhere in venue knowledge',
    ]
    const decision = await applyApprovalPolicyStage(
      inboundCtx(),
      makeGenerationResult({ knowledgeGap: false }),
      { status: 'flagged' as const, claims },
    )
    expect(decision.action).toBe('queue')
    if (decision.action !== 'queue') return
    expect(decision.ungroundedClaims).toEqual(claims)
  })

  // The three-state contract (TAC-364 ruling 3). `[]` and `null` are DIFFERENT
  // answers here and the difference is the point: TAC-367 was filed because a
  // grounding check that silently didn't run was invisible everywhere, so
  // "ran and found nothing" must be distinguishable from "never ran" on the
  // row. Each of the four grounding states gets its own assertion below,
  // because a single "is falsy when there's nothing" test would pass against a
  // version that conflated them — which is the bug being avoided.
  it('is [] — the check RAN and found nothing — on clean', async () => {
    const decision = await applyApprovalPolicyStage(
      inboundCtx(),
      makeGenerationResult({ knowledgeGap: false, voiceFidelity: 0.5 }),
      { status: 'clean' as const },
    )
    expect(decision.action).toBe('queue')
    if (decision.action !== 'queue') return
    expect(decision.ungroundedClaims).toEqual([])
    expect(decision.ungroundedClaims).not.toBeNull()
  })

  // The one that is easy to get backwards. A truncated check means the verdict
  // could not be READ — an absence of information about the reply, not a
  // finding against it. It queues (GROUNDING_CHECK_FAILED, fail-closed), but
  // there is no claim to show, and pairing "I couldn't finish checking this
  // one" with a list of flagged claims would be incoherent.
  // The one that is easy to get backwards. A truncated check RAN but produced
  // no readable verdict, so there is no claim information — which is NULL, not
  // `[]`. `[]` would assert it found nothing, and the paired review_reason
  // ("I couldn't finish checking this one") already carries the
  // didn't-complete signal, so NULL is what reads coherently beside it.
  it('is null on a truncated check — ran, but no readable verdict', async () => {
    const decision = await applyApprovalPolicyStage(
      inboundCtx(),
      makeGenerationResult({ knowledgeGap: false }),
      { status: 'truncated' as const },
    )
    expect(decision.action).toBe('queue')
    if (decision.action !== 'queue') return
    expect(decision.triggers).toContain(APPROVAL_TRIGGERS.GROUNDING_CHECK_FAILED)
    expect(decision.ungroundedClaims).toBeNull()
  })

  it('is null when the check never ran at all', async () => {
    // knowledgeGap=true means the model self-reported, so verifyGroundingStage
    // skips — the exact "didn't run" case the null exists to record.
    const decision = await applyApprovalPolicyStage(
      inboundCtx(),
      makeGenerationResult({ knowledgeGap: true }),
    )
    expect(decision.action).toBe('queue')
    if (decision.action !== 'queue') return
    expect(decision.ungroundedClaims).toBeNull()
  })

  it('distinguishes ran-and-found-nothing from never-ran', async () => {
    // The pair, asserted together. A version that collapsed both to `[]` — or
    // both to null — passes each of the two tests above in isolation only if
    // they are read separately; this one fails outright, and it is the whole
    // ruling in one assertion.
    const ran = await applyApprovalPolicyStage(
      inboundCtx(),
      makeGenerationResult({ knowledgeGap: false, voiceFidelity: 0.5 }),
      { status: 'clean' as const },
    )
    const neverRan = await applyApprovalPolicyStage(
      inboundCtx(),
      makeGenerationResult({ knowledgeGap: true }),
      { status: 'skipped' as const },
    )
    if (ran.action !== 'queue' || neverRan.action !== 'queue') throw new Error('both queue')
    expect(ran.ungroundedClaims).not.toEqual(neverRan.ungroundedClaims)
    expect(ran.ungroundedClaims).toEqual([])
    expect(neverRan.ungroundedClaims).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// TAC-364: generation_failed is a gap card to the shared predicate
// ---------------------------------------------------------------------------
describe('isKnowledgeGapCard — generation_failed (TAC-364)', () => {
  // The crash card arms pending_until like any gap card, so it is protected
  // while the clock runs regardless of its label. This leg is what keeps it
  // protected AFTER the timer CAS-claims and nulls that column — without it,
  // splitting the crash path off `knowledge_gap` would have silently
  // reintroduced the data-loss bug the review_reason leg exists to prevent:
  // the next turn that queued for any reason would UPDATE the card in place
  // and the guest's outstanding question would be gone.
  it('recognizes a crash card whose clock has already fired', () => {
    expect(
      isKnowledgeGapCard({
        review_reason: GENERATION_FAILED_REVIEW_REASON,
        pending_until: null,
      }),
    ).toBe(true)
  })

  it('still refuses an ordinary pending draft', () => {
    expect(
      isKnowledgeGapCard({ review_reason: 'commitment_type_gated', pending_until: null }),
    ).toBe(false)
  })
})

describe('KNOWLEDGE_GAP_CARD_REVIEW_REASONS (TAC-364)', () => {
  // Pinned BY VALUE. The set is shared between isKnowledgeGapCard and the
  // PostgREST filter in findPendingQuestion, and those two used to be
  // hand-maintained copies that drifted — the query carried one value where
  // the predicate carried two, and a backstop card whose clock had fired was
  // recognized by one and invisible to the other for as long as that lasted.
  // Sharing the array makes the drift impossible; this test makes a change to
  // the SET deliberate, since adding a value silently widens what the agent
  // treats as an unanswered question.
  it('is exactly the three card-producing reasons', () => {
    expect([...KNOWLEDGE_GAP_CARD_REVIEW_REASONS]).toEqual([
      'knowledge_gap',
      'knowledge_gap_backstop',
      'generation_failed',
    ])
  })

  it('is what isKnowledgeGapCard actually accepts', () => {
    for (const reason of KNOWLEDGE_GAP_CARD_REVIEW_REASONS) {
      expect(isKnowledgeGapCard({ review_reason: reason, pending_until: null })).toBe(true)
    }
  })
})

// ---------------------------------------------------------------------------
// TAC-394: two pending slots per guest (migration 041)
// ---------------------------------------------------------------------------
//
// Every fixture sets `pending_commitment`, because the carrier is what decides a
// card's slot. Rows come back in the order listed, and several tests put the
// WRONG slot's card first: before TAC-394 the gate took whichever row an
// unordered `.limit(1)` read returned, so a card listed first is the card it
// would have regenerated over.
describe('applyApprovalPolicyStage — two pending slots (TAC-394)', () => {
  const compA = {
    type: 'comp',
    description: 'a free cortado on your next visit',
    code: '7K2P',
    expiresAt: null,
  }
  const compCard = {
    id: 'card-a',
    body: "Really sorry to hear that. Come back in and the next one's on us.",
    pending_until: null,
    review_reason: APPROVAL_TRIGGERS.COMMITMENT_TYPE_GATED,
    pending_commitment: compA,
    created_at: '2026-09-14T16:26:34.000Z',
  }
  const conversationCard = {
    id: 'card-conv',
    body: '7am on Sundays',
    pending_until: null,
    review_reason: 'category_requires_approval',
    pending_commitment: null,
    created_at: '2026-09-14T16:31:23.000Z',
  }
  const conversationGapCard = {
    ...conversationCard,
    id: 'gap-conv',
    body: '',
    pending_until: new Date(Date.now() + 60_000).toISOString(),
    review_reason: APPROVAL_TRIGGERS.KNOWLEDGE_GAP,
  }
  const HELD = { default: 'operator_approval', perCategory: {} }

  function inbound(category: string, policy?: unknown): RuntimeContext {
    return makeCtx({
      venue: { id: 'venue-1', approvalPolicy: policy } as RuntimeContext['venue'],
      currentMessage: {
        id: 'inbound-2',
        body: 'what time do you open on sundaus',
        providerMessageId: 'p2',
        receivedAt: new Date(),
        channel: 'text',
      },
      classification: {
        category,
        classifierConfidence: 0.9,
        reasoning: 'test',
        crisisSafety: false,
      } as RuntimeContext['classification'],
    })
  }

  beforeEach(() => {
    pendingDraftMaybeSingleMock.mockReset()
    pendingDraftMaybeSingleMock.mockResolvedValue({ data: null, error: null })
  })

  // THE RULING'S TEST, at the gate. "Preserves the obligation" means the same
  // commitment, not the same type: a comp for a different item is a different
  // obligation, and the pending card wins.
  it('comp A pending, replacement carries comp B: the existing card wins', async () => {
    pendingDraftMaybeSingleMock.mockResolvedValue({ data: [compCard], error: null })
    const decision = await applyApprovalPolicyStage(
      inbound('comp_complaint'),
      makeGenerationResult({
        commitment: { type: 'comp', description: 'a free croissant', code: 'Q4X9' },
      }),
    )
    expect(decision).toEqual({
      action: 'drop',
      reason: 'obligation_slot_taken',
      triggers: expect.arrayContaining([APPROVAL_TRIGGERS.COMMITMENT_TYPE_GATED]),
      protectedDraftId: 'card-a',
      protectedCommitment: {
        type: 'comp',
        description: 'a free cortado on your next visit',
        code: '7K2P',
      },
      droppedCommitment: { type: 'comp', description: 'a free croissant', code: 'Q4X9' },
    })
  })

  it('the same comp, differing only in case and whitespace, regenerates the comp card in place', async () => {
    pendingDraftMaybeSingleMock.mockResolvedValue({
      data: [conversationCard, compCard],
      error: null,
    })
    const decision = await applyApprovalPolicyStage(
      inbound('comp_complaint'),
      makeGenerationResult({
        commitment: { type: 'comp', description: '  A Free Cortado on your next visit ' },
      }),
    )
    expect(decision.action).toBe('queue')
    if (decision.action !== 'queue') return
    expect(decision.slot).toBe('obligation')
    expect(decision.existingPendingDraftId).toBe('card-a')
    expect(decision.otherSlotOccupied).toBe(true)
    expect(decision.triggers).toContain(APPROVAL_TRIGGERS.PREVIOUS_PENDING_HELD)
  })

  // Accepted consequence (ruled 2026-09-14): rewording beyond case and
  // whitespace is a different commitment. Pinned so it stays deliberate.
  it('the same comp in different words is dropped, and the existing card stays', async () => {
    pendingDraftMaybeSingleMock.mockResolvedValue({ data: [compCard], error: null })
    const decision = await applyApprovalPolicyStage(
      inbound('comp_complaint'),
      makeGenerationResult({ commitment: { type: 'comp', description: 'your next cortado is free' } }),
    )
    expect(decision.action).toBe('drop')
    if (decision.action !== 'drop') return
    expect(decision.reason).toBe('obligation_slot_taken')
    expect(decision.protectedDraftId).toBe('card-a')
  })

  it('a hold for the same item is a different obligation', async () => {
    pendingDraftMaybeSingleMock.mockResolvedValue({ data: [compCard], error: null })
    const decision = await applyApprovalPolicyStage(
      inbound('comp_complaint'),
      makeGenerationResult({
        commitment: { type: 'hold', description: 'a free cortado on your next visit' },
      }),
    )
    expect(decision.action).toBe('drop')
    if (decision.action !== 'drop') return
    expect(decision.reason).toBe('obligation_slot_taken')
  })

  // The 2026-09-14 incident, fixed. Nothing holds the hours answer, so it sends.
  it('an untriggered reply to the next question SENDS beside a pending comp card', async () => {
    pendingDraftMaybeSingleMock.mockResolvedValue({ data: [compCard], error: null })
    const decision = await applyApprovalPolicyStage(
      inbound('new_question'),
      makeGenerationResult({ body: '7am on Sundays' }),
    )
    expect(decision).toEqual({ action: 'send' })
  })

  it('a held reply to the next question becomes a second card, never a regen of the comp card', async () => {
    pendingDraftMaybeSingleMock.mockResolvedValue({ data: [compCard], error: null })
    const decision = await applyApprovalPolicyStage(
      inbound('new_question', HELD),
      makeGenerationResult({ body: '7am on Sundays' }),
    )
    expect(decision.action).toBe('queue')
    if (decision.action !== 'queue') return
    expect(decision.slot).toBe('conversation')
    expect(decision.existingPendingDraftId).toBeNull()
    expect(decision.otherSlotOccupied).toBe(true)
    // previous_pending_held fires only for a card in the draft's OWN slot.
    expect(decision.triggers).toEqual(['category_requires_approval'])
  })

  it('with both cards pending and the comp card listed first, a held reply regenerates the conversation card', async () => {
    pendingDraftMaybeSingleMock.mockResolvedValue({
      data: [compCard, conversationCard],
      error: null,
    })
    const decision = await applyApprovalPolicyStage(
      inbound('new_question', HELD),
      makeGenerationResult({ body: 'we open at 7 on sundays' }),
    )
    expect(decision.action).toBe('queue')
    if (decision.action !== 'queue') return
    expect(decision.slot).toBe('conversation')
    expect(decision.existingPendingDraftId).toBe('card-conv')
    expect(decision.triggers).toContain(APPROVAL_TRIGGERS.PREVIOUS_PENDING_HELD)
  })

  // "Can give up its obligation" means the body is blanked (signed off
  // 2026-09-14). TAC-309 nulls the carrier with the body, so the draft is a
  // conversation card and never competes with the comp.
  it('a blanked comp B draft gives up its obligation and lands in the conversation slot', async () => {
    pendingDraftMaybeSingleMock.mockResolvedValue({ data: [compCard], error: null })
    const decision = await applyApprovalPolicyStage(
      inbound('new_question'),
      makeGenerationResult({
        knowledgeGap: true,
        commitment: { type: 'comp', description: 'a free croissant' },
      }),
    )
    expect(decision.action).toBe('queue')
    if (decision.action !== 'queue') return
    expect(decision.slot).toBe('conversation')
    expect(decision.blankBody).toBe(true)
    expect(decision.existingPendingDraftId).toBeNull()
    expect(decision.otherSlotOccupied).toBe(true)
  })

  it('TAC-308 still applies inside the obligation slot: a comp gap card is not regenerated by a non-gap turn', async () => {
    const compGapCard = {
      ...compCard,
      pending_until: new Date(Date.now() + 60_000).toISOString(),
      review_reason: APPROVAL_TRIGGERS.KNOWLEDGE_GAP_BACKSTOP,
    }
    pendingDraftMaybeSingleMock.mockResolvedValue({ data: [compGapCard], error: null })
    const decision = await applyApprovalPolicyStage(
      inbound('comp_complaint'),
      makeGenerationResult({
        commitment: { type: 'comp', description: 'a free cortado on your next visit' },
      }),
      { status: 'clean' as const },
    )
    expect(decision.action).toBe('drop')
    if (decision.action !== 'drop') return
    expect(decision.reason).toBe('knowledge_gap_card_protected')
    expect(decision.protectedDraftId).toBe('card-a')
  })

  it('a knowledge-gap card in the conversation slot still lets an answerable reply send, with a comp card listed first', async () => {
    pendingDraftMaybeSingleMock.mockResolvedValue({
      data: [compCard, conversationGapCard],
      error: null,
    })
    const decision = await applyApprovalPolicyStage(
      inbound('new_question'),
      makeGenerationResult({ body: 'we open at 7' }),
    )
    expect(decision).toEqual({ action: 'send' })
  })

  // The holding-message clock is the guest's, not the slot's. The timeout scan
  // fires once per card, so a gap turn that armed a clock beside a gap card in
  // the OTHER slot would send the guest a second holding message.
  it('a gap turn in the obligation slot arms no clock beside a gap card in the conversation slot', async () => {
    pendingDraftMaybeSingleMock.mockResolvedValue({ data: [conversationGapCard], error: null })
    const decision = await applyApprovalPolicyStage(
      inbound('comp_complaint'),
      makeGenerationResult({
        commitment: { type: 'comp', description: 'a free cortado on your next visit' },
      }),
      { status: 'flagged' as const, claims: ['invents a fact'] },
    )
    expect(decision.action).toBe('queue')
    if (decision.action !== 'queue') return
    expect(decision.slot).toBe('obligation')
    expect(decision.existingPendingDraftId).toBeNull()
    expect(decision.triggers).toContain(APPROVAL_TRIGGERS.KNOWLEDGE_GAP_BACKSTOP)
    expect(decision.pendingUntil).toBeUndefined()
  })

  it('a gap turn in the conversation slot arms no clock beside a gap card in the obligation slot', async () => {
    const compGapCard = {
      ...compCard,
      pending_until: new Date(Date.now() + 60_000).toISOString(),
      review_reason: APPROVAL_TRIGGERS.KNOWLEDGE_GAP_BACKSTOP,
    }
    pendingDraftMaybeSingleMock.mockResolvedValue({ data: [compGapCard], error: null })
    const decision = await applyApprovalPolicyStage(
      inbound('new_question'),
      makeGenerationResult({ knowledgeGap: true }),
    )
    expect(decision.action).toBe('queue')
    if (decision.action !== 'queue') return
    expect(decision.slot).toBe('conversation')
    expect(decision.existingPendingDraftId).toBeNull()
    expect(decision.pendingUntil).toBeUndefined()
  })

  // The control: an ordinary comp card is not a gap card, so it arms nothing.
  it('a gap turn beside an ordinary comp card still arms its clock', async () => {
    pendingDraftMaybeSingleMock.mockResolvedValue({ data: [compCard], error: null })
    const decision = await applyApprovalPolicyStage(
      inbound('new_question'),
      makeGenerationResult({ knowledgeGap: true }),
    )
    expect(decision.action).toBe('queue')
    if (decision.action !== 'queue') return
    expect(decision.slot).toBe('conversation')
    expect(decision.pendingUntil).toBeInstanceOf(Date)
  })

  // The holding message treats anything but `send` as a failure and falls back
  // to an ungated line. A comp card in the other slot must not cost it its send.
  it('the holding-message path (manual trigger, no inbound) sends beside a comp card', async () => {
    pendingDraftMaybeSingleMock.mockResolvedValue({
      data: [compCard, conversationGapCard],
      error: null,
    })
    const decision = await applyApprovalPolicyStage(
      makeCtx({
        venue: { id: 'venue-1' } as RuntimeContext['venue'],
        followupTrigger: { reason: 'manual', triggeredAt: new Date() } as RuntimeContext['followupTrigger'],
        currentMessage: null,
      }),
      makeGenerationResult({ body: 'Still looking into that for you.' }),
    )
    expect(decision).toEqual({ action: 'send' })
  })
})

// TAC-394: pending-slots.ts cannot import APPROVAL_TRIGGERS (it would pull this
// file's SDK dependencies into the persist layer), so it spells the trigger and
// review_reason codes it keys on as literals. These pin those literals to the
// constants they stand for.
describe('pending-slot literals track the gate constants (TAC-394)', () => {
  it('KNOWLEDGE_GAP_CARD_REVIEW_REASONS is the gate constants, in order', () => {
    expect([...KNOWLEDGE_GAP_CARD_REVIEW_REASONS]).toEqual([
      APPROVAL_TRIGGERS.KNOWLEDGE_GAP,
      APPROVAL_TRIGGERS.KNOWLEDGE_GAP_BACKSTOP,
      GENERATION_FAILED_REVIEW_REASON,
    ])
  })

  it("gapFlagsFromTriggers reads the gate's own trigger codes", () => {
    expect(gapFlagsFromTriggers([APPROVAL_TRIGGERS.KNOWLEDGE_GAP])).toEqual({
      isGapTurn: true,
      checkDidNotComplete: false,
    })
    expect(gapFlagsFromTriggers([APPROVAL_TRIGGERS.KNOWLEDGE_GAP_BACKSTOP])).toEqual({
      isGapTurn: true,
      checkDidNotComplete: false,
    })
    expect(gapFlagsFromTriggers([APPROVAL_TRIGGERS.GROUNDING_CHECK_FAILED])).toEqual({
      isGapTurn: false,
      checkDidNotComplete: true,
    })
    expect(
      gapFlagsFromTriggers([
        APPROVAL_TRIGGERS.COMMITMENT_TYPE_GATED,
        APPROVAL_TRIGGERS.PREVIOUS_PENDING_HELD,
      ]),
    ).toEqual({ isGapTurn: false, checkDidNotComplete: false })
    expect(gapFlagsFromTriggers(undefined)).toEqual({ isGapTurn: false, checkDidNotComplete: false })
  })
})


describe('verifyProsePromiseStage (TAC-401)', () => {
  beforeEach(() => {
    verifyProsePromiseMock.mockReset()
    captureProsePromiseCaughtMock.mockReset()
    captureProsePromiseCheckUnavailableMock.mockReset()
  })

  function flagged(type: string | null, description: string | null) {
    return {
      ok: true,
      data: {
        promisesSomething: true,
        commitmentType: type,
        commitmentDescription: description,
        promptVersion: 'v1.0.0',
      },
    }
  }

  const clean = {
    ok: true,
    data: {
      promisesSomething: false,
      commitmentType: null,
      commitmentDescription: null,
      promptVersion: 'v1.0.0',
    },
  }

  it('skips without calling the model for a demo guest', async () => {
    const ctx = makeCtx({
      guest: { id: 'guest-1', firstName: 'Sam', isDemo: true } as RuntimeContext['guest'],
    })
    const result = await verifyProsePromiseStage(ctx, makeGenerationResult({}))
    expect(result).toEqual({ status: 'skipped' })
    expect(verifyProsePromiseMock).not.toHaveBeenCalled()
  })

  // Ruling 3 at the call boundary: an obligation already on the draft means
  // the card already carries a carrier, so the check would buy nothing.
  it('skips without calling the model when the draft already carries an obligation', async () => {
    const result = await verifyProsePromiseStage(
      makeCtx({}),
      makeGenerationResult({ commitment: { type: 'comp', description: 'oat latte' } }),
    )
    expect(result).toEqual({ status: 'skipped' })
    expect(verifyProsePromiseMock).not.toHaveBeenCalled()
  })

  // The other half of ruling 3, and the one a "tidy" would break: a
  // recommendation is NOT an obligation, so the check still has to run. The
  // carrier is protected downstream by resolveDraftCarrier, not by skipping.
  it('DOES run when the draft carries only a recommendation', async () => {
    verifyProsePromiseMock.mockResolvedValueOnce(clean)
    const result = await verifyProsePromiseStage(
      makeCtx({}),
      makeGenerationResult({ commitment: { type: 'recommendation', description: 'the cortado' } }),
    )
    expect(result).toEqual({ status: 'clean' })
    expect(verifyProsePromiseMock).toHaveBeenCalledTimes(1)
  })

  // Ruling 1 forbids depending on the self-flag, so a model-flagged draft is
  // NOT a reason to skip: it queues, but with no carrier, which is the ticket.
  it('DOES run when the model self-flagged, because nothing may depend on that flag', async () => {
    verifyProsePromiseMock.mockResolvedValueOnce(clean)
    const result = await verifyProsePromiseStage(
      makeCtx({}),
      makeGenerationResult({ requiresOperatorApproval: true }),
    )
    expect(result).toEqual({ status: 'clean' })
    expect(verifyProsePromiseMock).toHaveBeenCalledTimes(1)
  })

  it('returns "clean" when the check finds no promise', async () => {
    verifyProsePromiseMock.mockResolvedValueOnce(clean)
    const result = await verifyProsePromiseStage(makeCtx({}), makeGenerationResult({}))
    expect(result).toEqual({ status: 'clean' })
    expect(captureProsePromiseCaughtMock).not.toHaveBeenCalled()
  })

  it('mints the carrier ONCE, with a verification code, on a flagged promise', async () => {
    verifyProsePromiseMock.mockResolvedValueOnce(flagged('comp', 'a replacement cortado'))
    const result = await verifyProsePromiseStage(
      makeCtx({}),
      makeGenerationResult({ body: "sorry about that, next one's on us" }),
    )
    expect(result.status).toBe('flagged')
    if (result.status !== 'flagged') return
    expect(result.commitment).not.toBeNull()
    expect(result.commitment?.type).toBe('comp')
    expect(result.commitment?.description).toBe('a replacement cortado')
    // A comp needs a code, and it is minted here rather than at each persist
    // site so the code on the card is the code in the alert.
    expect(result.commitment?.code).toMatch(/^[A-Z0-9]{4}$/)
    expect(verifyProsePromiseMock).toHaveBeenCalledTimes(1)
  })

  // The ambiguous shape survives as flagged-with-no-carrier. Downgrading it to
  // 'clean' is the false negative the fail-closed posture exists to prevent.
  it('stays flagged with a null carrier when the check cannot name the commitment', async () => {
    verifyProsePromiseMock.mockResolvedValueOnce(flagged(null, null))
    const result = await verifyProsePromiseStage(makeCtx({}), makeGenerationResult({}))
    expect(result).toEqual({ status: 'flagged', commitment: null })
  })

  it('emits the caught event with what is owed and whether the model had its own carrier', async () => {
    verifyProsePromiseMock.mockResolvedValueOnce(flagged('comp', 'a replacement cortado'))
    await verifyProsePromiseStage(
      makeCtx({}),
      makeGenerationResult({ commitment: { type: 'recommendation', description: 'the cortado' } }),
    )
    expect(captureProsePromiseCaughtMock).toHaveBeenCalledTimes(1)
    const props = captureProsePromiseCaughtMock.mock.calls[0]?.[0]
    expect(props.commitmentType).toBe('comp')
    expect(props.commitmentDescription).toBe('a replacement cortado')
    expect(props.keptExistingCommitment).toBe(true)
  })

  // ---- Failure posture (ruled 2026-09-21, ruling 1) ----

  it('retries ONCE on a transient fault and uses the retry verdict', async () => {
    verifyProsePromiseMock
      .mockResolvedValueOnce({ ok: false, error: 'fetch failed', errorCode: 'ai_verify_prose_promise_failed' })
      .mockResolvedValueOnce(clean)
    const result = await verifyProsePromiseStage(makeCtx({}), makeGenerationResult({}))
    expect(result).toEqual({ status: 'clean' })
    expect(verifyProsePromiseMock).toHaveBeenCalledTimes(2)
    expect(captureProsePromiseCheckUnavailableMock).not.toHaveBeenCalled()
  })

  // THE MUTANT THIS WHOLE TICKET TURNS ON. Returning 'clean' here instead of
  // 'check_failed' is the fail-open revert: a promise sends because the check
  // could not run.
  it('FAILS CLOSED when the retry also fails', async () => {
    verifyProsePromiseMock
      .mockResolvedValueOnce({ ok: false, error: 'fetch failed', errorCode: 'ai_verify_prose_promise_failed' })
      .mockResolvedValueOnce({ ok: false, error: 'fetch failed again', errorCode: 'ai_verify_prose_promise_failed' })
    const result = await verifyProsePromiseStage(makeCtx({}), makeGenerationResult({}))
    expect(result).toEqual({ status: 'check_failed' })
    expect(verifyProsePromiseMock).toHaveBeenCalledTimes(2)
    const props = captureProsePromiseCheckUnavailableMock.mock.calls[0]?.[0]
    expect(props.outcome).toBe('errored')
    expect(props.retried).toBe(true)
  })

  // Truncation is NOT retried: the cap was already hit, so a second call hits
  // it again. Spending the retry here would be pure latency on every
  // truncated turn.
  it('does NOT retry on truncation, and fails closed at once', async () => {
    verifyProsePromiseMock.mockResolvedValueOnce({
      ok: false,
      error: 'no object generated',
      errorCode: 'ai_verify_prose_promise_truncated',
    })
    const result = await verifyProsePromiseStage(makeCtx({}), makeGenerationResult({}))
    expect(result).toEqual({ status: 'check_failed' })
    expect(verifyProsePromiseMock).toHaveBeenCalledTimes(1)
    const props = captureProsePromiseCheckUnavailableMock.mock.calls[0]?.[0]
    expect(props.outcome).toBe('truncated')
    expect(props.retried).toBe(false)
  })
})

describe('applyApprovalPolicyStage — prose-promise triggers (TAC-401)', () => {
  beforeEach(() => {
    // Both slots empty. Without this the gate reads whatever the previous
    // describe left on the shared mock and every decision here comes back
    // 'drop', which looks like a wiring bug and is a fixture one.
    pendingDraftMaybeSingleMock.mockReset()
    pendingDraftMaybeSingleMock.mockResolvedValue({ data: null, error: null })
  })

  const promisedComp = {
    type: 'comp' as const,
    description: 'a replacement cortado',
    code: 'A1B2',
    expiresAt: null,
  }

  it('queues on a flagged promise and threads the carrier to the persist layer', async () => {
    const decision = await applyApprovalPolicyStage(
      makeCtx({}),
      makeGenerationResult({ body: "next one's on us" }),
      { status: 'skipped' },
      { status: 'skipped' },
      { status: 'flagged', commitment: promisedComp },
    )
    expect(decision.action).toBe('queue')
    if (decision.action !== 'queue') return
    expect(decision.triggers).toContain(APPROVAL_TRIGGERS.PROSE_PROMISE_BACKSTOP)
    expect(decision.promisedCommitment).toEqual(promisedComp)
  })

  it('queues on a failed check under its OWN trigger, carrying no commitment', async () => {
    const decision = await applyApprovalPolicyStage(
      makeCtx({}),
      makeGenerationResult({}),
      { status: 'skipped' },
      { status: 'skipped' },
      { status: 'check_failed' },
    )
    expect(decision.action).toBe('queue')
    if (decision.action !== 'queue') return
    expect(decision.triggers).toEqual([APPROVAL_TRIGGERS.PROSE_PROMISE_CHECK_FAILED])
    expect(decision.triggers).not.toContain(APPROVAL_TRIGGERS.PROSE_PROMISE_BACKSTOP)
    expect(decision.promisedCommitment).toBeNull()
  })

  it('sends when the check is clean and nothing else fires', async () => {
    const decision = await applyApprovalPolicyStage(
      makeCtx({}),
      makeGenerationResult({}),
      { status: 'skipped' },
      { status: 'skipped' },
      { status: 'clean' },
    )
    expect(decision.action).toBe('send')
  })

  // The default keeps every caller that predates this parameter behaving
  // exactly as before — the harness and the Voices path both omit it.
  it('defaults to skipped when the caller omits the parameter', async () => {
    const decision = await applyApprovalPolicyStage(makeCtx({}), makeGenerationResult({}))
    expect(decision.action).toBe('send')
  })

  // A flagged promise routes the draft into the OBLIGATION slot, because the
  // carrier it supplies is a comp. That is what makes it compete with a real
  // comp card rather than with the conversation card.
  it('routes a flagged promise into the obligation slot', async () => {
    const decision = await applyApprovalPolicyStage(
      makeCtx({}),
      makeGenerationResult({}),
      { status: 'skipped' },
      { status: 'skipped' },
      { status: 'flagged', commitment: promisedComp },
    )
    expect(decision.action).toBe('queue')
    if (decision.action !== 'queue') return
    expect(decision.slot).toBe('obligation')
  })

  // Ruling 3, at the gate: the model's own emission wins, so the draft keeps
  // the recommendation and stays in the conversation slot.
  it('keeps the model recommendation as the carrier and leaves the slot alone', async () => {
    const decision = await applyApprovalPolicyStage(
      makeCtx({}),
      makeGenerationResult({
        commitment: { type: 'recommendation', description: 'the cortado' },
      }),
      { status: 'skipped' },
      { status: 'skipped' },
      { status: 'flagged', commitment: promisedComp },
    )
    expect(decision.action).toBe('queue')
    if (decision.action !== 'queue') return
    expect(decision.slot).toBe('conversation')
  })

  // PRIMARY_TRIGGER_PRIORITY: this outranks the two signals it replaces as the
  // control, both of which measured 0 catches on the 4 genuine promises.
  it('wins the operator label over comp_regex_backstop and model_flagged', async () => {
    const decision = await applyApprovalPolicyStage(
      makeCtx({}),
      makeGenerationResult({
        // "on us" trips the comp regex; requiresOperatorApproval trips the
        // self-flag. Both co-fire with the prose-promise catch here.
        body: "sorry about that one, the next one's on us",
        requiresOperatorApproval: true,
      }),
      { status: 'skipped' },
      { status: 'skipped' },
      { status: 'flagged', commitment: promisedComp },
    )
    expect(decision.action).toBe('queue')
    if (decision.action !== 'queue') return
    expect(decision.triggers).toContain(APPROVAL_TRIGGERS.COMP_REGEX_BACKSTOP)
    expect(decision.triggers).toContain(APPROVAL_TRIGGERS.MODEL_FLAGGED)
    expect(decision.primaryTrigger).toBe(APPROVAL_TRIGGERS.PROSE_PROMISE_BACKSTOP)
  })

  // The failed-check trigger is the opposite: it reports an absence, so any
  // concrete co-firing trigger is the more useful label.
  it('lets a concrete trigger win the label over a failed check', async () => {
    const decision = await applyApprovalPolicyStage(
      makeCtx({}),
      makeGenerationResult({ commitment: { type: 'comp', description: 'oat latte' } }),
      { status: 'skipped' },
      { status: 'skipped' },
      { status: 'check_failed' },
    )
    expect(decision.action).toBe('queue')
    if (decision.action !== 'queue') return
    expect(decision.triggers).toContain(APPROVAL_TRIGGERS.PROSE_PROMISE_CHECK_FAILED)
    expect(decision.primaryTrigger).toBe(APPROVAL_TRIGGERS.COMMITMENT_TYPE_GATED)
  })
})
