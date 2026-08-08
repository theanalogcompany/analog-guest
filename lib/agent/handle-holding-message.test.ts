import { beforeEach, describe, expect, it, vi } from 'vitest'

// ./stages pulls in @/lib/rag → voyageai, whose ESM build trips vitest's
// directory-import resolver at module load. See CLAUDE.md "Module split for
// testability". Must precede the imports below.
vi.mock('voyageai', () => ({ VoyageAIClient: class {} }))

import { FALLBACK_HOLDING_BODY, handleHoldingMessage } from './handle-holding-message'

// The subject here is the FAILURE LADDER (TAC-308 decision #7): generate,
// retry once, then send a plain line rather than leave the guest in silence.
// The gate is mocked because what matters is how this module REACTS to a
// queue/refuse verdict, not how the gate reaches one.

const generateStageMock = vi.fn()
const applyApprovalPolicyStageMock = vi.fn()
const scheduleAndSendMock = vi.fn()
const fireRedAlertMock = vi.fn().mockResolvedValue(undefined)
const capturePostHogEventMock = vi.fn().mockResolvedValue(undefined)
const buildRuntimeContextMock = vi.fn()
const optedOutMaybeSingleMock = vi.fn()
vi.mock('@/lib/db/admin', () => ({
  createAdminClient: () => ({
    from: () => ({
      select: () => ({
        eq: () => ({ maybeSingle: () => optedOutMaybeSingleMock() }),
      }),
    }),
  }),
}))

vi.mock('./stages', () => ({
  generateStage: (...a: unknown[]) => generateStageMock(...a),
  applyApprovalPolicyStage: (...a: unknown[]) => applyApprovalPolicyStageMock(...a),
  retrieveCorpusStage: vi.fn(async () => []),
  retrieveKnowledgeStage: vi.fn(async () => []),
  shouldRetrieveKnowledge: () => false,
}))
vi.mock('./build-runtime-context', () => ({
  buildRuntimeContext: (...a: unknown[]) => buildRuntimeContextMock(...a),
}))
vi.mock('./schedule-and-send', () => ({
  scheduleAndSend: (...a: unknown[]) => scheduleAndSendMock(...a),
}))
vi.mock('./alerts', () => ({
  fireRedAlert: (...a: unknown[]) => fireRedAlertMock(...a),
  capturePostHogEvent: (...a: unknown[]) => capturePostHogEventMock(...a),
}))
vi.mock('@/lib/observability', () => ({
  startAgentTrace: () => ({
    id: '',
    span: () => ({ end: vi.fn(), span: () => ({ end: vi.fn() }) }),
    update: vi.fn(),
    flushAsync: vi.fn(async () => {}),
    captureContent: false,
  }),
}))

function makeCtx() {
  return {
    agentRunId: 'run-1',
    venue: { id: 'venue-1', timezone: 'America/Los_Angeles', holdAllOutbound: false },
    guest: { id: 'guest-1', firstName: 'Sam' },
    currentMessage: null,
    followupTrigger: { reason: 'manual', triggeredAt: new Date() },
    pendingQuestion: null,
    corpus: null,
    knowledgeCorpus: null,
    classification: null,
    recentMessages: [],
    recognition: {},
    mechanics: [],
    recentVisits: [],
    activeCommitments: [],
    trace: { id: '' },
  }
}

function goodGeneration(body = "still tracking that down for you") {
  return {
    status: 'success',
    result: {
      body,
      voiceFidelity: 0.82,
      reasoning: 'holding note',
      requiresOperatorApproval: false,
      approvalReason: '',
      complaintIntent: 'none',
      knowledgeGap: false,
      contextUpdate: {},
      commitment: {},
      arrivalCapture: {},
      attempts: 1,
      attemptScores: [0.82],
      attemptHistory: [],
      systemPrompt: '',
      userPrompt: '',
      promptVersion: 'v1.25.0',
      dashViolationPersisted: false,
    },
  }
}

const QUESTION = {
  question: 'what grade is the matcha?',
  askedAt: new Date('2026-08-07T12:00:00Z'),
}

beforeEach(() => {
  vi.clearAllMocks()
  buildRuntimeContextMock.mockResolvedValue(makeCtx())
  scheduleAndSendMock.mockResolvedValue({
    outboundMessageId: 'out-1',
    providerMessageId: 'p-1',
  })
  generateStageMock.mockResolvedValue(goodGeneration())
  applyApprovalPolicyStageMock.mockResolvedValue({ action: 'send' })
  optedOutMaybeSingleMock.mockResolvedValue({ data: { opted_out_at: null }, error: null })
})

describe('handleHoldingMessage (TAC-308)', () => {
  it('sends a generated holding message on the happy path', async () => {
    const r = await handleHoldingMessage({
      venueId: 'venue-1',
      guestId: 'guest-1',
      pendingQuestion: QUESTION,
    })
    expect(r).toEqual({ status: 'sent', outboundMessageId: 'out-1', usedFallback: false })
    expect(generateStageMock).toHaveBeenCalledTimes(1)
    expect(scheduleAndSendMock).toHaveBeenCalledTimes(1)
  })

  // The mode is what flips the ## Unanswered question block from "don't
  // promise anything" into the holding message's brief. Getting it wrong
  // would generate a reply that refuses to say the one thing it must.
  it('marks the context as writing_holding before generating', async () => {
    await handleHoldingMessage({
      venueId: 'venue-1',
      guestId: 'guest-1',
      pendingQuestion: QUESTION,
    })
    const ctxUsed = generateStageMock.mock.calls[0]?.[0] as { pendingQuestion: unknown }
    expect(ctxUsed.pendingQuestion).toEqual({
      question: QUESTION.question,
      askedAt: QUESTION.askedAt,
      mode: 'writing_holding',
    })
  })

  it('skips the human-feel delay — the message is already late by construction', async () => {
    await handleHoldingMessage({
      venueId: 'venue-1',
      guestId: 'guest-1',
      pendingQuestion: QUESTION,
    })
    expect(scheduleAndSendMock.mock.calls[0]?.[2]).toMatchObject({ skipHumanFeelDelay: true })
  })

  it('retries generation once when the first attempt is refused', async () => {
    generateStageMock
      .mockResolvedValueOnce({ status: 'refused', attemptScores: [0.2], finalScore: 0.2 })
      .mockResolvedValueOnce(goodGeneration())
    const r = await handleHoldingMessage({
      venueId: 'venue-1',
      guestId: 'guest-1',
      pendingQuestion: QUESTION,
    })
    expect(generateStageMock).toHaveBeenCalledTimes(2)
    expect(r).toMatchObject({ status: 'sent', usedFallback: false })
  })

  // A queue verdict is a FAILURE here, not a route: the knowledge-gap card
  // already holds this guest's one pending slot (migration 020), so there is
  // nowhere to put a queued holding message.
  it('treats a queue verdict as a failed attempt and retries', async () => {
    applyApprovalPolicyStageMock
      .mockResolvedValueOnce({
        action: 'queue',
        triggers: ['model_flagged'],
        primaryTrigger: 'model_flagged',
        compMatchedPattern: null,
        existingPendingDraftId: null,
      })
      .mockResolvedValueOnce({ action: 'send' })
    const r = await handleHoldingMessage({
      venueId: 'venue-1',
      guestId: 'guest-1',
      pendingQuestion: QUESTION,
    })
    expect(generateStageMock).toHaveBeenCalledTimes(2)
    expect(r).toMatchObject({ status: 'sent', usedFallback: false })
  })

  // Silence is the worse outcome (decision #7). After two failed attempts a
  // fixed line goes out rather than nothing.
  it('falls back to the plain line after two failed attempts', async () => {
    generateStageMock.mockResolvedValue({
      status: 'refused',
      attemptScores: [0.1],
      finalScore: 0.1,
    })
    const r = await handleHoldingMessage({
      venueId: 'venue-1',
      guestId: 'guest-1',
      pendingQuestion: QUESTION,
    })
    expect(generateStageMock).toHaveBeenCalledTimes(2)
    expect(r).toMatchObject({ status: 'sent', usedFallback: true })
    const sentGeneration = scheduleAndSendMock.mock.calls[0]?.[1] as { body: string }
    expect(sentGeneration.body).toBe(FALLBACK_HOLDING_BODY)
  })

  it('alerts when the fallback fires, because that means the prompt is wrong', async () => {
    generateStageMock.mockResolvedValue({
      status: 'refused',
      attemptScores: [0.1],
      finalScore: 0.1,
    })
    await handleHoldingMessage({
      venueId: 'venue-1',
      guestId: 'guest-1',
      pendingQuestion: QUESTION,
    })
    expect(fireRedAlertMock).toHaveBeenCalledWith(
      expect.objectContaining({ stage: 'generation' }),
    )
  })

  // Honest zero: this row is not a voice sample and must never be mistaken
  // for one in a fidelity aggregate or fed back as a corpus exemplar.
  it('stamps the fallback with voiceFidelity 0', async () => {
    generateStageMock.mockResolvedValue({
      status: 'refused',
      attemptScores: [0.1],
      finalScore: 0.1,
    })
    await handleHoldingMessage({
      venueId: 'venue-1',
      guestId: 'guest-1',
      pendingQuestion: QUESTION,
    })
    const sentGeneration = scheduleAndSendMock.mock.calls[0]?.[1] as { voiceFidelity: number }
    expect(sentGeneration.voiceFidelity).toBe(0)
  })

  // The fallback exists for a guest who has been waiting. It must not itself
  // be gateable into silence.
  it('does not run the fallback through the approval gate', async () => {
    generateStageMock.mockResolvedValue({
      status: 'refused',
      attemptScores: [0.1],
      finalScore: 0.1,
    })
    await handleHoldingMessage({
      venueId: 'venue-1',
      guestId: 'guest-1',
      pendingQuestion: QUESTION,
    })
    // Two gate calls would mean an attempt was gated; zero means both
    // generations refused upstream and the fallback went straight out.
    expect(applyApprovalPolicyStageMock).not.toHaveBeenCalled()
    expect(scheduleAndSendMock).toHaveBeenCalledTimes(1)
  })

  it('does not retry generation when the transport itself fails', async () => {
    scheduleAndSendMock.mockRejectedValue(new Error('sendblue down'))
    const r = await handleHoldingMessage({
      venueId: 'venue-1',
      guestId: 'guest-1',
      pendingQuestion: QUESTION,
    })
    expect(r).toMatchObject({ status: 'failed', stage: 'send' })
    expect(generateStageMock).toHaveBeenCalledTimes(1)
  })

  it('fails closed when the runtime context cannot be built', async () => {
    buildRuntimeContextMock.mockRejectedValue(new Error('venue not found'))
    const r = await handleHoldingMessage({
      venueId: 'venue-1',
      guestId: 'guest-1',
      pendingQuestion: QUESTION,
    })
    expect(r).toMatchObject({ status: 'failed', stage: 'context_build' })
    expect(scheduleAndSendMock).not.toHaveBeenCalled()
  })
})

describe('handleHoldingMessage — suppression + persistence (TAC-308 review)', () => {
  it('suppresses the send when the guest has opted out', async () => {
    optedOutMaybeSingleMock.mockResolvedValue({
      data: { opted_out_at: '2026-08-07T12:03:00Z' },
      error: null,
    })
    const r = await handleHoldingMessage({
      venueId: 'venue-1',
      guestId: 'guest-1',
      pendingQuestion: QUESTION,
    })
    expect(r).toEqual({ status: 'suppressed', reason: 'opted_out' })
    expect(scheduleAndSendMock).not.toHaveBeenCalled()
  })

  // Fails CLOSED: an unreadable opt-out state suppresses. A few minutes more
  // silence beats messaging someone who left.
  it('suppresses when the opt-out check itself errors', async () => {
    optedOutMaybeSingleMock.mockResolvedValue({ data: null, error: { message: 'db down' } })
    const r = await handleHoldingMessage({
      venueId: 'venue-1',
      guestId: 'guest-1',
      pendingQuestion: QUESTION,
    })
    expect(r).toMatchObject({ status: 'suppressed', reason: 'opted_out' })
  })

  // A venue running hold_all_outbound reviews every guest-facing message.
  // The fallback bypasses the gate by design, so without this the holding
  // message would override that setting without anyone deciding to.
  it('suppresses for a venue that holds all outbound', async () => {
    buildRuntimeContextMock.mockResolvedValue({
      ...makeCtx(),
      venue: { id: 'venue-1', timezone: 'America/Los_Angeles', holdAllOutbound: true },
    })
    const r = await handleHoldingMessage({
      venueId: 'venue-1',
      guestId: 'guest-1',
      pendingQuestion: QUESTION,
    })
    expect(r).toEqual({ status: 'suppressed', reason: 'hold_all_outbound' })
    expect(scheduleAndSendMock).not.toHaveBeenCalled()
  })

  // HOLDING_MESSAGE_CATEGORY drove generation but never reached the row —
  // messages.category is nullable, so it failed silently.
  it('persists the row under the manual category, not null', async () => {
    await handleHoldingMessage({
      venueId: 'venue-1',
      guestId: 'guest-1',
      pendingQuestion: QUESTION,
    })
    const ctxUsed = scheduleAndSendMock.mock.calls[0]?.[0] as {
      classification: { category: string } | null
    }
    expect(ctxUsed.classification?.category).toBe('manual')
  })
})
