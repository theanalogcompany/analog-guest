// Tests for runPostSendChecks (decision 0003, rewritten 2026-09-29): the five
// post-generation checks run AFTER dispatch, inside waitUntil, against a reply
// the guest already has.
//
// Scope: this module's own contract — every check called once with disposition
// 'sent', allSettled semantics (one rejection cannot skip the flush or a
// sibling), the fail-open outer catch, the post-check flush, and the span
// shapes. The stages' own behaviour (retries, degrade states, captures) is
// stages.test.ts's; the orchestrator hop that decides WHEN this runs is
// handle-inbound.test.ts's.
//
// Fixture strategy: './stages' is fully mocked with an explicit factory (the
// allow-list posture lib/agent/CLAUDE.md mandates — a bare vi.fn() resolves
// `undefined`, which Promise.allSettled reports as fulfilled, so every mock
// gets an explicit realistic default). The trace is a hand-built fake whose
// span() records name+input and returns a per-span `end` spy.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { GenerateMessageResult } from '@/lib/ai'
import type { AgentTrace } from '@/lib/observability'
import type { RuntimeContext } from './types'

const verifyGroundingStageMock = vi.fn()
const verifyMechanicOfferStageMock = vi.fn()
const verifyProsePromiseStageMock = vi.fn()
const verifyCancellationClaimStageMock = vi.fn()
const verifyClosedVenueArrivalStageMock = vi.fn()

// Explicit allow-list: post-send-checks.ts imports exactly these five names.
// Mocking the module wholesale also keeps the real stages.ts (and its
// @/lib/rag → voyageai chain) out of the test process entirely.
vi.mock('./stages', () => ({
  verifyGroundingStage: (...a: unknown[]) => verifyGroundingStageMock(...a),
  verifyMechanicOfferStage: (...a: unknown[]) => verifyMechanicOfferStageMock(...a),
  verifyProsePromiseStage: (...a: unknown[]) => verifyProsePromiseStageMock(...a),
  verifyCancellationClaimStage: (...a: unknown[]) => verifyCancellationClaimStageMock(...a),
  verifyClosedVenueArrivalStage: (...a: unknown[]) => verifyClosedVenueArrivalStageMock(...a),
}))

import { runPostSendChecks } from './post-send-checks'

const CHECK_NAMES = [
  'verify_grounding',
  'verify_mechanic_offer',
  'verify_prose_promise',
  'verify_cancellation_claim',
  'verify_closed_venue_arrival',
] as const

const ALL_STAGE_MOCKS = [
  verifyGroundingStageMock,
  verifyMechanicOfferStageMock,
  verifyProsePromiseStageMock,
  verifyCancellationClaimStageMock,
  verifyClosedVenueArrivalStageMock,
]

// Only the fields post-send-checks.ts itself dereferences (guest.isDemo for
// the grounding span's `ran`, mechanics for gatedMechanicCount). The stages
// are mocked, so nothing else on the context is read.
function makeCtx(): RuntimeContext {
  return {
    agentRunId: 'run-1',
    guest: { id: 'guest-1', isDemo: false },
    mechanics: [],
  } as unknown as RuntimeContext
}

function makeGeneration(): GenerateMessageResult {
  return { body: 'see you tomorrow', knowledgeGap: false } as GenerateMessageResult
}

interface RecordedSpan {
  name: string
  input: Record<string, unknown>
  end: ReturnType<typeof vi.fn>
}

function makeTrace() {
  const spans: RecordedSpan[] = []
  const flushAsync = vi.fn(async () => undefined)
  const trace = {
    id: 'trace-1',
    captureContent: false,
    span: vi.fn((name: string, input?: unknown) => {
      const end = vi.fn()
      spans.push({ name, input: input as Record<string, unknown>, end })
      return { id: `span-${spans.length}`, end, update: vi.fn(), span: vi.fn(), generation: vi.fn() }
    }),
    update: vi.fn(),
    flushAsync,
  }
  return { trace: trace as unknown as AgentTrace, spans, flushAsync }
}

function baseArgs(trace: AgentTrace) {
  return {
    ctx: makeCtx(),
    generation: makeGeneration(),
    agentRunId: 'run-1',
    outboundMessageId: 'out-1',
    trace,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
  // Explicit realistic defaults, never bare vi.fn(): the module reads
  // `.status` / `.claim` / `.resolution.status` off each settled value when
  // shaping span outputs and the batch log line.
  verifyGroundingStageMock.mockResolvedValue({ status: 'clean' })
  verifyMechanicOfferStageMock.mockResolvedValue({ status: 'skipped' })
  verifyProsePromiseStageMock.mockResolvedValue({ status: 'clean' })
  verifyCancellationClaimStageMock.mockResolvedValue({
    resolution: { status: 'none' },
    claim: 'clean',
  })
  verifyClosedVenueArrivalStageMock.mockResolvedValue({ status: 'skipped' })
})

describe('runPostSendChecks — the five checks and their arguments', () => {
  it("calls each check exactly once with the ctx, the generation, and disposition 'sent'", async () => {
    const { trace } = makeTrace()
    const args = baseArgs(trace)

    await runPostSendChecks(args)

    for (const mock of ALL_STAGE_MOCKS) {
      expect(mock).toHaveBeenCalledTimes(1)
      // Identity, not shape: the stages must judge the same objects the
      // orchestrator sent, not copies rebuilt here.
      expect(mock.mock.calls[0][0]).toBe(args.ctx)
      expect(mock.mock.calls[0][1]).toBe(args.generation)
      expect(mock.mock.calls[0][2]).toBe('sent')
    }
  })
})

describe('runPostSendChecks — allSettled / fail-open posture', () => {
  it('resolves, keeps the siblings, and still flushes when one check rejects', async () => {
    const { trace, flushAsync } = makeTrace()
    verifyGroundingStageMock.mockRejectedValue(new Error('verifier down'))

    await expect(runPostSendChecks(baseArgs(trace))).resolves.toBeUndefined()

    expect(verifyMechanicOfferStageMock).toHaveBeenCalledTimes(1)
    expect(verifyProsePromiseStageMock).toHaveBeenCalledTimes(1)
    expect(verifyCancellationClaimStageMock).toHaveBeenCalledTimes(1)
    expect(verifyClosedVenueArrivalStageMock).toHaveBeenCalledTimes(1)
    // The allSettled-vs-all discriminator: under Promise.all a single
    // rejection short-circuits into the outer catch and the flush (and the
    // batch log line) never run.
    expect(flushAsync).toHaveBeenCalledTimes(1)
  })

  it('ends the rejecting check’s span as ERROR while the others end normally', async () => {
    const { trace, spans } = makeTrace()
    verifyGroundingStageMock.mockRejectedValue(new Error('verifier down'))

    await runPostSendChecks(baseArgs(trace))

    const grounding = spans.find((s) => s.name === 'verify_grounding')
    expect(grounding).toBeDefined()
    expect(grounding!.end).toHaveBeenCalledTimes(1)
    expect(grounding!.end.mock.calls[0][0]).toMatchObject({
      level: 'ERROR',
      statusMessage: 'verifier down',
    })
    for (const s of spans.filter((s) => s.name !== 'verify_grounding')) {
      expect(s.end).toHaveBeenCalledTimes(1)
      expect(s.end.mock.calls[0][0]).not.toMatchObject({ level: 'ERROR' })
    }
  })

  it('never throws when trace.flushAsync rejects', async () => {
    const { trace, flushAsync } = makeTrace()
    flushAsync.mockRejectedValue(new Error('langfuse unreachable'))

    await expect(runPostSendChecks(baseArgs(trace))).resolves.toBeUndefined()
  })
})

describe('runPostSendChecks — the trace', () => {
  it('flushes once, and only after every check span has ended', async () => {
    const { trace, spans, flushAsync } = makeTrace()
    let endedAtFlushTime = -1
    flushAsync.mockImplementation(async () => {
      endedAtFlushTime = spans.filter((s) => s.end.mock.calls.length > 0).length
    })

    await runPostSendChecks(baseArgs(trace))

    expect(flushAsync).toHaveBeenCalledTimes(1)
    // Snapshotted INSIDE the flush mock: an after-the-fact count cannot tell
    // "flushed after the checks" from "flushed before them".
    expect(endedAtFlushTime).toBe(5)
  })

  it("opens one span per check under the unchanged names, input carrying disposition 'sent' and the outbound id, and ends each", async () => {
    const { trace, spans } = makeTrace()

    await runPostSendChecks(baseArgs(trace))

    expect(spans.map((s) => s.name)).toEqual([...CHECK_NAMES])
    for (const s of spans) {
      // The names are pinned so existing Langfuse queries keep matching; the
      // input fields are what keeps the two placements countable apart.
      expect(s.input).toMatchObject({ disposition: 'sent', outboundMessageId: 'out-1' })
      expect(s.end).toHaveBeenCalledTimes(1)
    }
  })
})
