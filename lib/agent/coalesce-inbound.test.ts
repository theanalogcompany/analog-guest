// TAC-526: the orchestrator half of burst coalescing.
//
// SEPARATE FILE, not additions to handle-inbound.test.ts, for the reason
// two-pending-slots.test.ts is separate from pending-slots.test.ts: this needs
// a SHARED claim store across two handleInbound calls, which is a fixture the
// 2,000-line sibling has no use for and would have to carry on every test.
//
// The harness below is copied VERBATIM from handle-inbound.test.ts so the two
// files cannot drift in what they mock away. What is added is the claim store
// (the real in-memory fake, not a stub) and injected `{ now, sleep }` so no
// test waits 8 real seconds.
//
// EVERY TEST FORCES THE GATE EXPLICITLY. `handleInbound(id, { coalescing })`
// rather than the shipped constant, so the shut path stays covered after the
// flip — a rollback restores it, and a file that only tested whatever the
// constant happens to say would lose that coverage the moment it flipped.

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
//
// TAC-526 DIVERGES FROM THE SIBLING HERE, and it is the one change: `eq`
// CAPTURES ITS ARGUMENT and passes it to `inboundSingleMock`. A turn that
// adopts a newer message calls `loadInbound` a SECOND time with a different
// id, and a mock that ignores its arguments answers both calls with the same
// row — so the adoption silently reads as a no-op and the test that exists to
// prove it passes vacuously. Found by that test failing with
// `answering === invokedFor`, not by review.
vi.mock('@/lib/db/admin', () => ({
  createAdminClient: () => ({
    from: (table: string) => ({
      select: () => ({
        eq: (_column: string, value: string) => ({
          single: () => inboundSingleMock(value),
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

// The real fake, not a stub: the primary key it enforces IS the claim, and a
// stub that answered "won" twice would make every assertion here vacuous.
import { createTurnClaimsFake } from './testing/turn-claims-fake'
import { pickNewer, type CoalesceDeps } from './coalesce-turn'
import { handleInbound } from './handle-inbound'

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


// ---------------------------------------------------------------------------
// TAC-526 fixtures
// ---------------------------------------------------------------------------

const MSG_1 = INBOUND_ID
const MSG_2 = '33333333-3333-4333-8333-333333333333'
const MSG_3 = '44444444-4444-4444-8444-444444444444'

const T0 = new Date('2026-09-23T15:32:36.000Z')
/** The incident's real gap: 7 seconds. */
const T_PLUS_7S = new Date('2026-09-23T15:32:43.000Z')
const T_PLUS_10M = new Date('2026-09-23T15:42:36.000Z')

interface FakeInbound {
  id: string
  body: string
  createdAt: Date
}

/**
 * The guest's inbound rows, shared by `loadInbound` and `findNewerInbound` —
 * ONE source of truth, so a test cannot seed a message the newest-message
 * query can see and the loader cannot, or the reverse.
 */
let inboxRows: FakeInbound[] = []

function seedInbox(...rows: FakeInbound[]): void {
  inboxRows = [...rows]
  // Answers BY ID, which is what lets an adoption's second loadInbound be told
  // apart from the first. A mock that ignored the id made the adoption test
  // pass while adopting nothing.
  inboundSingleMock.mockImplementation(async (id: string) => {
    const row = inboxRows.find((r) => r.id === id)
    if (!row) return { data: null, error: { message: `no row for ${id}` } }
    return {
      data: {
        id: row.id,
        body: row.body,
        provider_message_id: `p-${row.id}`,
        created_at: row.createdAt.toISOString(),
        venue_id: VENUE_ID,
        guest_id: GUEST_ID,
        direction: 'inbound',
        channel: 'text',
      },
      error: null,
    }
  })
}

/**
 * Deps backed by the real claim fake and the seeded inbox.
 *
 * `findNewerInbound` runs the REAL `pickNewer` over the seeded rows rather
 * than returning a canned answer: the same-millisecond ordering it implements
 * is the property the Instagram batch shape depends on, and a canned answer
 * would assert nothing about it.
 */
function makeDeps(overrides: Partial<CoalesceDeps> = {}) {
  const store = createTurnClaimsFake()
  const deps: CoalesceDeps = {
    store,
    findNewerInbound: async ({ afterCreatedAt, afterId }) => {
      const sorted = [...inboxRows].sort((a, b) => {
        const d = b.createdAt.getTime() - a.createdAt.getTime()
        return d !== 0 ? d : a.id < b.id ? 1 : -1
      })
      return {
        ok: true,
        newer: pickNewer(
          sorted.map((r) => ({ id: r.id, created_at: r.createdAt.toISOString() })),
          afterCreatedAt,
          afterId,
        ),
      }
    },
    now: () => T0,
    // Never a real wait. The settle is a wall-clock delay in production and a
    // no-op here; what these tests assert is the ORDER of claim and adopt.
    sleep: async () => {},
    ...overrides,
  }
  return { store, deps }
}

/**
 * Two webhook invocations that OVERLAP, which is the shape of the defect. Run
 * sequentially they do not contend at all — the first releases its claim
 * before the second starts — so a sequential test would pass against a build
 * with no claim in it. The first version of these tests made exactly that
 * mistake and reported two replies as if that were the feature working.
 */
function bothInvocations(
  a: string,
  b: string,
  deps: CoalesceDeps,
  coalescing = true,
): Promise<unknown[]> {
  return Promise.all([
    handleInbound(a, { coalescing, coalesceDeps: deps }),
    handleInbound(b, { coalescing, coalesceDeps: deps }),
  ])
}

function statuses(results: unknown[]): string[] {
  return results.map((r) => (r as { status: string }).status).sort()
}

function sendSucceeds(): void {
  generateStageMock.mockResolvedValue({ status: 'success', result: successResult() })
  applyApprovalPolicyStageMock.mockResolvedValue({ action: 'send' })
  scheduleAndSendMock.mockResolvedValue({ outboundMessageId: 'sent-1', providerMessageId: 'p' })
}

beforeEach(() => {
  seedInbox({ id: MSG_1, body: "nice i'll try that", createdAt: T0 })
})

/** The incident's two messages, 7 seconds apart. */
function seedTheBurst(): void {
  seedInbox(
    { id: MSG_1, body: "nice i'll try that", createdAt: T0 },
    { id: MSG_2, body: 'yeah been here a couple times before', createdAt: T_PLUS_7S },
  )
}

describe('TAC-526 — a guest burst becomes one turn', () => {
  /**
   * AC 1. The incident shape. One run claims the conversation and answers the
   * NEWEST message; the other stands down.
   *
   * Asserts the SET of outcomes rather than which invocation won: either is
   * correct, and pinning one would be pinning a microtask ordering.
   */
  it('two messages inside the window produce exactly ONE reply', async () => {
    seedTheBurst()
    sendSucceeds()
    const { deps } = makeDeps()

    const results = await bothInvocations(MSG_1, MSG_2, deps)

    expect(statuses(results)).toEqual(['coalesced', 'sent'])
    expect(scheduleAndSendMock).toHaveBeenCalledTimes(1)
    expect(generateStageMock).toHaveBeenCalledTimes(1)
  })

  /**
   * The same run from the other side: the winner ADOPTS the newer message
   * rather than replying to the one it was invoked for. Without this the claim
   * would only suppress the second reply and the guest's second message would
   * go unanswered — a regression, not a fix.
   */
  it('the reply is generated against the NEWEST message of the burst', async () => {
    seedTheBurst()
    sendSucceeds()
    const { deps } = makeDeps()

    await bothInvocations(MSG_1, MSG_2, deps)

    expect(buildRuntimeContextMock).toHaveBeenCalledTimes(1)
    const ctxArg = buildRuntimeContextMock.mock.calls[0][0] as { currentMessage: { id: string } }
    expect(ctxArg.currentMessage.id).toBe(MSG_2)
  })

  /**
   * AC 2, and the incident's actual harm: the guest was asked their name
   * twice, five seconds apart. One run means one recording, so one ask.
   */
  it('never records the same intention prompt twice across a burst', async () => {
    seedTheBurst()
    sendSucceeds()
    buildRuntimeContextMock.mockResolvedValue(
      makeCtx({ openIntentions: [{ key: 'learn_name', promptLine: 'ask their name' }] }),
    )
    const { deps } = makeDeps()

    await bothInvocations(MSG_1, MSG_2, deps)

    expect(recordIntentionPromptsMock).toHaveBeenCalledTimes(1)
  })

  /**
   * The loser's ledger row. It has to say WHICH turn covered it, or the table
   * cannot distinguish a coalesced message from one nobody answered — which is
   * the blindness TAC-523 built that table to remove.
   */
  it('the loser records itself as folded into the winning run', async () => {
    seedTheBurst()
    sendSucceeds()
    const { deps } = makeDeps()

    await bothInvocations(MSG_1, MSG_2, deps)

    const coalesced = recordInboundTurnOutcomeMock.mock.calls
      .map((c) => c[0] as { result: { status: string; intoAgentRunId?: string } })
      .filter((c) => c.result?.status === 'coalesced')
    expect(coalesced).toHaveLength(1)
    expect(coalesced[0].result.intoAgentRunId).toEqual(expect.any(String))
    expect(coalesced[0].result.intoAgentRunId).not.toBe('unknown')
  })

  /** AC 4. Ten minutes apart is not a burst: the claim is released in between. */
  it('messages MINUTES apart each get their own reply', async () => {
    sendSucceeds()
    const { store, deps } = makeDeps()

    await handleInbound(MSG_1, { coalescing: true, coalesceDeps: deps })
    // The first turn released, so the table is empty again.
    expect(store.rows()).toHaveLength(0)

    seedInbox(
      { id: MSG_1, body: 'hey', createdAt: T0 },
      { id: MSG_3, body: 'actually one more thing', createdAt: T_PLUS_10M },
    )
    const second = await handleInbound(MSG_3, { coalescing: true, coalesceDeps: deps })

    expect(second).toMatchObject({ status: 'sent' })
    expect(scheduleAndSendMock).toHaveBeenCalledTimes(2)
  })

  it('releases the claim on the happy path, so the next turn can take it', async () => {
    sendSucceeds()
    const { store, deps } = makeDeps()
    await handleInbound(MSG_1, { coalescing: true, coalesceDeps: deps })
    expect(store.rows()).toHaveLength(0)
  })

  /**
   * The gate forced shut: today's behaviour, exactly. This is what a rollback
   * restores, so it stays covered after the flip rather than being deleted by
   * it.
   */
  it('with coalescing OFF: no claim is taken, nothing is adopted, two replies go out', async () => {
    seedTheBurst()
    sendSucceeds()
    const { store, deps } = makeDeps()

    const results = await bothInvocations(MSG_1, MSG_2, deps, false)

    expect(statuses(results)).toEqual(['sent', 'sent'])
    expect(scheduleAndSendMock).toHaveBeenCalledTimes(2)
    expect(store.calls.insert).toBe(0)
    const answered = buildRuntimeContextMock.mock.calls.map(
      (c) => (c[0] as { currentMessage: { id: string } }).currentMessage.id,
    )
    expect(answered.sort()).toEqual([MSG_1, MSG_2].sort())
  })
})

describe('TAC-526 — a message that lands while the run is generating', () => {
  /**
   * AC 3, the harder half. The settle cannot catch this one: the message
   * arrives after the claim, while the model call is in flight. The run
   * adopts it and generates again rather than answering a turn the guest has
   * already moved past.
   */
  it('extends the turn rather than sending a reply to a stale message', async () => {
    sendSucceeds()
    const { deps } = makeDeps()
    // The fragment lands DURING generation — seeded as a side effect of the
    // model call, which is the only way to place it inside that window.
    generateStageMock.mockImplementationOnce(async () => {
      seedInbox(
        { id: MSG_1, body: "nice i'll try that", createdAt: T0 },
        { id: MSG_2, body: 'yeah been here a couple times before', createdAt: T_PLUS_7S },
      )
      return { status: 'success', result: successResult() }
    })

    const result = await handleInbound(MSG_1, { coalescing: true, coalesceDeps: deps })

    expect(result).toMatchObject({ status: 'sent' })
    // Generated twice, sent once, and the send answers the newer message.
    expect(generateStageMock).toHaveBeenCalledTimes(2)
    expect(scheduleAndSendMock).toHaveBeenCalledTimes(1)
    const ctxArg = buildRuntimeContextMock.mock.calls[1][0] as { currentMessage: { id: string } }
    expect(ctxArg.currentMessage.id).toBe(MSG_2)
  })

  /**
   * The bound. A guest typing continuously must not hold a turn open forever,
   * so at MAX_TURN_EXTENSIONS the run sends what it has and the handoff covers
   * the rest.
   *
   * THE SUPPLY OF FRAGMENTS IS FINITE (five), deliberately. An endless supply
   * makes the unbounded mutant HANG rather than fail, and a hang is a bad
   * kill: the harness times out, prints nothing useful, and leaves the mutant
   * applied. With five available, removing the bound terminates at six
   * generations and fails this count instead — fast, and legible.
   */
  it('stops extending at the bound and sends what it has', async () => {
    sendSucceeds()
    const { deps } = makeDeps()
    let n = 0
    generateStageMock.mockImplementation(async () => {
      if (n < 5) {
        n += 1
        inboxRows.push({
          id: `55555555-5555-4555-8555-${String(n).padStart(12, '0')}`,
          body: `fragment ${n}`,
          createdAt: new Date(T0.getTime() + n * 1000),
        })
      }
      return { status: 'success', result: successResult() }
    })

    const result = await handleInbound(MSG_1, { coalescing: true, coalesceDeps: deps })

    expect(result).toMatchObject({ status: 'sent' })
    // MAX_TURN_EXTENSIONS = 2, so three generations: the original and two
    // extensions. Pinned as a NUMBER because "it terminated" is also true of a
    // bound of fifty, and of no bound at all against a finite supply.
    expect(generateStageMock).toHaveBeenCalledTimes(3)
    // And exactly one reply, however many times it regenerated.
    expect(scheduleAndSendMock).toHaveBeenCalledTimes(1)
  })

  /**
   * THE REASON THE HANDOFF EXISTS. Before the claim, if one run died the other
   * still replied — two runs was the bug and also the redundancy. With a claim
   * and no handoff the loser has already stood down, so the guest gets
   * silence: a robustness regression introduced by the fix.
   *
   * THE FRAGMENT ARRIVES DURING THE SEND, and that placement is the whole
   * test. A first version seeded it earlier and passed while the handoff was
   * deleted — the EXTENSION was loading MSG_2, and the assertion could not
   * tell which mechanism had done it. Arriving after the extension check has
   * already run leaves the handoff as the only thing that can reach it.
   *
   * Driven through the trace flush, the one way to throw past the
   * orchestrator's own top-level catch and reach the wrapper's.
   */
  it('hands off an uncovered message when the run throws', async () => {
    sendSucceeds()
    const { deps } = makeDeps()
    traceControl.flushThrows = true
    scheduleAndSendMock.mockImplementation(async () => {
      seedInbox(
        { id: MSG_1, body: "nice i'll try that", createdAt: T0 },
        { id: MSG_2, body: 'yeah been here a couple times before', createdAt: T_PLUS_7S },
      )
      return { outboundMessageId: 'sent-1', providerMessageId: 'p' }
    })

    await expect(
      handleInbound(MSG_1, { coalescing: true, coalesceDeps: deps }),
    ).rejects.toThrow('flush failed')

    // The handoff re-invoked for the uncovered message. Without it MSG_2 is
    // never answered by anyone: its own run already stood down.
    //
    // `waitFor` because the handoff runs under `waitUntil` and is deliberately
    // NOT awaited — that is what keeps it off the response path in production.
    await vi.waitFor(() => {
      expect(inboundSingleMock.mock.calls.map((c) => c[0])).toContain(MSG_2)
    })
  })

  /**
   * The same handoff on a NORMAL return. It is not a catch-path special case:
   * a message arriving after the extension check is uncovered however the turn
   * ended, and the guest is owed a reply to it either way.
   */
  it('hands off an uncovered message on a clean send', async () => {
    sendSucceeds()
    const { deps } = makeDeps()
    let seeded = false
    scheduleAndSendMock.mockImplementation(async () => {
      if (!seeded) {
        seeded = true
        seedInbox(
          { id: MSG_1, body: "nice i'll try that", createdAt: T0 },
          { id: MSG_2, body: 'yeah been here a couple times before', createdAt: T_PLUS_7S },
        )
      }
      return { outboundMessageId: 'sent-1', providerMessageId: 'p' }
    })

    const result = await handleInbound(MSG_1, { coalescing: true, coalesceDeps: deps })

    expect(result).toMatchObject({ status: 'sent' })
    // Two sends: this turn's, and the handed-off turn's answer to MSG_2. Same
    // `waitFor` reason as above — the handoff is fire-and-forget by design.
    await vi.waitFor(() => {
      expect(scheduleAndSendMock).toHaveBeenCalledTimes(2)
    })
    expect(inboundSingleMock.mock.calls.map((c) => c[0])).toContain(MSG_2)
  })

  it('hands nothing off when the turn covered the newest message', async () => {
    seedTheBurst()
    sendSucceeds()
    const { deps } = makeDeps()

    await handleInbound(MSG_1, { coalescing: true, coalesceDeps: deps })

    // It adopted MSG_2, so there is nothing left uncovered and no second run.
    expect(scheduleAndSendMock).toHaveBeenCalledTimes(1)
    expect(generateStageMock).toHaveBeenCalledTimes(1)
  })

  /**
   * The claim must be gone BEFORE the handoff runs, or the handed-off run
   * loses the claim it was invoked to take and the guest gets nothing —
   * the handoff defeating itself.
   */
  it('releases the claim before handing off, so the next run can take it', async () => {
    sendSucceeds()
    const { store, deps } = makeDeps()
    generateStageMock.mockImplementationOnce(async () => {
      // Arrives too late for the extension budget to matter; what is asserted
      // is the release ordering, not the extension.
      seedInbox(
        { id: MSG_1, body: "nice i'll try that", createdAt: T0 },
        { id: MSG_2, body: 'second', createdAt: T_PLUS_7S },
      )
      return { status: 'success', result: successResult() }
    })

    await handleInbound(MSG_1, { coalescing: true, coalesceDeps: deps })

    // Whatever ran, nothing is left holding the conversation.
    expect(store.rows()).toHaveLength(0)
  })
})

describe('TAC-526 — the paths it must not touch', () => {
  /**
   * CRISIS SAFETY. The reply is fixed and unconditional, and deferring it to a
   * newer fragment would be the worst failure this feature could have.
   *
   * Structural rather than a check: the crisis short-circuit returns hundreds
   * of lines before the extension. This pins that, so a future edit that moves
   * the extension earlier fails here rather than in production.
   */
  it('never extends a crisis-safety turn, even with a newer message waiting', async () => {
    seedTheBurst()
    classifyStageMock.mockResolvedValue({
      category: 'unknown',
      classifierConfidence: 0.9,
      reasoning: 'crisis',
      crisisSafety: true,
    })
    scheduleAndSendMock.mockResolvedValue({ outboundMessageId: 'crisis-1', providerMessageId: 'p' })
    const { deps } = makeDeps()

    const result = await handleInbound(MSG_1, { coalescing: true, coalesceDeps: deps })

    expect(result).toMatchObject({ status: 'sent', outboundMessageId: 'crisis-1' })
    // Sent once, and generation never ran: the crisis body is a fixed string.
    expect(scheduleAndSendMock).toHaveBeenCalledTimes(1)
    expect(generateStageMock).not.toHaveBeenCalled()
  })

  /**
   * A crisis message that arrives SECOND is still answered — by the winner,
   * which adopted it. The claim does not swallow it.
   */
  it('answers a crisis message that arrived second, via the adoption', async () => {
    seedTheBurst()
    classifyStageMock.mockResolvedValue({
      category: 'unknown',
      classifierConfidence: 0.9,
      reasoning: 'crisis',
      crisisSafety: true,
    })
    scheduleAndSendMock.mockResolvedValue({ outboundMessageId: 'crisis-1', providerMessageId: 'p' })
    const { deps } = makeDeps()

    const results = await bothInvocations(MSG_1, MSG_2, deps)

    expect(statuses(results)).toEqual(['coalesced', 'sent'])
    // The turn that replied is the one holding the crisis message.
    const ctxArg = buildRuntimeContextMock.mock.calls[0][0] as { currentMessage: { id: string } }
    expect(ctxArg.currentMessage.id).toBe(MSG_2)
  })

  /**
   * THE BOUNDARY WITH TAC-397. A draft waiting for an operator is that
   * ticket's `resolveConversationDisposition`; a run in progress is this one's
   * claim. The extension must never fire on the queue path, or the two
   * mechanisms would both be deciding what a second message does.
   */
  it('never extends when the turn queued a card, and still releases', async () => {
    generateStageMock.mockResolvedValue({ status: 'success', result: successResult() })
    applyApprovalPolicyStageMock.mockResolvedValue({
      action: 'queue',
      triggers: ['model_flagged'],
      primaryTrigger: 'model_flagged',
      existingPendingDraftId: null,
    })
    const { store, deps } = makeDeps()
    generateStageMock.mockImplementationOnce(async () => {
      seedInbox(
        { id: MSG_1, body: "nice i'll try that", createdAt: T0 },
        { id: MSG_2, body: 'second', createdAt: T_PLUS_7S },
      )
      return { status: 'success', result: successResult() }
    })

    const result = await handleInbound(MSG_1, { coalescing: true, coalesceDeps: deps })

    expect(result).toMatchObject({ status: 'queued' })
    // One generation: the queue path returns before the extension check.
    expect(generateStageMock).toHaveBeenCalledTimes(1)
    expect(store.rows()).toHaveLength(0)
  })

  /**
   * FAILS OPEN. A claim store that cannot be reached must not cost a guest
   * their reply — that would make silence a NEW failure mode introduced by the
   * fix for a duplicate one.
   */
  it('still replies when the claim store is unreachable', async () => {
    sendSucceeds()
    const { store, deps } = makeDeps()
    store.failNext('insert', 10)

    const result = await handleInbound(MSG_1, { coalescing: true, coalesceDeps: deps })

    expect(result).toMatchObject({ status: 'sent' })
    expect(scheduleAndSendMock).toHaveBeenCalledTimes(1)
  })

  it('does not try to release a claim it never took', async () => {
    sendSucceeds()
    const { store, deps } = makeDeps()
    store.failNext('insert', 10)

    await handleInbound(MSG_1, { coalescing: true, coalesceDeps: deps })

    expect(store.calls.delete).toBe(0)
  })
})
