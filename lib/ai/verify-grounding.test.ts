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
    })

    const args = generateObjectMock.mock.calls[0][0] as { prompt: string }
    expect(args.prompt).toContain("what's the wifi password?")
    expect(args.prompt).toContain('Le Mils Guest')
  })
})
