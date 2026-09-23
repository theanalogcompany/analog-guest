// TAC-299. Tests for the operator-initiated decline orchestrator.
//
// Two layers:
//
//   1. Structural invariant tests: read the source file and assert that
//      neither `scheduleAndSend` nor `sendMessage` is imported. This is
//      the load-bearing "persist-pending, not auto-send" guarantee — a
//      regression would have to ADD the import to silently text a guest.
//      Belt-and-suspenders alongside the route's structural review.
//
//   2. Behavior tests: mock the stage functions and verify the pipeline
//      routes appropriately on each terminal status (queued / refused /
//      failed) and threads commitment metadata through correctly.

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// ---- structural invariant ----

describe('handle-operator-decline structural invariants (TAC-299)', () => {
  const source = readFileSync(
    resolve(__dirname, 'handle-operator-decline.ts'),
    'utf-8',
  )

  // Extract the imported identifiers from the file. Codebase convention is
  // curly-brace named imports (no default imports anywhere in lib/agent),
  // so a regex against `import { ... } from '...'` blocks covers every case.
  // Multi-line imports are supported because the `[^}]` character class
  // matches newlines by default (we DON'T need the `s` flag — that only
  // affects how `.` behaves). Both `import { ... }` and `import type { ... }`
  // are captured.
  function importedIdentifiers(src: string): Set<string> {
    const out = new Set<string>()
    const re = /import\s+(?:type\s+)?\{([^}]+)\}\s+from\s+['"][^'"]+['"]/g
    let m: RegExpExecArray | null
    while ((m = re.exec(src)) !== null) {
      for (const name of m[1].split(',')) {
        const trimmed = name.trim().split(/\s+as\s+/)[0].trim()
        if (trimmed.length > 0) out.add(trimmed)
      }
    }
    return out
  }

  const imports = importedIdentifiers(source)

  it('does NOT import scheduleAndSend (persist-not-send is structural)', () => {
    expect(imports.has('scheduleAndSend')).toBe(false)
  })

  it('does NOT import sendMessage (no Sendblue dispatch on this path)', () => {
    expect(imports.has('sendMessage')).toBe(false)
  })

  it('does NOT import applyApprovalPolicyStage (decline bypasses the gate)', () => {
    expect(imports.has('applyApprovalPolicyStage')).toBe(false)
  })

  it('DOES import persistOrRegenQueuedDraft (the persist-pending entry)', () => {
    expect(imports.has('persistOrRegenQueuedDraft')).toBe(true)
  })
})

// ---- behavior tests ----

// The end-to-end binding test below importActual's ./stages for the real
// buildAiRuntime. stages.ts reaches Voyage at module load, whose ESM build
// trips vitest's directory-import resolver — the documented trap. Mock the SDK
// leaf only, exactly as lib/tunables/manifest.test.ts does; buildAiRuntime is
// pure and never touches it.
vi.mock('voyageai', () => ({
  VoyageAIClient: class {},
}))

const buildRuntimeContextMock = vi.fn()
const retrieveCorpusStageMock = vi.fn()
const generateStageMock = vi.fn()
const verifyProsePromiseStageMock = vi.fn()
const loadPendingRowsBySlotMock = vi.fn()
const captureDraftDroppedMock = vi.fn()
const persistOrRegenQueuedDraftMock = vi.fn()
const fireRedAlertMock = vi.fn()
const dispatchArrivalCaptureMock = vi.fn()
const updateGuestContextMock = vi.fn()
const captureDraftQueuedMock = vi.fn()
const captureDraftRegeneratedMock = vi.fn()
const captureAgentLatencyHighMock = vi.fn()

vi.mock('./build-runtime-context', () => ({
  buildRuntimeContext: (...args: unknown[]) => buildRuntimeContextMock(...args),
}))
// TAC-527: this factory is an explicit ALLOW-LIST, so a stage the source
// imports and this object omits arrives `undefined`. The decline path wraps
// its prose-promise call in a try/catch that degrades to 'check_failed', so an
// omission here would leave the carrier permanently null while every test in
// this file stayed green — this repo's documented handle-inbound.test.ts trap.
vi.mock('./stages', () => ({
  retrieveCorpusStage: (...args: unknown[]) => retrieveCorpusStageMock(...args),
  generateStage: (...args: unknown[]) => generateStageMock(...args),
  verifyProsePromiseStage: (...args: unknown[]) => verifyProsePromiseStageMock(...args),
}))
// TAC-394: only the slot read is mocked. decideSlotAction and the identity
// helpers run REAL, so which card a decline regenerates is decided by the code
// under test, not by a fixture.
vi.mock('./pending-slots', async () => {
  const actual = await vi.importActual<typeof import('./pending-slots')>('./pending-slots')
  return {
    ...actual,
    loadPendingRowsBySlot: (...args: unknown[]) => loadPendingRowsBySlotMock(...args),
  }
})
vi.mock('./schedule-and-send', () => ({
  persistOrRegenQueuedDraft: (...args: unknown[]) =>
    persistOrRegenQueuedDraftMock(...args),
}))
vi.mock('./alerts', () => ({
  fireRedAlert: (...args: unknown[]) => fireRedAlertMock(...args),
}))
vi.mock('./dispatch-arrival-capture', () => ({
  dispatchArrivalCapture: (...args: unknown[]) =>
    dispatchArrivalCaptureMock(...args),
}))
vi.mock('@/lib/guests/context', () => ({
  isEmptyContextUpdate: () => true,
  updateGuestContext: (...args: unknown[]) => updateGuestContextMock(...args),
}))
vi.mock('@/lib/analytics/posthog', () => ({
  AGENT_LATENCY_HIGH_THRESHOLD_MS: 10_000,
  captureAgentLatencyHigh: (...args: unknown[]) =>
    captureAgentLatencyHighMock(...args),
  captureDraftDropped: (...args: unknown[]) => captureDraftDroppedMock(...args),
  captureDraftQueued: (...args: unknown[]) => captureDraftQueuedMock(...args),
  captureDraftRegenerated: (...args: unknown[]) =>
    captureDraftRegeneratedMock(...args),
}))
vi.mock('@/lib/observability', () => ({
  startAgentTrace: () => ({
    id: '',
    captureContent: false,
    span: () => ({
      span: () => ({
        end: () => undefined,
      }),
      end: () => undefined,
      generation: () => ({ end: () => undefined }),
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
  buildRecognitionContent: () => ({}),
}))

import { handleOperatorDecline } from './handle-operator-decline'

const VENUE_ID = '00000000-0000-0000-0000-00000000000a'
const GUEST_ID = '11111111-1111-4111-8111-111111111111'
const COMMITMENT_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const MESSAGE_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const EXISTING_PENDING_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
// TAC-389 ruling 4: a sibling the guest also has open. The production shape,
// and the one the old `activeCommitments: []` fixture could not reach: this
// path always has at least the declined row, because the route loaded it by id
// to get here.
const SIBLING_COMMITMENT_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'

function makeCtx() {
  return {
    agentRunId: 'agent-run-1',
    venue: { id: VENUE_ID, slug: 'v', brandPersona: {}, venueInfo: { hours: {} }, timezone: 'UTC', sendblueNumber: '+1', holdAllOutbound: false },
    guest: {
      id: GUEST_ID,
      phoneNumber: '+1',
      firstName: 'Sam',
      createdAt: new Date(),
      createdVia: 'inbound_message',
      isDemo: false,
      context: {},
    },
    currentMessage: null,
    followupTrigger: null as unknown,
    recentMessages: [],
    recognition: {
      score: 0.5,
      state: 'regular',
      signals: {},
      computedAt: new Date(),
    },
    mechanics: [],
    recentVisits: [],
    // TAC-389 ruling 4: production-shaped. The declined row is ALWAYS
    // 'pending_ack' at generation time (the route cancels it only after this
    // run returns), and it is rendered SECOND here on purpose: the incident's
    // own Langfuse prompt had the sibling first and the declined comp second,
    // and findActiveCommitmentsForGuest orders oldest-first, so a filter that
    // kept the head of the list would pass a fixture that put the declined row
    // first.
    activeCommitments: [
      {
        id: SIBLING_COMMITMENT_ID,
        type: 'recommendation',
        description: 'the Pink Panther',
        code: null,
        status: 'open',
        expected_arrival: null,
        arrival_signal: null,
        created_at: '2026-09-14T08:00:00.000Z',
      },
      {
        id: COMMITMENT_ID,
        type: 'comp',
        description: 'cortado replacement',
        code: '7K2P',
        status: 'pending_ack',
        expected_arrival: null,
        arrival_signal: 'imminent',
        created_at: '2026-09-14T08:30:00.000Z',
      },
    ],
    openIntentions: [],
    intentionDerivation: { newlyEligible: [], brakeEngaged: false },
    corpus: null,
    knowledgeCorpus: null,
    classification: null,
    trace: {
      id: '',
      captureContent: false,
    },
  }
}

function makeGenerationResult() {
  return {
    body: 'so sorry, we ran out of the olive cake today',
    voiceFidelity: 0.85,
    promptVersion: 'v1.16.0',
    attempts: 1,
    attemptScores: [0.85],
    attemptHistory: [],
    systemPrompt: '',
    userPrompt: '',
    requiresOperatorApproval: false,
    approvalReason: '',
    contextUpdate: {},
    commitment: {},
    arrivalCapture: {},
    dashViolationPersisted: false,
    selfTalkViolationPersisted: false,
    emojiDirectiveViolated: false,
  }
}

// TAC-389: what generateStage was actually handed, captured AT CALL TIME.
//
// The mock's recorded argument is a REFERENCE to the same ctx the orchestrator
// mutates, so reading `generateStageMock.mock.calls[0][0].activeCommitments`
// after the run reports the array as it is at assertion time, not as the
// generation saw it. Moving the filter to the line AFTER `generateStage` —
// which is the live defect this ticket exists to fix, the writer seeing every
// sibling — passed all 24 tests that way. Snapshotting inside the mock is what
// makes the ORDERING assertable, and no arrangement of the fixture can.
let commitmentIdsSeenByGenerate: string[] | null = null
let ctxSeenByGenerate: Record<string, unknown> | null = null

function generateSucceedsCapturingCtx() {
  generateStageMock.mockImplementationOnce(async (ctx: unknown) => {
    const live = ctx as { activeCommitments: { id: string }[] }
    commitmentIdsSeenByGenerate = live.activeCommitments.map((c) => c.id)
    // The array is copied, not aliased, for the same reason the ids are: the
    // orchestrator keeps mutating the object after this returns.
    ctxSeenByGenerate = {
      ...(ctx as Record<string, unknown>),
      activeCommitments: [...live.activeCommitments],
    }
    return { status: 'success', result: makeGenerationResult() }
  })
}

// TAC-394: a pending row as loadPendingRowsBySlot returns it.
function pendingRow(id: string, body: string, pendingCommitment: unknown = null) {
  return {
    id,
    body,
    pending_until: null,
    review_reason: 'model_flagged',
    pending_commitment: pendingCommitment,
    created_at: '2026-09-14T16:00:00.000Z',
  }
}

beforeEach(() => {
  buildRuntimeContextMock.mockReset()
  // TAC-527: explicit, never a bare mockReset. An undefined resolution reads
  // as a thrown TypeError inside the orchestrator and degrades to
  // 'check_failed', which is a DIFFERENT state from the clean one most tests
  // here mean to exercise.
  verifyProsePromiseStageMock.mockReset()
  verifyProsePromiseStageMock.mockResolvedValue({ status: 'clean' })
  // TAC-389: mirror production. build-runtime-context.ts puts the trigger it
  // was handed straight onto the ctx it returns (`input.followupTrigger ?? null`),
  // so a fixture that returns `followupTrigger: null` on a path that always has
  // one cannot assert that the flag reaches the generation at all. That is this
  // repo's documented "a mocked behaviour flag must contradict production at
  // your peril" trap.
  buildRuntimeContextMock.mockImplementation(async (input: unknown) => {
    const ctx = makeCtx()
    ctx.followupTrigger =
      (input as { followupTrigger?: unknown }).followupTrigger ?? null
    return ctx
  })
  retrieveCorpusStageMock.mockReset()
  retrieveCorpusStageMock.mockResolvedValue([])
  generateStageMock.mockReset()
  commitmentIdsSeenByGenerate = null
  ctxSeenByGenerate = null
  loadPendingRowsBySlotMock.mockReset()
  loadPendingRowsBySlotMock.mockResolvedValue({ obligation: null, conversation: [] })
  captureDraftDroppedMock.mockReset()
  captureDraftDroppedMock.mockResolvedValue(undefined)
  persistOrRegenQueuedDraftMock.mockReset()
  fireRedAlertMock.mockReset()
  fireRedAlertMock.mockResolvedValue(undefined)
  dispatchArrivalCaptureMock.mockReset()
  dispatchArrivalCaptureMock.mockResolvedValue({ kind: 'noop' })
  updateGuestContextMock.mockReset()
  captureDraftQueuedMock.mockReset()
  captureDraftQueuedMock.mockResolvedValue(undefined)
  captureDraftRegeneratedMock.mockReset()
  captureDraftRegeneratedMock.mockResolvedValue(undefined)
  captureAgentLatencyHighMock.mockReset()
})

afterEach(() => {
  vi.clearAllMocks()
})

describe('handleOperatorDecline', () => {
  it('returns queued with primaryTrigger=operator_decline_initiated on the happy path', async () => {
    generateStageMock.mockResolvedValueOnce({
      status: 'success',
      result: makeGenerationResult(),
    })
    persistOrRegenQueuedDraftMock.mockResolvedValueOnce({
      outboundMessageId: MESSAGE_ID,
      action: 'inserted',
      priorReviewReason: null,
    })

    const result = await handleOperatorDecline({
      venueId: VENUE_ID,
      guestId: GUEST_ID,
      commitmentId: COMMITMENT_ID,
      commitmentDescription: 'olive cake',
    })

    expect(result).toEqual({
      status: 'queued',
      outboundMessageId: MESSAGE_ID,
      triggers: ['operator_decline_initiated'],
      primaryTrigger: 'operator_decline_initiated',
    })
  })

  it('threads commitment description into the FollowupTrigger.metadata.hint', async () => {
    generateStageMock.mockResolvedValueOnce({
      status: 'success',
      result: makeGenerationResult(),
    })
    persistOrRegenQueuedDraftMock.mockResolvedValueOnce({
      outboundMessageId: MESSAGE_ID,
      action: 'inserted',
      priorReviewReason: null,
    })

    await handleOperatorDecline({
      venueId: VENUE_ID,
      guestId: GUEST_ID,
      commitmentId: COMMITMENT_ID,
      commitmentDescription: 'orange polenta cake',
    })

    expect(buildRuntimeContextMock).toHaveBeenCalledOnce()
    const ctxArg = buildRuntimeContextMock.mock.calls[0][0] as {
      followupTrigger?: { reason: string; metadata?: { hint?: string } }
    }
    expect(ctxArg.followupTrigger?.reason).toBe('manual')
    expect(ctxArg.followupTrigger?.metadata?.hint).toContain('orange polenta cake')
    expect(ctxArg.followupTrigger?.metadata?.hint).toContain("can't fulfill")
  })

  // ---- TAC-389: the structural anchor ----

  it('hands generateStage ONLY the commitment being declined', async () => {
    generateSucceedsCapturingCtx()
    persistOrRegenQueuedDraftMock.mockResolvedValueOnce({
      outboundMessageId: MESSAGE_ID,
      action: 'inserted',
      priorReviewReason: null,
    })

    await handleOperatorDecline({
      venueId: VENUE_ID,
      guestId: GUEST_ID,
      commitmentId: COMMITMENT_ID,
      commitmentDescription: 'cortado replacement',
    })

    expect(generateStageMock).toHaveBeenCalledOnce()
    // The set, not just its head: a filter that kept the first row would make
    // a length assertion alone pass on a differently-ordered fixture. And
    // captured at call time, so the FILTER RUNNING LATE fails here.
    expect(commitmentIdsSeenByGenerate).toEqual([COMMITMENT_ID])
  })

  it('drops the sibling the 2026-09-14 incident draft named instead', async () => {
    generateSucceedsCapturingCtx()
    persistOrRegenQueuedDraftMock.mockResolvedValueOnce({
      outboundMessageId: MESSAGE_ID,
      action: 'inserted',
      priorReviewReason: null,
    })

    await handleOperatorDecline({
      venueId: VENUE_ID,
      guestId: GUEST_ID,
      commitmentId: COMMITMENT_ID,
      commitmentDescription: 'cortado replacement',
    })

    expect(commitmentIdsSeenByGenerate).not.toContain(SIBLING_COMMITMENT_ID)
  })

  it('leaves the block empty when the declined row is no longer active', async () => {
    // A race: cancelled or acknowledged between the route's load and this run,
    // or findActiveCommitmentsForGuest failed and buildRuntimeContext fell back
    // to []. The filter yields nothing, and nothing invents a row to stand in.
    buildRuntimeContextMock.mockImplementationOnce(async () => {
      const ctx = makeCtx()
      ctx.activeCommitments = ctx.activeCommitments.filter(
        (c) => c.id !== COMMITMENT_ID,
      )
      return ctx
    })
    generateSucceedsCapturingCtx()
    persistOrRegenQueuedDraftMock.mockResolvedValueOnce({
      outboundMessageId: MESSAGE_ID,
      action: 'inserted',
      priorReviewReason: null,
    })

    const result = await handleOperatorDecline({
      venueId: VENUE_ID,
      guestId: GUEST_ID,
      commitmentId: COMMITMENT_ID,
      commitmentDescription: 'cortado replacement',
    })

    expect(commitmentIdsSeenByGenerate).toEqual([])
    expect(result.status).toBe('queued')
  })

  it('marks the trigger isOperatorDecline so the prompt gets the decline intro', async () => {
    generateSucceedsCapturingCtx()
    persistOrRegenQueuedDraftMock.mockResolvedValueOnce({
      outboundMessageId: MESSAGE_ID,
      action: 'inserted',
      priorReviewReason: null,
    })

    await handleOperatorDecline({
      venueId: VENUE_ID,
      guestId: GUEST_ID,
      commitmentId: COMMITMENT_ID,
      commitmentDescription: 'cortado replacement',
    })

    const ctxArg = buildRuntimeContextMock.mock.calls[0][0] as {
      followupTrigger?: { reason: string; isOperatorDecline?: boolean }
    }
    // reason='manual' is shared with ordinary Command Center follow-ups, so it
    // cannot carry this on its own.
    expect(ctxArg.followupTrigger?.reason).toBe('manual')
    expect(ctxArg.followupTrigger?.isOperatorDecline).toBe(true)
    // And it survives the round trip onto the ctx the generation reads it from.
    const generatedWith = generateStageMock.mock.calls[0][0] as {
      followupTrigger?: { isOperatorDecline?: boolean }
    }
    expect(generatedWith.followupTrigger?.isOperatorDecline).toBe(true)
  })

  it('renders one commitment under the decline intro, end to end', async () => {
    // The intro claims "it is the only promise listed here". That claim is
    // true because a DIFFERENT module filtered, so nothing in the serializer
    // can make it true on its own and nothing in the orchestrator can see that
    // it was said. This is the only test that holds both halves at once: it
    // takes the ctx the generation was really handed and runs the REAL
    // buildAiRuntime and runtimeToProse over it.
    generateSucceedsCapturingCtx()
    persistOrRegenQueuedDraftMock.mockResolvedValueOnce({
      outboundMessageId: MESSAGE_ID,
      action: 'inserted',
      priorReviewReason: null,
    })

    await handleOperatorDecline({
      venueId: VENUE_ID,
      guestId: GUEST_ID,
      commitmentId: COMMITMENT_ID,
      commitmentDescription: 'cortado replacement',
    })

    const { buildAiRuntime } =
      await vi.importActual<typeof import('./stages')>('./stages')
    const { runtimeToProse } = await vi.importActual<
      typeof import('@/lib/ai/prompts/serializers')
    >('@/lib/ai/prompts/serializers')

    // The SNAPSHOT, not the live ctx: this test is sensitive to the filter
    // running late as well as to it filtering wrongly.
    const prose = runtimeToProse(
      buildAiRuntime(ctxSeenByGenerate as unknown as Parameters<typeof buildAiRuntime>[0]),
      'manual',
      new Date(),
    )

    const block = prose
      .slice(prose.indexOf('## Active commitments'))
      .split('\n\n')[0]
    expect(block).toContain('The promise this message is declining.')
    const rows = block.split('\n').filter((l) => l.startsWith('- ['))
    expect(rows).toHaveLength(1)
    expect(rows[0]).toContain('cortado replacement')
    expect(rows[0]).not.toContain('Pink Panther')
  })

  it('passes existingPendingDraftId through to persistOrRegenQueuedDraft when found', async () => {
    loadPendingRowsBySlotMock.mockResolvedValueOnce({
      obligation: null,
      conversation: [pendingRow(EXISTING_PENDING_ID, 'prior draft')],
    })
    generateStageMock.mockResolvedValueOnce({
      status: 'success',
      result: makeGenerationResult(),
    })
    persistOrRegenQueuedDraftMock.mockResolvedValueOnce({
      outboundMessageId: EXISTING_PENDING_ID,
      action: 'updated',
      priorReviewReason: 'model_flagged',
    })

    const result = await handleOperatorDecline({
      venueId: VENUE_ID,
      guestId: GUEST_ID,
      commitmentId: COMMITMENT_ID,
      commitmentDescription: 'olive cake',
    })

    expect(persistOrRegenQueuedDraftMock).toHaveBeenCalledOnce()
    // signature: (ctx, generation, primaryTrigger, existingPendingDraftId, options)
    const persistArgs = persistOrRegenQueuedDraftMock.mock.calls[0]
    expect(persistArgs[2]).toBe('operator_decline_initiated')
    expect(persistArgs[3]).toBe(EXISTING_PENDING_ID)
    // TAC-394: race recovery decides with the decline's own policy.
    // TAC-527: and carries the prose-promise carrier, null on a clean check.
    expect(persistArgs[4]).toEqual({ callerPolicy: 'regen_always', promisedCommitment: null })
    expect(result.status).toBe('queued')
  })

  it('passes null existingPendingDraftId when neither slot holds a card', async () => {
    loadPendingRowsBySlotMock.mockResolvedValueOnce({ obligation: null, conversation: [] })
    generateStageMock.mockResolvedValueOnce({
      status: 'success',
      result: makeGenerationResult(),
    })
    persistOrRegenQueuedDraftMock.mockResolvedValueOnce({
      outboundMessageId: MESSAGE_ID,
      action: 'inserted',
      priorReviewReason: null,
    })

    await handleOperatorDecline({
      venueId: VENUE_ID,
      guestId: GUEST_ID,
      commitmentId: COMMITMENT_ID,
      commitmentDescription: 'olive cake',
    })

    expect(persistOrRegenQueuedDraftMock.mock.calls[0][3]).toBeNull()
  })

  it('fires captureDraftQueued on INSERT path', async () => {
    loadPendingRowsBySlotMock.mockResolvedValueOnce({ obligation: null, conversation: [] })
    generateStageMock.mockResolvedValueOnce({
      status: 'success',
      result: makeGenerationResult(),
    })
    persistOrRegenQueuedDraftMock.mockResolvedValueOnce({
      outboundMessageId: MESSAGE_ID,
      action: 'inserted',
      priorReviewReason: null,
    })

    await handleOperatorDecline({
      venueId: VENUE_ID,
      guestId: GUEST_ID,
      commitmentId: COMMITMENT_ID,
      commitmentDescription: 'olive cake',
    })

    expect(captureDraftQueuedMock).toHaveBeenCalledOnce()
    expect(captureDraftRegeneratedMock).not.toHaveBeenCalled()
  })

  it('fires captureDraftRegenerated on UPDATE-in-place path', async () => {
    loadPendingRowsBySlotMock.mockResolvedValueOnce({
      obligation: null,
      conversation: [pendingRow(EXISTING_PENDING_ID, 'prior')],
    })
    generateStageMock.mockResolvedValueOnce({
      status: 'success',
      result: makeGenerationResult(),
    })
    persistOrRegenQueuedDraftMock.mockResolvedValueOnce({
      outboundMessageId: EXISTING_PENDING_ID,
      action: 'updated',
      priorReviewReason: 'model_flagged',
    })

    await handleOperatorDecline({
      venueId: VENUE_ID,
      guestId: GUEST_ID,
      commitmentId: COMMITMENT_ID,
      commitmentDescription: 'olive cake',
    })

    expect(captureDraftRegeneratedMock).toHaveBeenCalledOnce()
    const props = captureDraftRegeneratedMock.mock.calls[0][0] as {
      priorReviewReason: string | null
      primaryTrigger: string
    }
    expect(props.priorReviewReason).toBe('model_flagged')
    expect(props.primaryTrigger).toBe('operator_decline_initiated')
    expect(captureDraftQueuedMock).not.toHaveBeenCalled()
  })

  it('returns refused when generation refuses (low fidelity loop exhausted)', async () => {
    generateStageMock.mockResolvedValueOnce({
      status: 'refused',
      attemptScores: [0.32, 0.34, 0.36],
      finalScore: 0.36,
    })

    const result = await handleOperatorDecline({
      venueId: VENUE_ID,
      guestId: GUEST_ID,
      commitmentId: COMMITMENT_ID,
      commitmentDescription: 'olive cake',
    })

    expect(result.status).toBe('refused')
    if (result.status === 'refused') {
      expect(result.reason).toBe('low_fidelity')
    }
    expect(persistOrRegenQueuedDraftMock).not.toHaveBeenCalled()
  })

  it('returns failed when generation fails', async () => {
    generateStageMock.mockResolvedValueOnce({
      status: 'failed',
      error: 'anthropic 500',
    })

    const result = await handleOperatorDecline({
      venueId: VENUE_ID,
      guestId: GUEST_ID,
      commitmentId: COMMITMENT_ID,
      commitmentDescription: 'olive cake',
    })

    expect(result.status).toBe('failed')
    if (result.status === 'failed') {
      expect(result.stage).toBe('generation')
      expect(result.error).toBe('anthropic 500')
    }
    expect(persistOrRegenQueuedDraftMock).not.toHaveBeenCalled()
  })

  it('returns failed/persist when persistOrRegenQueuedDraft throws', async () => {
    generateStageMock.mockResolvedValueOnce({
      status: 'success',
      result: makeGenerationResult(),
    })
    persistOrRegenQueuedDraftMock.mockRejectedValueOnce(new Error('connection lost'))

    const result = await handleOperatorDecline({
      venueId: VENUE_ID,
      guestId: GUEST_ID,
      commitmentId: COMMITMENT_ID,
      commitmentDescription: 'olive cake',
    })

    expect(result.status).toBe('failed')
    if (result.status === 'failed') {
      expect(result.stage).toBe('persist')
    }
  })

  it('returns failed when buildRuntimeContext throws', async () => {
    buildRuntimeContextMock.mockRejectedValueOnce(new Error('guest not found'))

    const result = await handleOperatorDecline({
      venueId: VENUE_ID,
      guestId: GUEST_ID,
      commitmentId: COMMITMENT_ID,
      commitmentDescription: 'olive cake',
    })

    expect(result.status).toBe('failed')
    if (result.status === 'failed') {
      expect(result.stage).toBe('context_build')
    }
    expect(persistOrRegenQueuedDraftMock).not.toHaveBeenCalled()
  })

  it('does NOT call retrieveKnowledgeStage (declines skip knowledge corpus)', async () => {
    generateStageMock.mockResolvedValueOnce({
      status: 'success',
      result: makeGenerationResult(),
    })
    persistOrRegenQueuedDraftMock.mockResolvedValueOnce({
      outboundMessageId: MESSAGE_ID,
      action: 'inserted',
      priorReviewReason: null,
    })

    await handleOperatorDecline({
      venueId: VENUE_ID,
      guestId: GUEST_ID,
      commitmentId: COMMITMENT_ID,
      commitmentDescription: 'olive cake',
    })

    // generateStage is called; that's the only stage that consumes
    // ctx.knowledgeCorpus. We confirm via the absence of any
    // retrieveKnowledgeStage mock import (it's not in the orchestrator's
    // import list per the structural test above).
    expect(generateStageMock).toHaveBeenCalledOnce()
  })
})

describe('handleOperatorDecline: two pending slots (TAC-394)', () => {
  const COMP_A = {
    type: 'comp',
    description: 'a free cortado on your next visit',
    code: '7K2P',
    expiresAt: null,
  }
  const INPUT = {
    venueId: VENUE_ID,
    guestId: GUEST_ID,
    commitmentId: COMMITMENT_ID,
    commitmentDescription: 'olive cake',
  }

  // TAC-299's rule that a decline supersedes the pending reply now applies to
  // the reply in its own slot. The comp card beside it is left alone.
  it('regenerates the conversation card, never the comp card beside it', async () => {
    loadPendingRowsBySlotMock.mockResolvedValueOnce({
      obligation: pendingRow('card-a', "the next one's on us", COMP_A),
      conversation: [pendingRow('card-conv', 'we open at 7')],
    })
    generateStageMock.mockResolvedValueOnce({ status: 'success', result: makeGenerationResult() })
    persistOrRegenQueuedDraftMock.mockResolvedValueOnce({
      outboundMessageId: 'card-conv',
      action: 'updated',
      priorReviewReason: 'model_flagged',
    })

    const result = await handleOperatorDecline(INPUT)

    const persistArgs = persistOrRegenQueuedDraftMock.mock.calls[0]
    expect(persistArgs[3]).toBe('card-conv')
    expect(persistArgs[4]).toEqual({ callerPolicy: 'regen_always', promisedCommitment: null })
    expect(result.status).toBe('queued')
  })

  it('records the slot it took and that the comp card holds the other one', async () => {
    loadPendingRowsBySlotMock.mockResolvedValueOnce({
      obligation: pendingRow('card-a', "the next one's on us", COMP_A),
      conversation: [],
    })
    generateStageMock.mockResolvedValueOnce({ status: 'success', result: makeGenerationResult() })
    persistOrRegenQueuedDraftMock.mockResolvedValueOnce({
      outboundMessageId: MESSAGE_ID,
      action: 'inserted',
      priorReviewReason: null,
    })

    await handleOperatorDecline(INPUT)

    expect(persistOrRegenQueuedDraftMock.mock.calls[0][3]).toBeNull()
    expect(captureDraftQueuedMock).toHaveBeenCalledWith(
      expect.objectContaining({
        slot: 'conversation',
        otherSlotOccupied: true,
        hasPreviousPending: false,
      }),
    )
  })

  // No path overwrites one obligation with another. A decline draft carrying a
  // DIFFERENT comp than the pending comp card is dropped before any write, and
  // the alert names both offers and the guest.
  it('drops a decline draft carrying a different comp, and writes nothing', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    loadPendingRowsBySlotMock.mockResolvedValueOnce({
      obligation: pendingRow('card-a', "the next one's on us", COMP_A),
      conversation: [],
    })
    generateStageMock.mockResolvedValueOnce({
      status: 'success',
      result: {
        ...makeGenerationResult(),
        commitment: { type: 'comp', description: 'a free croissant' },
      },
    })

    const result = await handleOperatorDecline(INPUT)

    expect(result).toEqual({
      status: 'dropped',
      reason: 'obligation_slot_taken',
      protectedDraftId: 'card-a',
      triggers: ['operator_decline_initiated'],
    })
    expect(persistOrRegenQueuedDraftMock).not.toHaveBeenCalled()
    expect(captureDraftQueuedMock).not.toHaveBeenCalled()
    expect(captureDraftDroppedMock).toHaveBeenCalledWith({
      agentRunId: expect.any(String),
      venueId: VENUE_ID,
      guestId: GUEST_ID,
      guestFirstName: 'Sam',
      guestPhone: '+1',
      reason: 'obligation_slot_taken',
      protectedDraftId: 'card-a',
      protectedCommitment: {
        type: 'comp',
        description: 'a free cortado on your next visit',
        code: '7K2P',
      },
      droppedCommitment: { type: 'comp', description: 'a free croissant', code: null },
      triggers: ['operator_decline_initiated'],
      kind: 'followup',
      category: 'manual',
      droppedBody: 'so sorry, we ran out of the olive cake today',
    })
    warn.mockRestore()
  })

  it('reports a drop found during the write the same way', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    generateStageMock.mockResolvedValueOnce({
      status: 'success',
      result: {
        ...makeGenerationResult(),
        commitment: { type: 'comp', description: 'a free croissant' },
      },
    })
    persistOrRegenQueuedDraftMock.mockResolvedValueOnce({
      outboundMessageId: null,
      action: 'dropped',
      priorReviewReason: null,
      reason: 'obligation_slot_taken',
      protectedDraftId: 'card-a',
      protectedCommitment: {
        type: 'comp',
        description: 'a free cortado on your next visit',
        code: '7K2P',
      },
      droppedCommitment: { type: 'comp', description: 'a free croissant', code: null },
    })

    const result = await handleOperatorDecline(INPUT)

    expect(result).toEqual({
      status: 'dropped',
      reason: 'obligation_slot_taken',
      protectedDraftId: 'card-a',
      triggers: ['operator_decline_initiated'],
    })
    expect(captureDraftDroppedMock).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'obligation_slot_taken', protectedDraftId: 'card-a' }),
    )
    expect(captureDraftQueuedMock).not.toHaveBeenCalled()
    warn.mockRestore()
  })

  // A failed read fails OPEN to the INSERT path. If a card is actually there,
  // the slot's unique index and race recovery decide again with the same policy.
  it('inserts when the slot read fails', async () => {
    loadPendingRowsBySlotMock.mockResolvedValueOnce(null)
    generateStageMock.mockResolvedValueOnce({ status: 'success', result: makeGenerationResult() })
    persistOrRegenQueuedDraftMock.mockResolvedValueOnce({
      outboundMessageId: MESSAGE_ID,
      action: 'inserted',
      priorReviewReason: null,
    })

    const result = await handleOperatorDecline(INPUT)

    const persistArgs = persistOrRegenQueuedDraftMock.mock.calls[0]
    expect(persistArgs[3]).toBeNull()
    expect(persistArgs[4]).toEqual({ callerPolicy: 'regen_always', promisedCommitment: null })
    expect(result.status).toBe('queued')
  })
})

// TAC-527 gap B. This path skips applyApprovalPolicyStage by design, and the
// prose-promise check is called from the gate's CALLERS rather than the gate,
// so it was skipped here too and the persist call supplied no carrier. A
// decline draft promising a comp in prose created nothing on approval — the
// reported incident's defect on a different route.
describe('handleOperatorDecline: a prose promise in a decline draft (TAC-527)', () => {
  const PROMISED_COMP = {
    type: 'comp' as const,
    description: 'a replacement olive cake',
    code: 'QQ41',
    expiresAt: null,
  }
  const OTHER_COMP = {
    type: 'comp',
    description: 'a free cortado on your next visit',
    code: '7K2P',
    expiresAt: null,
  }
  const INPUT = {
    venueId: VENUE_ID,
    guestId: GUEST_ID,
    commitmentId: COMMITMENT_ID,
    commitmentDescription: 'olive cake',
  }

  it('persists the carrier the check named, so approving creates the comp', async () => {
    loadPendingRowsBySlotMock.mockResolvedValueOnce({ obligation: null, conversation: [] })
    verifyProsePromiseStageMock.mockResolvedValueOnce({
      status: 'flagged',
      commitment: PROMISED_COMP,
    })
    generateStageMock.mockResolvedValueOnce({
      status: 'success',
      // No structured commitment: the promise is in the prose only, which is
      // the whole shape of this defect.
      result: { ...makeGenerationResult(), body: "sorry, we're out. next one's on us" },
    })
    persistOrRegenQueuedDraftMock.mockResolvedValueOnce({
      outboundMessageId: MESSAGE_ID,
      action: 'inserted',
      priorReviewReason: null,
    })

    const result = await handleOperatorDecline(INPUT)

    expect(result.status).toBe('queued')
    expect(persistOrRegenQueuedDraftMock.mock.calls[0][4]).toEqual({
      callerPolicy: 'regen_always',
      promisedCommitment: PROMISED_COMP,
    })
  })

  // AC5, on this route. A decline that gives nothing away must not mint an
  // obligation just because it is a decline.
  it('persists NO carrier when the check finds no promise', async () => {
    loadPendingRowsBySlotMock.mockResolvedValueOnce({ obligation: null, conversation: [] })
    verifyProsePromiseStageMock.mockResolvedValueOnce({ status: 'clean' })
    generateStageMock.mockResolvedValueOnce({
      status: 'success',
      result: makeGenerationResult(),
    })
    persistOrRegenQueuedDraftMock.mockResolvedValueOnce({
      outboundMessageId: MESSAGE_ID,
      action: 'inserted',
      priorReviewReason: null,
    })

    await handleOperatorDecline(INPUT)

    expect(persistOrRegenQueuedDraftMock.mock.calls[0][4]).toEqual({
      callerPolicy: 'regen_always',
      promisedCommitment: null,
    })
  })

  // THE DIVERGENCE GUARD, and the reason this ticket moved the slot identity
  // off draftCommitmentIdentity. The slot the decision is made against and the
  // carrier the row persists have to be the same thing. Under the old call the
  // draft below has no structured commitment, so it read as a CONVERSATION
  // draft, regenerated the conversation card and wrote — while persisting a
  // comp carrier. That is the TAC-401 blocker: a flagged draft 23505s into a
  // card the slot decision had left alone.
  it('routes a prose-promised comp to the OBLIGATION slot, and drops rather than overwriting a different comp', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    loadPendingRowsBySlotMock.mockResolvedValueOnce({
      obligation: pendingRow('card-a', "the next one's on us", OTHER_COMP),
      conversation: [pendingRow('card-b', 'an earlier reply')],
    })
    verifyProsePromiseStageMock.mockResolvedValueOnce({
      status: 'flagged',
      commitment: PROMISED_COMP,
    })
    generateStageMock.mockResolvedValueOnce({
      status: 'success',
      result: { ...makeGenerationResult(), body: "sorry, we're out. next one's on us" },
    })

    const result = await handleOperatorDecline(INPUT)

    expect(result).toEqual({
      status: 'dropped',
      reason: 'obligation_slot_taken',
      protectedDraftId: 'card-a',
      triggers: ['operator_decline_initiated'],
    })
    expect(persistOrRegenQueuedDraftMock).not.toHaveBeenCalled()
    warn.mockRestore()
  })

  // Degrades to no carrier, NOT to a hold. There is nothing stronger to fail
  // closed into here: the draft is queued unconditionally already.
  it('still queues with no carrier when the check throws', async () => {
    loadPendingRowsBySlotMock.mockResolvedValueOnce({ obligation: null, conversation: [] })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    verifyProsePromiseStageMock.mockRejectedValueOnce(new Error('boom'))
    generateStageMock.mockResolvedValueOnce({
      status: 'success',
      result: makeGenerationResult(),
    })
    persistOrRegenQueuedDraftMock.mockResolvedValueOnce({
      outboundMessageId: MESSAGE_ID,
      action: 'inserted',
      priorReviewReason: null,
    })

    const result = await handleOperatorDecline(INPUT)

    expect(result.status).toBe('queued')
    expect(persistOrRegenQueuedDraftMock.mock.calls[0][4]).toEqual({
      callerPolicy: 'regen_always',
      promisedCommitment: null,
    })
    warn.mockRestore()
  })
})
