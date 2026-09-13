import { NoObjectGeneratedError } from 'ai'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  VERIFY_GROUNDING_MAX_OUTPUT_TOKENS,
  VERIFY_GROUNDING_TRUNCATED_ERROR_CODE,
  verifyGrounding,
} from './verify-grounding'
import type { VenueInfo } from '@/lib/schemas'

// Mock the AI SDK and the model client so no real Anthropic call goes out.
// Same pattern as extract-reported-order.test.ts / classify-intention-prompts
// tests in this directory.
const generateObjectMock = vi.fn()
// TAC-367: the REAL NoObjectGeneratedError is passed through from the actual
// SDK rather than stubbed. The truncation carve-out keys on
// `NoObjectGeneratedError.isInstance(e)`, so a hand-rolled stub would test our
// stub's identity check instead of the SDK's — and would keep passing if the
// real class's shape ever changed underneath us. Only generateObject is
// replaced; nothing else in this file needs the network.
vi.mock('ai', async (importActual) => {
  const actual = await importActual<typeof import('ai')>()
  return {
    ...actual,
    generateObject: (...args: unknown[]) => generateObjectMock(...args),
  }
})
vi.mock('./client', () => ({
  getClassificationModel: () => 'mock-model',
}))

afterEach(() => {
  generateObjectMock.mockReset()
})

function makeVenueInfo(overrides: Partial<VenueInfo> = {}): VenueInfo {
  return {
    address: { line1: '123 Main St', city: 'San Francisco', region: 'CA', postalCode: '94103' },
    contact: {},
    hours: {},
    menu: { items: [], highlights: [], notes: undefined },
    staff: [],
    currentContext: [],
    ...overrides,
  } as VenueInfo
}

describe('verifyGrounding', () => {
  it('returns hasUngroundedClaim + claims + promptVersion on success', async () => {
    generateObjectMock.mockResolvedValue({
      object: {
        hasUngroundedClaim: true,
        ungroundedClaims: ['names four SoFi variations not listed anywhere'],
        reasoning: 'source only says there are four variations, does not name them',
      },
    })

    const result = await verifyGrounding({
      inboundBody: 'what are the four SoFi variations?',
      replyBody: 'the four are classic, spiced, iced, and cardamom',
      venueInfo: makeVenueInfo(),
      knowledgeChunks: [],
      runtimeContext: '',
    })

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.data.hasUngroundedClaim).toBe(true)
      expect(result.data.ungroundedClaims).toEqual([
        'names four SoFi variations not listed anywhere',
      ])
      expect(result.data.promptVersion).toEqual(expect.any(String))
    }
  })

  it('returns hasUngroundedClaim=false and empty claims for a grounded reply', async () => {
    generateObjectMock.mockResolvedValue({
      object: {
        hasUngroundedClaim: false,
        ungroundedClaims: [],
        reasoning: 'reply matches source material',
      },
    })

    const result = await verifyGrounding({
      inboundBody: 'do you have oat milk',
      replyBody: 'yeah, oat and almond',
      venueInfo: makeVenueInfo(),
      knowledgeChunks: [],
      runtimeContext: '',
    })

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.data.hasUngroundedClaim).toBe(false)
      expect(result.data.ungroundedClaims).toEqual([])
    }
  })

  // Code-review follow-up: nothing structurally stops the model from
  // returning hasUngroundedClaim=true with an empty claims array. The
  // safety-relevant flag must survive; only the display list is patched.
  it('substitutes a fallback claim when the model flags true with an empty claims array', async () => {
    generateObjectMock.mockResolvedValue({
      object: { hasUngroundedClaim: true, ungroundedClaims: [], reasoning: 'unsure' },
    })

    const result = await verifyGrounding({
      inboundBody: 'what are the four SoFi variations?',
      replyBody: 'the four are classic, spiced, iced, and cardamom',
      venueInfo: makeVenueInfo(),
      knowledgeChunks: [],
      runtimeContext: '',
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.data.hasUngroundedClaim).toBe(true)
    expect(result.data.ungroundedClaims).toHaveLength(1)
    expect(result.data.ungroundedClaims[0]).toMatch(/did not specify/)
  })

  it('rejects an empty replyBody without calling the model', async () => {
    const result = await verifyGrounding({
      inboundBody: 'hi',
      replyBody: '',
      venueInfo: makeVenueInfo(),
      runtimeContext: '',
    })
    expect(result).toEqual({ ok: false, error: 'invalid_input' })
    expect(generateObjectMock).not.toHaveBeenCalled()
  })

  it('treats undefined knowledgeChunks as empty (renders the no-match framing, not a crash)', async () => {
    generateObjectMock.mockResolvedValue({
      object: { hasUngroundedClaim: false, ungroundedClaims: [], reasoning: '' },
    })

    await verifyGrounding({
      inboundBody: 'hi',
      replyBody: 'hey there',
      venueInfo: makeVenueInfo(),
      // knowledgeChunks omitted entirely
      runtimeContext: '',
    })

    const args = generateObjectMock.mock.calls[0][0] as { prompt: string }
    expect(args.prompt).toContain('No specific venue knowledge matched this query')
  })

  // ---- TAC-367: truncation is its own failure ----

  // The whole carve-out depends on this one discrimination. Built from the
  // REAL NoObjectGeneratedError so it exercises the SDK's own isInstance,
  // with finishReason 'length' — the shape observed live: 12 paced calls on
  // a production-size prompt, 11 emitting 373-496 output tokens and one
  // running past the 500 cap and truncating mid-JSON.
  it('returns the truncation errorCode when the call fails with finishReason length', async () => {
    generateObjectMock.mockRejectedValue(
      new NoObjectGeneratedError({
        message: 'No object generated: could not parse the response.',
        cause: new Error('AI_JSONParseError'),
        text: '{"reasoning": "The guest asked',
        response: { id: 'r', timestamp: new Date(), modelId: 'm' },
        usage: {
          inputTokens: 5673,
          outputTokens: 500,
          totalTokens: 6173,
          inputTokenDetails: {
            noCacheTokens: undefined,
            cacheReadTokens: undefined,
            cacheWriteTokens: undefined,
          },
          outputTokenDetails: { textTokens: undefined, reasoningTokens: undefined },
        },
        finishReason: 'length',
      }),
    )
    const result = await verifyGrounding({
      inboundBody: 'what is it',
      replyBody: 'It starts with a floral base',
      venueInfo: makeVenueInfo(),
      runtimeContext: '## Recent conversation\n[venue] Blossom Tonic, honestly',
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.errorCode).toBe(VERIFY_GROUNDING_TRUNCATED_ERROR_CODE)
  })

  // The negative half: a NoObjectGeneratedError that did NOT truncate (the
  // model emitted prose, or stopped normally with unparseable output) is not
  // a truncation. Mistaking it for one would fail closed on a case the
  // fail-open rationale still covers.
  it('does NOT report truncation when the parse failed but finishReason is stop', async () => {
    generateObjectMock.mockRejectedValue(
      new NoObjectGeneratedError({
        message: 'No object generated: could not parse the response.',
        cause: new Error('AI_JSONParseError'),
        text: 'I cannot answer that.',
        response: { id: 'r', timestamp: new Date(), modelId: 'm' },
        usage: {
          inputTokens: 100,
          outputTokens: 12,
          totalTokens: 112,
          inputTokenDetails: {
            noCacheTokens: undefined,
            cacheReadTokens: undefined,
            cacheWriteTokens: undefined,
          },
          outputTokenDetails: { textTokens: undefined, reasoningTokens: undefined },
        },
        finishReason: 'stop',
      }),
    )
    const result = await verifyGrounding({
      inboundBody: 'what is it',
      replyBody: 'It starts with a floral base',
      venueInfo: makeVenueInfo(),
      runtimeContext: '## Recent conversation\n[venue] Blossom Tonic, honestly',
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.errorCode).toBe('ai_verify_grounding_failed')
  })

  // A plain transport error carries no finishReason at all and must stay on
  // the fail-open code.
  it('does NOT report truncation for an ordinary thrown Error', async () => {
    generateObjectMock.mockRejectedValue(new Error('socket hang up'))
    const result = await verifyGrounding({
      inboundBody: 'what is it',
      replyBody: 'It starts with a floral base',
      venueInfo: makeVenueInfo(),
      runtimeContext: '## Recent conversation\n[venue] Blossom Tonic, honestly',
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.errorCode).toBe('ai_verify_grounding_failed')
  })

  // Pins the VALUE, not just that a constant exists. 500 is what this
  // verifier outgrew; a future edit that walks it back toward the observed
  // 373-496 output range reopens the hole, and should have to delete a test
  // that says so.
  it('requests VERIFY_GROUNDING_MAX_OUTPUT_TOKENS, which is well clear of the observed output range', async () => {
    generateObjectMock.mockResolvedValue({
      object: { reasoning: 'r', hasUngroundedClaim: false, ungroundedClaims: [] },
    })
    await verifyGrounding({
      inboundBody: 'q',
      replyBody: 'a',
      venueInfo: makeVenueInfo(),
      runtimeContext: '',
    })
    const args = generateObjectMock.mock.calls[0][0] as { maxOutputTokens: number }
    expect(args.maxOutputTokens).toBe(VERIFY_GROUNDING_MAX_OUTPUT_TOKENS)
    expect(VERIFY_GROUNDING_MAX_OUTPUT_TOKENS).toBe(2000)
  })

  it('returns ok:false with an errorCode when generateObject throws', async () => {
    generateObjectMock.mockRejectedValue(new Error('model unavailable'))

    const result = await verifyGrounding({
      inboundBody: 'hi',
      replyBody: 'hey there',
      venueInfo: makeVenueInfo(),
      knowledgeChunks: [],
      runtimeContext: '',
    })

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toBe('model unavailable')
      expect(result.errorCode).toBe('ai_verify_grounding_failed')
    }
  })

  it('includes both the guest message and the reply in the prompt', async () => {
    generateObjectMock.mockResolvedValue({
      object: { hasUngroundedClaim: false, ungroundedClaims: [], reasoning: '' },
    })

    await verifyGrounding({
      inboundBody: "what's the wifi password?",
      replyBody: 'Le Mils Guest',
      venueInfo: makeVenueInfo(),
      knowledgeChunks: [],
      runtimeContext: '',
    })

    const args = generateObjectMock.mock.calls[0][0] as { prompt: string }
    expect(args.prompt).toContain("what's the wifi password?")
    expect(args.prompt).toContain('Le Mils Guest')
  })
})

// TAC-301 part 1.5. The six false-positive classes that prompted this fix were
// all the same shape: the generator saw a runtime block, the verifier didn't,
// and a correct reply was suppressed as unsupported. These tests exist so the
// SEVENTH block can't reintroduce it silently.
describe('runtime context in the source material', () => {
  function mockClean() {
    generateObjectMock.mockResolvedValueOnce({
      object: { hasUngroundedClaim: false, ungroundedClaims: [], reasoning: '' },
    })
  }

  function promptFromCall(): string {
    return (generateObjectMock.mock.calls[0][0] as { prompt: string }).prompt
  }

  it('passes the runtime context through VERBATIM, not summarized or re-serialized', async () => {
    mockClean()
    const runtimeContext =
      '## Right now\n- Date: Friday, 2026-09-12\n- Status: CLOSED right now. Next open tomorrow at 7:00 AM.'
    await verifyGrounding({
      inboundBody: 'walking over now',
      replyBody: "we're closed for the night, back at 7 tomorrow",
      venueInfo: makeVenueInfo(),
      runtimeContext,
    })
    // Verbatim containment is the contract. If a future change summarizes or
    // slices this, the exact string stops appearing and this fails.
    expect(promptFromCall()).toContain(runtimeContext)
  })

  // runtimeContext is REQUIRED on the input type, so "caller forgot it" is a
  // compile error rather than a test case. What remains testable is a caller
  // that passes something empty.
  it('omits the section for an empty or whitespace-only runtime context', async () => {
    mockClean()
    await verifyGrounding({
      inboundBody: 'hi',
      replyBody: 'hey',
      venueInfo: makeVenueInfo(),
      runtimeContext: '   \n  ',
    })
    expect(promptFromCall()).not.toContain('## Runtime context for this turn')
  })

  // WHAT THIS CATCHES, stated precisely, because a code-review mutation showed
  // the obvious reading is wrong: adding a NEW block to runtimeToProse does not
  // fail this test, and doesn't need to — verbatim pass-through means a new
  // block reaches the verifier automatically. What it catches is someone
  // REINTRODUCING CURATION: slicing runtimeContext down to one block, or
  // rebuilding it from a hand-maintained list. That is the actual regression
  // risk, since a maintained list is how all six divergences below arrived.
  //
  // The blocks are the exact divergences measured against Le Mil's live config
  // on 2026-09-13, each of which suppressed a correct reply.
  it('carries every fact-bearing runtime block the generator renders', async () => {
    mockClean()
    const runtimeContext = [
      '## Right now\n- Status: CLOSED right now. Next open tomorrow at 7:00 AM.',
      '## What this guest can access\n- New Bean Sample — a rare new-harvest bean',
      '## Visit history\n- cortado [3 days ago]',
      '## Guest context\n- dairy free',
      '## Active commitments\n- [comp] oat latte (id: abc-123, code: 4F2K, status: open)',
      '## Recent conversation\n[guest, 1 hour ago] coming by with my sister Saturday',
    ].join('\n\n')

    await verifyGrounding({
      inboundBody: 'anything for me?',
      replyBody: 'your code is 4F2K',
      venueInfo: makeVenueInfo(),
      runtimeContext,
    })

    const prompt = promptFromCall()
    for (const header of [
      '## Right now',
      '## What this guest can access',
      '## Visit history',
      '## Guest context',
      '## Active commitments',
      '## Recent conversation',
    ]) {
      expect(prompt).toContain(header)
    }
  })

  it('tells the verifier that runtime context is valid grounding', async () => {
    mockClean()
    await verifyGrounding({
      inboundBody: 'hi',
      replyBody: 'hey',
      venueInfo: makeVenueInfo(),
      runtimeContext: '## Right now\n- Status: OPEN right now, closes at 3:00 PM.',
    })
    const system = (generateObjectMock.mock.calls[0][0] as { system: string }).system
    expect(system).toContain('runtime context for this turn')
  })

  // The counter-argument to passing the prompt wholesale: ## Recent
  // conversation contains the assistant's OWN prior messages, so a
  // fabrication that escaped once could ground itself later. Mitigated in the
  // system prompt rather than by filtering the string (filtering would
  // reintroduce the curation this whole change removes).
  // Found by reading the model's own reasoning during verification. Structured
  // output generates fields in declaration order, so with reasoning LAST the
  // verdict was written before the analysis existed. Observed: on a reply
  // naming what the guest ordered last time, the reasoning reversed itself and
  // ended "This IS supported by the source material provided. The claim is
  // grounded" — while the emitted boolean stayed true. Order is behaviour
  // here, not style.
  it('declares reasoning BEFORE the verdict so the model analyses first', async () => {
    mockClean()
    await verifyGrounding({
      inboundBody: 'what did I get last time?',
      replyBody: 'you had the cortado last time',
      venueInfo: makeVenueInfo(),
      runtimeContext: '## Visit history\n- [3 days ago] cortado',
    })
    const schema = (generateObjectMock.mock.calls[0][0] as { schema: { shape: object } }).schema
    const keys = Object.keys(schema.shape)
    expect(keys.indexOf('reasoning')).toBeLessThan(keys.indexOf('hasUngroundedClaim'))
  })

  // Three ways the verifier was observed exceeding its remit, each producing a
  // false flag on a correct reply: re-litigating eligibility that
  // filterEligibleMechanics already decided, flagging hedged phrasing about a
  // fact that IS in the source material, and second-guessing whether saying it
  // was wise.
  it('scopes the verifier to factual support only', async () => {
    mockClean()
    await verifyGrounding({
      inboundBody: 'hi',
      replyBody: 'hey',
      venueInfo: makeVenueInfo(),
      runtimeContext: '## Right now\n- Status: OPEN right now, closes at 3:00 PM.',
    })
    const system = (generateObjectMock.mock.calls[0][0] as { system: string }).system
    expect(system).toContain('QUALIFIES')
    expect(system).toContain('how confidently something is phrased')
    expect(system).toContain('whether saying it was a good idea')
  })

  it("tells the verifier the assistant's own prior messages are not grounding", async () => {
    mockClean()
    await verifyGrounding({
      inboundBody: 'hi',
      replyBody: 'hey',
      venueInfo: makeVenueInfo(),
      runtimeContext: '## Recent conversation\n[venue, 1 day ago] the wifi password is hunter2',
    })
    const system = (generateObjectMock.mock.calls[0][0] as { system: string }).system
    expect(system).toContain('[venue, ...]')
    expect(system).toContain('Observations:')
  })
})
