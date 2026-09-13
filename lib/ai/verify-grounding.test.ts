import { afterEach, describe, expect, it, vi } from 'vitest'
import { verifyGrounding } from './verify-grounding'
import type { VenueInfo } from '@/lib/schemas'

// Mock the AI SDK and the model client so no real Anthropic call goes out.
// Same pattern as extract-reported-order.test.ts / classify-intention-prompts
// tests in this directory.
const generateObjectMock = vi.fn()
vi.mock('ai', () => ({
  generateObject: (...args: unknown[]) => generateObjectMock(...args),
}))
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
