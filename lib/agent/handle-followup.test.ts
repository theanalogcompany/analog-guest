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
// Resolves NON-EMPTY deliberately: with [] it would return exactly the value
// an "expect empty" assertion checks, and could not tell "skipped retrieval"
// from "retrieved nothing". Never called by the fixed implementation.
const retrieveKnowledgeStageMock = vi.fn<(...a: unknown[]) => Promise<unknown[]>>(async () => [
  {
    id: 'k1',
    knowledgeCorpusId: 'kc1',
    text: 'The Masala Mixer is a Desi community social event planned for the loft.',
    sourceType: 'synthesized',
    confidence: 0.9,
    similarity: 0.34,
    primaryTags: ['events'],
    secondaryTags: [],
  },
])
const generateStageMock = vi.fn()
const applyApprovalPolicyStageMock = vi.fn()
const verifyGroundingStageMock = vi.fn()
const verifyProsePromiseStageMock = vi.fn()
const verifyClosedVenueArrivalStageMock = vi.fn()
// TAC-513: default CLEAN, not undefined. The './stages' factory below is an
// explicit allow-list, so a stage missing from it arrives `undefined` and
// throws inside the allSettled argument list before the gate is reached.
const verifyCancellationClaimStageMock = vi.fn().mockResolvedValue({ resolution: { status: 'none' }, claim: 'clean' })
const verifyMechanicOfferStageMock = vi.fn()
const persistOrRegenQueuedDraftMock = vi.fn()
const captureDraftDroppedMock = vi.fn()
const captureManualFollowupSlotOccupiedMock = vi.fn()
const scheduleAndSendMock = vi.fn()
const dispatchReplyMock = vi.fn()

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
    // TAC-367: pure helper, passed through REAL rather than stubbed. It
    // decides whether this path retrieves at all, so a mocked version would
    // be testing the mock's opinion of the operator's note rather than the
    // shared extractor buildAiRuntime uses. Same posture as APPROVAL_TRIGGERS.
    operatorInstructionQuery: actual.operatorInstructionQuery,
    retrieveCorpusStage: (...a: unknown[]) => retrieveCorpusStageMock(...a),
    retrieveKnowledgeStage: (...a: unknown[]) => retrieveKnowledgeStageMock(...a),
    // TAC-367: TRUE, matching production for the `event` and `manual` triggers
    // these tests actually exercise. It was `() => false` — the opposite — so
    // retrieveKnowledgeStage was unreachable in every test here and the live
    // synthetic-query retrieval was invisible to the suite. Second instance of
    // that exact defect found in one sitting (handle-holding-message.test.ts
    // was the first); see CLAUDE.md's rule on mocked behaviour flags.
    shouldRetrieveKnowledge: () => true,
    generateStage: (...a: unknown[]) => generateStageMock(...a),
    applyApprovalPolicyStage: (...a: unknown[]) => applyApprovalPolicyStageMock(...a),
    verifyGroundingStage: (...a: unknown[]) => verifyGroundingStageMock(...a),
    // TAC-401: this factory is an explicit ALLOW-LIST. A stage missing here
    // arrives `undefined` at the call site, which in an allSettled array is a
    // TypeError swallowed into a rejected settlement — the check would read as
    // permanently degraded and every test here would stay green.
    verifyProsePromiseStage: (...a: unknown[]) => verifyProsePromiseStageMock(...a),
    verifyClosedVenueArrivalStage: (...a: unknown[]) =>
      verifyClosedVenueArrivalStageMock(...a),
    verifyCancellationClaimStage: (...a: unknown[]) => verifyCancellationClaimStageMock(...a),
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
// TAC-536: the scan greeting is the one reason that reaches the Instagram
// transport, and only dispatchReply gets there.
vi.mock('./dispatch-reply', () => ({
  dispatchReply: (...a: unknown[]) => dispatchReplyMock(...a),
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
  captureDraftDropped: (...a: unknown[]) => captureDraftDroppedMock(...a),
  captureDraftQueued: vi.fn(),
  captureDraftRegenerated: vi.fn(),
  captureManualFollowupSlotOccupied: (...a: unknown[]) =>
    captureManualFollowupSlotOccupiedMock(...a),
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
import type { ActiveCommitment } from '@/lib/schemas/guest-commitment'
import type { FollowupTrigger, RuntimeContext } from './types'

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
    scanArrival: null,
    conversationChannel: 'text',
    pendingQuestion: null,
    recentMessages: [],
    recognition: { state: 'regular', score: 0, computedAt: new Date() } as RuntimeContext['recognition'],
    mechanics: [],
    recentVisits: [],
    activeCommitments: [],
    openIntentions: [],
    intentionDerivation: { newlyEligible: [], brakeEngaged: false },
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
    // TAC-513: REQUIRED on GenerateMessageResult. A fixture omitting it reads
    // `undefined` everywhere, which resolves as "cancels nothing" and hides
    // the carrier path from every test in this file.
    cancelsCommitmentId: '',
    attempts: 1,
    attemptScores: [0.85],
    attemptHistory: [],
    systemPrompt: '',
    userPrompt: '',
    promptVersion: 'v1.67.0',
    dashViolationPersisted: false,
    selfTalkViolationPersisted: false,
    emojiDirectiveViolated: false,
  }
}

beforeEach(() => {
  buildRuntimeContextMock.mockReset()
  retrieveCorpusStageMock.mockReset()
  retrieveKnowledgeStageMock.mockReset()
  generateStageMock.mockReset()
  applyApprovalPolicyStageMock.mockReset()
  verifyGroundingStageMock.mockReset()
  verifyProsePromiseStageMock.mockReset()
  verifyClosedVenueArrivalStageMock.mockReset()
  verifyCancellationClaimStageMock.mockReset()
  verifyMechanicOfferStageMock.mockReset()
  persistOrRegenQueuedDraftMock.mockReset()
  scheduleAndSendMock.mockReset()
  dispatchReplyMock.mockReset()
  dispatchReplyMock.mockResolvedValue({
    kind: 'sent',
    outboundMessageId: 'out-ig',
    providerMessageId: 'mid-ig',
    generationId: 'gen-ig',
    bubbleCount: 1,
    deliveredBody: 'hey',
    undelivered: null,
  })
  captureDraftDroppedMock.mockReset()
  captureManualFollowupSlotOccupiedMock.mockReset()

  buildRuntimeContextMock.mockImplementation(
    async (args: { followupTrigger: RuntimeContext['followupTrigger'] }) =>
      makeCtx(args.followupTrigger),
  )
  retrieveCorpusStageMock.mockResolvedValue([])
  generateStageMock.mockResolvedValue({ status: 'success', result: successResult() })
  // TAC-376: default to 'skipped', matching production's most common case
  // (a followup with no gap-shaped finding). Tests that need a real verdict
  // override with mockResolvedValueOnce.
  verifyGroundingStageMock.mockResolvedValue({ status: 'skipped' })
  // TAC-401: 'skipped' by default, so every pre-existing test in this file
  // behaves exactly as it did before the check existed.
  verifyProsePromiseStageMock.mockResolvedValue({ status: 'skipped' })
  // TAC-363: 'skipped' is what the real stage returns at an open venue.
  verifyClosedVenueArrivalStageMock.mockResolvedValue({ status: 'skipped' })
  verifyCancellationClaimStageMock.mockResolvedValue({ resolution: { status: 'none' }, claim: 'clean' })
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
      // TAC-364: the gate ALWAYS returns this on a queue decision (it is
      // required on ApprovalDecision), so a fixture omitting it would feed
      // `undefined` down a path production never produces. null is what a
      // followup / skipped-check turn actually carries — see ruling 3.
      ungroundedClaims: null,
      existingPendingDraftId: null,
      blankBody: false,
      slot: 'conversation',
      otherSlotOccupied: false,
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
    // TAC-376: followups now run verifyGroundingStage — the default fixture
    // resolves 'skipped' (this test's own finding is on the mechanic-offer
    // side), so the gate receives the real skipped result, not null.
    expect(groundingArg).toEqual({ status: 'skipped' })
    expect(mechanicOfferArg).toEqual({ status: 'flagged', mechanicId: 'mech-1' })

    // TAC-364: the followup path threads the gate's trigger set and claims to
    // the persist layer exactly as inbound does.
    const [, , , , persistOpts] = persistOrRegenQueuedDraftMock.mock.calls[0]
    expect(persistOpts.reviewTriggers).toEqual(['mechanic_offer_backstop'])
    expect(persistOpts.ungroundedClaims).toBeNull()
    expect(result.status).toBe('queued')
    expect(scheduleAndSendMock).not.toHaveBeenCalled()
  })

  // TAC-376: the actual new wiring this ticket adds. A followup whose
  // grounding backstop flags something must thread that finding into the
  // gate exactly as an inbound catch would, and the flagged claims must
  // reach the persist layer's ungroundedClaims — not silently stay null the
  // way every followup row was forced to before this ticket.
  it('threads a "flagged" grounding result into applyApprovalPolicyStage and the persisted ungroundedClaims', async () => {
    verifyGroundingStageMock.mockResolvedValueOnce({
      status: 'flagged',
      claims: ['thanks the guest for a referral with no referral on record'],
    })
    verifyMechanicOfferStageMock.mockResolvedValueOnce({ status: 'skipped' })
    applyApprovalPolicyStageMock.mockResolvedValue({
      action: 'queue',
      triggers: ['knowledge_gap_backstop'],
      primaryTrigger: 'knowledge_gap_backstop',
      compMatchedPattern: null,
      ungroundedClaims: ['thanks the guest for a referral with no referral on record'],
      existingPendingDraftId: null,
      blankBody: false,
      slot: 'conversation',
      otherSlotOccupied: false,
    })
    persistOrRegenQueuedDraftMock.mockResolvedValue({
      outboundMessageId: 'queued-flagged-1',
      action: 'inserted',
      priorReviewReason: null,
    })

    const result = await handleFollowup({
      venueId: VENUE_ID,
      guestId: GUEST_ID,
      trigger: { reason: 'perk_unlock', triggeredAt: new Date() },
    })

    expect(verifyGroundingStageMock).toHaveBeenCalledTimes(1)
    const [, , groundingArg] = applyApprovalPolicyStageMock.mock.calls[0]
    expect(groundingArg).toEqual({
      status: 'flagged',
      claims: ['thanks the guest for a referral with no referral on record'],
    })
    const [, , , , persistOpts] = persistOrRegenQueuedDraftMock.mock.calls[0]
    expect(persistOpts.reviewTriggers).toEqual(['knowledge_gap_backstop'])
    expect(persistOpts.ungroundedClaims).toEqual([
      'thanks the guest for a referral with no referral on record',
    ])
    expect(result.status).toBe('queued')
    expect(scheduleAndSendMock).not.toHaveBeenCalled()
  })

  // TAC-424 RENAMES this test to what it actually asserts. It was called "a
  // degraded grounding call does not queue on its own (fail-open reaches
  // send)" while mocking `{ status: 'clean' }` — so it described a posture
  // through a fixture that could never exercise it, and after TAC-424 made a
  // degraded call queue, it would have gone on passing while certifying the
  // opposite of the shipped behaviour. That is this repo's catalogued pair (a
  // test name is not evidence of what the test checks; a mocked flag that
  // contradicts production certifies the bug), and the real degraded case is
  // the test directly below.
  it('a clean grounding call reaches send', async () => {
    verifyGroundingStageMock.mockResolvedValueOnce({ status: 'clean' })
    verifyMechanicOfferStageMock.mockResolvedValueOnce({ status: 'skipped' })
    applyApprovalPolicyStageMock.mockResolvedValue({ action: 'send' })

    const result = await handleFollowup({
      venueId: VENUE_ID,
      guestId: GUEST_ID,
      trigger: { reason: 'day_1', triggeredAt: new Date() },
    })

    const [, , groundingArg] = applyApprovalPolicyStageMock.mock.calls[0]
    expect(groundingArg).toEqual({ status: 'clean' })
    expect(result.status).toBe('sent')
    expect(scheduleAndSendMock).toHaveBeenCalledTimes(1)
  })

  // TAC-424: the posture both directions, at the orchestrator boundary. A
  // degraded result must reach the gate as `degraded` — not be flattened to
  // `clean` on the way — and must queue.
  it('a degraded grounding call queues (fail-closed since TAC-424)', async () => {
    verifyGroundingStageMock.mockResolvedValueOnce({ status: 'degraded' })
    verifyMechanicOfferStageMock.mockResolvedValueOnce({ status: 'skipped' })
    applyApprovalPolicyStageMock.mockResolvedValue({
      action: 'queue',
      triggers: ['grounding_check_failed', 'grounding_check_degraded'],
      primaryTrigger: 'grounding_check_failed',
      compMatchedPattern: null,
      ungroundedClaims: null,
      existingPendingDraftId: null,
      blankBody: false,
      slot: 'conversation',
      otherSlotOccupied: false,
    })
    persistOrRegenQueuedDraftMock.mockResolvedValue({
      outboundMessageId: 'queued-degraded-1',
      action: 'inserted',
      priorReviewReason: null,
    })

    const result = await handleFollowup({
      venueId: VENUE_ID,
      guestId: GUEST_ID,
      trigger: { reason: 'day_1', triggeredAt: new Date() },
    })

    // The verdict reaches the gate as `degraded`, not flattened to `clean` on
    // the way. That flattening IS the defect this ticket closed, so asserting
    // the queue alone would not distinguish the fix from a gate mock that
    // queues whatever it is handed.
    const [, , groundingArg] = applyApprovalPolicyStageMock.mock.calls[0]
    expect(groundingArg).toEqual({ status: 'degraded' })
    expect(result.status).toBe('queued')
    expect(scheduleAndSendMock).not.toHaveBeenCalled()
  })

  it('a truncated grounding call queues (fail-closed)', async () => {
    verifyGroundingStageMock.mockResolvedValueOnce({ status: 'truncated' })
    verifyMechanicOfferStageMock.mockResolvedValueOnce({ status: 'skipped' })
    applyApprovalPolicyStageMock.mockResolvedValue({
      action: 'queue',
      triggers: ['grounding_check_failed'],
      primaryTrigger: 'grounding_check_failed',
      compMatchedPattern: null,
      ungroundedClaims: null,
      existingPendingDraftId: null,
      blankBody: false,
      slot: 'conversation',
      otherSlotOccupied: false,
    })
    persistOrRegenQueuedDraftMock.mockResolvedValue({
      outboundMessageId: 'queued-truncated-1',
      action: 'inserted',
      priorReviewReason: null,
    })

    const result = await handleFollowup({
      venueId: VENUE_ID,
      guestId: GUEST_ID,
      trigger: { reason: 'cold_lapsed', triggeredAt: new Date() },
    })

    const [, , groundingArg] = applyApprovalPolicyStageMock.mock.calls[0]
    expect(groundingArg).toEqual({ status: 'truncated' })
    expect(result.status).toBe('queued')
    expect(scheduleAndSendMock).not.toHaveBeenCalled()
  })

  // A hypothetical future throw inside verifyGroundingStage must not silently
  // discard verifyMechanicOfferStage's finding — the whole reason this file
  // uses Promise.allSettled rather than Promise.all, mirroring handle-inbound.
  it('degrades to skipped, not a rejection, when verifyGroundingStage throws (allSettled)', async () => {
    verifyGroundingStageMock.mockRejectedValueOnce(new Error('boom'))
    verifyMechanicOfferStageMock.mockResolvedValueOnce({ status: 'flagged', mechanicId: 'mech-2' })
    applyApprovalPolicyStageMock.mockResolvedValue({
      action: 'queue',
      triggers: ['mechanic_offer_backstop'],
      primaryTrigger: 'mechanic_offer_backstop',
      compMatchedPattern: null,
      ungroundedClaims: null,
      existingPendingDraftId: null,
      blankBody: false,
      slot: 'conversation',
      otherSlotOccupied: false,
    })
    persistOrRegenQueuedDraftMock.mockResolvedValue({
      outboundMessageId: 'queued-reject-1',
      action: 'inserted',
      priorReviewReason: null,
    })

    await handleFollowup({
      venueId: VENUE_ID,
      guestId: GUEST_ID,
      trigger: { reason: 'day_3', triggeredAt: new Date() },
    })

    const [, , groundingArg, mechanicOfferArg] = applyApprovalPolicyStageMock.mock.calls[0]
    expect(groundingArg).toEqual({ status: 'skipped' })
    expect(mechanicOfferArg).toEqual({ status: 'flagged', mechanicId: 'mech-2' })
  })

  // TAC-367 PR 3 (option B). The original defect was retrieving against
  // `Followup {reason} for {name}` — a template with no referent in any
  // corpus that still returned a full 4/4 slate. An operator's note is real
  // content about a real topic, so it IS a legitimate query; everything else
  // on this path has no free text at all.
  it('retrieves knowledge using the operator note as the query on a manual followup', async () => {
    await handleFollowup({
      venueId: VENUE_ID,
      guestId: GUEST_ID,
      trigger: {
        reason: 'manual',
        triggeredAt: new Date(),
        metadata: { hint: 'tell her about the new Panama lot' },
      },
    })
    expect(retrieveKnowledgeStageMock).toHaveBeenCalledTimes(1)
    // The THIRD argument is the query, and it must be the operator's own
    // text. Asserting the value, not just that retrieval happened — the
    // template-string defect would also have "retrieved".
    const [, , query] = retrieveKnowledgeStageMock.mock.calls[0]
    expect(query).toBe('tell her about the new Panama lot')
  })

  // The two cases with no free text to query on. A cron followup's content is
  // structured (visit history, guest context, the perk's reward_description)
  // and already in the prompt; a hintless manual followup has nothing at all.
  it.each([
    ['manual with no note', { reason: 'manual' as const, triggeredAt: new Date() }],
    ['a cron day_7 followup', { reason: 'day_7' as const, triggeredAt: new Date() }],
  ])('does not retrieve knowledge for %s', async (_label, trigger) => {
    await handleFollowup({ venueId: VENUE_ID, guestId: GUEST_ID, trigger })
    expect(retrieveKnowledgeStageMock).not.toHaveBeenCalled()
    const ctx = generateStageMock.mock.calls[0][0] as { knowledgeCorpus: unknown }
    expect(ctx.knowledgeCorpus).toEqual([])
  })

  // A whitespace-only note is not a note. Without this, `metadata: {hint: ' '}`
  // would query on an empty-ish string and retrieve whatever ranks highest —
  // the template-string failure in a different costume.
  it('treats a whitespace-only note as no note', async () => {
    await handleFollowup({
      venueId: VENUE_ID,
      guestId: GUEST_ID,
      trigger: { reason: 'manual', triggeredAt: new Date(), metadata: { hint: '   ' } },
    })
    expect(retrieveKnowledgeStageMock).not.toHaveBeenCalled()
  })

  it('FAILS CLOSED — a "check_failed" result still queues rather than sending', async () => {
    verifyMechanicOfferStageMock.mockResolvedValueOnce({ status: 'check_failed' })
    applyApprovalPolicyStageMock.mockResolvedValue({
      action: 'queue',
      triggers: ['mechanic_offer_backstop'],
      primaryTrigger: 'mechanic_offer_backstop',
      compMatchedPattern: null,
      // TAC-364: the gate ALWAYS returns this on a queue decision (it is
      // required on ApprovalDecision), so a fixture omitting it would feed
      // `undefined` down a path production never produces. null is what a
      // followup / skipped-check turn actually carries — see ruling 3.
      ungroundedClaims: null,
      existingPendingDraftId: null,
      blankBody: false,
      slot: 'conversation',
      otherSlotOccupied: false,
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

describe('handleFollowup: a draft with nowhere to go (TAC-394)', () => {
  const QUEUE = {
    action: 'queue',
    triggers: ['category_requires_approval'],
    primaryTrigger: 'category_requires_approval',
    compMatchedPattern: null,
    ungroundedClaims: null,
    existingPendingDraftId: null,
    blankBody: false,
    slot: 'conversation',
    otherSlotOccupied: false,
  }

  beforeEach(() => {
    verifyMechanicOfferStageMock.mockResolvedValue({ status: 'skipped' })
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  // The live bug on main: a manual followup's INSERT hit the unique index and
  // race recovery regenerated the waiting card anyway. The policy passed here
  // is what stops it, so both values are pinned.
  it.each([
    ['manual', 'never_regen'],
    ['day_7', 'regen'],
  ] as const)('a %s followup persists with callerPolicy %s', async (reason, policy) => {
    applyApprovalPolicyStageMock.mockResolvedValue(QUEUE)
    persistOrRegenQueuedDraftMock.mockResolvedValue({
      outboundMessageId: 'queued-1',
      action: 'inserted',
      priorReviewReason: null,
    })

    await handleFollowup({
      venueId: VENUE_ID,
      guestId: GUEST_ID,
      trigger: { reason, triggeredAt: new Date() },
    })

    const [, , , , opts] = persistOrRegenQueuedDraftMock.mock.calls[0]
    expect(opts.callerPolicy).toBe(policy)
  })

  // Refused, never skipped silently: logged, recorded as its own event, and the
  // route tells the operator who clicked. No dropped-draft Slack alert, which
  // would tell the same person twice.
  it('a manual followup refused at the gate records the refusal and writes nothing', async () => {
    applyApprovalPolicyStageMock.mockResolvedValue({
      action: 'drop',
      reason: 'slot_occupied',
      triggers: ['category_requires_approval'],
      protectedDraftId: 'waiting-card',
      protectedCommitment: null,
      droppedCommitment: null,
    })

    const result = await handleFollowup({
      venueId: VENUE_ID,
      guestId: GUEST_ID,
      trigger: { reason: 'manual', triggeredAt: new Date() },
    })

    expect(result).toEqual({
      status: 'dropped',
      reason: 'slot_occupied',
      protectedDraftId: 'waiting-card',
      triggers: ['category_requires_approval'],
    })
    expect(captureManualFollowupSlotOccupiedMock).toHaveBeenCalledWith({
      agentRunId: expect.any(String),
      venueId: VENUE_ID,
      guestId: GUEST_ID,
      waitingDraftId: 'waiting-card',
      triggers: ['category_requires_approval'],
    })
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining('manual followup refused'),
      expect.anything(),
    )
    expect(captureDraftDroppedMock).not.toHaveBeenCalled()
    expect(persistOrRegenQueuedDraftMock).not.toHaveBeenCalled()
    expect(scheduleAndSendMock).not.toHaveBeenCalled()
  })

  it('the same refusal found during the write is reported the same way', async () => {
    applyApprovalPolicyStageMock.mockResolvedValue(QUEUE)
    persistOrRegenQueuedDraftMock.mockResolvedValue({
      outboundMessageId: null,
      action: 'dropped',
      priorReviewReason: null,
      reason: 'slot_occupied',
      protectedDraftId: 'waiting-card',
      protectedCommitment: null,
      droppedCommitment: null,
    })

    const result = await handleFollowup({
      venueId: VENUE_ID,
      guestId: GUEST_ID,
      trigger: { reason: 'manual', triggeredAt: new Date() },
    })

    expect(result).toEqual({
      status: 'dropped',
      reason: 'slot_occupied',
      protectedDraftId: 'waiting-card',
      triggers: ['category_requires_approval'],
    })
    expect(captureManualFollowupSlotOccupiedMock).toHaveBeenCalledTimes(1)
    expect(captureDraftDroppedMock).not.toHaveBeenCalled()
    expect(scheduleAndSendMock).not.toHaveBeenCalled()
  })

  it('any other drop goes to the dropped-draft alert, naming both commitments', async () => {
    const kept = { type: 'comp', description: 'a free cortado on your next visit', code: '7K2P' }
    const dropped = { type: 'comp', description: 'a free croissant', code: null }
    applyApprovalPolicyStageMock.mockResolvedValue({
      action: 'drop',
      reason: 'obligation_slot_taken',
      triggers: ['commitment_type_gated'],
      protectedDraftId: 'card-a',
      protectedCommitment: kept,
      droppedCommitment: dropped,
    })

    await handleFollowup({
      venueId: VENUE_ID,
      guestId: GUEST_ID,
      trigger: { reason: 'day_7', triggeredAt: new Date() },
    })

    expect(captureDraftDroppedMock).toHaveBeenCalledWith(
      expect.objectContaining({
        guestFirstName: 'Sam',
        reason: 'obligation_slot_taken',
        protectedDraftId: 'card-a',
        protectedCommitment: kept,
        droppedCommitment: dropped,
        triggers: ['commitment_type_gated'],
        kind: 'followup',
      }),
    )
    expect(captureManualFollowupSlotOccupiedMock).not.toHaveBeenCalled()
  })
})

// TAC-469 rule 2: a follow-up never auto-sends on Instagram. Refused before
// generating, so no caller (the engine, the Command Center button, a perk
// unlock, a demo guest) can reach an Instagram send by this path.
describe('handleFollowup: never on Instagram (TAC-469)', () => {
  const trigger = (reason: 'day_3' | 'manual' | 'perk_unlock' | 'cold_lapsed') => ({
    reason,
    triggeredAt: new Date(),
  })

  it.each(['day_3', 'manual', 'perk_unlock', 'cold_lapsed'] as const)(
    'refuses a %s follow-up for an Instagram conversation before generating',
    async (reason) => {
      buildRuntimeContextMock.mockImplementation(async (args: { followupTrigger: RuntimeContext['followupTrigger'] }) => ({
        ...makeCtx(args.followupTrigger),
        conversationChannel: 'instagram',
      }))
      const result = await handleFollowup({ venueId: VENUE_ID, guestId: GUEST_ID, trigger: trigger(reason) })
      expect(result).toEqual({ status: 'refused', reason: 'instagram_followups_are_manual' })
      expect(generateStageMock).not.toHaveBeenCalled()
      expect(scheduleAndSendMock).not.toHaveBeenCalled()
      expect(persistOrRegenQueuedDraftMock).not.toHaveBeenCalled()
    },
  )

  it('refuses a demo guest on Instagram too: the demo bypass is about approval, not channel', async () => {
    buildRuntimeContextMock.mockImplementation(async (args: { followupTrigger: RuntimeContext['followupTrigger'] }) => {
      const ctx = makeCtx(args.followupTrigger)
      return { ...ctx, conversationChannel: 'instagram', guest: { ...ctx.guest, isDemo: true } }
    })
    const result = await handleFollowup({ venueId: VENUE_ID, guestId: GUEST_ID, trigger: trigger('day_3') })
    expect(result).toEqual({ status: 'refused', reason: 'instagram_followups_are_manual' })
    expect(scheduleAndSendMock).not.toHaveBeenCalled()
  })

  it('refuses an unresolved channel: nothing routes on null', async () => {
    buildRuntimeContextMock.mockImplementation(async (args: { followupTrigger: RuntimeContext['followupTrigger'] }) => ({
      ...makeCtx(args.followupTrigger),
      conversationChannel: null,
    }))
    const result = await handleFollowup({ venueId: VENUE_ID, guestId: GUEST_ID, trigger: trigger('day_3') })
    expect(result).toEqual({ status: 'refused', reason: 'channel_unresolved' })
    expect(generateStageMock).not.toHaveBeenCalled()
  })

  it('still sends a text follow-up, unchanged', async () => {
    const result = await handleFollowup({ venueId: VENUE_ID, guestId: GUEST_ID, trigger: trigger('day_3') })
    expect(generateStageMock).toHaveBeenCalledTimes(1)
    expect(result.status).not.toBe('refused')
  })

  // TAC-536: the ONE carve-out. The reversed half of the it.each above, which
  // is why both live in this block: the pair is what says the refusal was
  // narrowed rather than removed.
  describe('the scan-greeting carve-out', () => {
    const scanTrigger = (): FollowupTrigger => ({
      reason: 'instagram_scan_arrival',
      triggeredAt: new Date(),
      instagramScanArrival: { scanMessageId: 'scan-msg-1', hadPriorConversation: true },
    })

    beforeEach(() => {
      buildRuntimeContextMock.mockImplementation(async (args: { followupTrigger: RuntimeContext['followupTrigger'] }) => ({
        ...makeCtx(args.followupTrigger),
        conversationChannel: 'instagram',
      }))
      // These two are RESET by the file's own beforeEach and never given a
      // default, because every pre-existing Instagram test refuses before
      // generating and never reaches them. This block is the first that does,
      // so a bare vi.fn() resolves undefined and the orchestrator throws on
      // `.status` — CLAUDE.md records exactly this trap in this exact file.
      verifyMechanicOfferStageMock.mockResolvedValue({ status: 'skipped' })
      applyApprovalPolicyStageMock.mockResolvedValue({ action: 'send' })
    })

    it('generates and sends on Instagram where every other reason is refused', async () => {
      const result = await handleFollowup({
        venueId: VENUE_ID,
        guestId: GUEST_ID,
        trigger: scanTrigger(),
      })
      expect(result).toMatchObject({ status: 'sent' })
      expect(generateStageMock).toHaveBeenCalledTimes(1)
    })

    // Only dispatchReply reaches the Instagram transport. Routing this through
    // scheduleAndSend would try to send an Instagram greeting over Sendblue.
    it('sends through dispatchReply, never scheduleAndSend', async () => {
      await handleFollowup({ venueId: VENUE_ID, guestId: GUEST_ID, trigger: scanTrigger() })
      expect(dispatchReplyMock).toHaveBeenCalledTimes(1)
      expect(scheduleAndSendMock).not.toHaveBeenCalled()
    })

    // NOT OPTIONAL. A reply naming no inbound is read by the reply check as
    // answering everything before it, so a greeting that named nothing would
    // silence the agent's own reply to whatever the guest says next. Dropping
    // this is the mutant that matters most on this path.
    it('names the scan row it answers', async () => {
      await handleFollowup({ venueId: VENUE_ID, guestId: GUEST_ID, trigger: scanTrigger() })
      expect(dispatchReplyMock.mock.calls[0]?.[2]).toMatchObject({
        answersInboundId: 'scan-msg-1',
        replyCheck: { inboundMessageId: 'scan-msg-1' },
      })
    })

    // scan_message_id is ON DELETE SET NULL, so a scan whose row was removed
    // still produces a greeting with nothing to name. Exempting the check is
    // right there; pointing it at a row that does not exist is not.
    it('exempts the reply check when the scan row is gone', async () => {
      await handleFollowup({
        venueId: VENUE_ID,
        guestId: GUEST_ID,
        trigger: {
          reason: 'instagram_scan_arrival',
          triggeredAt: new Date(),
          instagramScanArrival: { scanMessageId: null, hadPriorConversation: false },
        },
      })
      expect(dispatchReplyMock.mock.calls[0]?.[2]).toMatchObject({
        answersInboundId: undefined,
        replyCheck: 'exempt',
      })
    })

    it('records it as guest_arrived, not follow_up', async () => {
      await handleFollowup({ venueId: VENUE_ID, guestId: GUEST_ID, trigger: scanTrigger() })
      expect(generateStageMock.mock.calls[0]?.[1]).toBe('guest_arrived')
    })

    // The Instagram arm can decline. The text arm throws instead, so these are
    // reachable only here, and they must not read as a clean send.
    it('reports a reply staff already sent as superseded, not sent', async () => {
      dispatchReplyMock.mockResolvedValue({ kind: 'superseded', byMessageId: 'staff-1' })
      const result = await handleFollowup({
        venueId: VENUE_ID,
        guestId: GUEST_ID,
        trigger: scanTrigger(),
      })
      expect(result).toEqual({ status: 'superseded', byMessageId: 'staff-1' })
    })

    it('reports a carded greeting as queued', async () => {
      dispatchReplyMock.mockResolvedValue({ kind: 'carded', reason: 'window_closed', cardId: 'card-9' })
      const result = await handleFollowup({
        venueId: VENUE_ID,
        guestId: GUEST_ID,
        trigger: scanTrigger(),
      })
      expect(result).toMatchObject({ status: 'queued', outboundMessageId: 'card-9' })
    })

    // The caller's run id has to reach the trace, or the ledger row it writes
    // afterwards points at a trace that does not exist.
    it('uses the caller agentRunId when one is given', async () => {
      await handleFollowup({
        venueId: VENUE_ID,
        guestId: GUEST_ID,
        agentRunId: 'run-from-the-cron',
        trigger: scanTrigger(),
      })
      expect(buildRuntimeContextMock.mock.calls[0]?.[0]).toMatchObject({
        agentRunId: 'run-from-the-cron',
      })
    })
  })
})

// TAC-401: the followup half of ruling 3, "covers followups by design". One of
// the four genuine uncarried promises in the measurement was an engine
// followup, and before these two tests the whole path had the mechanism wired
// and nothing asserting it — both mutants below survived the full suite.
describe('handleFollowup — prose-promise backstop (TAC-401)', () => {
  beforeEach(() => {
    // The file's own beforeEach resets this one without defaulting it, so a
    // bare vi.fn() resolves `undefined`, which Promise.allSettled reports as
    // FULFILLED — the orchestrator then reads `undefined.status` and the turn
    // fails before it ever reaches the gate.
    verifyMechanicOfferStageMock.mockResolvedValue({ status: 'skipped' })
  })

  const commitment = {
    type: 'comp' as const,
    description: 'a replacement cortado',
    code: 'A1B2',
    expiresAt: null,
  }

  it('threads the prose-promise verdict through to applyApprovalPolicyStage', async () => {
    verifyProsePromiseStageMock.mockResolvedValueOnce({ status: 'flagged', commitment })
    applyApprovalPolicyStageMock.mockResolvedValue({ action: 'send' })

    await handleFollowup({
      venueId: VENUE_ID,
      guestId: GUEST_ID,
      trigger: { reason: 'day_3', triggeredAt: new Date() },
    })

    expect(verifyProsePromiseStageMock).toHaveBeenCalledTimes(1)
    const [, , , , prosePromiseArg] = applyApprovalPolicyStageMock.mock.calls[0]
    expect(prosePromiseArg).toEqual({ status: 'flagged', commitment })
  })

  it('passes the named commitment into the persist options', async () => {
    verifyProsePromiseStageMock.mockResolvedValueOnce({ status: 'flagged', commitment })
    applyApprovalPolicyStageMock.mockResolvedValue({
      action: 'queue',
      triggers: ['prose_promise_backstop'],
      primaryTrigger: 'prose_promise_backstop',
      compMatchedPattern: null,
      ungroundedClaims: [],
      existingPendingDraftId: null,
      blankBody: false,
      slot: 'obligation',
      otherSlotOccupied: false,
      promisedCommitment: commitment,
    })
    persistOrRegenQueuedDraftMock.mockResolvedValue({
      outboundMessageId: 'queued-promise-1',
      action: 'inserted',
      priorReviewReason: null,
    })

    await handleFollowup({
      venueId: VENUE_ID,
      guestId: GUEST_ID,
      trigger: { reason: 'day_3', triggeredAt: new Date() },
    })

    const [, , , , persistOpts] = persistOrRegenQueuedDraftMock.mock.calls[0]
    expect(persistOpts.promisedCommitment).toEqual(commitment)
  })
})

// ---------------------------------------------------------------------------
// TAC-513: the cancellation reaches the persist layer on this path too
// ---------------------------------------------------------------------------
//
// A followup can cancel a commitment as easily as a reply can ("we can't do
// the comp after all"), and the threading here is a second, independent copy
// of the inbound one. A mutant that dropped it from BOTH orchestrators left
// the whole suite green, so each needs its own assertion.
describe('handleFollowup — cancellation carrier (TAC-513)', () => {
  const TONIC: ActiveCommitment = {
    id: '9f1c2d3e-4a5b-4c6d-8e9f-0a1b2c3d4e5f',
    type: 'comp',
    description: 'replacement blossom tonic',
    code: 'GWPZ',
    status: 'open',
    expected_arrival: null,
    arrival_signal: null,
    created_at: new Date().toISOString(),
  }

  // This file sets no beforeEach default for the mechanic-offer mock, so a
  // test that reaches the gate has to supply one or the orchestrator reads
  // `.status` off undefined and fails at context_build.
  beforeEach(() => {
    verifyMechanicOfferStageMock.mockResolvedValue({ status: 'skipped' })
  })

  it('calls verifyCancellationClaimStage once per followup', async () => {
    applyApprovalPolicyStageMock.mockResolvedValue({ action: 'send' })

    await handleFollowup({
      venueId: VENUE_ID,
      guestId: GUEST_ID,
      trigger: { reason: 'day_7', triggeredAt: new Date() },
    })

    expect(verifyCancellationClaimStageMock).toHaveBeenCalledTimes(1)
  })

  it('passes the resolved cancellation into the persist options', async () => {
    const pendingCancellation = { commitmentId: TONIC.id }
    generateStageMock.mockResolvedValue({
      status: 'success',
      result: { ...successResult(), cancelsCommitmentId: TONIC.id },
    })
    verifyCancellationClaimStageMock.mockResolvedValueOnce({
      resolution: { status: 'resolved', cancellation: pendingCancellation, commitment: TONIC },
      claim: 'skipped',
    })
    applyApprovalPolicyStageMock.mockResolvedValue({
      action: 'queue',
      triggers: ['commitment_cancellation_gated'],
      primaryTrigger: 'commitment_cancellation_gated',
      compMatchedPattern: null,
      ungroundedClaims: null,
      existingPendingDraftId: null,
      blankBody: false,
      pendingCancellation,
    })
    persistOrRegenQueuedDraftMock.mockResolvedValue({
      outboundMessageId: 'card-f1',
      action: 'inserted',
      priorReviewReason: null,
    })

    const result = await handleFollowup({
      venueId: VENUE_ID,
      guestId: GUEST_ID,
      trigger: { reason: 'day_7', triggeredAt: new Date() },
    })

    expect(result.status).toBe('queued')
    const [, , , , persistOpts] = persistOrRegenQueuedDraftMock.mock.calls[0]
    expect(persistOpts.pendingCancellation).toEqual(pendingCancellation)
  })

  // See handle-inbound.test.ts for why the degrade RECOMPUTES rather than
  // assuming. Pinned here too because this is a separate expression.
  it('recomputes a RESOLVED resolution when the stage unexpectedly throws', async () => {
    buildRuntimeContextMock.mockImplementation(
      async (args: { followupTrigger: RuntimeContext['followupTrigger'] }) => ({
        ...makeCtx(args.followupTrigger),
        activeCommitments: [TONIC],
      }),
    )
    generateStageMock.mockResolvedValue({
      status: 'success',
      result: { ...successResult(), cancelsCommitmentId: TONIC.id },
    })
    verifyCancellationClaimStageMock.mockRejectedValueOnce(new Error('unexpected throw'))
    applyApprovalPolicyStageMock.mockResolvedValue({
      action: 'queue',
      triggers: ['prose_cancellation_check_failed'],
      primaryTrigger: 'prose_cancellation_check_failed',
      compMatchedPattern: null,
      ungroundedClaims: null,
      existingPendingDraftId: null,
      blankBody: false,
    })
    persistOrRegenQueuedDraftMock.mockResolvedValue({
      outboundMessageId: 'card-f2',
      action: 'inserted',
      priorReviewReason: null,
    })

    await handleFollowup({
      venueId: VENUE_ID,
      guestId: GUEST_ID,
      trigger: { reason: 'day_7', triggeredAt: new Date() },
    })

    const [, , , , , cancellationArg] = applyApprovalPolicyStageMock.mock.calls[0]
    expect(cancellationArg).toEqual({
      resolution: { status: 'resolved', cancellation: { commitmentId: TONIC.id }, commitment: TONIC },
      claim: 'check_failed',
    })
  })
})
