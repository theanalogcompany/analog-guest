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
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ActiveCommitment } from '@/lib/schemas/guest-commitment'
import type { CoalesceDeps } from './coalesce-turn'

// ./stages pulls in @/lib/rag → voyageai, whose ESM build trips vitest's
// directory-import resolver at module load. See CLAUDE.md "Module split for
// testability".
vi.mock('voyageai', () => ({ VoyageAIClient: class {} }))
vi.mock('@/lib/rag', () => ({
  loadVoicePack: vi.fn(),
  retrieveKnowledgeContext: vi.fn(),
}))

const buildRuntimeContextMock = vi.fn()
const classifyStageMock = vi.fn()
const retrieveCorpusStageMock = vi.fn()
// TAC-547: handle-inbound calls the two-arm stage. Mocked at the same seam
// the single-arm one was, because it still does real DB/Voyage work.
const retrieveKnowledgeWithContextStageMock = vi.fn()
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
// TAC-540. Resolves rather than returning undefined: handle-inbound calls
// `.catch()` on the typing_on promise, and a bare vi.fn() would throw there
// on the first call — the defect arriving through the mock, which this repo
// has already paid for once with verifyMechanicOfferStage.
const signalTypingMock = vi.fn().mockResolvedValue({ status: 'sent' })
const guestMaybeSingleMock = vi.fn()
const inboundSingleMock = vi.fn()
const existingReplyMaybeSingleMock = vi.fn()
// TAC-529: the venues read behind the halt gate. It needs its OWN mock, not
// the shape-dispatch default: `loadVenueStatus` is select().eq().maybeSingle(),
// the same shape as the existing-reply probe, so without a `venues` branch
// below it was answered by existingReplyMaybeSingleMock — which returns
// `{ data: null }`, reads as "no status", and leaves the gate unreachable
// while every test in this file passes. The third instance of this trap in
// this ticket alone.
const venueStatusMaybeSingleMock = vi.fn()

// The orchestrator makes four distinct DB reads directly: the inbound row
// (.single()), the duplicate-reply check (.limit().maybeSingle()), TAC-309's
// opt-out probe (.eq().maybeSingle()), and TAC-529's venue-status read
// (.eq().maybeSingle()). Dispatch on shape, then on table where two reads
// share a shape.
vi.mock('@/lib/db/admin', () => ({
  createAdminClient: () => ({
    from: (table: string) => ({
      select: () => ({
        eq: () => ({
          single: () => inboundSingleMock(),
          maybeSingle: () => {
            if (table === 'guests') return guestMaybeSingleMock()
            if (table === 'venues') return venueStatusMaybeSingleMock()
            return existingReplyMaybeSingleMock()
          },
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
    retrieveKnowledgeWithContextStage: (...a: unknown[]) =>
      retrieveKnowledgeWithContextStageMock(...a),
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
    // TAC-540. Passed through REAL via importOriginal rather than stubbed:
    // it is a pure predicate over the context these tests already build, and
    // a stub would be this file asserting on its own opinion of when the
    // typing dots appear. A missing entry here arrives `undefined` and throws
    // the whole turn into `failed` — which is how the allow-list announced
    // itself when this landed.
    mayAutoSendAfterClassification: actual.mayAutoSendAfterClassification,
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
  captureDashViolationPersisted: vi.fn(),
  captureDemoBypassedApprovalGate: vi.fn(),
  captureRegenerationTriggered: vi.fn(),
  captureVoiceFidelityLow: vi.fn(),
  captureGenerationTruncated: vi.fn(),
  CLASSIFICATION_CONFIDENCE_LOW_THRESHOLD: 0.7,
  CLASSIFICATION_CONFIDENCE_REROUTE_THRESHOLD: 0.3,
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
// TAC-526: the settle is a REAL wall-clock wait once the flag is on and the
// constant is nonzero — 8s originally, 3s after TAC-540, 0 today — and every
// call in this file goes through it: `handleInbound(id)` with no options takes
// the shipped gate and the default deps. Unmocked at 8s, this one file went
// from ~2s to over two minutes. The mock stays at settle=0 so a nonzero
// rollback cannot silently reintroduce that wait into the suite.
//
// ONLY `sleep` is replaced. The claim, the adopt and the extension all run for
// real against this file's mocked admin client, which has no `.insert`, so
// they fail OPEN exactly as production would when the claims table is
// unreachable — which is what keeps every assertion below describing today's
// behaviour rather than a path the mock invented. That fail-open is itself
// load-bearing: it is why flipping the flag does not change a single
// expectation in this file.
vi.mock('./coalesce-turn', async () => {
  const actual = await vi.importActual<typeof import('./coalesce-turn')>('./coalesce-turn')
  return {
    ...actual,
    defaultCoalesceDeps: () => ({ ...actual.defaultCoalesceDeps(), sleep: async () => {} }),
  }
})
vi.mock('@vercel/functions', () => ({ waitUntil: (p: unknown) => p }))
// TAC-540. The transport is a spy, so these tests see WHICH signal was sent
// and when, without a Graph call. The channel switch itself is the real one
// in typing-indicator.test.ts; what is under test here is when handle-inbound
// asks for dots and when it takes them away.
vi.mock('./typing-indicator', () => ({
  signalTyping: (...a: unknown[]) => signalTypingMock(...a),
}))
const traceControl = vi.hoisted(() => ({ flushThrows: false }))
/**
 * TAC-540 part D. Spans now RECORD when they open and close, so a test can
 * see whether each of the five checks owns its own window or whether they
 * all share the batch's. Before this the mock discarded everything, which is
 * why three spans could wrap the same `Promise.allSettled` for a year with
 * nothing to notice it.
 *
 * Ordinals rather than timestamps: two checks that finish in the same
 * millisecond are indistinguishable by clock, and what is being asserted is
 * ORDER.
 */
const spanLog = vi.hoisted(() => ({ events: [] as Array<{ name: string; phase: 'open' | 'close' }> }))
vi.mock('@/lib/observability', () => ({
  startAgentTrace: () => ({
    id: '',
    captureContent: false,
    span: (name: string) => {
      spanLog.events.push({ name, phase: 'open' })
      return {
        span: () => ({ end: () => undefined }),
        end: () => {
          spanLog.events.push({ name, phase: 'close' })
        },
        update: () => undefined,
      }
    },
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
      // TAC-540: `hours` is non-optional on VenueInfo (the schema defaults it
      // to {}), so `venueInfo: {}` was a fixture lying about a state the type
      // forbids. It went unnoticed while every real reader of it — the gate's
      // closed-venue triggers — was mocked out in this file;
      // mayAutoSendAfterClassification is the first one that actually runs
      // here. Backfilled rather than making the source defensive, the call
      // TAC-301, TAC-362 and TAC-377 each made on the same kind of helper.
      venueInfo: { hours: {} },
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
    // TAC-547: real value, not a placeholder. Left at the followup_rules
    // default so the contextual arm is reachable for any test that supplies
    // history; the shared fixture keeps an EMPTY history because several
    // tests here depend on it for firstTouchAfterQrScan.
    conversationWindowMs: 48 * 60 * 60 * 1000,
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
  // TAC-540: clearAllMocks wipes this too, and an undefined return makes
  // handle-inbound's `.catch()` on it throw.
  signalTypingMock.mockResolvedValue({ status: 'sent' })
  spanLog.events = []
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
  // An ordinary live venue. Every test that needs another status says so.
  venueStatusMaybeSingleMock.mockResolvedValue({ data: { status: 'active' }, error: null })
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
  retrieveKnowledgeWithContextStageMock.mockResolvedValue([
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
    // TAC-532: pin the WIRING, not just that a push fired. Before this, reverting
    // guestQuestion/guestCategory to null at the call site passed 1746 tests -
    // tsc forces a value, never the right one.
    expect(sendDraftFlaggedPushMock).toHaveBeenCalledWith(
      expect.objectContaining({
        draftId: 'card-1',
        guestQuestion: 'is rayan working tomorrow',
        guestIsCrisis: false,
      }),
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
    promptVersion: 'v1.70.0',
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
  /**
   * REVERSED BY TAC-540, not deleted, because the old behaviour is exactly
   * what changed and a deleted assertion leaves no record that it was ever
   * the other way.
   *
   * Corpus retrieval now STARTS beside classification, so on a crisis turn it
   * has already been called and its result is thrown away — the ticket's own
   * ruling. Generation and the approval gate are still skipped, which is what
   * the short circuit is actually for.
   *
   * The property that replaces "never called" is stronger and is the one that
   * matters here: the crisis path must not WAIT for it. See the two tests
   * below.
   */
  it('sends the fixed reply directly, skipping generation and the approval gate', async () => {
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
    // Started alongside classification, and discarded: one Voyage embed and
    // one RPC spent on a turn that does not use them, which the ticket
    // accepts in exchange for overlapping them on every ordinary turn.
    expect(retrieveCorpusStageMock).toHaveBeenCalledTimes(1)
    expect(generateStageMock).not.toHaveBeenCalled()
    expect(applyApprovalPolicyStageMock).not.toHaveBeenCalled()
  })

  /**
   * TAC-540, and the reason part C is NOT `Promise.allSettled` over the pair.
   * Awaiting both together would make the crisis reply wait for a retrieval
   * it never reads — adding latency on the one turn in this file where
   * latency is worst.
   *
   * Fails if the corpus promise is awaited before the crisis short circuit:
   * this retrieval never settles, so the whole turn would hang and the test
   * would time out rather than assert.
   */
  it('does NOT wait for the discarded retrieval before sending the crisis reply', async () => {
    classifyStageMock.mockResolvedValueOnce({
      category: 'casual_chatter',
      classifierConfidence: 0.8,
      reasoning: 'mock',
      crisisSafety: true,
    })
    retrieveCorpusStageMock.mockReturnValueOnce(new Promise(() => {}))
    scheduleAndSendMock.mockResolvedValue({
      outboundMessageId: 'crisis-3',
      providerMessageId: 'p',
    })

    const r = await handleInbound(INBOUND_ID)

    expect(r).toMatchObject({ status: 'sent', outboundMessageId: 'crisis-3' })
  }, 2000)

  /**
   * The discarded retrieval's REJECTION must not reach the crisis turn. The
   * `.then(ok, err)` claim in handle-inbound is what makes this true; without
   * it this is an unhandled rejection, and the corpus red alert would fire on
   * a turn that never consulted the corpus.
   */
  it('a retrieval that fails after the crisis short circuit changes nothing', async () => {
    classifyStageMock.mockResolvedValueOnce({
      category: 'casual_chatter',
      classifierConfidence: 0.8,
      reasoning: 'mock',
      crisisSafety: true,
    })
    retrieveCorpusStageMock.mockRejectedValueOnce(new Error('voice pack load failed'))
    scheduleAndSendMock.mockResolvedValue({
      outboundMessageId: 'crisis-4',
      providerMessageId: 'p',
    })

    const r = await handleInbound(INBOUND_ID)
    await new Promise((resolve) => setTimeout(resolve, 5))

    expect(r).toMatchObject({ status: 'sent', outboundMessageId: 'crisis-4' })
    expect(fireRedAlertMock).not.toHaveBeenCalled()
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

    // TAC-547: the property is unchanged (inbound retrieves); the stage it
    // goes through is the two-arm one now.
    expect(retrieveKnowledgeWithContextStageMock).toHaveBeenCalledTimes(1)
    const ctx = generateStageMock.mock.calls[0][0] as { knowledgeCorpus: unknown[] }
    expect(ctx.knowledgeCorpus).toHaveLength(1)
  })

  // TAC-547. Found by a code-review mutant that survived all 6973 tests:
  // handing the stage `{ ...ctx, recentMessages: [] }` makes the contextual
  // arm dead in production with nothing red. `toHaveBeenCalledTimes` says the
  // stage RAN; only this says it was given what it needs to run two arms.
  //
  // The context is SNAPSHOT INSIDE the mock, never read off
  // `mock.calls` afterwards: handleInbound mutates ctx in place, so a
  // recorded argument is a live reference and would describe the end state
  // (the TAC-389 trap).
  it('hands the stage a context carrying the conversation, not an emptied one', async () => {
    let handed: { recentMessages: unknown[]; conversationWindowMs: number } | null = null
    retrieveKnowledgeWithContextStageMock.mockImplementationOnce(async (c: unknown) => {
      const ctx = c as { recentMessages: unknown[]; conversationWindowMs: number }
      handed = {
        recentMessages: [...ctx.recentMessages],
        conversationWindowMs: ctx.conversationWindowMs,
      }
      return []
    })
    buildRuntimeContextMock.mockResolvedValue(
      makeCtx({
        recentMessages: [
          {
            direction: 'inbound',
            body: 'does the bhadra taste good',
            delivery: 'delivered',
            createdAt: new Date(Date.now() - 6 * 60_000),
          },
        ],
      }),
    )
    generateStageMock.mockResolvedValue({ status: 'success', result: successResult() })
    applyApprovalPolicyStageMock.mockResolvedValue({ action: 'send' })
    scheduleAndSendMock.mockResolvedValue({ outboundMessageId: 'sent-w', providerMessageId: 'p' })

    await handleInbound(INBOUND_ID)

    expect(handed).not.toBeNull()
    expect(handed!.recentMessages.length).toBeGreaterThan(0)
    expect(handed!.conversationWindowMs).toBeGreaterThan(0)
  })
})

// TAC-532 code review. The four push assertions in this file all covered CARD
// paths (crash, Instagram send-failure, split remainder, crisis). None covered
// the MAIN QUEUE path, which is the one that produced the incident: three
// knowledge_gap cards for one guest, three identical pushes. So reverting
// `guestQuestion`/`guestCategory` to null at that call site - a full revert of
// this ticket's deliverable at the layer that produces the defect - passed
// 1751 tests. tsc forces a value there, never the right one.
describe('handleInbound — the queued draft push carries the guest turn (TAC-532)', () => {
  it('passes the guest question and category from the context, not null', async () => {
    generateStageMock.mockResolvedValue({ status: 'success', result: successResult() })
    applyApprovalPolicyStageMock.mockResolvedValue({
      action: 'queue',
      triggers: [APPROVAL_TRIGGERS.KNOWLEDGE_GAP],
      primaryTrigger: APPROVAL_TRIGGERS.KNOWLEDGE_GAP,
      compMatchedPattern: null,
      ungroundedClaims: null,
      existingPendingDraftId: null,
      pendingUntil: new Date(),
      blankBody: true,
    })

    await handleInbound(INBOUND_ID)

    expect(sendDraftFlaggedPushMock).toHaveBeenCalledWith(
      expect.objectContaining({
        primaryTrigger: APPROVAL_TRIGGERS.KNOWLEDGE_GAP,
        guestQuestion: 'is rayan working tomorrow',
        guestCategory: 'new_question',
        guestIsCrisis: false,
      }),
    )
  })
})

// ---------------------------------------------------------------------------
// Decision 0003, rewritten 2026-09-29: the five post-generation checks are
// DEFERRED past dispatch on the inbound path.
// ---------------------------------------------------------------------------
//
// This block REVERSES (not deletes) the TAC-350/TAC-355/TAC-367/TAC-424
// wiring tests that pinned the old posture, where each verify stage ran
// between generateStage and the gate and its verdict was threaded into
// applyApprovalPolicyStage. The gate now receives the documented neutral
// values, the stages run AFTER the reply dispatches (runPostSendChecks,
// disposition 'sent'), and a queued/dropped/silenced turn runs no checks at
// all. The stages' own behaviour — retries, degrade states, event emissions
// — is covered in stages.test.ts and post-send-checks.test.ts; this file
// owns the orchestrator hops. One test carries over from the old block
// almost unchanged: the prose-promise persist-options hop, because the gate
// can still return `promisedCommitment` and the orchestrator must not drop
// it.
describe('handleInbound — deferred post-generation checks (decision 0003 rewrite)', () => {
  it('passes the neutral deferred values to the gate', async () => {
    generateStageMock.mockResolvedValue({ status: 'success', result: successResult() })
    applyApprovalPolicyStageMock.mockResolvedValue({ action: 'send' })
    scheduleAndSendMock.mockResolvedValue({ outboundMessageId: 'sent-d1', providerMessageId: 'p' })

    await handleInbound(INBOUND_ID)

    expect(applyApprovalPolicyStageMock).toHaveBeenCalledTimes(1)
    const [, , grounding, mechanicOffer, prosePromise, cancellation, closedVenue] =
      applyApprovalPolicyStageMock.mock.calls[0]
    expect(grounding).toBeNull()
    expect(mechanicOffer).toEqual({ status: 'skipped' })
    expect(prosePromise).toEqual({ status: 'skipped' })
    expect(cancellation).toEqual({ resolution: { status: 'none' }, claim: 'skipped' })
    expect(closedVenue).toEqual({ status: 'skipped' })
  })

  // The falsifiable half of "deferred": the count is snapshotted INSIDE the
  // gate mock, so a regression that moves any check back before the gate
  // fails here even though all five have been called by the end of the turn.
  it('calls no verify stage before the gate decides, and all five after the send', async () => {
    generateStageMock.mockResolvedValue({ status: 'success', result: successResult() })
    let callsAtGateTime = -1
    applyApprovalPolicyStageMock.mockImplementation(async () => {
      callsAtGateTime =
        verifyGroundingStageMock.mock.calls.length +
        verifyMechanicOfferStageMock.mock.calls.length +
        verifyProsePromiseStageMock.mock.calls.length +
        verifyCancellationClaimStageMock.mock.calls.length +
        verifyClosedVenueArrivalStageMock.mock.calls.length
      return { action: 'send' }
    })
    scheduleAndSendMock.mockResolvedValue({ outboundMessageId: 'sent-d2', providerMessageId: 'p' })

    await handleInbound(INBOUND_ID)

    expect(callsAtGateTime).toBe(0)
    expect(verifyGroundingStageMock).toHaveBeenCalledTimes(1)
    expect(verifyMechanicOfferStageMock).toHaveBeenCalledTimes(1)
    expect(verifyProsePromiseStageMock).toHaveBeenCalledTimes(1)
    expect(verifyCancellationClaimStageMock).toHaveBeenCalledTimes(1)
    expect(verifyClosedVenueArrivalStageMock).toHaveBeenCalledTimes(1)
  })

  it("runs every post-send check with disposition 'sent'", async () => {
    generateStageMock.mockResolvedValue({ status: 'success', result: successResult() })
    applyApprovalPolicyStageMock.mockResolvedValue({ action: 'send' })
    scheduleAndSendMock.mockResolvedValue({ outboundMessageId: 'sent-d3', providerMessageId: 'p' })

    await handleInbound(INBOUND_ID)

    for (const mock of [
      verifyGroundingStageMock,
      verifyMechanicOfferStageMock,
      verifyProsePromiseStageMock,
      verifyCancellationClaimStageMock,
      verifyClosedVenueArrivalStageMock,
    ]) {
      expect(mock).toHaveBeenCalledTimes(1)
      expect(mock.mock.calls[0][2]).toBe('sent')
    }
  })

  // A queued draft is already in front of an operator; drop/silence sent
  // nothing. Running the checks there would alert on text no guest ever saw.
  it('runs no checks when the gate queues', async () => {
    generateStageMock.mockResolvedValue({ status: 'success', result: successResult() })
    applyApprovalPolicyStageMock.mockResolvedValue({
      action: 'queue',
      triggers: [APPROVAL_TRIGGERS.FIDELITY_BELOW_AUTO_SEND_FLOOR],
      primaryTrigger: APPROVAL_TRIGGERS.FIDELITY_BELOW_AUTO_SEND_FLOOR,
      compMatchedPattern: null,
      ungroundedClaims: null,
      existingPendingDraftId: null,
      blankBody: false,
    })
    persistOrRegenQueuedDraftMock.mockResolvedValue({
      outboundMessageId: 'card-d1',
      action: 'inserted',
      priorReviewReason: null,
    })

    await handleInbound(INBOUND_ID)

    expect(verifyGroundingStageMock).not.toHaveBeenCalled()
    expect(verifyMechanicOfferStageMock).not.toHaveBeenCalled()
    expect(verifyProsePromiseStageMock).not.toHaveBeenCalled()
    expect(verifyCancellationClaimStageMock).not.toHaveBeenCalled()
    expect(verifyClosedVenueArrivalStageMock).not.toHaveBeenCalled()
  })

  // TAC-401's acceptance criterion, carried over from the reversed block: the
  // commitment the gate names has to reach the row, or a caught promise is
  // still untracked. On the deferred posture the inbound gate always receives
  // a 'skipped' prose check and so returns promisedCommitment null in
  // production — this pins the HOP so a posture revert cannot land on an
  // orchestrator that silently drops the carrier. Asserted on the persist
  // call's options rather than a returned value (the TAC-385 mutant).
  it('passes a gate-named commitment into the persist options', async () => {
    const commitment = {
      type: 'comp' as const,
      description: 'a replacement cortado',
      code: 'A1B2',
      expiresAt: null,
    }
    generateStageMock.mockResolvedValue({ status: 'success', result: successResult() })
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
      outboundMessageId: 'card-d2',
      action: 'inserted',
      priorReviewReason: null,
    })

    await handleInbound(INBOUND_ID)

    expect(persistOrRegenQueuedDraftMock).toHaveBeenCalledTimes(1)
    const [, , , , options] = persistOrRegenQueuedDraftMock.mock.calls[0]
    expect(options.promisedCommitment).toEqual(commitment)
  })

  // Reverses TAC-367's "degrades an unexpected throw to skipped": there is no
  // gate input left to degrade. The invariant that replaces it is that a
  // post-send throw cannot touch the already-sent reply's outcome.
  it('reports the turn sent even when a post-send check throws', async () => {
    generateStageMock.mockResolvedValue({ status: 'success', result: successResult() })
    verifyGroundingStageMock.mockRejectedValueOnce(new Error('unexpected throw'))
    applyApprovalPolicyStageMock.mockResolvedValue({ action: 'send' })
    scheduleAndSendMock.mockResolvedValue({ outboundMessageId: 'sent-d4', providerMessageId: 'p' })

    const result = await handleInbound(INBOUND_ID)

    expect(result.status).toBe('sent')
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
      expect.objectContaining({
        draftId: 'card-7',
        primaryTrigger: 'instagram_send_failed',
        guestQuestion: 'do you have oat milk?',
        guestIsCrisis: false,
      }),
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
    expect(sendDraftFlaggedPushMock).toHaveBeenCalledWith(
      expect.objectContaining({ draftId: 'card-8', guestQuestion: 'do you have oat milk?' }),
    )
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
    // TAC-532 code review, THE BLOCKER: this is the path that routes a crisis
    // turn into a push. The flag has to arrive true here, or shouldQuoteGuest
    // sees only category ('unknown' above, not comp_complaint) and the guest's
    // self-harm message is quoted onto every operator's lock screen.
    expect(sendDraftFlaggedPushMock).toHaveBeenCalledWith(
      expect.objectContaining({ draftId: 'card-crisis', guestIsCrisis: true, guestCategory: 'unknown' }),
    )
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

  // Kills the mutant that disconnects the cancellation check from the
  // post-send batch entirely. Since the decision 0003 rewrite the call this
  // pins happens AFTER dispatch (runPostSendChecks), not before the gate.
  it('calls verifyCancellationClaimStage once per sent inbound', async () => {
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

  // Decision 0003 rewrite: the LLM claim check is deferred post-send, but the
  // PURE resolution still reaches the gate inline — a draft whose emission
  // cancels a real commitment has to queue (trigger 13) whatever happens to
  // the deferred check. Reverses "recomputes a RESOLVED resolution when the
  // stage unexpectedly throws": there is no throw to recover from, because
  // the orchestrator now computes the resolution itself.
  it('passes a RESOLVED pure resolution to the gate when the reply cancels a live commitment', async () => {
    buildRuntimeContextMock.mockResolvedValue(makeCtx({ activeCommitments: [TONIC] }))
    generateStageMock.mockResolvedValue({
      status: 'success',
      result: { ...successResult(), cancelsCommitmentId: TONIC.id },
    })
    applyApprovalPolicyStageMock.mockResolvedValue({
      action: 'queue',
      triggers: [APPROVAL_TRIGGERS.COMMITMENT_CANCELLATION_GATED],
      primaryTrigger: APPROVAL_TRIGGERS.COMMITMENT_CANCELLATION_GATED,
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
      claim: 'skipped',
    })
  })

  // The other direction. On the ordinary turn the emission is empty, and the
  // gate must see NONE — not 'unresolved', which would fire trigger 16 and
  // hold a reply that says nothing about a cancellation. Reverses
  // "recomputes NONE on a throw when the reply cancels nothing".
  it('passes a NONE pure resolution to the gate on an ordinary reply', async () => {
    generateStageMock.mockResolvedValue({ status: 'success', result: successResult() })
    applyApprovalPolicyStageMock.mockResolvedValue({ action: 'send' })
    scheduleAndSendMock.mockResolvedValue({ outboundMessageId: 'sent-c3', providerMessageId: 'p' })

    await handleInbound(INBOUND_ID)

    const [, , , , , cancellationArg] = applyApprovalPolicyStageMock.mock.calls[0]
    expect(cancellationArg).toEqual({ resolution: { status: 'none' }, claim: 'skipped' })
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
    retrieveCorpusStageMock.mockRejectedValue(new Error('empty_voice_pack'))

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
    retrieveCorpusStageMock.mockRejectedValue(new Error('empty_voice_pack'))

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

// TAC-529, ruled 2026-09-23 (question 1: A). A venue is paused because
// something is wrong, and the reply path is where the damage would happen.
//
// The load-bearing assertion in most of these is that buildRuntimeContext was
// never called. It is not a proxy for "cheaper": context build runs
// computeGuestState, which WRITES guest_states and an audit row on a band
// change, so a gate placed after it would leave a switched-off venue still
// accumulating recognition state. A `status === 'venue_halted'` assertion
// alone would pass for a gate in the wrong place.
describe('handleInbound — paused and archived venues (TAC-529)', () => {
  it.each(['paused', 'archived'])('does not reply at a %s venue', async (status) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    venueStatusMaybeSingleMock.mockResolvedValue({ data: { status }, error: null })

    const r = await handleInbound(INBOUND_ID)

    expect(r).toEqual({ status: 'venue_halted', venueStatus: status })
    // Before context build, so nothing was classified, retrieved, generated
    // or written — including guest_states.
    expect(buildRuntimeContextMock).not.toHaveBeenCalled()
    expect(generateStageMock).not.toHaveBeenCalled()
    expect(scheduleAndSendMock).not.toHaveBeenCalled()
    warn.mockRestore()
  })

  // The silence has to be countable, or it is indistinguishable from a
  // swallowed reply — which is the whole reason TAC-523's ledger exists.
  it('records the turn so the silence is countable', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    venueStatusMaybeSingleMock.mockResolvedValue({ data: { status: 'paused' }, error: null })

    await handleInbound(INBOUND_ID)

    expect(recordInboundTurnOutcomeMock).toHaveBeenCalledTimes(1)
    const call = recordInboundTurnOutcomeMock.mock.calls[0]?.[0] as {
      inboundMessageId: string
      result: unknown
    }
    expect(call).toMatchObject({
      inboundMessageId: INBOUND_ID,
      result: { status: 'venue_halted', venueStatus: 'paused' },
    })
    warn.mockRestore()
  })

  // The OTHER half of the placement claim. The comment at the gate says it
  // sits before openCoalescedTurn "so a halted venue never takes a
  // conversation claim it would only release" — and nothing tested that: the
  // buildRuntimeContext assertion above covers only the context-build half,
  // so moving the gate below the coalescing block passed all 101 tests.
  //
  // It matters because coalescing is on: a gate one block later would put a
  // claim insert, release and hand-off (plus the settle sleep, whenever the
  // constant is nonzero — it was 8s when this was written) on EVERY inbound
  // at a paused venue, which is exactly the churn the placement exists to
  // avoid.
  //
  // Asserted through the injected deps rather than behaviourally, the same
  // technique handle-operator-decline.test.ts uses for its persist-not-send
  // invariant: these spies are the only way to see that a step did not run.
  it('takes no conversation claim and does not settle, at a halted venue', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    venueStatusMaybeSingleMock.mockResolvedValue({ data: { status: 'paused' }, error: null })
    const insertClaim = vi.fn()
    const readClaim = vi.fn()
    const sleep = vi.fn()
    const findNewerInbound = vi.fn()
    const deps = {
      store: {
        insertClaim,
        readClaim,
        takeOverClaim: vi.fn(),
        deleteClaim: vi.fn(),
      },
      findNewerInbound,
      now: () => new Date(),
      sleep,
    } as unknown as CoalesceDeps

    const r = await handleInbound(INBOUND_ID, { coalescing: true, coalesceDeps: deps })

    expect(r).toEqual({ status: 'venue_halted', venueStatus: 'paused' })
    expect(insertClaim).not.toHaveBeenCalled()
    expect(readClaim).not.toHaveBeenCalled()
    expect(sleep).not.toHaveBeenCalled()
    expect(findNewerInbound).not.toHaveBeenCalled()
    warn.mockRestore()
  })

  // The live-data test. Le Mil's is 'pending' in production and replies to
  // guests today; an allow-list on 'active' would have stopped it.
  it('DOES reply at a pending venue, because the live venue is pending', async () => {
    venueStatusMaybeSingleMock.mockResolvedValue({ data: { status: 'pending' }, error: null })
    applyApprovalPolicyStageMock.mockResolvedValue({ action: 'send' })
    generateStageMock.mockResolvedValue({ status: 'success', result: successResult() })
    scheduleAndSendMock.mockResolvedValue({ outboundMessageId: 'out-1', providerMessageId: 'p1' })

    const r = await handleInbound(INBOUND_ID)

    expect(r).toEqual({ status: 'sent', outboundMessageId: 'out-1' })
    expect(buildRuntimeContextMock).toHaveBeenCalled()
  })

  it('replies at an active venue', async () => {
    venueStatusMaybeSingleMock.mockResolvedValue({ data: { status: 'active' }, error: null })
    applyApprovalPolicyStageMock.mockResolvedValue({ action: 'send' })
    generateStageMock.mockResolvedValue({ status: 'success', result: successResult() })
    scheduleAndSendMock.mockResolvedValue({ outboundMessageId: 'out-1', providerMessageId: 'p1' })

    const r = await handleInbound(INBOUND_ID)

    expect(r).toEqual({ status: 'sent', outboundMessageId: 'out-1' })
  })

  it('replies when the status is one it cannot read', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    venueStatusMaybeSingleMock.mockResolvedValue({ data: { status: 'suspended' }, error: null })
    applyApprovalPolicyStageMock.mockResolvedValue({ action: 'send' })
    generateStageMock.mockResolvedValue({ status: 'success', result: successResult() })
    scheduleAndSendMock.mockResolvedValue({ outboundMessageId: 'out-1', providerMessageId: 'p1' })

    const r = await handleInbound(INBOUND_ID)

    expect(r).toEqual({ status: 'sent', outboundMessageId: 'out-1' })
    warn.mockRestore()
  })

  // Fails OPEN. A read that errored has established nothing, and going silent
  // on a live venue over a database blip is the worse of the two failures.
  // Both failure shapes, because they take different code paths and only one
  // of them was handled when this gate first shipped. supabase-js returns most
  // failures as `{ error }`, but a socket reset or an aborted fetch THROWS,
  // and an unguarded throw reached runInboundTurn's catch: a red alert and no
  // reply, which is what the docstring called the worse of the two failures.
  it('replies when the venue status read THROWS', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    venueStatusMaybeSingleMock.mockRejectedValue(new Error('socket hang up'))
    applyApprovalPolicyStageMock.mockResolvedValue({ action: 'send' })
    generateStageMock.mockResolvedValue({ status: 'success', result: successResult() })
    scheduleAndSendMock.mockResolvedValue({ outboundMessageId: 'out-1', providerMessageId: 'p1' })
    const r = await handleInbound(INBOUND_ID)
    expect(r).toEqual({ status: 'sent', outboundMessageId: 'out-1' })
    warn.mockRestore()
  })

  it('replies when the venue status read FAILS', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    venueStatusMaybeSingleMock.mockResolvedValue({
      data: null,
      error: { message: 'connection reset' },
    })
    applyApprovalPolicyStageMock.mockResolvedValue({ action: 'send' })
    generateStageMock.mockResolvedValue({ status: 'success', result: successResult() })
    scheduleAndSendMock.mockResolvedValue({ outboundMessageId: 'out-1', providerMessageId: 'p1' })

    const r = await handleInbound(INBOUND_ID)

    expect(r).toEqual({ status: 'sent', outboundMessageId: 'out-1' })
    warn.mockRestore()
  })
})

// ---------------------------------------------------------------------------
// TAC-540
// ---------------------------------------------------------------------------

/**
 * An Instagram context. `conversationChannel` is what the typing switch reads;
 * everything else is the ordinary fixture.
 *
 * Named apart from the `instagramCtx` inside the TAC-469 describe above,
 * which is scoped to that block and carries a phoneless guest it needs and
 * these tests do not.
 */
function typingCtx(overrides: Record<string, unknown> = {}) {
  return makeCtx({ conversationChannel: 'instagram', ...overrides })
}

/**
 * An Instagram auto-send that succeeds. `dispatch-reply.ts` is REAL in this
 * file, so an Instagram conversation routes to the mocked
 * dispatchInstagramReply, never to scheduleAndSend — which is also AC 4
 * holding by construction.
 */
function instagramSendSucceeds(outboundMessageId = 'ig-1'): void {
  dispatchInstagramReplyMock.mockResolvedValue({
    kind: 'sent',
    outboundMessageId,
    providerMessageId: 'mid-1',
    generationId: 'gen-1',
    bubbleCount: 1,
    deliveredBody: 'sure thing',
    undelivered: null,
  })
}

/** Just the signals, in order: ['on'] or ['on', 'on', 'off']. */
function typingSignals(): string[] {
  return signalTypingMock.mock.calls.map((c) => c[1] as string)
}

/**
 * Wait for the exit's fire-and-forget typing_off.
 *
 * It is handed to `waitUntil` rather than awaited (code review: awaiting it
 * put two Graph calls in front of the claim release and the retry), and
 * `waitUntil` is `(p) => p` here, so `handleInbound` returns before the `off`
 * is sent.
 *
 * WAITS FOR THE CONDITION, NOT A TICK COUNT, and the first version did the
 * latter. Two macrotasks happened to be enough, which is the same
 * coincidence the tests using it were added to remove: probing with one
 * extra `setTimeout` inside `stopTypingUnlessSent` broke it, and production
 * spends three supabase queries there before the POST. A fixed number of
 * ticks is a guess about an implementation; this is the property.
 */
async function flushTyping(): Promise<void> {
  await vi.waitFor(() => {
    expect(typingSignals()).toContain('off')
  })
}

describe('TAC-540 — typing dots on the auto-send path', () => {
  beforeEach(() => {
    buildRuntimeContextMock.mockResolvedValue(typingCtx())
  })

  /**
   * Drain fire-and-forget work before the next test, the same reason
   * coalesce-inbound.test.ts carries one: `waitUntil` is `(p) => p` here, so
   * a typing_off (and the handoff behind it) started in one test can still be
   * in flight when the next begins, where it lands in the shared
   * signalTypingMock and makes a `toEqual` on the signal sequence read
   * another test's work. Not reachable on the un-probed suite, which is
   * deterministic; it shows up the moment anything delays the exit.
   */
  afterEach(async () => {
    await new Promise((resolve) => setTimeout(resolve, 10))
  })

  /**
   * Both sites, and the second is not redundant. Meta turns the indicator off
   * "after 20 seconds or after a response is sent", and generation alone runs
   * to ~11s at p90 on top of classification's ~2.8s — so one typing_on would
   * routinely expire before the checks, the gate and the send had started.
   *
   * Fails if either call is removed, which is the whole point of asserting
   * the SEQUENCE rather than `toHaveBeenCalled()`.
   */
  it('turns the dots on after classification AND again after generation', async () => {
    applyApprovalPolicyStageMock.mockResolvedValue({ action: 'send' })
    generateStageMock.mockResolvedValue({ status: 'success', result: successResult() })
    instagramSendSucceeds()

    const r = await handleInbound(INBOUND_ID)

    expect(r).toMatchObject({ status: 'sent' })
    expect(typingSignals()).toEqual(['on', 'on'])
    expect(signalTypingMock).toHaveBeenCalledWith(
      { venueId: VENUE_ID, guestId: GUEST_ID, channel: 'instagram' },
      'on',
    )
  })

  /**
   * The ordering claim: the first typing_on precedes generation. Without it
   * the dots would appear only once the slow half was already done, which is
   * most of the wait the ticket exists to cover.
   */
  it('shows the dots BEFORE generation starts, not after', async () => {
    const order: string[] = []
    signalTypingMock.mockImplementation(async (_t: unknown, signal: string) => {
      order.push(`typing_${signal}`)
      return { status: 'sent' }
    })
    generateStageMock.mockImplementation(async () => {
      order.push('generate')
      return { status: 'success', result: successResult() }
    })
    applyApprovalPolicyStageMock.mockResolvedValue({ action: 'send' })
    instagramSendSucceeds()

    await handleInbound(INBOUND_ID)

    expect(order[0]).toBe('typing_on')
    expect(order).toContain('generate')
    expect(order.indexOf('typing_on')).toBeLessThan(order.indexOf('generate'))
  })

  /**
   * AC 2. A held draft is the case the whole `typing_off` mechanism exists
   * for: the prediction after classification said auto-send, a
   * post-generation check disagreed, and the guest must not be left watching
   * dots for a reply that is now sitting on an operator's screen.
   */
  it('turns the dots off when the draft is held for approval, and sends nothing', async () => {
    generateStageMock.mockResolvedValue({ status: 'success', result: successResult() })
    applyApprovalPolicyStageMock.mockResolvedValue({
      action: 'queue',
      triggers: ['model_flagged'],
      primaryTrigger: 'model_flagged',
      existingPendingDraftId: null,
    })
    persistOrRegenQueuedDraftMock.mockResolvedValue({
      outboundMessageId: 'card-1',
      action: 'inserted',
      priorReviewReason: null,
    })

    const r = await handleInbound(INBOUND_ID)
    // Code review: this is the headline test for the whole typing_off
    // mechanism and it was the one that had no flush. It passed by about one
    // microtask, because the mocked signalTyping resolves without ever
    // yielding to the macrotask queue — where production does a
    // loadInstagramSendTarget (three supabase queries) before the POST.
    // Verified by probe: one setTimeout inside stopTypingUnlessSent and it
    // failed with ['on','on'].
    await flushTyping()

    expect(r).toMatchObject({ status: 'queued' })
    expect(typingSignals()).toEqual(['on', 'on', 'off'])
    expect(dispatchInstagramReplyMock).not.toHaveBeenCalled()
  })

  /**
   * Meta clears the indicator when a message is sent, so a typing_off behind
   * a delivered reply is a second call fighting Meta's own clear. `sent` is
   * the ONE false in TYPING_OFF_AFTER, and this is what pins it.
   */
  it('does NOT turn the dots off after a reply actually went out', async () => {
    applyApprovalPolicyStageMock.mockResolvedValue({ action: 'send' })
    generateStageMock.mockResolvedValue({ status: 'success', result: successResult() })
    instagramSendSucceeds()

    await handleInbound(INBOUND_ID)

    expect(typingSignals()).not.toContain('off')
  })

  /**
   * Every other way a turn can end. Each case drives a DIFFERENT return site
   * in runInboundTurn, so a `typing_off` wired to one branch rather than to
   * the single exit fails here.
   *
   * The total map in handle-inbound is the other half: an eleventh
   * AgentResult status fails `tsc` rather than silently inheriting "leave the
   * dots on", which no test can catch because the status would not exist yet.
   */
  it.each([
    [
      'refused (below the fidelity floor)',
      () => {
        generateStageMock.mockResolvedValue({
          status: 'refused',
          attemptScores: [0.2],
          finalScore: 0.2,
        })
      },
    ],
    [
      'failed in generation, with no card',
      () => {
        generateStageMock.mockResolvedValue({ status: 'failed', error: 'boom' })
        loadPendingRowsBySlotMock.mockRejectedValue(new Error('no card for you'))
      },
    ],
    [
      'failed in the corpus stage',
      () => {
        retrieveCorpusStageMock.mockRejectedValue(new Error('voice pack load failed'))
      },
    ],
    [
      'dropped, because a pending card holds the slot',
      () => {
        generateStageMock.mockResolvedValue({ status: 'success', result: successResult() })
        applyApprovalPolicyStageMock.mockResolvedValue({
          action: 'drop',
          reason: 'obligation_slot_taken',
          protectedDraftId: 'card-9',
          protectedCommitment: null,
          droppedCommitment: null,
          triggers: ['commitment_type_gated'],
        })
      },
    ],
    [
      'silenced, because nothing needed answering',
      () => {
        generateStageMock.mockResolvedValue({ status: 'success', result: successResult() })
        applyApprovalPolicyStageMock.mockResolvedValue({ action: 'silence' })
      },
    ],
    /**
     * ADDED IN CODE REVIEW, and it was the gap: flipping
     * `TYPING_OFF_AFTER.superseded` to false passed 168 tests. It is the one
     * status that is neither covered by the cases above nor unreachable with
     * the dots on — `skipped_duplicate`, `venue_halted` and `coalesced` all
     * return before the context is even built.
     *
     * Reachable exactly like this: dots go on, generation succeeds, and the
     * Instagram reply check finds that staff already answered by hand. So
     * nothing is sent, Meta never clears the indicator, and without the
     * `typing_off` the guest watches dots for the full 20 seconds
     * immediately after a human replied to them.
     */
    [
      'superseded, because staff already answered in the Instagram app',
      () => {
        generateStageMock.mockResolvedValue({ status: 'success', result: successResult() })
        applyApprovalPolicyStageMock.mockResolvedValue({ action: 'send' })
        dispatchInstagramReplyMock.mockResolvedValue({ kind: 'superseded', byMessageId: 'staff-1' })
      },
    ],
  ])('turns the dots off when the turn ends %s', async (_name, arrange) => {
    arrange()
    const r = await handleInbound(INBOUND_ID).catch(() => null)
    // The exit hands typing_off to waitUntil rather than awaiting it, so
    // that the claim release and the retry are not held behind two Graph
    // calls. Drained here.
    await flushTyping()

    expect(r).not.toMatchObject({ status: 'sent' })
    expect(typingSignals()).toContain('off')
  })

  /**
   * A crisis turn never turns the dots on, so there is nothing to turn off.
   *
   * The ticket lists "crisis-routed" among the typing_off cases, but a crisis
   * turn DOES dispatch a reply — so placing typing_on below the short circuit
   * is what makes that list consistent with no special case. It also keeps
   * the crisis path's timing exactly as it was.
   *
   * Fails if typing_on is hoisted above the crisis short circuit, which is
   * the obvious reading of "after classification".
   */
  it('never shows dots on a crisis turn, and never has to take them away', async () => {
    classifyStageMock.mockResolvedValueOnce({
      category: 'casual_chatter',
      classifierConfidence: 0.8,
      reasoning: 'mock',
      crisisSafety: true,
    })
    dispatchInstagramReplyMock.mockResolvedValue({
      kind: 'sent',
      outboundMessageId: 'crisis-1',
      providerMessageId: 'mid-c',
      generationId: 'gen-c',
      bubbleCount: 1,
      deliveredBody: 'fixed crisis body',
      undelivered: null,
    })

    const r = await handleInbound(INBOUND_ID)

    expect(r).toMatchObject({ status: 'sent' })
    expect(signalTypingMock).not.toHaveBeenCalled()
  })
})

describe('TAC-540 — the prediction that decides whether dots appear at all', () => {
  /**
   * A category routed to operator approval will queue whatever the draft
   * says, so showing dots would be a false promise on every one of those
   * turns rather than occasionally.
   */
  it('shows no dots when the category is routed to operator approval', async () => {
    buildRuntimeContextMock.mockResolvedValue(
      typingCtx({
        venue: {
          ...typingCtx().venue,
          approvalPolicy: { default: 'auto_send', perCategory: { new_question: 'operator_approval' } },
        },
      }),
    )
    generateStageMock.mockResolvedValue({ status: 'success', result: successResult() })
    applyApprovalPolicyStageMock.mockResolvedValue({
      action: 'queue',
      triggers: ['category_requires_approval'],
      primaryTrigger: 'category_requires_approval',
      existingPendingDraftId: null,
    })
    persistOrRegenQueuedDraftMock.mockResolvedValue({
      outboundMessageId: 'card-1',
      action: 'inserted',
      priorReviewReason: null,
    })

    await handleInbound(INBOUND_ID)

    expect(signalTypingMock).not.toHaveBeenCalled()
  })

  /**
   * Not in the ticket's own wording, and included because at a venue
   * carrying it EVERY reply queues — so without it the dots would be false on
   * every single turn there. Strictly narrowing.
   */
  it('shows no dots at a venue holding all outbound', async () => {
    const base = typingCtx()
    buildRuntimeContextMock.mockResolvedValue(
      typingCtx({ venue: { ...base.venue, holdAllOutbound: true } }),
    )
    generateStageMock.mockResolvedValue({ status: 'success', result: successResult() })
    applyApprovalPolicyStageMock.mockResolvedValue({
      action: 'queue',
      triggers: ['hold_all_outbound'],
      primaryTrigger: 'hold_all_outbound',
      existingPendingDraftId: null,
    })
    persistOrRegenQueuedDraftMock.mockResolvedValue({
      outboundMessageId: 'card-1',
      action: 'inserted',
      priorReviewReason: null,
    })

    await handleInbound(INBOUND_ID)

    expect(signalTypingMock).not.toHaveBeenCalled()
  })

  /**
   * The ticket's own closed-venue clause. `isVenueClosed` is a POSITIVE
   * verdict only, so a venue whose hours nobody filled in still gets dots —
   * which is why the fixture states real hours and a time outside them
   * rather than leaving `hours` empty.
   */
  it('shows no dots while the venue is positively closed', async () => {
    const base = typingCtx()
    buildRuntimeContextMock.mockResolvedValue(
      typingCtx({
        venue: {
          ...base.venue,
          timezone: 'America/Los_Angeles',
          venueInfo: { hours: { monday: '7:00 AM – 3:00 PM' } },
        },
        // A Monday, 21:00 in Los Angeles: six hours after close.
        recognition: { ...base.recognition, computedAt: new Date('2026-09-22T04:00:00.000Z') },
      }),
    )
    applyApprovalPolicyStageMock.mockResolvedValue({ action: 'send' })
    generateStageMock.mockResolvedValue({ status: 'success', result: successResult() })
    instagramSendSucceeds()

    await handleInbound(INBOUND_ID)

    expect(signalTypingMock).not.toHaveBeenCalled()
  })

  /** AC 4, from the orchestrator's side. */
  it('a text conversation never reaches the typing switch at all', async () => {
    buildRuntimeContextMock.mockResolvedValue(makeCtx())
    applyApprovalPolicyStageMock.mockResolvedValue({ action: 'send' })
    generateStageMock.mockResolvedValue({ status: 'success', result: successResult() })
    scheduleAndSendMock.mockResolvedValue({ outboundMessageId: 'out-1', providerMessageId: 'p1' })

    const r = await handleInbound(INBOUND_ID)

    expect(r).toMatchObject({ status: 'sent' })
    expect(signalTypingMock).not.toHaveBeenCalled()
    // The other half of AC 4: the text arm still runs, untouched.
    expect(scheduleAndSendMock).toHaveBeenCalledTimes(1)
    expect(dispatchInstagramReplyMock).not.toHaveBeenCalled()
  })
})

describe('TAC-540 — a sender action can never change the reply', () => {
  beforeEach(() => {
    buildRuntimeContextMock.mockResolvedValue(typingCtx())
    applyApprovalPolicyStageMock.mockResolvedValue({ action: 'send' })
    generateStageMock.mockResolvedValue({ status: 'success', result: successResult() })
    instagramSendSucceeds()
  })

  /**
   * AC 3, one test per failure mode. Each asserts the reply's OUTCOME and
   * that it still reached scheduleAndSend with the same body — not merely
   * that nothing threw, because a turn that silently degraded to a card
   * would also not throw.
   */
  it.each([
    ['throws', () => signalTypingMock.mockRejectedValue(new Error('graph exploded'))],
    ['returns a non-2xx', () => signalTypingMock.mockResolvedValue({ status: 'send_failed', kind: 'graph_error' })],
    ['times out', () => signalTypingMock.mockResolvedValue({ status: 'send_failed', kind: 'timeout' })],
    [
      'never settles',
      () =>
        signalTypingMock.mockImplementation((_t: unknown, signal: string) =>
          // typing_off IS awaited at the exit, so a never-settling `off`
          // would hang the turn. Only `on` is left open here, which is the
          // fire-and-forget one.
          signal === 'on' ? new Promise(() => {}) : Promise.resolve({ status: 'sent' }),
        ),
    ],
  ])('a typing_on that %s changes nothing about the reply', async (_name, arrange) => {
    arrange()

    const r = await handleInbound(INBOUND_ID)

    expect(r).toEqual({ status: 'sent', outboundMessageId: 'ig-1' })
    // AC 4 rides along: an Instagram turn never reaches the Sendblue arm.
    expect(dispatchInstagramReplyMock).toHaveBeenCalledTimes(1)
    expect(scheduleAndSendMock).not.toHaveBeenCalled()
  }, 2000)

  /**
   * THE EXIT MUST NOT HOLD THE REPLY PATH, added in code review.
   *
   * `stopTypingUnlessSent` runs immediately before `closeCoalescedTurn`,
   * which releases the conversation claim and then fires the retry or hands
   * off a newer message — the things that actually produce the guest's reply
   * on a failed turn. Awaiting it put up to two Graph round-trips and an
   * un-timeouted send-target lookup in front of that, on the one ticket whose
   * subject is Instagram latency.
   *
   * FAILS WHEN THE waitUntil IS REVERTED TO AN await: this typing_off never
   * settles, so the whole turn hangs and the test times out rather than
   * asserting. Without it, nothing in the suite noticed the difference —
   * re-awaiting the exit passed all 132 tests.
   */
  it('returns without waiting for typing_off, so the retry is not held behind it', async () => {
    generateStageMock.mockResolvedValue({ status: 'refused', attemptScores: [0.1], finalScore: 0.1 })
    signalTypingMock.mockImplementation(async (_t: unknown, signal: string) =>
      signal === 'off' ? new Promise(() => {}) : { status: 'sent' },
    )

    const r = await handleInbound(INBOUND_ID)

    expect(r).toMatchObject({ status: 'refused' })
  }, 2000)

  /**
   * The same property on the CATCH path, which is where it matters most.
   *
   * `closeCoalescedTurn(..., null)`'s own comment calls a throw "the
   * strongest case for a retry": the turn produced no result at all, so the
   * guest certainly got nothing. An `await` there would delay exactly that
   * retry. The happy path was pinned and this one was not — found in code
   * review, and reverting only this call to an `await` passed all 170 tests.
   *
   * `flushThrows` makes `trace.flushAsync()` throw from runInboundTurn's
   * `finally`, which is the only way to escape its own top-level catch and
   * reach the wrapper's.
   */
  it('returns without waiting for typing_off when the turn throws past its own catch', async () => {
    traceControl.flushThrows = true
    applyApprovalPolicyStageMock.mockResolvedValue({ action: 'send' })
    generateStageMock.mockResolvedValue({ status: 'success', result: successResult() })
    instagramSendSucceeds()
    signalTypingMock.mockImplementation(async (_t: unknown, signal: string) =>
      signal === 'off' ? new Promise(() => {}) : { status: 'sent' },
    )

    await expect(handleInbound(INBOUND_ID)).rejects.toThrow('flush failed')
  }, 2000)

  /**
   * THE ORDERING GUARD, and the test the ruling asked for specifically.
   *
   * typing_on is fire-and-forget, so a turn that fails fast can reach its
   * exit while that POST is still open. Sent in that order, Meta applies the
   * `off` first and the `on` second, and the guest watches dots for the full
   * 20-second timeout on a turn that is not replying.
   *
   * The fixture forces exactly that race: typing_on does not resolve until
   * it is released, and the turn fails immediately after it is issued. If
   * the exit did not await the in-flight typing_on, the `off` would be sent
   * while `on` was still pending — which is what the index comparison below
   * detects.
   *
   * FAILS WHEN THE AWAIT IS REMOVED: without it, `off` is recorded while
   * the `on` promise is still pending.
   *
   * KNOWN SENSITIVITY, recorded rather than chased. This is the most
   * timing-sensitive test in the file, and inserting an extra macrotask into
   * the very statement it pins breaks it while leaving every other TAC-540
   * test green. That is a probe perturbing the line under test, not a
   * defect — but if it ever goes flaky, this is why, and the fixture's 20ms
   * release is the knob.
   */
  it('waits for an in-flight typing_on before sending typing_off', async () => {
    const completed: string[] = []
    let releaseOn: (() => void) | null = null
    signalTypingMock.mockImplementation(async (_t: unknown, signal: string) => {
      if (signal === 'on') {
        await new Promise<void>((resolve) => {
          releaseOn = resolve
        })
        completed.push('on')
        return { status: 'sent' }
      }
      completed.push('off')
      return { status: 'sent' }
    })
    // Fail the turn right after the first typing_on is issued, so the exit is
    // reached while that POST is still open.
    generateStageMock.mockImplementation(async () => {
      // The typing_on is in flight by now; let it finish only once the turn
      // has had the chance to reach its exit.
      setTimeout(() => releaseOn?.(), 20)
      return { status: 'refused', attemptScores: [0.1], finalScore: 0.1 }
    })

    const r = await handleInbound(INBOUND_ID)
    // typing_off is fire-and-forget at the exit (code review: awaiting it
    // held the claim release and the retry behind two Graph calls), so the
    // run returns before it lands. Waited for here, not slept past.
    await vi.waitFor(() => {
      expect(completed).toContain('off')
    })

    expect(r).toMatchObject({ status: 'refused' })
    // The `on` completed FIRST. Without the in-flight await inside
    // stopTypingUnlessSent, `off` is pushed while the `on` promise is still
    // pending and this order is reversed.
    expect(completed).toEqual(['on', 'off'])
  })
})

describe('TAC-540 — classify and voice retrieval overlap', () => {
  /**
   * Both must be IN FLIGHT at the same time. Asserted with deferred
   * promises rather than by timing: `retrieveCorpusStage` is only allowed to
   * finish once `classifyStage` has been entered, so if the two ran in
   * sequence this deadlocks and the test times out rather than passing on a
   * fast machine.
   *
   * Fails the moment retrieval is moved back below classification.
   */
  it('has both in flight at once: neither finishes before the other starts', async () => {
    const entered = { classify: false, corpus: false }
    let bothEntered: (() => void) | null = null
    const bothRunning = new Promise<void>((resolve) => {
      bothEntered = resolve
    })
    const enter = (which: 'classify' | 'corpus') => {
      entered[which] = true
      if (entered.classify && entered.corpus) bothEntered?.()
    }

    // ORDER-AGNOSTIC on purpose. The property the ticket names is that they
    // OVERLAP, not which is called first — so neither mock is allowed to
    // resolve until both have been entered. Sequentially this deadlocks and
    // the test times out; in parallel both gates open and it passes whichever
    // order they were started in.
    //
    // An earlier version had classification release retrieval, which also
    // pinned retrieval as FIRST. That is true of the implementation and is
    // not what is being claimed here, so it was over-specified: a later
    // reordering that kept them parallel would have failed it.
    retrieveCorpusStageMock.mockImplementation(async () => {
      enter('corpus')
      await bothRunning
      return []
    })
    classifyStageMock.mockImplementation(async () => {
      enter('classify')
      await bothRunning
      return { category: 'new_question', classifierConfidence: 0.9, reasoning: 'r', crisisSafety: false }
    })
    applyApprovalPolicyStageMock.mockResolvedValue({ action: 'send' })
    generateStageMock.mockResolvedValue({ status: 'success', result: successResult() })
    scheduleAndSendMock.mockResolvedValue({ outboundMessageId: 'out-1', providerMessageId: 'p1' })

    const r = await handleInbound(INBOUND_ID)

    expect(r).toMatchObject({ status: 'sent' })
    expect(entered).toEqual({ classify: true, corpus: true })
    expect(retrieveCorpusStageMock).toHaveBeenCalledTimes(1)
  }, 2000)

  /**
   * Failure semantics, unchanged. Same stage name, same red alert, same
   * return — and, the part the parallelisation could have broken, the
   * classification failure does NOT wait for retrieval: this one never
   * settles, so a turn that awaited it would time out.
   */
  it('a classification failure still fails as classification, without waiting for retrieval', async () => {
    retrieveCorpusStageMock.mockReturnValue(new Promise(() => {}))
    classifyStageMock.mockRejectedValue(new Error('anthropic exploded'))

    const r = await handleInbound(INBOUND_ID)

    expect(r).toMatchObject({ status: 'failed', stage: 'classification' })
    expect(fireRedAlertMock).toHaveBeenCalledWith(
      expect.objectContaining({ stage: 'classification' }),
    )
  }, 2000)

  /**
   * The floating-promise claim. Without the `.then(ok, err)` in
   * handle-inbound, this rejection has no handler attached when the
   * classification failure returns, and Node reports an unhandled rejection.
   *
   * Asserted by listening for the process event rather than by inspecting
   * the source: an unhandled rejection does not fail a vitest assertion on
   * its own, so nothing else here would notice it.
   */
  it('a retrieval that rejects after a classification failure is not an unhandled rejection', async () => {
    const unhandled: unknown[] = []
    const onUnhandled = (reason: unknown) => unhandled.push(reason)
    process.on('unhandledRejection', onUnhandled)
    try {
      retrieveCorpusStageMock.mockRejectedValue(new Error('voice pack load failed'))
      classifyStageMock.mockRejectedValue(new Error('anthropic exploded'))

      const r = await handleInbound(INBOUND_ID)
      // Two macrotask turns: Node reports an unhandled rejection after the
      // microtask queue drains, so a same-tick assertion would always pass.
      await new Promise((resolve) => setTimeout(resolve, 10))

      expect(r).toMatchObject({ status: 'failed', stage: 'classification' })
      expect(unhandled).toEqual([])
    } finally {
      process.off('unhandledRejection', onUnhandled)
    }
  })

  /** The corpus failure keeps its own stage and its own alert. */
  it('a corpus failure still fails as corpus, in its old position', async () => {
    retrieveCorpusStageMock.mockRejectedValue(new Error('voice pack load failed'))

    const r = await handleInbound(INBOUND_ID)

    expect(r).toMatchObject({ status: 'failed', stage: 'corpus' })
    expect(fireRedAlertMock).toHaveBeenCalledWith(expect.objectContaining({ stage: 'corpus' }))
    // Classification ran first and succeeded, so its alert never fired: the
    // ordering when both could fail is unchanged.
    expect(fireRedAlertMock).not.toHaveBeenCalledWith(
      expect.objectContaining({ stage: 'classification' }),
    )
  })
})

describe('TAC-540 — each verify check owns its own span window', () => {
  const CHECK_SPANS = [
    'verify_grounding',
    'verify_mechanic_offer',
    'verify_prose_promise',
    'verify_cancellation_claim',
    'verify_closed_venue_arrival',
  ]

  /**
   * Resolve a stage only when its gate is opened, and record the resolution
   * in the SAME ordered log the spans write to — so a test can see whether a
   * span closed while other checks were still running.
   */
  function deferred<T>(name: string, value: T) {
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    return {
      run: async () => {
        await gate
        spanLog.events.push({ name: `resolved:${name}`, phase: 'close' })
        return value
      },
      release: () => release(),
    }
  }

  beforeEach(() => {
    generateStageMock.mockResolvedValue({ status: 'success', result: successResult() })
    applyApprovalPolicyStageMock.mockResolvedValue({ action: 'send' })
    scheduleAndSendMock.mockResolvedValue({ outboundMessageId: 'out-1', providerMessageId: 'p1' })
  })

  it('opens a span for all five checks, including the two that had none', async () => {
    await handleInbound(INBOUND_ID)

    const opened = spanLog.events.filter((e) => e.phase === 'open').map((e) => e.name)
    for (const name of CHECK_SPANS) expect(opened).toContain(name)
  })

  /**
   * THE AC 6 TEST: a span must close when ITS OWN call resolves, not when
   * the batch does.
   *
   * Before this ticket all three existing spans were ended after the
   * `Promise.allSettled`, so every one of them recorded the maximum of the
   * five and no check could be told apart from another (TAC-420 finding F1).
   *
   * The fixture releases the five checks in a chosen order and asserts the
   * spans closed in that same order. Under the old shape every close lands
   * after the slowest check, so the recorded order would be the array order
   * instead — which is a DIFFERENT order here by construction.
   */
  it('closes each span while the other checks are STILL RUNNING, not after the batch', async () => {
    const grounding = deferred('grounding', { status: 'skipped' as const })
    const mechanic = deferred('mechanic', { status: 'skipped' as const })
    const prose = deferred('prose', { status: 'skipped' as const })
    const cancellation = deferred('cancellation', { resolution: { status: 'none' as const }, claim: 'clean' as const })
    const closedVenue = deferred('closedVenue', { status: 'skipped' as const })

    verifyGroundingStageMock.mockImplementation(grounding.run)
    verifyMechanicOfferStageMock.mockImplementation(mechanic.run)
    verifyProsePromiseStageMock.mockImplementation(prose.run)
    verifyCancellationClaimStageMock.mockImplementation(cancellation.run)
    verifyClosedVenueArrivalStageMock.mockImplementation(closedVenue.run)

    const turn = handleInbound(INBOUND_ID)
    // Deliberately NOT the order the checks appear in the allSettled array:
    // if the spans closed together after the batch, the recorded order would
    // be that array order and this assertion would fail.
    const releaseOrder = [
      ['verify_closed_venue_arrival', closedVenue],
      ['verify_prose_promise', prose],
      ['verify_grounding', grounding],
      ['verify_cancellation_claim', cancellation],
      ['verify_mechanic_offer', mechanic],
    ] as const
    for (const [, d] of releaseOrder) {
      d.release()
      // One macrotask between releases, so each span's close is recorded
      // before the next check is allowed to finish.
      await new Promise((resolve) => setTimeout(resolve, 0))
    }
    await turn

    // THE ASSERTION THAT ACTUALLY CATCHES IT, and the first version of this
    // test did not.
    //
    // Asserting the close ORDER is not enough: the pre-TAC-540 shape ends
    // every span after the batch, but it ends them in the order the checks
    // resolved — so the order matches and a mutant restoring that shape
    // passes. Found by running exactly that mutant against the first version
    // of this test, which it survived.
    //
    // What separates the two is the WINDOW. Each span must close while the
    // other checks are still in flight, so the log has to interleave:
    // resolved, closed, resolved, closed. Batched ends produce all five
    // resolutions and then all five closes.
    const log = spanLog.events
      .filter((e) => CHECK_SPANS.includes(e.name) || e.name.startsWith('resolved:'))
      .filter((e) => e.phase === 'close')
      .map((e) => e.name)

    const firstSpanClose = log.findIndex((n) => CHECK_SPANS.includes(n))
    const lastResolve = log.map((n) => n.startsWith('resolved:')).lastIndexOf(true)
    expect(firstSpanClose).toBeGreaterThanOrEqual(0)
    expect(firstSpanClose).toBeLessThan(lastResolve)

    // ...and each span still closes in ITS OWN check's order, which is what
    // makes the slowest one identifiable afterwards.
    const closed = log.filter((n) => CHECK_SPANS.includes(n))
    expect(closed).toEqual(releaseOrder.map(([name]) => name))
  })

  /**
   * A check that THROWS must still close its span, and must still reach
   * `allSettled` as a rejection so the existing degrade-to-`skipped` /
   * `check_failed` handling below it is untouched.
   *
   * Fails if the thunk swallows the error instead of rethrowing: the turn
   * would then read a fulfilled `undefined` and crash where it destructures.
   */
  it('closes the span and still rejects when a check throws', async () => {
    verifyGroundingStageMock.mockRejectedValue(new Error('haiku exploded'))

    const r = await handleInbound(INBOUND_ID)

    expect(r).toMatchObject({ status: 'sent' })
    const closed = spanLog.events.filter((e) => e.phase === 'close').map((e) => e.name)
    expect(closed).toContain('verify_grounding')
  })
})
