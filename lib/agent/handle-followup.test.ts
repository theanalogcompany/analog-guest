import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// TAC-355: scoped narrowly to the wiring this ticket adds to
// handleFollowup — the mechanic-offer backstop is invoked on cron-triggered
// (non-manual) followups, skipped entirely on manual ones, and its result
// threads correctly into applyApprovalPolicyStage as the fourth argument
// (including the fail-closed check_failed case actually queuing). This is
// NOT a general coverage backfill for handle-followup.ts — every stage
// below the point relevant to that wiring is mocked to the simplest
// success shape that lets the function reach the assertion, not exercised
// for its own behavior (that's out of scope here; see the ticket).

const buildRuntimeContextMock = vi.fn()
const retrieveCorpusStageMock = vi.fn()
const retrieveKnowledgeStageMock = vi.fn()
const generateStageMock = vi.fn()
const applyApprovalPolicyStageMock = vi.fn()
const verifyMechanicOfferStageMock = vi.fn()
const persistOrRegenQueuedDraftMock = vi.fn()
const scheduleAndSendMock = vi.fn()

vi.mock('./build-runtime-context', () => ({
  buildRuntimeContext: (...a: unknown[]) => buildRuntimeContextMock(...a),
}))
// stages.ts imports from @/lib/rag at module scope; vi.importActual('./stages')
// below (needed only to forward the real APPROVAL_TRIGGERS) still runs that
// import, and the real lib/rag module transitively hits voyageai's ESM
// directory-import resolution failure (the same module-load gotcha CLAUDE.md
// documents for lib/tunables/manifest.test.ts) unless it's mocked away here
// too, even though neither retrieveContext nor retrieveKnowledgeContext is
// exercised directly in this file.
vi.mock('@/lib/rag', () => ({
  retrieveContext: vi.fn(),
  retrieveKnowledgeContext: vi.fn(),
}))
vi.mock('@/lib/ai', () => ({
  generateMessage: vi.fn(),
  verifyGrounding: vi.fn(),
  verifyMechanicOffer: vi.fn(),
}))
vi.mock('./stages', async () => {
  const actual = await vi.importActual<typeof import('./stages')>('./stages')
  return {
    APPROVAL_TRIGGERS: actual.APPROVAL_TRIGGERS,
    retrieveCorpusStage: (...a: unknown[]) => retrieveCorpusStageMock(...a),
    retrieveKnowledgeStage: (...a: unknown[]) => retrieveKnowledgeStageMock(...a),
    shouldRetrieveKnowledge: () => false,
    generateStage: (...a: unknown[]) => generateStageMock(...a),
    applyApprovalPolicyStage: (...a: unknown[]) => applyApprovalPolicyStageMock(...a),
    verifyMechanicOfferStage: (...a: unknown[]) => verifyMechanicOfferStageMock(...a),
  }
})
vi.mock('./schedule-and-send', () => ({
  persistOrRegenQueuedDraft: (...a: unknown[]) => persistOrRegenQueuedDraftMock(...a),
  scheduleAndSend: (...a: unknown[]) => scheduleAndSendMock(...a),
}))
vi.mock('./alerts', () => ({
  fireRedAlert: vi.fn(),
  capturePostHogEvent: vi.fn(),
}))
vi.mock('./dispatch-arrival-capture', () => ({
  dispatchArrivalCapture: vi.fn(async () => ({ kind: 'noop' })),
}))
vi.mock('@/lib/guests/context', () => ({
  isEmptyContextUpdate: () => true,
  updateGuestContext: vi.fn(),
}))
vi.mock('@/lib/notifications/send', () => ({
  sendDraftFlaggedPush: vi.fn(),
  shouldSendDraftFlaggedPush: () => false,
}))
vi.mock('@/lib/analytics/posthog', () => ({
  AGENT_LATENCY_HIGH_THRESHOLD_MS: 999_999_999,
  captureAgentLatencyHigh: vi.fn(),
  captureDraftDropped: vi.fn(),
  captureDraftQueued: vi.fn(),
  captureDraftRegenerated: vi.fn(),
}))
vi.mock('@vercel/functions', () => ({ waitUntil: (p: unknown) => p }))
vi.mock('@/lib/observability', () => ({
  startAgentTrace: () => ({
    id: '',
    captureContent: false,
    span: () => ({ span: () => ({ end: () => undefined }), end: () => undefined, update: () => undefined }),
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

import { handleFollowup } from './handle-followup'
import type { RuntimeContext } from './types'

const VENUE_ID = '11111111-1111-4111-8111-111111111111'
const GUEST_ID = '22222222-2222-4222-8222-222222222222'

function makeCtx(followupTrigger: RuntimeContext['followupTrigger']): RuntimeContext {
  return {
    agentRunId: 'run-1',
    venue: { id: VENUE_ID, holdAllOutbound: false } as RuntimeContext['venue'],
    guest: { id: GUEST_ID, firstName: 'Sam', isDemo: false } as RuntimeContext['guest'],
    currentMessage: null,
    // handleFollowup's own context_build step throws (inbound-XOR-outbound
    // invariant) unless followupTrigger is non-null here — buildRuntimeContext
    // is mocked, so this has to be set to whatever the test's own trigger is.
    followupTrigger,
    pendingQuestion: null,
    recentMessages: [],
    recognition: { state: 'regular', score: 0, computedAt: new Date() } as RuntimeContext['recognition'],
    mechanics: [],
    recentVisits: [],
    activeCommitments: [],
    openIntentions: [],
    corpus: null,
    knowledgeCorpus: null,
    classification: null,
    trace: { id: '' } as RuntimeContext['trace'],
  }
}

function successResult() {
  return {
    body: 'thinking of you — come by soon',
    voiceFidelity: 0.85,
    reasoning: 'r',
    requiresOperatorApproval: false,
    approvalReason: '',
    complaintIntent: 'none' as const,
    knowledgeGap: false,
    contextUpdate: {},
    commitment: {},
    arrivalCapture: {},
    attempts: 1,
    attemptScores: [0.85],
    attemptHistory: [],
    systemPrompt: '',
    userPrompt: '',
    promptVersion: 'v1.45.0',
    dashViolationPersisted: false,
    selfTalkViolationPersisted: false,
  }
}

beforeEach(() => {
  buildRuntimeContextMock.mockReset()
  retrieveCorpusStageMock.mockReset()
  retrieveKnowledgeStageMock.mockReset()
  generateStageMock.mockReset()
  applyApprovalPolicyStageMock.mockReset()
  verifyMechanicOfferStageMock.mockReset()
  persistOrRegenQueuedDraftMock.mockReset()
  scheduleAndSendMock.mockReset()

  buildRuntimeContextMock.mockImplementation(
    async (args: { followupTrigger: RuntimeContext['followupTrigger'] }) =>
      makeCtx(args.followupTrigger),
  )
  retrieveCorpusStageMock.mockResolvedValue([])
  generateStageMock.mockResolvedValue({ status: 'success', result: successResult() })
  scheduleAndSendMock.mockResolvedValue({
    outboundMessageId: 'sent-1',
    providerMessageId: 'p1',
    generationId: 'gen-1',
    bubbleCount: 1,
  })
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('handleFollowup — mechanic-offer backstop wiring (TAC-355)', () => {
  // TAC-307 REVERSED THIS TEST. It previously asserted that a manual followup
  // skipped both the backstop and the whole approval gate, on the reasoning
  // that clicking Follow Up was itself the operator's approval. That conflates
  // authorising the ACT of reaching out with authorising the TEXT, which is
  // model-generated and unreviewed — so a venue holding everything could still
  // be auto-sent past by a button click. The gate now runs on every followup
  // path; the assertions below are the inverse of what they used to be.
  it('runs the gate and the mechanic-offer backstop for a manual followup (Follow Up button)', async () => {
    applyApprovalPolicyStageMock.mockClear()
    // Both mocks need real returns now. Before TAC-307 the manual path
    // short-circuited past both, so their undefined defaults were never
    // dereferenced — the test passed for a reason that has stopped being true.
    verifyMechanicOfferStageMock.mockResolvedValue({ status: 'skipped' })
    applyApprovalPolicyStageMock.mockResolvedValue({ action: 'send' })

    await handleFollowup({
      venueId: VENUE_ID,
      guestId: GUEST_ID,
      trigger: { reason: 'manual', triggeredAt: new Date(), metadata: { hint: 'checking in' } },
    })

    expect(verifyMechanicOfferStageMock).toHaveBeenCalled()
    expect(applyApprovalPolicyStageMock).toHaveBeenCalled()
    // Still sends here because this fixture's gate returns action:'send'. The
    // point is that the decision was ASKED FOR, not that it came back 'send'.
    expect(scheduleAndSendMock).toHaveBeenCalledTimes(1)
  })

  it('invokes verifyMechanicOfferStage for a cron-triggered (day_7) followup and threads a "flagged" result into applyApprovalPolicyStage as the fourth argument', async () => {
    verifyMechanicOfferStageMock.mockResolvedValueOnce({ status: 'flagged', mechanicId: 'mech-1' })
    applyApprovalPolicyStageMock.mockResolvedValue({
      action: 'queue',
      triggers: ['mechanic_offer_backstop'],
      primaryTrigger: 'mechanic_offer_backstop',
      compMatchedPattern: null,
      existingPendingDraftId: null,
      blankBody: false,
    })
    persistOrRegenQueuedDraftMock.mockResolvedValue({
      outboundMessageId: 'queued-1',
      action: 'inserted',
      priorReviewReason: null,
    })

    const result = await handleFollowup({
      venueId: VENUE_ID,
      guestId: GUEST_ID,
      trigger: { reason: 'day_7', triggeredAt: new Date() },
    })

    expect(verifyMechanicOfferStageMock).toHaveBeenCalledTimes(1)
    expect(applyApprovalPolicyStageMock).toHaveBeenCalledTimes(1)
    const [, , groundingArg, mechanicOfferArg] = applyApprovalPolicyStageMock.mock.calls[0]
    // followup never has a grounding backstop (inbound-only) — always null here.
    expect(groundingArg).toBeNull()
    expect(mechanicOfferArg).toEqual({ status: 'flagged', mechanicId: 'mech-1' })
    expect(result.status).toBe('queued')
    expect(scheduleAndSendMock).not.toHaveBeenCalled()
  })

  it('FAILS CLOSED — a "check_failed" result still queues rather than sending', async () => {
    verifyMechanicOfferStageMock.mockResolvedValueOnce({ status: 'check_failed' })
    applyApprovalPolicyStageMock.mockResolvedValue({
      action: 'queue',
      triggers: ['mechanic_offer_backstop'],
      primaryTrigger: 'mechanic_offer_backstop',
      compMatchedPattern: null,
      existingPendingDraftId: null,
      blankBody: false,
    })
    persistOrRegenQueuedDraftMock.mockResolvedValue({
      outboundMessageId: 'queued-2',
      action: 'inserted',
      priorReviewReason: null,
    })

    const result = await handleFollowup({
      venueId: VENUE_ID,
      guestId: GUEST_ID,
      trigger: { reason: 'event', triggeredAt: new Date() },
    })

    expect(verifyMechanicOfferStageMock).toHaveBeenCalledTimes(1)
    const [, , , mechanicOfferArg] = applyApprovalPolicyStageMock.mock.calls[0]
    expect(mechanicOfferArg).toEqual({ status: 'check_failed' })
    expect(result.status).toBe('queued')
    expect(persistOrRegenQueuedDraftMock).toHaveBeenCalledTimes(1)
    expect(scheduleAndSendMock).not.toHaveBeenCalled()
  })

  it('sends normally when verifyMechanicOfferStage returns "skipped" (its own skip conditions held) and nothing else queues', async () => {
    verifyMechanicOfferStageMock.mockResolvedValueOnce({ status: 'skipped' })
    applyApprovalPolicyStageMock.mockResolvedValue({ action: 'send' })

    const result = await handleFollowup({
      venueId: VENUE_ID,
      guestId: GUEST_ID,
      trigger: { reason: 'day_1', triggeredAt: new Date() },
    })

    expect(verifyMechanicOfferStageMock).toHaveBeenCalledTimes(1)
    const [, , , mechanicOfferArg] = applyApprovalPolicyStageMock.mock.calls[0]
    expect(mechanicOfferArg).toEqual({ status: 'skipped' })
    expect(result.status).toBe('sent')
    expect(scheduleAndSendMock).toHaveBeenCalledTimes(1)
  })
})
