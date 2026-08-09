// TAC-309. Tests for the generation-failure fallback in the inbound
// orchestrator.
//
// Scope is deliberately the NEW policy surface, not all of handleInbound:
// retry-once, the failure card, and the four rules that decide whether the
// card is written at all. Before TAC-309 a double generation failure returned
// silence — no outbound row, no card, nobody at the venue aware the guest had
// asked. That is the regression this file exists to hold.
//
// Modelled on handle-operator-decline.test.ts (the sibling orchestrator test).

import { beforeEach, describe, expect, it, vi } from 'vitest'

// ./stages pulls in @/lib/rag → voyageai, whose ESM build trips vitest's
// directory-import resolver at module load. See CLAUDE.md "Module split for
// testability".
vi.mock('voyageai', () => ({ VoyageAIClient: class {} }))
vi.mock('@/lib/rag', () => ({
  retrieveContext: vi.fn(),
  retrieveKnowledgeContext: vi.fn(),
}))

const buildRuntimeContextMock = vi.fn()
const classifyStageMock = vi.fn()
const retrieveCorpusStageMock = vi.fn()
const retrieveKnowledgeStageMock = vi.fn()
const generateStageMock = vi.fn()
const applyApprovalPolicyStageMock = vi.fn()
const findPendingDraftMock = vi.fn()
const persistOrRegenQueuedDraftMock = vi.fn()
const scheduleAndSendMock = vi.fn()
const fireRedAlertMock = vi.fn()
const captureDraftQueuedMock = vi.fn()
const sendDraftFlaggedPushMock = vi.fn()
const guestMaybeSingleMock = vi.fn()
const inboundSingleMock = vi.fn()
const existingReplyMaybeSingleMock = vi.fn()

// The orchestrator makes three distinct DB reads directly: the inbound row
// (.single()), the duplicate-reply check (.limit().maybeSingle()), and
// TAC-309's opt-out probe (.eq().maybeSingle()). Dispatch on shape.
vi.mock('@/lib/db/admin', () => ({
  createAdminClient: () => ({
    from: (table: string) => ({
      select: () => ({
        eq: () => ({
          single: () => inboundSingleMock(),
          maybeSingle: () =>
            table === 'guests' ? guestMaybeSingleMock() : existingReplyMaybeSingleMock(),
          eq: () => ({
            limit: () => ({ maybeSingle: () => existingReplyMaybeSingleMock() }),
          }),
          limit: () => ({ maybeSingle: () => existingReplyMaybeSingleMock() }),
        }),
      }),
    }),
  }),
}))
vi.mock('./build-runtime-context', () => ({
  buildRuntimeContext: (...a: unknown[]) => buildRuntimeContextMock(...a),
}))
vi.mock('./stages', async () => {
  const actual = await vi.importActual<typeof import('./stages')>('./stages')
  return {
    APPROVAL_TRIGGERS: actual.APPROVAL_TRIGGERS,
    KNOWLEDGE_GAP_WINDOW_MS: actual.KNOWLEDGE_GAP_WINDOW_MS,
    isKnowledgeGapCard: actual.isKnowledgeGapCard,
    classifyStage: (...a: unknown[]) => classifyStageMock(...a),
    retrieveCorpusStage: (...a: unknown[]) => retrieveCorpusStageMock(...a),
    retrieveKnowledgeStage: (...a: unknown[]) => retrieveKnowledgeStageMock(...a),
    shouldRetrieveKnowledge: () => false,
    generateStage: (...a: unknown[]) => generateStageMock(...a),
    applyApprovalPolicyStage: (...a: unknown[]) => applyApprovalPolicyStageMock(...a),
    findPendingDraft: (...a: unknown[]) => findPendingDraftMock(...a),
  }
})
vi.mock('./schedule-and-send', () => ({
  persistOrRegenQueuedDraft: (...a: unknown[]) => persistOrRegenQueuedDraftMock(...a),
  scheduleAndSend: (...a: unknown[]) => scheduleAndSendMock(...a),
}))
vi.mock('./alerts', () => ({
  fireRedAlert: (...a: unknown[]) => fireRedAlertMock(...a),
  capturePostHogEvent: vi.fn(),
}))
vi.mock('./dispatch-arrival-capture', () => ({
  dispatchArrivalCapture: vi.fn(async () => ({ kind: 'noop' })),
}))
vi.mock('@/lib/guests/context', () => ({
  isEmptyContextUpdate: () => true,
  updateGuestContext: vi.fn(),
}))
vi.mock('@/lib/analytics/posthog', () => ({
  AGENT_LATENCY_HIGH_THRESHOLD_MS: 10_000,
  captureAgentLatencyHigh: vi.fn(),
  captureDraftQueued: (...a: unknown[]) => captureDraftQueuedMock(...a),
  captureDraftRegenerated: vi.fn(),
  captureDraftDropped: vi.fn(),
  // Also consumed by the real ./stages, loaded via importActual below.
  captureClassificationLowConfidence: vi.fn(),
  captureCorpusRetrievalBelowThreshold: vi.fn(),
  captureDashViolationPersisted: vi.fn(),
  captureDemoBypassedApprovalGate: vi.fn(),
  captureRegenerationTriggered: vi.fn(),
  captureVoiceFidelityLow: vi.fn(),
  captureGenerationTruncated: vi.fn(),
  CLASSIFICATION_CONFIDENCE_LOW_THRESHOLD: 0.7,
  CLASSIFICATION_CONFIDENCE_REROUTE_THRESHOLD: 0.3,
  CORPUS_TOP_SIMILARITY_LOW_THRESHOLD: 0.5,
  VOICE_FIDELITY_LOW_THRESHOLD: 0.5,
}))
vi.mock('@/lib/notifications/send', () => ({
  sendDraftFlaggedPush: (...a: unknown[]) => sendDraftFlaggedPushMock(...a),
  shouldSendDraftFlaggedPush: () => true,
}))
vi.mock('@/lib/notifications/send-commitment-push', () => ({
  sendCommitmentArrivalPush: vi.fn(),
}))
vi.mock('@vercel/functions', () => ({ waitUntil: (p: unknown) => p }))
vi.mock('@/lib/observability', () => ({
  startAgentTrace: () => ({
    id: '',
    captureContent: false,
    span: () => ({
      span: () => ({ end: () => undefined }),
      end: () => undefined,
      update: () => undefined,
    }),
    update: () => undefined,
    flushAsync: async () => undefined,
  }),
}))
vi.mock('./trace-content', () => ({
  buildCorpusContent: () => ({}),
  buildGenerateAttemptContent: () => ({}),
  buildGenerateContent: () => ({}),
  buildKnowledgeCorpusContent: () => ({}),
  buildRecognitionContent: () => ({}),
}))

import { handleInbound } from './handle-inbound'
import { APPROVAL_TRIGGERS } from './stages'

const VENUE_ID = '00000000-0000-0000-0000-00000000000a'
const GUEST_ID = '11111111-1111-4111-8111-111111111111'
const INBOUND_ID = '22222222-2222-4222-8222-222222222222'

function makeCtx(overrides: Record<string, unknown> = {}) {
  return {
    agentRunId: 'run-1',
    venue: {
      id: VENUE_ID,
      slug: 'v',
      brandPersona: {},
      venueInfo: {},
      timezone: 'UTC',
      sendblueNumber: '+1',
      holdAllOutbound: false,
      approvalPolicy: { default: 'auto_send', perCategory: {} },
    },
    guest: {
      id: GUEST_ID,
      phoneNumber: '+15555550123',
      firstName: 'Sam',
      createdAt: new Date(),
      createdVia: 'inbound_message',
      isDemo: false,
      context: {},
      lastVisitAt: null,
    },
    currentMessage: {
      id: INBOUND_ID,
      providerMessageId: 'p1',
      body: 'is rayan working tomorrow',
      receivedAt: new Date(),
    },
    followupTrigger: null,
    pendingQuestion: null,
    recentMessages: [],
    recognition: { score: 0.5, state: 'regular', signals: {}, computedAt: new Date() },
    mechanics: [],
    recentVisits: [],
    activeCommitments: [],
    corpus: null,
    knowledgeCorpus: null,
    classification: null,
    trace: { id: '', captureContent: false },
    ...overrides,
  }
}

const GEN_FAILED = { status: 'failed' as const, error: 'No object generated' }

beforeEach(() => {
  vi.clearAllMocks()
  inboundSingleMock.mockResolvedValue({
    data: {
      id: INBOUND_ID,
      body: 'is rayan working tomorrow',
      provider_message_id: 'p1',
      created_at: new Date().toISOString(),
      venue_id: VENUE_ID,
      guest_id: GUEST_ID,
      direction: 'inbound',
    },
    error: null,
  })
  existingReplyMaybeSingleMock.mockResolvedValue({ data: null, error: null })
  guestMaybeSingleMock.mockResolvedValue({ data: { opted_out_at: null }, error: null })
  buildRuntimeContextMock.mockResolvedValue(makeCtx())
  classifyStageMock.mockResolvedValue({
    category: 'new_question',
    classifierConfidence: 0.9,
    reasoning: 'q',
  })
  retrieveCorpusStageMock.mockResolvedValue([])
  retrieveKnowledgeStageMock.mockResolvedValue([])
  findPendingDraftMock.mockResolvedValue(null)
  persistOrRegenQueuedDraftMock.mockResolvedValue({
    outboundMessageId: 'card-1',
    action: 'inserted',
    priorReviewReason: null,
  })
  sendDraftFlaggedPushMock.mockResolvedValue(undefined)
})

describe('handleInbound — generation-failure fallback (TAC-309)', () => {
  // The regression. Before TAC-309 this returned {status:'failed'} and the
  // guest sat in silence with nobody aware they'd asked.
  it('writes a queue card instead of returning silence', async () => {
    generateStageMock.mockResolvedValue(GEN_FAILED)
    const r = await handleInbound(INBOUND_ID)
    expect(r).toMatchObject({
      status: 'queued',
      outboundMessageId: 'card-1',
      primaryTrigger: APPROVAL_TRIGGERS.KNOWLEDGE_GAP,
    })
    expect(persistOrRegenQueuedDraftMock).toHaveBeenCalledTimes(1)
  })

  it('retries generation exactly once before carding', async () => {
    generateStageMock.mockResolvedValue(GEN_FAILED)
    await handleInbound(INBOUND_ID)
    expect(generateStageMock).toHaveBeenCalledTimes(2)
  })

  it('does not card when the retry succeeds', async () => {
    generateStageMock
      .mockResolvedValueOnce(GEN_FAILED)
      .mockResolvedValueOnce({ status: 'success', result: successResult() })
    applyApprovalPolicyStageMock.mockResolvedValue({ action: 'send' })
    scheduleAndSendMock.mockResolvedValue({
      outboundMessageId: 'sent-1',
      providerMessageId: 'p',
    })
    const r = await handleInbound(INBOUND_ID)
    expect(r).toMatchObject({ status: 'sent' })
    expect(persistOrRegenQueuedDraftMock).not.toHaveBeenCalled()
  })

  // Retrying a truncation runs into the same ceiling, doubles the wait for a
  // guest already getting nothing, and double-posts the alert.
  it('skips the retry when the failure was truncation', async () => {
    generateStageMock.mockResolvedValue({
      status: 'failed',
      error: 'could not parse the response',
      errorCode: 'ai_generation_truncated',
    })
    await handleInbound(INBOUND_ID)
    expect(generateStageMock).toHaveBeenCalledTimes(1)
    expect(persistOrRegenQueuedDraftMock).toHaveBeenCalledTimes(1)
  })

  it('persists the card blank, with a clock, under review_reason=knowledge_gap', async () => {
    generateStageMock.mockResolvedValue(GEN_FAILED)
    await handleInbound(INBOUND_ID)
    const [, , trigger, existingId, opts] = persistOrRegenQueuedDraftMock.mock.calls[0]
    expect(trigger).toBe(APPROVAL_TRIGGERS.KNOWLEDGE_GAP)
    expect(existingId).toBeNull()
    expect(opts).toMatchObject({ blankBody: true })
    expect(opts.pendingUntil).toBeInstanceOf(Date)
  })

  it('pushes so an operator learns the guest is waiting', async () => {
    generateStageMock.mockResolvedValue(GEN_FAILED)
    await handleInbound(INBOUND_ID)
    expect(sendDraftFlaggedPushMock).toHaveBeenCalledWith(
      expect.objectContaining({ draftId: 'card-1' }),
    )
  })

  it('still fires the red alert so crashes stay distinguishable from real gaps', async () => {
    generateStageMock.mockResolvedValue(GEN_FAILED)
    await handleInbound(INBOUND_ID)
    expect(fireRedAlertMock).toHaveBeenCalledWith(
      expect.objectContaining({ stage: 'generation' }),
    )
  })
})

describe('handleInbound — failure-card policy (TAC-309)', () => {
  beforeEach(() => {
    generateStageMock.mockResolvedValue(GEN_FAILED)
  })

  it('writes NO card when the guest has opted out', async () => {
    guestMaybeSingleMock.mockResolvedValue({
      data: { opted_out_at: '2026-08-08T00:00:00Z' },
      error: null,
    })
    const r = await handleInbound(INBOUND_ID)
    expect(persistOrRegenQueuedDraftMock).not.toHaveBeenCalled()
    expect(r).toMatchObject({ status: 'failed', stage: 'generation' })
  })

  // Deliberate inversion of the usual rule: a queue card IS the hold
  // outcome. Suppressing it would restore the exact silence this fixes, at
  // the venues that asked for the most oversight.
  it('DOES write a card at a hold_all_outbound venue', async () => {
    buildRuntimeContextMock.mockResolvedValue(
      makeCtx({
        venue: { ...makeCtx().venue, holdAllOutbound: true },
      }),
    )
    const r = await handleInbound(INBOUND_ID)
    expect(persistOrRegenQueuedDraftMock).toHaveBeenCalledTimes(1)
    expect(r).toMatchObject({ status: 'queued' })
  })

  // A crash on a LATER, unrelated turn must not erase a draft the operator
  // is about to act on. Writing here would blank the body, null the fidelity
  // and the commitment carrier, and relabel review_reason.
  it('refuses to overwrite a NON-gap pending draft', async () => {
    findPendingDraftMock.mockResolvedValue({
      id: 'comp-draft',
      body: "the next one's on us",
      pending_until: null,
      review_reason: APPROVAL_TRIGGERS.COMP_REGEX_BACKSTOP,
    })
    const r = await handleInbound(INBOUND_ID)
    expect(persistOrRegenQueuedDraftMock).not.toHaveBeenCalled()
    expect(r).toMatchObject({ status: 'failed' })
  })

  // An existing gap card IS updatable — but its deadline must survive, or a
  // crash could push out a clock that's already running.
  it('updates an existing gap card in place without re-arming its clock', async () => {
    findPendingDraftMock.mockResolvedValue({
      id: 'gap-card',
      body: '',
      pending_until: new Date(Date.now() + 60_000).toISOString(),
      review_reason: APPROVAL_TRIGGERS.KNOWLEDGE_GAP,
    })
    await handleInbound(INBOUND_ID)
    const [, , , existingId, opts] = persistOrRegenQueuedDraftMock.mock.calls[0]
    expect(existingId).toBe('gap-card')
    expect(opts.pendingUntil).toBeUndefined()
  })

  // A failure to record a failure must not deepen it.
  it('never throws when the persist layer throws', async () => {
    persistOrRegenQueuedDraftMock.mockRejectedValue(new Error('db down'))
    const r = await handleInbound(INBOUND_ID)
    expect(r).toMatchObject({ status: 'failed', stage: 'generation' })
  })
})

function successResult() {
  return {
    body: 'sure thing',
    voiceFidelity: 0.9,
    reasoning: 'r',
    requiresOperatorApproval: false,
    approvalReason: '',
    complaintIntent: 'none',
    knowledgeGap: false,
    contextUpdate: {},
    commitment: {},
    arrivalCapture: {},
    attempts: 1,
    attemptScores: [0.9],
    attemptHistory: [],
    systemPrompt: '',
    userPrompt: '',
    promptVersion: 'v1.28.0',
    dashViolationPersisted: false,
  }
}
