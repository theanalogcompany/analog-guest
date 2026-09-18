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
const verifyMechanicOfferStageMock = vi.fn()
const persistOrRegenQueuedDraftMock = vi.fn()
const captureDraftDroppedMock = vi.fn()
const captureManualFollowupSlotOccupiedMock = vi.fn()
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
    attempts: 1,
    attemptScores: [0.85],
    attemptHistory: [],
    systemPrompt: '',
    userPrompt: '',
    promptVersion: 'v1.52.0',
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
  verifyMechanicOfferStageMock.mockReset()
  persistOrRegenQueuedDraftMock.mockReset()
  scheduleAndSendMock.mockReset()
  captureDraftDroppedMock.mockReset()
  captureManualFollowupSlotOccupiedMock.mockReset()

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
    // followup never has a grounding backstop (inbound-only) — always null here.
    expect(groundingArg).toBeNull()
    expect(mechanicOfferArg).toEqual({ status: 'flagged', mechanicId: 'mech-1' })

    // TAC-364: the followup path threads the gate's trigger set and claims to
    // the persist layer exactly as inbound does. `ungroundedClaims` is NULL
    // here rather than `[]`, and the distinction is the ruling: NULL records
    // that the grounding check DID NOT RUN, which on a followup is true by
    // construction (verifyGroundingStage is inbound-only — that gap is
    // TAC-376). `[]` would claim it ran and found nothing, which would make
    // every followup row in the column a quiet lie about a check that never
    // happened.
    const [, , , , persistOpts] = persistOrRegenQueuedDraftMock.mock.calls[0]
    expect(persistOpts.reviewTriggers).toEqual(['mechanic_offer_backstop'])
    expect(persistOpts.ungroundedClaims).toBeNull()
    expect(result.status).toBe('queued')
    expect(scheduleAndSendMock).not.toHaveBeenCalled()
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
