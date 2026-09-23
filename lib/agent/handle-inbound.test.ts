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

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ActiveCommitment } from '@/lib/schemas/guest-commitment'

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
// TAC-350: independent grounding backstop. Defaults to "nothing to flag" for
// every test in this file that doesn't care about it — `clearAllMocks()`
// (used below) clears call history but not this default implementation.
const verifyGroundingStageMock = vi.fn().mockResolvedValue({ status: 'skipped' })
// TAC-401: defaults to 'skipped' like its sibling, so every pre-existing test
// in this file behaves exactly as it did before the check existed.
const verifyProsePromiseStageMock = vi.fn().mockResolvedValue({ status: 'skipped' })
// TAC-363: defaults to 'skipped', which is what the real stage returns on
// every turn at an OPEN venue — the fixtures' venue has no hours, so the
// real stage would skip too.
const verifyClosedVenueArrivalStageMock = vi.fn().mockResolvedValue({ status: 'skipped' })
// TAC-513: default CLEAN, not undefined. The './stages' factory below is an
// explicit allow-list, so a stage missing from it arrives `undefined` and
// throws inside the allSettled argument list before the gate is reached.
const verifyCancellationClaimStageMock = vi.fn().mockResolvedValue({ resolution: { status: 'none' }, claim: 'clean' })
// TAC-355: independent mechanic-offer backstop. Defaults to "skipped" for
// every test in this file that doesn't care about it, mirroring
// verifyGroundingStageMock's default-null posture above.
const verifyMechanicOfferStageMock = vi.fn().mockResolvedValue({ status: 'skipped' })
const loadPendingRowsBySlotMock = vi.fn()
const persistOrRegenQueuedDraftMock = vi.fn()
const scheduleAndSendMock = vi.fn()
const fireRedAlertMock = vi.fn()
const captureDraftQueuedMock = vi.fn()
const captureDraftDroppedMock = vi.fn()
const captureCrisisSafetyReplySentMock = vi.fn()
const captureIntentionPromptRecordingFailedMock = vi.fn()
const captureIntentionPromptRaisedMock = vi.fn()
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
    // TAC-364: forwarded REAL, like the constants around it. This factory is
    // an explicit allow-list, so a constant left out of it arrives `undefined`
    // at the call site rather than failing loudly — here that would have meant
    // persisting review_reason=undefined and calling
    // shouldSendDraftFlaggedPush(undefined), with every assertion in this file
    // still nominally "about" the crash card. Same trap verify-grounding.test
    // hit with NoObjectGeneratedError.
    GENERATION_FAILED_REVIEW_REASON: actual.GENERATION_FAILED_REVIEW_REASON,
    KNOWLEDGE_GAP_WINDOW_MS: actual.KNOWLEDGE_GAP_WINDOW_MS,
    isKnowledgeGapCard: actual.isKnowledgeGapCard,
    // TAC-332: pure and deterministic — forward the real implementation
    // rather than mocking it, same posture as the three constants above.
    computeFirstTouchAfterQrScan: actual.computeFirstTouchAfterQrScan,
    classifyStage: (...a: unknown[]) => classifyStageMock(...a),
    retrieveCorpusStage: (...a: unknown[]) => retrieveCorpusStageMock(...a),
    retrieveKnowledgeStage: (...a: unknown[]) => retrieveKnowledgeStageMock(...a),
    // TAC-367: TRUE, matching production. The real predicate's first line is
    // `if (ctx.currentMessage !== null) return true`, and every test in this
    // file exercises the inbound path, where currentMessage is non-null by
    // definition — so this was `() => false` against a production value of
    // true 100% of the time, and the whole knowledge-retrieval branch
    // (including its Langfuse span and degrade path) was unreachable in every
    // test of the repo's primary guest-facing path. Fourth instance of this
    // defect found in one sitting; see CLAUDE.md's rule on mocked behaviour
    // flags. Flipping it broke nothing — the branch simply had no coverage.
    shouldRetrieveKnowledge: () => true,
    generateStage: (...a: unknown[]) => generateStageMock(...a),
    applyApprovalPolicyStage: (...a: unknown[]) => applyApprovalPolicyStageMock(...a),
    verifyGroundingStage: (...a: unknown[]) => verifyGroundingStageMock(...a),
    verifyMechanicOfferStage: (...a: unknown[]) => verifyMechanicOfferStageMock(...a),
    // TAC-401: this factory is an explicit ALLOW-LIST. A stage missing here
    // arrives `undefined` at the call site, and inside an allSettled array
    // that is a TypeError swallowed into a rejected settlement — the check
    // would read as permanently degraded with every test here still green.
    verifyProsePromiseStage: (...a: unknown[]) => verifyProsePromiseStageMock(...a),
    verifyClosedVenueArrivalStage: (...a: unknown[]) =>
      verifyClosedVenueArrivalStageMock(...a),
    verifyCancellationClaimStage: (...a: unknown[]) => verifyCancellationClaimStageMock(...a),
  }
})
vi.mock('./schedule-and-send', () => ({
  persistOrRegenQueuedDraft: (...a: unknown[]) => persistOrRegenQueuedDraftMock(...a),
  scheduleAndSend: (...a: unknown[]) => scheduleAndSendMock(...a),
}))
// TAC-469: the Instagram arm, mocked so this file pins the ORCHESTRATOR's
// mapping of its outcomes. The arm's own behaviour is
// dispatch-instagram-reply.test.ts's. dispatch-reply.ts (the switch) is real.
const dispatchInstagramReplyMock = vi.fn()
vi.mock('./dispatch-instagram-reply', () => ({
  INSTAGRAM_SEND_FAILED_REVIEW_REASON: 'instagram_send_failed',
  dispatchInstagramReply: (...a: unknown[]) => dispatchInstagramReplyMock(...a),
}))
// TAC-394: the crash card reads the guest's pending slots. Only that database
// read is mocked; decideSlotAction and the identity helpers are forwarded REAL,
// so a test here cannot pass on a mock's opinion of which slot a card is in.
vi.mock('./pending-slots', async () => {
  const actual = await vi.importActual<typeof import('./pending-slots')>('./pending-slots')
  return {
    ...actual,
    loadPendingRowsBySlot: (...a: unknown[]) => loadPendingRowsBySlotMock(...a),
  }
})
vi.mock('./alerts', () => ({
  fireRedAlert: (...a: unknown[]) => fireRedAlertMock(...a),
  capturePostHogEvent: vi.fn(),
}))
// TAC-523: the ledger writer, mocked wholesale — its own coverage lives in
// record-inbound-turn-outcome.test.ts, against a fake that records inserts.
// NAMED, not a bare vi.fn(): what this file has to prove is that the
// orchestrator hands it the real AgentResult, and a fixed stub cannot show
// that. See the 'records the turn's outcome' block at the end of this file.
const recordInboundTurnOutcomeMock = vi.fn<(...args: unknown[]) => Promise<void>>()
vi.mock('./record-inbound-turn-outcome', () => ({
  recordInboundTurnOutcome: (...a: unknown[]) => recordInboundTurnOutcomeMock(...a),
}))
// TAC-363: a named handle, because the push fan-out below is the delivery
// mechanism for "every open obligation is surfaced" and a fixed 'noop' cannot
// reach it. Reverting the loop to a single row passed every test in this file
// while dispatch-arrival-capture.test.ts still proved both rows came back.
const dispatchArrivalCaptureMock = vi.fn<(...args: unknown[]) => Promise<unknown>>()
vi.mock('./dispatch-arrival-capture', () => ({
  dispatchArrivalCapture: (...a: unknown[]) => dispatchArrivalCaptureMock(...a),
}))
// TAC-323: fire-and-forget side effect, mocked wholesale — its own unit
// coverage lives in extract-reported-order.test.ts.
vi.mock('./extract-reported-order', async () => {
  const actual = await vi.importActual<typeof import('./extract-reported-order')>(
    './extract-reported-order',
  )
  return {
    // TAC-332: stages.ts's real computeFirstTouchAfterQrScan (forwarded,
    // not mocked, in the ./stages mock below) imports this constant — it's
    // now reachable from a code path this file doesn't mock away, so the
    // mock needs to provide it. A plain re-exported value, not a mock.
    REPORTED_ORDER_WINDOW_DAYS: actual.REPORTED_ORDER_WINDOW_DAYS,
    extractReportedOrder: vi.fn(async () => ({ kind: 'no_menu_item_mentioned' })),
  }
})
const recordIntentionPromptsMock = vi.fn()
const recordIntentionEligibilityMock = vi.fn()
// TAC-324: same posture as extractReportedOrder above — fire-and-forget side
// effect, mocked wholesale; its own unit coverage lives in
// lib/agent/intentions/record.test.ts. This file only needs to prove the
// call site: gated on ctx.openIntentions, fired with the right shape, never
// lets a rejection propagate.
vi.mock('./intentions/record', () => ({
  recordIntentionPrompts: (...a: unknown[]) => recordIntentionPromptsMock(...a),
  recordIntentionEligibility: (...a: unknown[]) => recordIntentionEligibilityMock(...a),
}))
vi.mock('@/lib/guests/context', () => ({
  isEmptyContextUpdate: () => true,
  updateGuestContext: vi.fn(),
}))
vi.mock('@/lib/analytics/posthog', () => ({
  AGENT_LATENCY_HIGH_THRESHOLD_MS: 10_000,
  captureAgentLatencyHigh: vi.fn(),
  captureDraftQueued: (...a: unknown[]) => captureDraftQueuedMock(...a),
  captureCrisisSafetyReplySent: (...a: unknown[]) => captureCrisisSafetyReplySentMock(...a),
  captureDraftRegenerated: vi.fn(),
  captureDraftDropped: (...a: unknown[]) => captureDraftDroppedMock(...a),
  captureIntentionPromptRecordingFailed: (...a: unknown[]) =>
    captureIntentionPromptRecordingFailedMock(...a),
  // TAC-436: this factory is an ALLOW-LIST. Omitted here, the new export
  // arrives `undefined` and throws inside the waitUntil .then(), which nothing
  // in this file would surface.
  captureIntentionPromptRaised: (...a: unknown[]) => captureIntentionPromptRaisedMock(...a),
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
// TAC-363: must RESOLVE, not return undefined. handle-inbound calls
// `.catch()` on the result, so a bare vi.fn() throws a TypeError after the
// first push and the fan-out silently stops at one — which is exactly the
// defect these tests exist to catch, arriving through the mock instead.
const sendCommitmentArrivalPushMock = vi.fn<(...args: unknown[]) => Promise<unknown>>()
vi.mock('@/lib/notifications/send-commitment-push', () => ({
  sendCommitmentArrivalPush: (...a: unknown[]) => sendCommitmentArrivalPushMock(...a),
}))
vi.mock('@vercel/functions', () => ({ waitUntil: (p: unknown) => p }))
const traceControl = vi.hoisted(() => ({ flushThrows: false }))
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
    // TAC-523: `await trace.flushAsync()` sits in runInboundTurn's `finally`,
    // which is the only way the orchestrator can throw past its own top-level
    // catch — and therefore the only way to reach the wrapper's catch.
    flushAsync: async () => {
      if (traceControl.flushThrows) throw new Error('flush failed')
    },
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
import { APPROVAL_TRIGGERS, GENERATION_FAILED_REVIEW_REASON } from './stages'

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
      channel: 'text',
    },
    followupTrigger: null,
    conversationChannel: 'text',
    pendingQuestion: null,
    recentMessages: [],
    recognition: { score: 0.5, state: 'regular', signals: {}, computedAt: new Date() },
    mechanics: [],
    recentVisits: [],
    activeCommitments: [],
    openIntentions: [],
    intentionDerivation: { newlyEligible: [], brakeEngaged: false },
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
  traceControl.flushThrows = false
  // TAC-363: vi.clearAllMocks() wipes the factory's own implementation, so the
  // default has to be restored here or every test gets `undefined` back.
  dispatchArrivalCaptureMock.mockResolvedValue({ kind: 'noop' })
  sendCommitmentArrivalPushMock.mockResolvedValue(undefined)
  inboundSingleMock.mockResolvedValue({
    data: {
      id: INBOUND_ID,
      body: 'is rayan working tomorrow',
      provider_message_id: 'p1',
      created_at: new Date().toISOString(),
      venue_id: VENUE_ID,
      guest_id: GUEST_ID,
      direction: 'inbound',
      channel: 'text',
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
    crisisSafety: false,
  })
  retrieveCorpusStageMock.mockResolvedValue([])
  // Non-empty: with [] an assertion of [] could not tell "retrieval was
  // skipped" from "retrieval ran and matched nothing".
  retrieveKnowledgeStageMock.mockResolvedValue([
    {
      id: 'k1',
      knowledgeCorpusId: 'kc1',
      text: 'Le Mils roasts Indian coffee in-house.',
      sourceType: 'synthesized',
      confidence: 0.9,
      similarity: 0.52,
      primaryTags: ['sourcing'],
      secondaryTags: [],
    },
  ])
  loadPendingRowsBySlotMock.mockResolvedValue({ obligation: null, conversation: [] })
  persistOrRegenQueuedDraftMock.mockResolvedValue({
    outboundMessageId: 'card-1',
    action: 'inserted',
    priorReviewReason: null,
  })
  sendDraftFlaggedPushMock.mockResolvedValue(undefined)
  recordIntentionPromptsMock.mockResolvedValue({ kind: 'no_open_intentions' })
  recordIntentionEligibilityMock.mockResolvedValue({ kind: 'nothing_to_record' })
  captureIntentionPromptRecordingFailedMock.mockResolvedValue(undefined)
  captureIntentionPromptRaisedMock.mockResolvedValue(undefined)
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
      // TAC-364: the AgentResult carries the crash's own reason too, so a
      // caller reading the result (and the PostHog draft_queued payload built
      // from it) can't disagree with the row about why the card exists.
      primaryTrigger: GENERATION_FAILED_REVIEW_REASON,
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

  // TAC-364 REVERSES the review_reason half of this test. TAC-309 stamped
  // these cards `knowledge_gap` to inherit the timer, the holding message and
  // the eviction protection — all of which still work, because none of them
  // key on review_reason. What the reuse cost was the operator-facing copy:
  // the card read "a guest asked something I don't have an answer for" on a
  // turn where the guest may have asked something perfectly answerable and the
  // generator simply crashed. Everything else about the card is unchanged, and
  // the assertions below say so.
  it('persists the card blank, with a clock, under review_reason=generation_failed', async () => {
    generateStageMock.mockResolvedValue(GEN_FAILED)
    await handleInbound(INBOUND_ID)
    const [, , trigger, existingId, opts] = persistOrRegenQueuedDraftMock.mock.calls[0]
    expect(trigger).toBe(GENERATION_FAILED_REVIEW_REASON)
    expect(trigger).not.toBe(APPROVAL_TRIGGERS.KNOWLEDGE_GAP)
    expect(existingId).toBeNull()
    expect(opts).toMatchObject({ blankBody: true })
    expect(opts.pendingUntil).toBeInstanceOf(Date)
    // This path never ran the gate, so there is no trigger SET to record —
    // only the one reason it stamps itself. Pinned so a future caller doesn't
    // synthesize a single-element array and make the column claim the gate ran.
    expect(opts.reviewTriggers).toBeUndefined()
  })

  // The crash card still IS a gap card to every predicate that decides whether
  // it survives. This is the half of the split that is easy to get wrong:
  // without it, the moment the holding timer CAS-claims and nulls
  // pending_until, the next turn that queues for any reason would UPDATE this
  // row in place and the guest's outstanding question would be gone.
  it('is still recognized as a gap card by the real predicate', async () => {
    const { isKnowledgeGapCard } = await vi.importActual<typeof import('./stages')>('./stages')
    expect(
      isKnowledgeGapCard({
        review_reason: GENERATION_FAILED_REVIEW_REASON,
        pending_until: null,
      }),
    ).toBe(true)
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
    // TAC-394: a comp promised in prose, with no structured commitment, is a
    // conversation-slot card: the slot the blank crash card would take.
    loadPendingRowsBySlotMock.mockResolvedValue({
      obligation: null,
      conversation: [{
        id: 'comp-draft',
        body: "the next one's on us",
        pending_until: null,
        review_reason: APPROVAL_TRIGGERS.COMP_REGEX_BACKSTOP,
        pending_commitment: null,
        created_at: '2026-09-14T16:00:00.000Z',
      }],
    })
    const r = await handleInbound(INBOUND_ID)
    expect(persistOrRegenQueuedDraftMock).not.toHaveBeenCalled()
    expect(r).toMatchObject({ status: 'failed' })
  })

  // An existing gap card IS updatable — but its deadline must survive, or a
  // crash could push out a clock that's already running.
  it('updates an existing gap card in place without re-arming its clock', async () => {
    loadPendingRowsBySlotMock.mockResolvedValue({
      obligation: null,
      conversation: [{
        id: 'gap-card',
        body: '',
        pending_until: new Date(Date.now() + 60_000).toISOString(),
        review_reason: APPROVAL_TRIGGERS.KNOWLEDGE_GAP,
        pending_commitment: null,
        created_at: '2026-09-14T16:00:00.000Z',
      }],
    })
    await handleInbound(INBOUND_ID)
    const [, , , existingId, opts] = persistOrRegenQueuedDraftMock.mock.calls[0]
    expect(existingId).toBe('gap-card')
    expect(opts.pendingUntil).toBeUndefined()
  })

  // TAC-394: the crash card is blank and carries no commitment, so it belongs
  // in the CONVERSATION slot. A comp card in the obligation slot is neither in
  // its way nor at risk from it. With one slot per guest, this crash left the
  // guest's question with no card at all.
  it('writes the card beside a pending comp card in the other slot', async () => {
    loadPendingRowsBySlotMock.mockResolvedValue({
      obligation: {
        id: 'card-a',
        body: "Really sorry. The next one's on us.",
        pending_until: null,
        review_reason: 'commitment_type_gated',
        pending_commitment: {
          type: 'comp',
          description: "the next one's on us",
          code: '7K2P',
          expiresAt: null,
        },
        created_at: '2026-09-14T16:00:00.000Z',
      },
      conversation: [],
    })
    const r = await handleInbound(INBOUND_ID)
    expect(r).toMatchObject({ status: 'queued', outboundMessageId: 'card-1' })
    const [, , , existingId, opts] = persistOrRegenQueuedDraftMock.mock.calls[0]
    expect(existingId).toBeNull()
    expect(opts.callerPolicy).toBe('regen_gap_card_only')
    // An ordinary comp card is not a gap card, so the crash card still arms its clock.
    expect(opts.pendingUntil).toBeInstanceOf(Date)
    expect(captureDraftQueuedMock).toHaveBeenCalledWith(
      expect.objectContaining({ slot: 'conversation', otherSlotOccupied: true }),
    )
  })

  // A failed slot read counts as two empty slots, as findPendingDraft's null did:
  // the card is written with a clock, and migration 041's index plus persist race
  // recovery are the backstop.
  it('writes the card with a clock when the slot read fails', async () => {
    loadPendingRowsBySlotMock.mockResolvedValue(null)
    const r = await handleInbound(INBOUND_ID)
    expect(r).toMatchObject({ status: 'queued', outboundMessageId: 'card-1' })
    const [, , , existingId, opts] = persistOrRegenQueuedDraftMock.mock.calls[0]
    expect(existingId).toBeNull()
    expect(opts.pendingUntil).toBeInstanceOf(Date)
    expect(opts.callerPolicy).toBe('regen_gap_card_only')
    expect(captureDraftQueuedMock).toHaveBeenCalledWith(
      expect.objectContaining({
        slot: 'conversation',
        otherSlotOccupied: false,
        hasPreviousPending: false,
      }),
    )
  })

  // The pre-check saw an empty conversation slot, then a non-gap draft took it
  // before the write. Recovery refuses under 'regen_gap_card_only', and a
  // refused card is a skipped card: nothing queued, nothing pushed.
  it('treats a refusal during the write as a skipped card', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    persistOrRegenQueuedDraftMock.mockResolvedValue({
      outboundMessageId: null,
      action: 'dropped',
      priorReviewReason: null,
      reason: 'slot_occupied',
      protectedDraftId: 'late-draft',
      protectedCommitment: null,
      droppedCommitment: null,
    })
    const r = await handleInbound(INBOUND_ID)
    expect(r).toMatchObject({ status: 'failed', stage: 'generation' })
    expect(captureDraftQueuedMock).not.toHaveBeenCalled()
    expect(sendDraftFlaggedPushMock).not.toHaveBeenCalled()
    warn.mockRestore()
  })

  // TAC-394: the holding-message clock is the guest's, not the slot's. A
  // knowledge-gap card in the OTHER slot already has one, and the timeout scan
  // fires per card, so a second clock would send the guest a second holding
  // message.
  it('arms no clock while a knowledge-gap card sits in the other slot', async () => {
    loadPendingRowsBySlotMock.mockResolvedValue({
      obligation: {
        id: 'gap-comp',
        body: "Sorry about that. The next one's on us.",
        pending_until: new Date(Date.now() + 60_000).toISOString(),
        review_reason: 'knowledge_gap_backstop',
        pending_commitment: {
          type: 'comp',
          description: "the next one's on us",
          code: '7K2P',
          expiresAt: null,
        },
        created_at: '2026-09-14T16:00:00.000Z',
      },
      conversation: [],
    })
    await handleInbound(INBOUND_ID)
    const [, , , existingId, opts] = persistOrRegenQueuedDraftMock.mock.calls[0]
    expect(existingId).toBeNull()
    expect(opts.pendingUntil).toBeUndefined()
  })

  // A failure to record a failure must not deepen it.
  it('never throws when the persist layer throws', async () => {
    persistOrRegenQueuedDraftMock.mockRejectedValue(new Error('db down'))
    const r = await handleInbound(INBOUND_ID)
    expect(r).toMatchObject({ status: 'failed', stage: 'generation' })
  })
})

describe('handleInbound: a draft with nowhere to go (TAC-394)', () => {
  const KEPT = { type: 'comp', description: 'a free cortado on your next visit', code: '7K2P' }
  const DROPPED = { type: 'comp', description: 'a free croissant', code: null }
  const QUEUE_INTO_OBLIGATION = {
    action: 'queue',
    triggers: ['commitment_type_gated'],
    primaryTrigger: 'commitment_type_gated',
    compMatchedPattern: null,
    ungroundedClaims: [],
    existingPendingDraftId: null,
    blankBody: false,
    slot: 'obligation',
    otherSlotOccupied: false,
  }

  beforeEach(() => {
    generateStageMock.mockResolvedValue({ status: 'success', result: successResult() })
  })

  // The ruling asked for the alert to name both offers and the guest, because
  // whoever reads it may be reading it mid-incident. toEqual on the payload: an
  // alert that quietly lost the guest's name or one of the offers is the
  // defect, and a partial match would pass it.
  // TAC-397: the orchestrator half of case 2. tsc covers the shape; this
  // covers that nothing is written and nothing is sent — the two facts the
  // guest and the operator actually experience.
  it('writes nothing and sends nothing on a silenced turn', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    applyApprovalPolicyStageMock.mockResolvedValue({ action: 'silence' })

    const r = await handleInbound(INBOUND_ID)

    expect(r).toEqual({ status: 'silenced' })
    expect(persistOrRegenQueuedDraftMock).not.toHaveBeenCalled()
    expect(scheduleAndSendMock).not.toHaveBeenCalled()
    expect(dispatchInstagramReplyMock).not.toHaveBeenCalled()
    log.mockRestore()
  })

  it('reports a gate-time drop with both commitments and the guest, and writes nothing', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    applyApprovalPolicyStageMock.mockResolvedValue({
      action: 'drop',
      reason: 'obligation_slot_taken',
      triggers: ['commitment_type_gated'],
      protectedDraftId: 'card-a',
      protectedCommitment: KEPT,
      droppedCommitment: DROPPED,
    })

    const r = await handleInbound(INBOUND_ID)

    expect(r).toEqual({
      status: 'dropped',
      reason: 'obligation_slot_taken',
      protectedDraftId: 'card-a',
      triggers: ['commitment_type_gated'],
    })
    expect(persistOrRegenQueuedDraftMock).not.toHaveBeenCalled()
    expect(scheduleAndSendMock).not.toHaveBeenCalled()
    expect(captureDraftDroppedMock).toHaveBeenCalledTimes(1)
    expect(captureDraftDroppedMock).toHaveBeenCalledWith({
      agentRunId: expect.any(String),
      venueId: VENUE_ID,
      guestId: GUEST_ID,
      guestFirstName: 'Sam',
      guestPhone: '+15555550123',
      reason: 'obligation_slot_taken',
      protectedDraftId: 'card-a',
      protectedCommitment: KEPT,
      droppedCommitment: DROPPED,
      triggers: ['commitment_type_gated'],
      kind: 'inbound',
      category: 'new_question',
      droppedBody: 'sure thing',
    })
    warn.mockRestore()
  })

  // The gate saw an empty slot and the write found a card there. Reported
  // exactly as a gate-time drop, because to the guest and the operator it is one.
  it('reports a drop found during the write the same way, and never pushes', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    applyApprovalPolicyStageMock.mockResolvedValue(QUEUE_INTO_OBLIGATION)
    persistOrRegenQueuedDraftMock.mockResolvedValue({
      outboundMessageId: null,
      action: 'dropped',
      priorReviewReason: null,
      reason: 'obligation_slot_taken',
      protectedDraftId: 'card-a',
      protectedCommitment: KEPT,
      droppedCommitment: DROPPED,
    })

    const r = await handleInbound(INBOUND_ID)

    expect(r).toEqual({
      status: 'dropped',
      reason: 'obligation_slot_taken',
      protectedDraftId: 'card-a',
      triggers: ['commitment_type_gated'],
    })
    const [, , , , opts] = persistOrRegenQueuedDraftMock.mock.calls[0]
    expect(opts.callerPolicy).toBe('regen')
    expect(captureDraftDroppedMock).toHaveBeenCalledWith(
      expect.objectContaining({
        guestFirstName: 'Sam',
        guestPhone: '+15555550123',
        reason: 'obligation_slot_taken',
        protectedDraftId: 'card-a',
        protectedCommitment: KEPT,
        droppedCommitment: DROPPED,
        droppedBody: 'sure thing',
      }),
    )
    expect(captureDraftQueuedMock).not.toHaveBeenCalled()
    expect(sendDraftFlaggedPushMock).not.toHaveBeenCalled()
    warn.mockRestore()
  })

  it('records which slot a queued draft took and whether the other slot is held', async () => {
    applyApprovalPolicyStageMock.mockResolvedValue({
      ...QUEUE_INTO_OBLIGATION,
      otherSlotOccupied: true,
    })

    await handleInbound(INBOUND_ID)

    expect(captureDraftQueuedMock).toHaveBeenCalledWith(
      expect.objectContaining({ slot: 'obligation', otherSlotOccupied: true }),
    )
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
    // TAC-513: REQUIRED on GenerateMessageResult, so a fixture omitting it
    // hands every test in this file `undefined` where production always has a
    // string. `resolveCancellation` reads both as "cancels nothing", so the
    // omission is invisible until a test means to exercise a real id.
    cancelsCommitmentId: '',
    attempts: 1,
    attemptScores: [0.9],
    attemptHistory: [],
    systemPrompt: '',
    userPrompt: '',
    promptVersion: 'v1.64.0',
    dashViolationPersisted: false,
    selfTalkViolationPersisted: false,
    emojiDirectiveViolated: false,
  }
}

describe('handleInbound — intention recording call sites (TAC-324, TAC-380)', () => {
  function setUpSentPath() {
    generateStageMock.mockResolvedValue({ status: 'success', result: successResult() })
    applyApprovalPolicyStageMock.mockResolvedValue({ action: 'send' })
    scheduleAndSendMock.mockResolvedValue({
      outboundMessageId: 'sent-1',
      providerMessageId: 'p',
    })
  }

  const UNDERSTAND = {
    key: 'understand_order' as const,
    promptLine: "You haven't heard what this guest ordered yet.",
    eligibleAt: new Date('2026-09-13T12:00:00.000Z'),
  }
  const LEARN_NAME = {
    key: 'learn_name' as const,
    promptLine: "You don't know this guest's name yet.",
    eligibleAt: new Date('2026-09-10T12:00:00.000Z'),
  }
  const qrScanGuest = {
    id: GUEST_ID,
    phoneNumber: '+15555550123',
    firstName: null,
    createdAt: new Date(),
    createdVia: 'qr_scan',
    isDemo: false,
    context: {},
    lastVisitAt: null,
  }

  it('never calls recordIntentionPrompts when ctx.openIntentions is empty', async () => {
    setUpSentPath()
    buildRuntimeContextMock.mockResolvedValue(makeCtx({ openIntentions: [] }))
    const r = await handleInbound(INBOUND_ID)
    expect(r).toMatchObject({ status: 'sent' })
    expect(recordIntentionPromptsMock).not.toHaveBeenCalled()
  })

  it('calls recordIntentionPrompts with the sent body, the rendered intentions, and a send-time stamp', async () => {
    setUpSentPath()
    const openIntentions = [UNDERSTAND, LEARN_NAME]
    buildRuntimeContextMock.mockResolvedValue(makeCtx({ openIntentions }))
    const r = await handleInbound(INBOUND_ID)
    expect(r).toMatchObject({ status: 'sent', outboundMessageId: 'sent-1' })
    expect(recordIntentionPromptsMock).toHaveBeenCalledWith({
      venueId: VENUE_ID,
      guestId: GUEST_ID,
      messageId: 'sent-1',
      sentBody: successResult().body,
      openIntentions,
      now: expect.any(Date),
    })
  })

  // TAC-380 trap 4. A classifier failure closes everything recording is handed,
  // so recording must never be handed an intention that didn't render. Both
  // tests assert the send HAPPENED, or "not called" would pass for the wrong
  // reason.
  it('never records on an opt_out turn, even with intentions open (trap 4)', async () => {
    setUpSentPath()
    classifyStageMock.mockResolvedValue({
      category: 'opt_out',
      classifierConfidence: 0.99,
      reasoning: 'stop',
      crisisSafety: false,
    })
    buildRuntimeContextMock.mockResolvedValue(makeCtx({ openIntentions: [UNDERSTAND] }))
    await handleInbound(INBOUND_ID)
    expect(scheduleAndSendMock).toHaveBeenCalled()
    expect(recordIntentionPromptsMock).not.toHaveBeenCalled()
  })

  it('never records while the guest is owed an answer to an earlier question (trap 4)', async () => {
    setUpSentPath()
    buildRuntimeContextMock.mockResolvedValue(
      makeCtx({
        openIntentions: [UNDERSTAND],
        pendingQuestion: { question: 'is rayan working', askedAt: new Date(), mode: 'outstanding' },
      }),
    )
    await handleInbound(INBOUND_ID)
    expect(scheduleAndSendMock).toHaveBeenCalled()
    expect(recordIntentionPromptsMock).not.toHaveBeenCalled()
  })

  // REVERSED by TAC-423, ruled 2026-09-22. This asserted the opposite until
  // then: TAC-332 excluded the opener turn from recording because the opener
  // scripted its own question about whether the guest was new, so the
  // classifier could only return a correct negative or a false positive that
  // closes a one-shot goal forever. The opener no longer scripts a question at
  // all, and what that turn now asks IS the first intention line, so refusing
  // to record it was refusing to record the one ask this turn reliably makes.
  //
  // Kept as an assertion rather than deleted, because the behaviour is
  // deliberately changed and the next reader needs to see which way round it
  // goes and why.
  it('records on the true opener turn, like every other turn (TAC-423)', async () => {
    setUpSentPath()
    buildRuntimeContextMock.mockResolvedValue(
      makeCtx({ openIntentions: [UNDERSTAND], guest: qrScanGuest, recentMessages: [] }),
    )
    const r = await handleInbound(INBOUND_ID)
    expect(r).toMatchObject({ status: 'sent' })
    expect(recordIntentionPromptsMock).toHaveBeenCalled()
    // The offered set is the rendered one, not ctx.openIntentions widened.
    expect(recordIntentionPromptsMock.mock.calls[0][0]).toMatchObject({
      openIntentions: [UNDERSTAND],
    })
  })

  // The same qr_scan guest past the opener turn. Both turns record now, so
  // this no longer distinguishes the two; it stays because it is the case the
  // suppression never covered, and losing it would leave nothing asserting
  // that an ordinary qr_scan turn records.
  it('still calls recordIntentionPrompts for a qr_scan guest past the opener turn', async () => {
    setUpSentPath()
    buildRuntimeContextMock.mockResolvedValue(
      makeCtx({
        openIntentions: [UNDERSTAND],
        guest: qrScanGuest,
        recentMessages: [
          { direction: 'outbound', body: 'Hey, first time in?', createdAt: new Date() },
        ],
      }),
    )
    const r = await handleInbound(INBOUND_ID)
    expect(r).toMatchObject({ status: 'sent' })
    expect(recordIntentionPromptsMock).toHaveBeenCalled()
  })

  it('never calls recordIntentionPrompts on a queued (not sent) draft', async () => {
    generateStageMock.mockResolvedValue({ status: 'success', result: successResult() })
    applyApprovalPolicyStageMock.mockResolvedValue({
      action: 'queue',
      triggers: [APPROVAL_TRIGGERS.MODEL_FLAGGED],
      primaryTrigger: APPROVAL_TRIGGERS.MODEL_FLAGGED,
    })
    buildRuntimeContextMock.mockResolvedValue(makeCtx({ openIntentions: [LEARN_NAME] }))
    const r = await handleInbound(INBOUND_ID)
    expect(r).toMatchObject({ status: 'queued' })
    expect(recordIntentionPromptsMock).not.toHaveBeenCalled()
  })

  // A recording failure must never surface as a handleInbound failure — the
  // message has already reached the guest by the time this runs.
  it('does not let a recordIntentionPrompts rejection propagate or change the result', async () => {
    setUpSentPath()
    recordIntentionPromptsMock.mockRejectedValue(new Error('anthropic timeout'))
    buildRuntimeContextMock.mockResolvedValue(makeCtx({ openIntentions: [UNDERSTAND] }))
    const r = await handleInbound(INBOUND_ID)
    expect(r).toMatchObject({ status: 'sent', outboundMessageId: 'sent-1' })
  })

  // TAC-380: before this ticket a recording failure was a bare console.warn,
  // invisible in PostHog and Slack. Both non-normal outcomes now alert.
  it('alerts when the classifier failed twice and rendered intentions closed pessimistically', async () => {
    setUpSentPath()
    recordIntentionPromptsMock.mockResolvedValue({
      kind: 'closed_pessimistically',
      closedKeys: ['understand_order'],
      classifierError: 'anthropic timeout',
    })
    buildRuntimeContextMock.mockResolvedValue(makeCtx({ openIntentions: [UNDERSTAND] }))
    await handleInbound(INBOUND_ID)
    await vi.waitFor(() =>
      expect(captureIntentionPromptRecordingFailedMock).toHaveBeenCalledWith({
        agentRunId: expect.any(String),
        // TAC-385 PR 1: required, and asserted rather than loosened — it is
        // what tells the three send paths apart in Slack, and the dispatch
        // paths are where a pessimistic closure is most likely to be wrong.
        via: 'auto_send',
        venueId: VENUE_ID,
        guestId: GUEST_ID,
        messageId: 'sent-1',
        outcome: 'closed_pessimistically',
        keys: ['understand_order'],
        error: 'anthropic timeout',
      }),
    )
  })

  it('alerts when the prompt write fails', async () => {
    setUpSentPath()
    recordIntentionPromptsMock.mockResolvedValue({
      kind: 'write_failed',
      keys: ['learn_name'],
      source: 'classified',
      error: 'db down',
    })
    buildRuntimeContextMock.mockResolvedValue(makeCtx({ openIntentions: [LEARN_NAME] }))
    await handleInbound(INBOUND_ID)
    await vi.waitFor(() =>
      expect(captureIntentionPromptRecordingFailedMock).toHaveBeenCalledWith({
        agentRunId: expect.any(String),
        // TAC-385 PR 1: required, and asserted rather than loosened — it is
        // what tells the three send paths apart in Slack, and the dispatch
        // paths are where a pessimistic closure is most likely to be wrong.
        via: 'auto_send',
        venueId: VENUE_ID,
        guestId: GUEST_ID,
        messageId: 'sent-1',
        outcome: 'write_failed',
        keys: ['learn_name'],
        source: 'classified',
        error: 'db down',
      }),
    )
  })

  // TAC-436 ruling 5. The auto-send half of the raise event. `offeredKeys` is
  // the RENDERED set, which on this path is also the recordable set, so the
  // event can never claim a door was open that this turn suppressed.
  it('fires the raise event on a successful recording, naming the auto-send path', async () => {
    setUpSentPath()
    recordIntentionPromptsMock.mockResolvedValue({
      kind: 'recorded',
      raisedKeys: ['learn_name'],
      classifierAttempts: 1,
    })
    buildRuntimeContextMock.mockResolvedValue(makeCtx({ openIntentions: [UNDERSTAND, LEARN_NAME] }))
    await handleInbound(INBOUND_ID)
    await vi.waitFor(() => expect(captureIntentionPromptRaisedMock).toHaveBeenCalled())

    expect(captureIntentionPromptRaisedMock.mock.calls[0][0]).toMatchObject({
      via: 'auto_send',
      venueId: VENUE_ID,
      guestId: GUEST_ID,
      messageId: 'sent-1',
      raisedKeys: ['learn_name'],
      offeredKeys: [UNDERSTAND.key, LEARN_NAME.key],
      classifierAttempts: 1,
      sentBody: successResult().body,
    })
    expect(captureIntentionPromptRaisedMock.mock.calls[0][0].agentRunId).toEqual(expect.any(String))
  })

  // THE NEGATIVE THAT MATTERS. Most sends raise nothing; firing there would
  // make the event useless on the one question it exists to answer.
  it('does NOT fire the raise event when the send raised nothing', async () => {
    setUpSentPath()
    recordIntentionPromptsMock.mockResolvedValue({ kind: 'nothing_raised' })
    buildRuntimeContextMock.mockResolvedValue(makeCtx({ openIntentions: [LEARN_NAME] }))
    await handleInbound(INBOUND_ID)
    await vi.waitFor(() => expect(recordIntentionPromptsMock).toHaveBeenCalled())
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(captureIntentionPromptRaisedMock).not.toHaveBeenCalled()
  })

  it('does not alert on a normal recording', async () => {
    setUpSentPath()
    recordIntentionPromptsMock.mockResolvedValue({
      kind: 'recorded',
      raisedKeys: ['learn_name'],
      classifierAttempts: 1,
    })
    buildRuntimeContextMock.mockResolvedValue(makeCtx({ openIntentions: [LEARN_NAME] }))
    await handleInbound(INBOUND_ID)
    await vi.waitFor(() => expect(recordIntentionPromptsMock).toHaveBeenCalled())
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(captureIntentionPromptRecordingFailedMock).not.toHaveBeenCalled()
  })

  it('persists intentions newly eligible or re-armed this turn', async () => {
    setUpSentPath()
    const newlyEligible = [
      { key: 'learn_name' as const, eligibleAt: new Date('2026-09-14T11:00:00.000Z'), rearm: false },
      { key: 'got_the_recommendation' as const, eligibleAt: new Date('2026-09-14T10:00:00.000Z'), rearm: true },
    ]
    buildRuntimeContextMock.mockResolvedValue(
      makeCtx({ intentionDerivation: { newlyEligible, brakeEngaged: false } }),
    )
    await handleInbound(INBOUND_ID)
    expect(recordIntentionEligibilityMock).toHaveBeenCalledWith({
      venueId: VENUE_ID,
      guestId: GUEST_ID,
      entries: newlyEligible,
    })
  })

  it('never calls recordIntentionEligibility when nothing is newly eligible', async () => {
    setUpSentPath()
    await handleInbound(INBOUND_ID)
    expect(recordIntentionEligibilityMock).not.toHaveBeenCalled()
  })

  // An eligibility row starts an expiry window. Opening windows for a guest who
  // just asked to stop being contacted records intent to pursue them on the one
  // turn nothing should be. The send is asserted so "not called" can't pass
  // because the run ended before reaching the write.
  it('does not record eligibility on an opt_out turn', async () => {
    setUpSentPath()
    classifyStageMock.mockResolvedValue({
      category: 'opt_out',
      classifierConfidence: 0.99,
      reasoning: 'stop',
      crisisSafety: false,
    })
    buildRuntimeContextMock.mockResolvedValue(
      makeCtx({
        intentionDerivation: {
          newlyEligible: [{ key: 'learn_name', eligibleAt: new Date('2026-09-14T11:00:00.000Z'), rearm: false }],
          brakeEngaged: false,
        },
      }),
    )
    await handleInbound(INBOUND_ID)
    expect(scheduleAndSendMock).toHaveBeenCalled()
    expect(recordIntentionEligibilityMock).not.toHaveBeenCalled()
  })

  it('does not record eligibility on a crisis-safety turn', async () => {
    classifyStageMock.mockResolvedValue({
      category: 'casual_chatter',
      classifierConfidence: 0.8,
      reasoning: 'mock',
      crisisSafety: true,
    })
    scheduleAndSendMock.mockResolvedValue({ outboundMessageId: 'crisis-1', providerMessageId: 'p' })
    buildRuntimeContextMock.mockResolvedValue(
      makeCtx({
        intentionDerivation: {
          newlyEligible: [{ key: 'learn_name', eligibleAt: new Date('2026-09-14T11:00:00.000Z'), rearm: false }],
          brakeEngaged: false,
        },
      }),
    )
    const r = await handleInbound(INBOUND_ID)
    expect(r).toMatchObject({ status: 'sent', outboundMessageId: 'crisis-1' })
    expect(recordIntentionEligibilityMock).not.toHaveBeenCalled()
  })
})

describe('handleInbound — crisis-safety short circuit (TAC-348)', () => {
  it('sends the fixed reply directly, skipping retrieval, generation, and the approval gate', async () => {
    classifyStageMock.mockResolvedValueOnce({
      category: 'casual_chatter',
      classifierConfidence: 0.8,
      reasoning: 'mock',
      crisisSafety: true,
    })
    scheduleAndSendMock.mockResolvedValue({
      outboundMessageId: 'crisis-1',
      providerMessageId: 'p',
    })
    const r = await handleInbound(INBOUND_ID)
    expect(r).toMatchObject({ status: 'sent', outboundMessageId: 'crisis-1' })
    expect(retrieveCorpusStageMock).not.toHaveBeenCalled()
    expect(generateStageMock).not.toHaveBeenCalled()
    expect(applyApprovalPolicyStageMock).not.toHaveBeenCalled()
  })

  it('dispatches the exact fixed body via scheduleAndSend, skipping the read receipt and typing beats and stamping review_reason', async () => {
    classifyStageMock.mockResolvedValueOnce({
      category: 'unknown',
      classifierConfidence: 0.5,
      reasoning: 'mock',
      crisisSafety: true,
    })
    scheduleAndSendMock.mockResolvedValue({ outboundMessageId: 'crisis-2', providerMessageId: 'p' })
    await handleInbound(INBOUND_ID)
    expect(scheduleAndSendMock).toHaveBeenCalledTimes(1)
    const [, result, options] = scheduleAndSendMock.mock.calls[0] as [
      unknown,
      { body: string },
      { skipHumanFeelDelay?: boolean; reviewReason?: string },
    ]
    expect(result.body).toContain('911')
    expect(result.body).toContain('988')
    expect(options).toMatchObject({ skipHumanFeelDelay: true, reviewReason: 'crisis_safety_reply' })
  })

  it('fires captureCrisisSafetyReplySent on a successful send', async () => {
    classifyStageMock.mockResolvedValueOnce({
      category: 'comp_complaint',
      classifierConfidence: 0.7,
      reasoning: 'mock',
      crisisSafety: true,
    })
    scheduleAndSendMock.mockResolvedValue({ outboundMessageId: 'crisis-3', providerMessageId: 'p' })
    await handleInbound(INBOUND_ID)
    expect(captureCrisisSafetyReplySentMock).toHaveBeenCalledWith(
      expect.objectContaining({
        venueId: VENUE_ID,
        guestId: GUEST_ID,
        outboundMessageId: 'crisis-3',
        category: 'comp_complaint',
      }),
    )
  })

  it('does not fire when crisisSafety is false — normal pipeline runs unchanged', async () => {
    // Default beforeEach classifyStageMock already sets crisisSafety: false.
    generateStageMock.mockResolvedValue({ status: 'success', result: successResult() })
    applyApprovalPolicyStageMock.mockResolvedValue({ action: 'send' })
    scheduleAndSendMock.mockResolvedValue({ outboundMessageId: 'normal-1', providerMessageId: 'p' })
    const r = await handleInbound(INBOUND_ID)
    expect(r).toMatchObject({ status: 'sent', outboundMessageId: 'normal-1' })
    expect(generateStageMock).toHaveBeenCalledTimes(1)
    expect(captureCrisisSafetyReplySentMock).not.toHaveBeenCalled()
  })

  it('maps a scheduleAndSend failure to status failed, stage send', async () => {
    classifyStageMock.mockResolvedValueOnce({
      category: 'unknown',
      classifierConfidence: 0.5,
      reasoning: 'mock',
      crisisSafety: true,
    })
    scheduleAndSendMock.mockRejectedValue(new Error('sendblue down'))
    const r = await handleInbound(INBOUND_ID)
    expect(r).toMatchObject({ status: 'failed', stage: 'send' })
  })
})

// TAC-350: code-review follow-up. Every other test in this file relies on
// verifyGroundingStageMock's default (null) — nothing previously asserted
// that a NON-null finding actually reaches applyApprovalPolicyStage's third
// argument. Without this test, a future refactor that dropped
// `groundingBackstop` from the handleInbound call site would silently
// disable the backstop for all live inbound traffic while every other test
// in this file (and every pure-function test in stages.test.ts) kept passing.
// TAC-495: the inbound row's channel is what picks the channel copy, so it has
// to reach buildRuntimeContext intact. Two halves, because the supabase mock
// above ignores its select() argument: the behavioural test proves the row's
// value is carried through and parsed, the source test proves the column is
// actually selected. Without the second, dropping `channel` from the select
// would pass every test here while every real inbound arrived as unknown.
describe('handleInbound — the inbound message carries its channel (TAC-495)', () => {
  it('hands the row\'s channel to buildRuntimeContext on the current message', async () => {
    inboundSingleMock.mockResolvedValue({
      data: {
        id: INBOUND_ID,
        body: 'hi',
        provider_message_id: 'p1',
        created_at: new Date().toISOString(),
        venue_id: VENUE_ID,
        guest_id: GUEST_ID,
        direction: 'inbound',
        channel: 'instagram',
      },
      error: null,
    })
    generateStageMock.mockResolvedValue(GEN_FAILED)

    await handleInbound(INBOUND_ID)

    expect(buildRuntimeContextMock).toHaveBeenCalledWith(
      expect.objectContaining({
        currentMessage: expect.objectContaining({ channel: 'instagram' }),
      }),
    )
  })

  it('passes an unrecognized channel through as null, never as text', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    inboundSingleMock.mockResolvedValue({
      data: {
        id: INBOUND_ID,
        body: 'hi',
        provider_message_id: 'p1',
        created_at: new Date().toISOString(),
        venue_id: VENUE_ID,
        guest_id: GUEST_ID,
        direction: 'inbound',
        channel: 'sms',
      },
      error: null,
    })
    generateStageMock.mockResolvedValue(GEN_FAILED)

    await handleInbound(INBOUND_ID)

    expect(buildRuntimeContextMock).toHaveBeenCalledWith(
      expect.objectContaining({
        currentMessage: expect.objectContaining({ channel: null }),
      }),
    )
    warn.mockRestore()
  })

  it('selects the channel column when loading the inbound row', () => {
    const src = readFileSync(join(__dirname, 'handle-inbound.ts'), 'utf-8')
    const load = src.slice(src.indexOf('async function loadInbound('), src.indexOf('async function findExistingReply('))
    expect(load).toMatch(/\.select\('[^']*\bchannel\b[^']*'\)/)
    expect(load).toContain('channel: parseMessageChannel(data.channel),')
  })
})

// TAC-518: the referral on THIS TURN's row is the only way a returning guest's
// scan can be seen — created_via is stamped once, at guest creation, and says
// nothing about a guest who scanned again today. Same two halves as the block
// above, and for the same reason: the supabase mock ignores its select()
// argument, so a behavioural test alone would keep passing with the column
// dropped and every real scan arriving as "no referral".
describe('handleInbound — the inbound message carries its referral (TAC-518)', () => {
  function inboundRow(referralSource: string | null) {
    return {
      data: {
        id: INBOUND_ID,
        body: 'hi',
        provider_message_id: 'p1',
        created_at: new Date().toISOString(),
        venue_id: VENUE_ID,
        guest_id: GUEST_ID,
        direction: 'inbound',
        channel: 'instagram',
        referral_source: referralSource,
      },
      error: null,
    }
  }

  it("hands the row's referral_source to buildRuntimeContext on the current message", async () => {
    inboundSingleMock.mockResolvedValue(inboundRow('SHORTLINK'))
    generateStageMock.mockResolvedValue(GEN_FAILED)

    await handleInbound(INBOUND_ID)

    expect(buildRuntimeContextMock).toHaveBeenCalledWith(
      expect.objectContaining({
        currentMessage: expect.objectContaining({ referralSource: 'SHORTLINK' }),
      }),
    )
  })

  // Raw, not pre-judged: isScanReferral stays the one place that decides what
  // counts, so a source Meta adds later is decided in one file rather than
  // silently collapsed to a boolean here.
  it('passes a non-scan source through verbatim rather than flattening it', async () => {
    inboundSingleMock.mockResolvedValue(inboundRow('ADS'))
    generateStageMock.mockResolvedValue(GEN_FAILED)

    await handleInbound(INBOUND_ID)

    expect(buildRuntimeContextMock).toHaveBeenCalledWith(
      expect.objectContaining({
        currentMessage: expect.objectContaining({ referralSource: 'ADS' }),
      }),
    )
  })

  it('carries a null referral through as null', async () => {
    inboundSingleMock.mockResolvedValue(inboundRow(null))
    generateStageMock.mockResolvedValue(GEN_FAILED)

    await handleInbound(INBOUND_ID)

    expect(buildRuntimeContextMock).toHaveBeenCalledWith(
      expect.objectContaining({
        currentMessage: expect.objectContaining({ referralSource: null }),
      }),
    )
  })

  it('selects the referral_source column when loading the inbound row', () => {
    const src = readFileSync(join(__dirname, 'handle-inbound.ts'), 'utf-8')
    const load = src.slice(src.indexOf('async function loadInbound('), src.indexOf('async function findExistingReply('))
    expect(load).toMatch(/\.select\('[^']*\breferral_source\b[^']*'\)/)
    expect(load).toContain('referralSource: data.referral_source,')
  })
})

// TAC-367. The positive half of the pair whose negatives live in
// handle-holding-message.test.ts and handle-followup.test.ts: inbound SHOULD
// retrieve, outbound should not. Stating it here makes the distinction a
// tested property rather than three separate local decisions, and it is the
// assertion that would have caught the `() => false` stub this file carried.
describe('handleInbound — knowledge retrieval (TAC-367)', () => {
  it('retrieves knowledge and threads the chunks onto the context', async () => {
    generateStageMock.mockResolvedValue({ status: 'success', result: successResult() })
    applyApprovalPolicyStageMock.mockResolvedValue({ action: 'send' })
    scheduleAndSendMock.mockResolvedValue({ outboundMessageId: 'sent-k', providerMessageId: 'p' })

    await handleInbound(INBOUND_ID)

    expect(retrieveKnowledgeStageMock).toHaveBeenCalledTimes(1)
    const ctx = generateStageMock.mock.calls[0][0] as { knowledgeCorpus: unknown[] }
    expect(ctx.knowledgeCorpus).toHaveLength(1)
  })
})

describe('handleInbound — grounding backstop wiring (TAC-350)', () => {
  it('threads a non-null verifyGroundingStage finding into applyApprovalPolicyStage as the third argument', async () => {
    generateStageMock.mockResolvedValue({ status: 'success', result: successResult() })
    verifyGroundingStageMock.mockResolvedValueOnce({
      status: 'flagged',
      claims: ['invents a wifi network name not in venue facts'],
    })
    applyApprovalPolicyStageMock.mockResolvedValue({
      action: 'queue',
      triggers: [APPROVAL_TRIGGERS.KNOWLEDGE_GAP_BACKSTOP],
      primaryTrigger: APPROVAL_TRIGGERS.KNOWLEDGE_GAP_BACKSTOP,
      compMatchedPattern: null,
      // TAC-364: the gate ALWAYS returns this on a queue decision (it is
      // required on ApprovalDecision), so a fixture omitting it would feed
      // `undefined` down a path production never produces. null is what a
      // followup / skipped-check turn actually carries — see ruling 3.
      ungroundedClaims: null,
      existingPendingDraftId: null,
      pendingUntil: new Date(),
      blankBody: true,
    })

    await handleInbound(INBOUND_ID)

    expect(applyApprovalPolicyStageMock).toHaveBeenCalledTimes(1)
    const [, , groundingBackstopArg] = applyApprovalPolicyStageMock.mock.calls[0]
    expect(groundingBackstopArg).toEqual({
      status: 'flagged',
      claims: ['invents a wifi network name not in venue facts'],
    })
  })

  // TAC-401. The orchestrator hop for the prose-promise check, and it is the
  // assertion whose absence let the carrier never reach the card at all: the
  // check ran, fired its event and its Slack relay, and the promise auto-sent,
  // with the whole suite green. Mutant: pass `{ status: 'skipped' }` to
  // applyApprovalPolicyStage instead of the stage's result.
  it('threads the prose-promise verdict through to applyApprovalPolicyStage', async () => {
    generateStageMock.mockResolvedValue({ status: 'success', result: successResult() })
    verifyProsePromiseStageMock.mockResolvedValueOnce({
      status: 'flagged',
      commitment: {
        type: 'comp',
        description: 'a replacement cortado',
        code: 'A1B2',
        expiresAt: null,
      },
    })
    applyApprovalPolicyStageMock.mockResolvedValue({ action: 'send' })
    scheduleAndSendMock.mockResolvedValue({ outboundMessageId: 'sent-p', providerMessageId: 'p' })

    await handleInbound(INBOUND_ID)

    const [, , , , prosePromiseArg] = applyApprovalPolicyStageMock.mock.calls[0]
    expect(prosePromiseArg).toEqual({
      status: 'flagged',
      commitment: {
        type: 'comp',
        description: 'a replacement cortado',
        code: 'A1B2',
        expiresAt: null,
      },
    })
  })

  // TAC-401. THE acceptance criterion: the commitment the check named has to
  // reach the row, or the promise is caught and still untracked. Asserted on
  // the persist call's options rather than on a returned value, because the
  // persist layer is mocked here and a mock returns its fixture whatever it is
  // handed — the TAC-385 mutant, which is exactly how this shipped broken the
  // first time.
  it('passes the named commitment into the persist options', async () => {
    const commitment = {
      type: 'comp' as const,
      description: 'a replacement cortado',
      code: 'A1B2',
      expiresAt: null,
    }
    generateStageMock.mockResolvedValue({ status: 'success', result: successResult() })
    verifyProsePromiseStageMock.mockResolvedValueOnce({ status: 'flagged', commitment })
    applyApprovalPolicyStageMock.mockResolvedValue({
      action: 'queue',
      triggers: ['prose_promise_backstop'],
      primaryTrigger: 'prose_promise_backstop',
      ungroundedClaims: [],
      compMatchedPattern: null,
      existingPendingDraftId: null,
      slot: 'obligation',
      otherSlotOccupied: false,
      blankBody: false,
      promisedCommitment: commitment,
    })
    persistOrRegenQueuedDraftMock.mockResolvedValue({
      outboundMessageId: 'card-1',
      action: 'inserted',
      priorReviewReason: null,
    })

    await handleInbound(INBOUND_ID)

    expect(persistOrRegenQueuedDraftMock).toHaveBeenCalledTimes(1)
    const [, , , , options] = persistOrRegenQueuedDraftMock.mock.calls[0]
    expect(options.promisedCommitment).toEqual(commitment)
  })

  it('passes the skipped state through when the backstop finds nothing', async () => {
    generateStageMock.mockResolvedValue({ status: 'success', result: successResult() })
    applyApprovalPolicyStageMock.mockResolvedValue({ action: 'send' })
    scheduleAndSendMock.mockResolvedValue({ outboundMessageId: 'sent-2', providerMessageId: 'p' })

    await handleInbound(INBOUND_ID)

    expect(verifyGroundingStageMock).toHaveBeenCalledTimes(1)
    const [, , groundingBackstopArg] = applyApprovalPolicyStageMock.mock.calls[0]
    expect(groundingBackstopArg).toEqual({ status: 'skipped' })
  })

  // TAC-367: the truncated state has to survive the orchestrator hop. It is
  // the only grounding state that changes the send/queue outcome without
  // carrying any payload, so a hop that flattened it to 'skipped' would look
  // correct everywhere and silently restore fail-open.
  it('threads the truncated state through to applyApprovalPolicyStage', async () => {
    generateStageMock.mockResolvedValue({ status: 'success', result: successResult() })
    verifyGroundingStageMock.mockResolvedValueOnce({ status: 'truncated' })
    applyApprovalPolicyStageMock.mockResolvedValue({
      action: 'queue',
      triggers: [APPROVAL_TRIGGERS.GROUNDING_CHECK_FAILED],
      primaryTrigger: APPROVAL_TRIGGERS.GROUNDING_CHECK_FAILED,
      compMatchedPattern: null,
      // TAC-364: the gate ALWAYS returns this on a queue decision (it is
      // required on ApprovalDecision), so a fixture omitting it would feed
      // `undefined` down a path production never produces. null is what a
      // followup / skipped-check turn actually carries — see ruling 3.
      ungroundedClaims: null,
      existingPendingDraftId: null,
      blankBody: false,
    })

    await handleInbound(INBOUND_ID)

    const [, , groundingBackstopArg] = applyApprovalPolicyStageMock.mock.calls[0]
    expect(groundingBackstopArg).toEqual({ status: 'truncated' })
  })

  // TAC-424: the same threading assertion for the state this ticket added.
  // `degraded` is the one whose whole point is that it USED to arrive as
  // `clean`, so a hop that flattened it would restore the exact defect and
  // look correct everywhere — the gate would queue nothing and the row would
  // record a pass.
  it('threads the degraded state through to applyApprovalPolicyStage', async () => {
    generateStageMock.mockResolvedValue({ status: 'success', result: successResult() })
    verifyGroundingStageMock.mockResolvedValueOnce({ status: 'degraded' })
    applyApprovalPolicyStageMock.mockResolvedValue({
      action: 'queue',
      triggers: [
        APPROVAL_TRIGGERS.GROUNDING_CHECK_FAILED,
        APPROVAL_TRIGGERS.GROUNDING_CHECK_DEGRADED,
      ],
      primaryTrigger: APPROVAL_TRIGGERS.GROUNDING_CHECK_FAILED,
      compMatchedPattern: null,
      ungroundedClaims: null,
      existingPendingDraftId: null,
      blankBody: false,
    })

    await handleInbound(INBOUND_ID)

    const [, , groundingBackstopArg] = applyApprovalPolicyStageMock.mock.calls[0]
    expect(groundingBackstopArg).toEqual({ status: 'degraded' })
    expect(scheduleAndSendMock).not.toHaveBeenCalled()
  })

  // TAC-367: an unexpected throw is OUR bug, not evidence about the reply.
  // It must degrade to 'skipped', never to the fail-closed 'truncated' —
  // otherwise any future defect in this stage becomes a fleet-wide queue
  // flood rather than a logged degradation.
  it('degrades an unexpected throw to skipped, not to truncated', async () => {
    generateStageMock.mockResolvedValue({ status: 'success', result: successResult() })
    verifyGroundingStageMock.mockRejectedValueOnce(new Error('unexpected throw'))
    applyApprovalPolicyStageMock.mockResolvedValue({ action: 'send' })
    scheduleAndSendMock.mockResolvedValue({ outboundMessageId: 'sent-3', providerMessageId: 'p' })

    await handleInbound(INBOUND_ID)

    const [, , groundingBackstopArg] = applyApprovalPolicyStageMock.mock.calls[0]
    expect(groundingBackstopArg).toEqual({ status: 'skipped' })
  })
})

describe('handleInbound — mechanic-offer backstop wiring (TAC-355)', () => {
  it('threads a "flagged" verifyMechanicOfferStage result into applyApprovalPolicyStage as the fourth argument', async () => {
    generateStageMock.mockResolvedValue({ status: 'success', result: successResult() })
    verifyMechanicOfferStageMock.mockResolvedValueOnce({ status: 'flagged', mechanicId: 'mech-1' })
    applyApprovalPolicyStageMock.mockResolvedValue({
      action: 'queue',
      triggers: [APPROVAL_TRIGGERS.MECHANIC_OFFER_BACKSTOP],
      primaryTrigger: APPROVAL_TRIGGERS.MECHANIC_OFFER_BACKSTOP,
      compMatchedPattern: null,
      // TAC-364: the gate ALWAYS returns this on a queue decision (it is
      // required on ApprovalDecision), so a fixture omitting it would feed
      // `undefined` down a path production never produces. null is what a
      // followup / skipped-check turn actually carries — see ruling 3.
      ungroundedClaims: null,
      existingPendingDraftId: null,
      blankBody: false,
    })

    await handleInbound(INBOUND_ID)

    expect(verifyMechanicOfferStageMock).toHaveBeenCalledTimes(1)
    expect(applyApprovalPolicyStageMock).toHaveBeenCalledTimes(1)
    const [, , , mechanicOfferBackstopArg] = applyApprovalPolicyStageMock.mock.calls[0]
    expect(mechanicOfferBackstopArg).toEqual({ status: 'flagged', mechanicId: 'mech-1' })
  })

  it('runs verifyGroundingStage and verifyMechanicOfferStage concurrently, both threaded through on a clean turn', async () => {
    generateStageMock.mockResolvedValue({ status: 'success', result: successResult() })
    applyApprovalPolicyStageMock.mockResolvedValue({ action: 'send' })
    scheduleAndSendMock.mockResolvedValue({ outboundMessageId: 'sent-3', providerMessageId: 'p' })

    await handleInbound(INBOUND_ID)

    expect(verifyGroundingStageMock).toHaveBeenCalledTimes(1)
    expect(verifyMechanicOfferStageMock).toHaveBeenCalledTimes(1)
    const [, , groundingBackstopArg, mechanicOfferBackstopArg] =
      applyApprovalPolicyStageMock.mock.calls[0]
    expect(groundingBackstopArg).toEqual({ status: 'skipped' })
    expect(mechanicOfferBackstopArg).toEqual({ status: 'skipped' })
  })

  // [Operator follow-up] verifyGroundingStage and verifyMechanicOfferStage
  // are proven never to throw (every call inside each is independently
  // try/catch-safe — see the code comment at the Promise.allSettled call
  // site), but that invariant lives in other files. These two tests prove
  // the COMPOSITION itself degrades safely if that invariant were ever
  // violated: allSettled means one stage rejecting does not discard the
  // other stage's real finding, and each one's rejection degrades to
  // the orchestrator's own documented degradation for that stage.
  //
  // TAC-424 corrects this comment, which was wrong in both halves and named a
  // return value ('null') that stage has not produced since TAC-367. The
  // degradations are 'skipped' for grounding and 'check_failed' for
  // mechanic-offer, and they are NOT symmetric: the mechanic-offer one queues,
  // while grounding's 'skipped' is a pass-through to send. That asymmetry is
  // deliberate — a throw in our own code is not evidence about the reply — but
  // it is the one path left where an unchecked reply reaches a guest, so do
  // not read these two tests as proving nothing can.
  it('does not lose the mechanic-offer finding if verifyGroundingStage unexpectedly throws', async () => {
    generateStageMock.mockResolvedValue({ status: 'success', result: successResult() })
    verifyGroundingStageMock.mockRejectedValueOnce(new Error('unexpected throw'))
    verifyMechanicOfferStageMock.mockResolvedValueOnce({ status: 'flagged', mechanicId: 'mech-1' })
    applyApprovalPolicyStageMock.mockResolvedValue({
      action: 'queue',
      triggers: [APPROVAL_TRIGGERS.MECHANIC_OFFER_BACKSTOP],
      primaryTrigger: APPROVAL_TRIGGERS.MECHANIC_OFFER_BACKSTOP,
      compMatchedPattern: null,
      // TAC-364: the gate ALWAYS returns this on a queue decision (it is
      // required on ApprovalDecision), so a fixture omitting it would feed
      // `undefined` down a path production never produces. null is what a
      // followup / skipped-check turn actually carries — see ruling 3.
      ungroundedClaims: null,
      existingPendingDraftId: null,
      blankBody: false,
    })

    await handleInbound(INBOUND_ID)

    expect(applyApprovalPolicyStageMock).toHaveBeenCalledTimes(1)
    const [, , groundingBackstopArg, mechanicOfferBackstopArg] =
      applyApprovalPolicyStageMock.mock.calls[0]
    expect(groundingBackstopArg).toEqual({ status: 'skipped' })
    expect(mechanicOfferBackstopArg).toEqual({ status: 'flagged', mechanicId: 'mech-1' })
  })

  it('degrades to check_failed (still queues) if verifyMechanicOfferStage unexpectedly throws', async () => {
    generateStageMock.mockResolvedValue({ status: 'success', result: successResult() })
    verifyGroundingStageMock.mockResolvedValueOnce({ status: 'skipped' })
    verifyMechanicOfferStageMock.mockRejectedValueOnce(new Error('unexpected throw'))
    applyApprovalPolicyStageMock.mockResolvedValue({
      action: 'queue',
      triggers: [APPROVAL_TRIGGERS.MECHANIC_OFFER_BACKSTOP],
      primaryTrigger: APPROVAL_TRIGGERS.MECHANIC_OFFER_BACKSTOP,
      compMatchedPattern: null,
      // TAC-364: the gate ALWAYS returns this on a queue decision (it is
      // required on ApprovalDecision), so a fixture omitting it would feed
      // `undefined` down a path production never produces. null is what a
      // followup / skipped-check turn actually carries — see ruling 3.
      ungroundedClaims: null,
      existingPendingDraftId: null,
      blankBody: false,
    })

    await handleInbound(INBOUND_ID)

    expect(applyApprovalPolicyStageMock).toHaveBeenCalledTimes(1)
    const [, , , mechanicOfferBackstopArg] = applyApprovalPolicyStageMock.mock.calls[0]
    expect(mechanicOfferBackstopArg).toEqual({ status: 'check_failed' })
  })
})

// ---------------------------------------------------------------------------
// TAC-385 PR 1: the rendered set reaches the QUEUED card too
// ---------------------------------------------------------------------------
//
// Before this, only the auto-send path recorded intentions. A queued card an
// operator later approved or edited reached the guest and recorded nothing —
// 13 of 34 sent replies at Le Mil's in the 30 days to 2026-09-14.
//
// The fix is a single renderableIntentions(...) call hoisted above the
// queue/send fork, so what a card STORES and what an auto-send RECORDS are the
// same value by construction. The first test below proves that equivalence
// BEHAVIOURALLY rather than by counting call sites in the source: it runs the
// same context down both branches and compares the two.
describe('handleInbound — rendered intentions on the queue path (TAC-385)', () => {
  const UNDERSTAND = {
    key: 'understand_order' as const,
    promptLine: "You haven't heard what this guest ordered yet.",
    eligibleAt: new Date('2026-09-13T12:00:00.000Z'),
  }
  const LEARN_NAME = {
    key: 'learn_name' as const,
    promptLine: "You don't know this guest's name yet.",
    eligibleAt: new Date('2026-09-10T12:00:00.000Z'),
  }

  function setUpSend() {
    generateStageMock.mockResolvedValue({ status: 'success', result: successResult() })
    applyApprovalPolicyStageMock.mockResolvedValue({ action: 'send' })
    scheduleAndSendMock.mockResolvedValue({
      outboundMessageId: 'sent-1',
      providerMessageId: 'p',
    })
  }

  function setUpQueue() {
    generateStageMock.mockResolvedValue({ status: 'success', result: successResult() })
    applyApprovalPolicyStageMock.mockResolvedValue({
      action: 'queue',
      triggers: ['model_flagged'],
      primaryTrigger: 'model_flagged',
      existingPendingDraftId: null,
    })
  }

  // THE EQUIVALENCE. Two runs over one context: the queued card's stored set
  // must equal the auto-send's recorded set. A second, independently-derived
  // renderableIntentions call in either branch fails this the moment the two
  // disagree, which is the failure a call-site count is only a proxy for.
  it('stores on a queued card exactly what an auto-send would record', async () => {
    const openIntentions = [UNDERSTAND, LEARN_NAME]
    buildRuntimeContextMock.mockResolvedValue(makeCtx({ openIntentions }))

    setUpQueue()
    await handleInbound(INBOUND_ID)
    const [, , , , queueOpts] = persistOrRegenQueuedDraftMock.mock.calls[0]

    setUpSend()
    await handleInbound(INBOUND_ID)
    const recorded = recordIntentionPromptsMock.mock.calls[0][0].openIntentions

    expect(queueOpts.renderedIntentions).toEqual(recorded)
    expect(queueOpts.renderedIntentions).toEqual(openIntentions)
  })

  it('passes the rendered set to the queue persist', async () => {
    setUpQueue()
    buildRuntimeContextMock.mockResolvedValue(makeCtx({ openIntentions: [UNDERSTAND] }))

    const r = await handleInbound(INBOUND_ID)

    expect(r).toMatchObject({ status: 'queued' })
    const [, , , , opts] = persistOrRegenQueuedDraftMock.mock.calls[0]
    expect(opts.renderedIntentions).toEqual([UNDERSTAND])
  })

  // renderableIntentions suppresses on opt_out (TAC-328). A suppressed turn
  // must store nothing, or an operator approving that card would record an
  // intention against a reply to someone asking to stop being contacted.
  it('stores an empty set when the turn suppresses intentions', async () => {
    setUpQueue()
    // The orchestrator overwrites ctx.classification from classifyStage, so
    // the category has to come from the STAGE, not the context fixture.
    classifyStageMock.mockResolvedValue({
      category: 'opt_out',
      classifierConfidence: 0.99,
      reasoning: 'stop',
      crisisSafety: false,
    })
    buildRuntimeContextMock.mockResolvedValue(makeCtx({ openIntentions: [UNDERSTAND] }))

    await handleInbound(INBOUND_ID)

    const [, , , , opts] = persistOrRegenQueuedDraftMock.mock.calls[0]
    expect(opts.renderedIntentions).toEqual([])
  })

  // REVERSED by TAC-423, the write-time half of the change above. A queued
  // opener draft now STORES its rendered set, so an operator who approves it
  // records the ask the auto-send path records. Both halves move together
  // because both read one hoisted value in handle-inbound.ts.
  it('stores the rendered set on the true opener turn of a qr_scan guest (TAC-423)', async () => {
    setUpQueue()
    buildRuntimeContextMock.mockResolvedValue(
      makeCtx({
        openIntentions: [UNDERSTAND],
        guest: {
          id: GUEST_ID,
          phoneNumber: '+15555550123',
          firstName: null,
          createdAt: new Date(),
          createdVia: 'qr_scan',
          isDemo: false,
          context: {},
          lastVisitAt: null,
        },
        recentMessages: [],
      }),
    )

    await handleInbound(INBOUND_ID)

    const [, , , , opts] = persistOrRegenQueuedDraftMock.mock.calls[0]
    expect(opts.renderedIntentions).toEqual([UNDERSTAND])
  })
})

// TAC-469: an Instagram conversation's reply goes through the Instagram arm,
// and what it reports back decides the run's result.
describe('handleInbound — Instagram replies (TAC-469)', () => {
  const instagramCtx = () =>
    makeCtx({
      conversationChannel: 'instagram',
      guest: {
        id: GUEST_ID,
        phoneNumber: null,
        firstName: 'Sam',
        createdAt: new Date(),
        createdVia: 'inbound_message',
        isDemo: false,
        context: {},
        lastVisitAt: null,
      },
      currentMessage: {
        id: INBOUND_ID,
        providerMessageId: 'mid-in',
        body: 'do you have oat milk?',
        receivedAt: new Date(),
        channel: 'instagram',
      },
    })

  function setUpSendDecision() {
    generateStageMock.mockResolvedValue({ status: 'success', result: successResult() })
    applyApprovalPolicyStageMock.mockResolvedValue({ action: 'send' })
    buildRuntimeContextMock.mockResolvedValue(instagramCtx())
  }

  it('sends through the Instagram arm, never scheduleAndSend, with the reply check on this message', async () => {
    setUpSendDecision()
    dispatchInstagramReplyMock.mockResolvedValue({
      kind: 'sent',
      outboundMessageId: 'ig-row-1',
      providerMessageId: 'mid-1',
      generationId: 'gen-1',
      bubbleCount: 1,
      deliveredBody: 'ok',
      undelivered: null,
    })
    const r = await handleInbound(INBOUND_ID)
    expect(r).toEqual({ status: 'sent', outboundMessageId: 'ig-row-1' })
    expect(scheduleAndSendMock).not.toHaveBeenCalled()
    expect(dispatchInstagramReplyMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ replyCheck: { inboundMessageId: INBOUND_ID }, onUndelivered: 'card' }),
    )
  })

  it("a text conversation never reaches the Instagram arm", async () => {
    generateStageMock.mockResolvedValue({ status: 'success', result: successResult() })
    applyApprovalPolicyStageMock.mockResolvedValue({ action: 'send' })
    scheduleAndSendMock.mockResolvedValue({ outboundMessageId: 'sent-1', providerMessageId: 'p' })
    const r = await handleInbound(INBOUND_ID)
    expect(r).toMatchObject({ status: 'sent', outboundMessageId: 'sent-1' })
    expect(dispatchInstagramReplyMock).not.toHaveBeenCalled()
  })

  it('a reply that became a card queues the run and pushes the operator (rule 4)', async () => {
    setUpSendDecision()
    dispatchInstagramReplyMock.mockResolvedValue({ kind: 'carded', reason: 'window_closed_by_gate', cardId: 'card-7' })
    const r = await handleInbound(INBOUND_ID)
    expect(r).toEqual({
      status: 'queued',
      outboundMessageId: 'card-7',
      triggers: ['instagram_send_failed'],
      primaryTrigger: 'instagram_send_failed',
    })
    expect(sendDraftFlaggedPushMock).toHaveBeenCalledWith(
      expect.objectContaining({ draftId: 'card-7', primaryTrigger: 'instagram_send_failed' }),
    )
    // Nothing reached the guest, so nothing is recorded as asked.
    expect(recordIntentionPromptsMock).not.toHaveBeenCalled()
  })

  it('pushes for the card the rest of a split reply became', async () => {
    setUpSendDecision()
    dispatchInstagramReplyMock.mockResolvedValue({
      kind: 'sent',
      outboundMessageId: 'ig-row-1',
      providerMessageId: 'mid-1',
      generationId: 'gen-1',
      bubbleCount: 1,
      deliveredBody: 'first half',
      undelivered: { reason: 'rate_limited', cardId: 'card-8' },
    })
    const r = await handleInbound(INBOUND_ID)
    expect(r).toEqual({ status: 'sent', outboundMessageId: 'ig-row-1' })
    expect(sendDraftFlaggedPushMock).toHaveBeenCalledWith(expect.objectContaining({ draftId: 'card-8' }))
  })

  // The load-bearing half of the delivered-body fix: the RECORDER decides which
  // intentions close. An ask that sat in the message that never went out must
  // not close one.
  it('records the ask against what reached the guest, not the whole reply', async () => {
    setUpSendDecision()
    buildRuntimeContextMock.mockResolvedValue({
      ...instagramCtx(),
      openIntentions: [
        {
          key: 'learn_name',
          promptLine: "You don't know this guest's name yet.",
          eligibleAt: new Date('2026-09-13T12:00:00.000Z'),
        },
      ],
    })
    recordIntentionPromptsMock.mockResolvedValue({ kind: 'recorded', raisedKeys: [], classifierAttempts: 1 })
    dispatchInstagramReplyMock.mockResolvedValue({
      kind: 'sent',
      outboundMessageId: 'ig-row-1',
      providerMessageId: 'mid-1',
      generationId: 'gen-1',
      bubbleCount: 1,
      deliveredBody: 'first half',
      undelivered: { reason: 'rate_limited', cardId: 'card-8' },
    })
    await handleInbound(INBOUND_ID)
    expect(recordIntentionPromptsMock).toHaveBeenCalledWith(expect.objectContaining({ sentBody: 'first half' }))
    expect(captureIntentionPromptRaisedMock).toHaveBeenCalledWith(expect.objectContaining({ sentBody: 'first half' }))
  })

  it('a message staff already answered in the app sends nothing, pushes nothing, records nothing (rule 3)', async () => {
    setUpSendDecision()
    dispatchInstagramReplyMock.mockResolvedValue({ kind: 'superseded', byMessageId: 'echo-1' })
    const r = await handleInbound(INBOUND_ID)
    expect(r).toEqual({ status: 'superseded', byMessageId: 'echo-1' })
    expect(sendDraftFlaggedPushMock).not.toHaveBeenCalled()
    expect(recordIntentionPromptsMock).not.toHaveBeenCalled()
  })

  it('a reply that neither sent nor carded fails the run', async () => {
    setUpSendDecision()
    dispatchInstagramReplyMock.mockResolvedValue({ kind: 'not_sent', reason: 'window_closed_by_gate' })
    expect(await handleInbound(INBOUND_ID)).toEqual({ status: 'failed', stage: 'send', error: 'window_closed_by_gate' })
  })

  it('a reply that went out but saved no row fails at persist', async () => {
    setUpSendDecision()
    dispatchInstagramReplyMock.mockResolvedValue({ kind: 'sent_unrecorded', providerMessageId: 'mid-1', reason: 'persist_failed' })
    expect(await handleInbound(INBOUND_ID)).toEqual({ status: 'failed', stage: 'persist', error: 'persist_failed' })
  })

  // The fixed crisis body is two sentences, so on Instagram it can dispatch as
  // two messages, and the resource line is the second one. If the rest didn't
  // go out, the operator must be pushed: this is the turn where silence is
  // worst.
  it('pushes for the card when only part of the crisis-safety reply went out', async () => {
    buildRuntimeContextMock.mockResolvedValue(instagramCtx())
    classifyStageMock.mockResolvedValue({ category: 'unknown', classifierConfidence: 0.9, reasoning: 'r', crisisSafety: true })
    dispatchInstagramReplyMock.mockResolvedValue({
      kind: 'sent',
      outboundMessageId: 'crisis-ig',
      providerMessageId: 'mid-c',
      generationId: 'gen-c',
      bubbleCount: 1,
      deliveredBody: 'first half',
      undelivered: { reason: 'rate_limited', cardId: 'card-crisis' },
    })
    const r = await handleInbound(INBOUND_ID)
    expect(r).toEqual({ status: 'sent', outboundMessageId: 'crisis-ig' })
    expect(sendDraftFlaggedPushMock).toHaveBeenCalledWith(expect.objectContaining({ draftId: 'card-crisis' }))
  })

  it('exempts the crisis-safety reply from the reply check (ruled 2026-09-19)', async () => {
    buildRuntimeContextMock.mockResolvedValue(instagramCtx())
    classifyStageMock.mockResolvedValue({ category: 'unknown', classifierConfidence: 0.9, reasoning: 'r', crisisSafety: true })
    dispatchInstagramReplyMock.mockResolvedValue({
      kind: 'sent',
      outboundMessageId: 'crisis-ig',
      providerMessageId: 'mid-c',
      generationId: 'gen-c',
      bubbleCount: 1,
      deliveredBody: 'resources',
      undelivered: null,
    })
    const r = await handleInbound(INBOUND_ID)
    expect(r).toEqual({ status: 'sent', outboundMessageId: 'crisis-ig' })
    expect(dispatchInstagramReplyMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ replyCheck: 'exempt' }),
    )
  })

  it('stops a run with an unresolved channel before classifying: nothing routes on null', async () => {
    buildRuntimeContextMock.mockResolvedValue(makeCtx({ conversationChannel: null }))
    const r = await handleInbound(INBOUND_ID)
    expect(r).toMatchObject({ status: 'failed', stage: 'context_build' })
    expect(classifyStageMock).not.toHaveBeenCalled()
    expect(generateStageMock).not.toHaveBeenCalled()
    expect(scheduleAndSendMock).not.toHaveBeenCalled()
    expect(dispatchInstagramReplyMock).not.toHaveBeenCalled()
    expect(fireRedAlertMock).toHaveBeenCalledWith(expect.objectContaining({ stage: 'context_build' }))
  })
})

// ---------------------------------------------------------------------------
// TAC-513: the cancellation reaches the persist layer
// ---------------------------------------------------------------------------
//
// Every one of these is here because a mutant survived without it. The gate,
// the resolver, the CAS helper and the dispatch step were all covered; the
// WIRING between them was not, and a feature that is correct everywhere except
// where its pieces are joined is a feature that does not work.
//
// This is the repo's own recorded failure twice over: TAC-476 ("nothing tested
// the page's wiring INTO it") and TAC-385 ("the suite proved fixture-to-
// recorder plumbing, not row-to-recorder").
describe('handleInbound — cancellation carrier (TAC-513)', () => {
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

  // Kills the mutant that replaces the stage call with an inline clean result.
  // Both sibling backstops pin their own invocation this way; this one did not,
  // so the check could be disconnected from the orchestrator entirely with the
  // whole suite green.
  it('calls verifyCancellationClaimStage once per inbound', async () => {
    generateStageMock.mockResolvedValue({ status: 'success', result: successResult() })
    applyApprovalPolicyStageMock.mockResolvedValue({ action: 'send' })
    scheduleAndSendMock.mockResolvedValue({ outboundMessageId: 'sent-c1', providerMessageId: 'p' })

    await handleInbound(INBOUND_ID)

    expect(verifyCancellationClaimStageMock).toHaveBeenCalledTimes(1)
  })

  // Kills the mutant that drops `pendingCancellation` from the persist options.
  // Under it the gate resolves the cancellation correctly and the orchestrator
  // throws it away: messages.pending_cancellation is NULL, the operator
  // approves a card reading "that one's off", step 7b sees null, and the comp
  // stays open while the guest has been told it is gone. That is the
  // 2026-09-21 incident reproduced exactly, which is what this branch exists
  // to stop.
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
      triggers: [APPROVAL_TRIGGERS.COMMITMENT_CANCELLATION_GATED],
      primaryTrigger: APPROVAL_TRIGGERS.COMMITMENT_CANCELLATION_GATED,
      compMatchedPattern: null,
      ungroundedClaims: null,
      existingPendingDraftId: null,
      blankBody: false,
      pendingCancellation,
    })
    persistOrRegenQueuedDraftMock.mockResolvedValue({
      outboundMessageId: 'card-c1',
      action: 'inserted',
      priorReviewReason: null,
    })

    await handleInbound(INBOUND_ID)

    expect(persistOrRegenQueuedDraftMock).toHaveBeenCalledTimes(1)
    const [, , , , options] = persistOrRegenQueuedDraftMock.mock.calls[0]
    expect(options.pendingCancellation).toEqual(pendingCancellation)
  })

  // The degrade branch, and the reason it RECOMPUTES rather than assuming.
  // `resolveCancellation` is pure, so on an unexpected throw the orchestrator
  // can still answer the question correctly. Assuming `{ status: 'none' }`
  // instead would discard a resolvable id and hand the operator a card saying
  // the check did not run, with no carrier behind text that says a comp is off.
  it('recomputes a RESOLVED resolution when the stage unexpectedly throws', async () => {
    buildRuntimeContextMock.mockResolvedValue(makeCtx({ activeCommitments: [TONIC] }))
    generateStageMock.mockResolvedValue({
      status: 'success',
      result: { ...successResult(), cancelsCommitmentId: TONIC.id },
    })
    verifyCancellationClaimStageMock.mockRejectedValueOnce(new Error('unexpected throw'))
    applyApprovalPolicyStageMock.mockResolvedValue({
      action: 'queue',
      triggers: [APPROVAL_TRIGGERS.PROSE_CANCELLATION_CHECK_FAILED],
      primaryTrigger: APPROVAL_TRIGGERS.PROSE_CANCELLATION_CHECK_FAILED,
      compMatchedPattern: null,
      ungroundedClaims: null,
      existingPendingDraftId: null,
      blankBody: false,
    })
    persistOrRegenQueuedDraftMock.mockResolvedValue({
      outboundMessageId: 'card-c2',
      action: 'inserted',
      priorReviewReason: null,
    })

    await handleInbound(INBOUND_ID)

    const [, , , , , cancellationArg] = applyApprovalPolicyStageMock.mock.calls[0]
    expect(cancellationArg).toEqual({
      resolution: { status: 'resolved', cancellation: { commitmentId: TONIC.id }, commitment: TONIC },
      claim: 'check_failed',
    })
  })

  // The other direction, and it is why the degrade is not simply 'unresolved'.
  // On the ordinary turn the field is '', so assuming unresolved would fire
  // trigger 14 and hold a reply that says nothing about a cancellation, under
  // copy telling the operator it cancels something.
  it('recomputes NONE on a throw when the reply cancels nothing', async () => {
    generateStageMock.mockResolvedValue({ status: 'success', result: successResult() })
    verifyCancellationClaimStageMock.mockRejectedValueOnce(new Error('unexpected throw'))
    applyApprovalPolicyStageMock.mockResolvedValue({
      action: 'queue',
      triggers: [APPROVAL_TRIGGERS.PROSE_CANCELLATION_CHECK_FAILED],
      primaryTrigger: APPROVAL_TRIGGERS.PROSE_CANCELLATION_CHECK_FAILED,
      compMatchedPattern: null,
      ungroundedClaims: null,
      existingPendingDraftId: null,
      blankBody: false,
    })
    persistOrRegenQueuedDraftMock.mockResolvedValue({
      outboundMessageId: 'card-c3',
      action: 'inserted',
      priorReviewReason: null,
    })

    await handleInbound(INBOUND_ID)

    const [, , , , , cancellationArg] = applyApprovalPolicyStageMock.mock.calls[0]
    expect(cancellationArg).toEqual({ resolution: { status: 'none' }, claim: 'check_failed' })
  })
})

// TAC-363: the push fan-out.
//
// This is the delivery half of "every open obligation is surfaced when the
// guest walks in" — the dispatch returning two rows is necessary and not
// sufficient, because the operator learns about them from the push. Before
// these tests, reverting the loop to `commitmentRows.slice(0, 1)` — the
// 5Q22/ADH8 defect reinstated one layer up — passed every test in this file
// and the whole suite, because the dispatch was mocked to a fixed 'noop' and
// sendCommitmentArrivalPush was asserted nowhere.
describe('handleInbound — arrival push fan-out (TAC-363)', () => {
  const COMMITMENT_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
  const COMMITMENT_B = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'

  function commitmentRow(id: string, code: string) {
    return {
      id,
      venue_id: VENUE_ID,
      guest_id: GUEST_ID,
      type: 'comp',
      description: 'replacement cortado',
      code,
      status: 'pending_ack',
      expected_arrival: '2026-09-22T17:00:00Z',
      arrival_signal: 'imminent',
      created_at: '2026-09-20T12:00:00Z',
    }
  }

  it('pushes once per transitioned obligation, not once per arrival', async () => {
    dispatchArrivalCaptureMock.mockResolvedValue({
      kind: 'imminent_won',
      commitmentRows: [commitmentRow(COMMITMENT_A, '5Q22'), commitmentRow(COMMITMENT_B, 'ADH8')],
      failedCount: 0,
    })

    generateStageMock.mockResolvedValue({ status: 'success', result: successResult() })

    await handleInbound(INBOUND_ID)

    expect(sendCommitmentArrivalPushMock).toHaveBeenCalledTimes(2)
    expect(
      sendCommitmentArrivalPushMock.mock.calls.map(
        (c) => (c[0] as unknown as { commitmentId: string }).commitmentId,
      ),
    ).toEqual([COMMITMENT_A, COMMITMENT_B])
  })

  it('pushes nothing when the venue was closed and nothing was recorded', async () => {
    // Ruling 1(a) end to end: no row comes back, so no operator is woken at
    // 1am for an arrival that cannot happen.
    generateStageMock.mockResolvedValue({ status: 'success', result: successResult() })
    dispatchArrivalCaptureMock.mockResolvedValue({ kind: 'closed_venue_skipped' })
    await handleInbound(INBOUND_ID)
    expect(sendCommitmentArrivalPushMock).not.toHaveBeenCalled()
  })

  it('pushes nothing when the guest owes nothing an arrival can attach to', async () => {
    // Ruling 4(a): the only thing open was a recommendation.
    generateStageMock.mockResolvedValue({ status: 'success', result: successResult() })
    dispatchArrivalCaptureMock.mockResolvedValue({ kind: 'no_open_obligations' })
    await handleInbound(INBOUND_ID)
    expect(sendCommitmentArrivalPushMock).not.toHaveBeenCalled()
  })
})

describe('handleInbound — records the turn outcome (TAC-523)', () => {
  // The recorder is mocked in this file, so these assertions are the ONLY
  // thing proving the orchestrator hands it the real AgentResult. Without
  // them the mock would be a fixture agreeing with itself — the TAC-385
  // mutant, where a carrier was computed, never passed on, and every test
  // stayed green because the harness supplied the value production didn't.
  function lastRecordedCall() {
    const calls = recordInboundTurnOutcomeMock.mock.calls
    return calls[calls.length - 1]?.[0] as {
      inboundMessageId: string
      agentRunId: string
      result: unknown
    }
  }

  it('hands over the SENT result, with the outbound row id', async () => {
    applyApprovalPolicyStageMock.mockResolvedValue({ action: 'send' })
    generateStageMock.mockResolvedValue({ status: 'success', result: successResult() })
    scheduleAndSendMock.mockResolvedValue({ outboundMessageId: 'out-1', providerMessageId: 'p1' })

    const r = await handleInbound(INBOUND_ID)

    expect(r).toEqual({ status: 'sent', outboundMessageId: 'out-1' })
    expect(recordInboundTurnOutcomeMock).toHaveBeenCalledTimes(1)
    expect(lastRecordedCall()).toMatchObject({
      inboundMessageId: INBOUND_ID,
      result: { status: 'sent', outboundMessageId: 'out-1' },
    })
    expect(lastRecordedCall().agentRunId).toEqual(expect.any(String))
  })

  it('records the RUN\'s agentRunId, not a fresh one', async () => {
    // The ledger's whole value on a failure is correlating a row with the
    // PostHog event and the Langfuse trace for the same run. `expect.any(String)`
    // would pass against a freshly minted uuid, so this pins it against the id
    // the alert for the SAME turn carries.
    retrieveCorpusStageMock.mockRejectedValue(new Error('below MIN_STRONG_MATCHES'))

    await handleInbound(INBOUND_ID)

    const alerted = fireRedAlertMock.mock.calls[0][0] as { agentRunId: string }
    expect(alerted.agentRunId).toBeTruthy()
    expect(lastRecordedCall().agentRunId).toBe(alerted.agentRunId)
  })

  it('hands over a REFUSED result — the voice-fidelity floor, known path 1', async () => {
    generateStageMock.mockResolvedValue({
      status: 'refused',
      attemptScores: [0.31, 0.28],
      finalScore: 0.28,
    })

    const r = await handleInbound(INBOUND_ID)

    expect(r).toMatchObject({ status: 'refused', reason: 'low_fidelity' })
    expect(lastRecordedCall().result).toMatchObject({
      status: 'refused',
      reason: 'low_fidelity',
    })
  })

  it('hands over a FAILED result — the fail-closed corpus retrieval, known path 2', async () => {
    retrieveCorpusStageMock.mockRejectedValue(new Error('below MIN_STRONG_MATCHES'))

    const r = await handleInbound(INBOUND_ID)

    expect(r).toMatchObject({ status: 'failed', stage: 'corpus' })
    expect(lastRecordedCall().result).toMatchObject({ status: 'failed', stage: 'corpus' })
  })

  it('hands over a QUEUED result, so a card is in the ledger too', async () => {
    // The complete-ledger decision: successes are recorded, or a failure count
    // has no denominator.
    generateStageMock.mockResolvedValue({ status: 'success', result: successResult() })
    applyApprovalPolicyStageMock.mockResolvedValue({
      action: 'queue',
      triggers: ['model_flagged'],
      primaryTrigger: 'model_flagged',
    })

    const r = await handleInbound(INBOUND_ID)

    expect(r).toMatchObject({ status: 'queued', outboundMessageId: 'card-1' })
    expect(lastRecordedCall().result).toMatchObject({
      status: 'queued',
      outboundMessageId: 'card-1',
      primaryTrigger: 'model_flagged',
    })
  })

  it('records a duplicate turn, which is the one outcome that must not count as a turn', async () => {
    // Recorded so the redelivery is visible, and excluded from a strict turn
    // count by `outcome <> 'skipped_duplicate'` — see migration 055's header.
    existingReplyMaybeSingleMock.mockResolvedValue({ data: { id: 'already' }, error: null })

    const r = await handleInbound(INBOUND_ID)

    expect(r).toEqual({ status: 'skipped_duplicate' })
    expect(lastRecordedCall().result).toEqual({ status: 'skipped_duplicate' })
  })

  it('records exactly once per turn', async () => {
    applyApprovalPolicyStageMock.mockResolvedValue({ action: 'send' })
    generateStageMock.mockResolvedValue({ status: 'success', result: successResult() })
    scheduleAndSendMock.mockResolvedValue({ outboundMessageId: 'out-1', providerMessageId: 'p1' })

    await handleInbound(INBOUND_ID)

    expect(recordInboundTurnOutcomeMock).toHaveBeenCalledTimes(1)
  })

  it('RETHROWS when the orchestrator throws, and records it as unexpected', async () => {
    // The wrapper's catch branch. Code review found it had no test at all:
    // replacing `throw unexpected` with a `return` passed all 91 tests in this
    // file, because nothing else in the repo reaches it — both webhook route
    // tests mock handleInbound. Swallowing there would convert a rejected
    // promise inside waitUntil into a resolved one, so Vercel stops seeing the
    // invocation as errored, which is exactly the "swallow an exception that
    // previously did not exist" the ticket forbids.
    traceControl.flushThrows = true
    applyApprovalPolicyStageMock.mockResolvedValue({ action: 'send' })
    generateStageMock.mockResolvedValue({ status: 'success', result: successResult() })
    scheduleAndSendMock.mockResolvedValue({ outboundMessageId: 'out-1', providerMessageId: 'p1' })

    await expect(handleInbound(INBOUND_ID)).rejects.toThrow('flush failed')

    // Recorded, with no AgentResult, because the run produced none.
    expect(recordInboundTurnOutcomeMock).toHaveBeenCalledTimes(1)
    expect(lastRecordedCall()).toMatchObject({ inboundMessageId: INBOUND_ID, result: null })
  })

  it('a recorder that THROWS does not change what the guest got', async () => {
    // The wrapper's record call is guarded separately from the run. Inside the
    // same try, a throwing recorder would be caught, recorded again, and
    // rethrown — turning a reply that reached the guest into a failed request.
    // This is the mutant that catches a refactor merging the two.
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    applyApprovalPolicyStageMock.mockResolvedValue({ action: 'send' })
    generateStageMock.mockResolvedValue({ status: 'success', result: successResult() })
    scheduleAndSendMock.mockResolvedValue({ outboundMessageId: 'out-1', providerMessageId: 'p1' })
    recordInboundTurnOutcomeMock.mockRejectedValue(new Error('ledger table is gone'))

    const r = await handleInbound(INBOUND_ID)

    expect(r).toEqual({ status: 'sent', outboundMessageId: 'out-1' })
    expect(errorSpy).toHaveBeenCalled()
    errorSpy.mockRestore()
  })
})
