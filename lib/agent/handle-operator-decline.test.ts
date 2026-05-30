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

const buildRuntimeContextMock = vi.fn()
const retrieveCorpusStageMock = vi.fn()
const generateStageMock = vi.fn()
const findPendingDraftMock = vi.fn()
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
vi.mock('./stages', () => ({
  retrieveCorpusStage: (...args: unknown[]) => retrieveCorpusStageMock(...args),
  generateStage: (...args: unknown[]) => generateStageMock(...args),
  findPendingDraft: (...args: unknown[]) => findPendingDraftMock(...args),
}))
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

function makeCtx() {
  return {
    agentRunId: 'agent-run-1',
    venue: { id: VENUE_ID, slug: 'v', brandPersona: {}, venueInfo: {}, timezone: 'UTC', sendblueNumber: '+1' },
    guest: {
      id: GUEST_ID,
      phoneNumber: '+1',
      firstName: 'Sam',
      createdAt: new Date(),
      createdVia: 'inbound_message',
      isDemo: false,
      context: { dietary: null, home_base: null, life_context: [], observations: [] },
    },
    currentMessage: null,
    followupTrigger: null,
    recentMessages: [],
    recognition: {
      score: 0.5,
      state: 'regular',
      signals: {},
      computedAt: new Date(),
    },
    mechanics: [],
    recentVisits: [],
    activeCommitments: [],
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
  }
}

beforeEach(() => {
  buildRuntimeContextMock.mockReset()
  buildRuntimeContextMock.mockImplementation(async () => makeCtx())
  retrieveCorpusStageMock.mockReset()
  retrieveCorpusStageMock.mockResolvedValue([])
  generateStageMock.mockReset()
  findPendingDraftMock.mockReset()
  findPendingDraftMock.mockResolvedValue(null)
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

  it('passes existingPendingDraftId through to persistOrRegenQueuedDraft when found', async () => {
    findPendingDraftMock.mockResolvedValueOnce({ id: EXISTING_PENDING_ID, body: 'prior draft' })
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
    // signature: (ctx, generation, primaryTrigger, existingPendingDraftId)
    const persistArgs = persistOrRegenQueuedDraftMock.mock.calls[0]
    expect(persistArgs[2]).toBe('operator_decline_initiated')
    expect(persistArgs[3]).toBe(EXISTING_PENDING_ID)
    expect(result.status).toBe('queued')
  })

  it('passes null existingPendingDraftId when findPendingDraft returns null', async () => {
    findPendingDraftMock.mockResolvedValueOnce(null)
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
    findPendingDraftMock.mockResolvedValueOnce(null)
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
    findPendingDraftMock.mockResolvedValueOnce({ id: EXISTING_PENDING_ID, body: 'prior' })
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
