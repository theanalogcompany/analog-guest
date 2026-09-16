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
// TAC-367: resolves NON-EMPTY deliberately. With `[]` the mock returns exactly
// the value the "passes an empty array" test asserts, so that test could not
// tell "we skipped retrieval" from "we retrieved and got nothing" — it passed
// against the retrieval-reintroduced mutant. A non-empty return makes the two
// tests independently failing-capable. It is never called by the fixed
// implementation, so the value is free.
const retrieveKnowledgeStageMock = vi.fn(async () => [
  {
    id: 'k1',
    knowledgeCorpusId: 'kc1',
    text: 'The roasting session invite is an established mechanic.',
    sourceType: 'synthesized',
    confidence: 0.9,
    similarity: 0.48,
    primaryTags: ['mechanic_roasting_session_invite'],
    secondaryTags: [],
  },
])
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

// TAC-367: `shouldRetrieveKnowledge` returns TRUE here, matching PRODUCTION.
// It used to be stubbed `() => false`, which is the opposite of what this path
// actually does — it builds context with followupTrigger.reason='manual', for
// which the real predicate returns true — so retrieveKnowledgeStage was never
// reached in any test and the live retrieval was invisible to the whole suite.
// Returning true is what gives the assertion below its teeth: reintroduce the
// conditional and the call happens.
vi.mock('./stages', () => ({
  generateStage: (...a: unknown[]) => generateStageMock(...a),
  applyApprovalPolicyStage: (...a: unknown[]) => applyApprovalPolicyStageMock(...a),
  retrieveCorpusStage: vi.fn(async () => []),
  retrieveKnowledgeStage: () => retrieveKnowledgeStageMock(),
  shouldRetrieveKnowledge: () => true,
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
    openIntentions: [],
    intentionDerivation: { newlyEligible: [], brakeEngaged: false },
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
      selfTalkViolationPersisted: false,
    emojiDirectiveViolated: false,
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

  // TAC-367. The holding message is the only outbound in this repo with no
  // operator and no gate behind it, and that is acceptable ONLY because the
  // message is content-free by construction. Handing its generator retrieved
  // passages under a header framing them as grounding material is the one
  // input most likely to make it name a fact. Measured: the synthetic query
  // this path produced (`Followup manual for {name}`) returned a FULL slate
  // every time against Le Mil's live corpus, two of them mechanic entries.
  //
  // shouldRetrieveKnowledge is mocked TRUE above (as production behaves), so
  // this fails the moment the conditional comes back.
  it('never retrieves knowledge — the generator gets no chunks at all', async () => {
    await handleHoldingMessage({
      venueId: 'venue-1',
      guestId: 'guest-1',
      pendingQuestion: QUESTION,
    })
    expect(retrieveKnowledgeStageMock).not.toHaveBeenCalled()
  })

  // `[]`, not `null`. An empty array renders TAC-242's explicit "No specific
  // venue knowledge matched this query... do not invent specifics"; null omits
  // the block entirely. For this message the explicit framing is the point, so
  // pin the value rather than just "falsy".
  it('passes an empty array, not null, so the no-knowledge framing still renders', async () => {
    let seenKnowledgeCorpus: unknown
    generateStageMock.mockImplementationOnce(async (ctx: { knowledgeCorpus: unknown }) => {
      seenKnowledgeCorpus = structuredClone(ctx.knowledgeCorpus)
      return goodGeneration()
    })
    await handleHoldingMessage({
      venueId: 'venue-1',
      guestId: 'guest-1',
      pendingQuestion: QUESTION,
    })
    // Snapshotted INSIDE the mock: ctx is one object mutated in place, so
    // reading it after the run pins the final value rather than the value
    // generation actually received. Moving the assignment below the generate
    // loop would leave a post-hoc read green.
    expect(seenKnowledgeCorpus).toEqual([])
    expect(seenKnowledgeCorpus).not.toBeNull()
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

  it('skips the read receipt and typing beats — the message is already late by construction', async () => {
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

  // A queue verdict is a FAILURE here, not a route: the guest is already
  // waiting on the knowledge-gap card, which holds one of their pending slots
  // (migration 041), and a queued holding message would only add a second card
  // for the same question.
  it('treats a queue verdict as a failed attempt and retries', async () => {
    applyApprovalPolicyStageMock
      .mockResolvedValueOnce({
        action: 'queue',
        triggers: ['model_flagged'],
        primaryTrigger: 'model_flagged',
        compMatchedPattern: null,
        // TAC-364: the gate ALWAYS returns this on a queue decision (it is
        // required on ApprovalDecision), so a fixture omitting it would feed
        // `undefined` down a path production never produces. null is what a
        // followup / skipped-check turn actually carries — see ruling 3.
        ungroundedClaims: null,
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

  // TAC-307: the same reasoning on the approval-policy axis. This MUST be a
  // suppression rather than a gate outcome — tryGenerateHolding treats a queue
  // verdict as a failure and the failure ladder ends in sendFallback, which
  // bypasses the gate entirely. A policy hold enforced at the gate would be
  // converted straight into an ungated send one line later.
  it('suppresses when the venue holds everything by approval policy', async () => {
    buildRuntimeContextMock.mockResolvedValue({
      ...makeCtx(),
      venue: {
        id: 'venue-1',
        timezone: 'America/Los_Angeles',
        holdAllOutbound: false,
        approvalPolicy: { default: 'operator_approval', perCategory: {} },
      },
    })
    const r = await handleHoldingMessage({
      venueId: 'venue-1',
      guestId: 'guest-1',
      pendingQuestion: QUESTION,
    })
    expect(r).toEqual({ status: 'suppressed', reason: 'policy_hold' })
    expect(scheduleAndSendMock).not.toHaveBeenCalled()
  })

  it("suppresses when the venue holds the holding message's own category", async () => {
    // HOLDING_MESSAGE_CATEGORY is 'manual'; a venue that ticked that box has
    // said this exact kind of message waits.
    buildRuntimeContextMock.mockResolvedValue({
      ...makeCtx(),
      venue: {
        id: 'venue-1',
        timezone: 'America/Los_Angeles',
        holdAllOutbound: false,
        approvalPolicy: { default: 'auto_send', perCategory: { manual: 'operator_approval' } },
      },
    })
    const r = await handleHoldingMessage({
      venueId: 'venue-1',
      guestId: 'guest-1',
      pendingQuestion: QUESTION,
    })
    expect(r).toEqual({ status: 'suppressed', reason: 'policy_hold' })
  })

  it('still sends when approval policy holds some OTHER category', async () => {
    buildRuntimeContextMock.mockResolvedValue({
      ...makeCtx(),
      venue: {
        id: 'venue-1',
        timezone: 'America/Los_Angeles',
        holdAllOutbound: false,
        approvalPolicy: { default: 'auto_send', perCategory: { comp_complaint: 'operator_approval' } },
      },
    })
    const r = await handleHoldingMessage({
      venueId: 'venue-1',
      guestId: 'guest-1',
      pendingQuestion: QUESTION,
    })
    expect(r.status).not.toBe('suppressed')
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
