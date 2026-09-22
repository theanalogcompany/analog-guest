// TAC-363: tests for the closed-venue arrival check.
//
// These mock generateObject, so they prove the WIRING and the failure
// handling — what the function does with a verdict, and how it tells a
// truncated verdict from a transient fault. They prove nothing whatever about
// whether the model reaches the right verdict on real replies. The prompt
// content is pinned separately below for the two clauses a reviewer would
// otherwise have to take on trust.

import { NoObjectGeneratedError } from 'ai'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  VERIFY_CLOSED_VENUE_ARRIVAL_MAX_OUTPUT_TOKENS,
  VERIFY_CLOSED_VENUE_ARRIVAL_PROMPT_VERSION,
  VERIFY_CLOSED_VENUE_ARRIVAL_TRUNCATED_ERROR_CODE,
  verifyClosedVenueArrival,
} from './verify-closed-venue-arrival'

const generateObjectMock = vi.fn()
// The REAL NoObjectGeneratedError is passed through from the actual SDK
// rather than stubbed, for the reason verify-grounding.test.ts gives: the
// truncation carve-out keys on `NoObjectGeneratedError.isInstance(e)`, so a
// hand-rolled stub would test our own identity check instead of the SDK's,
// and would keep passing if the real class's shape changed underneath us.
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

function truncationError(): NoObjectGeneratedError {
  return new NoObjectGeneratedError({
    message: 'No object generated: could not parse the response.',
    cause: new Error('AI_JSONParseError'),
    text: '{"reasoning": "The guest said they are heading over and the reply',
    response: { id: 'r', timestamp: new Date(), modelId: 'm' },
    usage: {
      inputTokens: 900,
      outputTokens: VERIFY_CLOSED_VENUE_ARRIVAL_MAX_OUTPUT_TOKENS,
      totalTokens: 900 + VERIFY_CLOSED_VENUE_ARRIVAL_MAX_OUTPUT_TOKENS,
      inputTokenDetails: {
        noCacheTokens: undefined,
        cacheReadTokens: undefined,
        cacheWriteTokens: undefined,
      },
      outputTokenDetails: { textTokens: undefined, reasoningTokens: undefined },
    },
    finishReason: 'length',
  })
}

function parseErrorThatStopped(): NoObjectGeneratedError {
  return new NoObjectGeneratedError({
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
  })
}

describe('verifyClosedVenueArrival', () => {
  it('reports a confirmed arrival', async () => {
    generateObjectMock.mockResolvedValue({
      object: {
        reasoning: 'The reply agrees the guest can come now.',
        confirmsArrival: true,
      },
    })
    const r = await verifyClosedVenueArrival({ replyBody: 'See you soon!' })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.data.confirmsArrival).toBe(true)
      expect(r.data.promptVersion).toBe(VERIFY_CLOSED_VENUE_ARRIVAL_PROMPT_VERSION)
    }
  })

  it('reports a clean reply', async () => {
    generateObjectMock.mockResolvedValue({
      object: {
        reasoning: 'The reply says the venue is closed and names the opening time.',
        confirmsArrival: false,
      },
    })
    const r = await verifyClosedVenueArrival({
      replyBody: "we're closed for the day, back at 7 tomorrow",
    })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.data.confirmsArrival).toBe(false)
  })

  it('refuses an empty body without calling the model', async () => {
    const r = await verifyClosedVenueArrival({ replyBody: '   ' })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toBe('invalid_input')
    expect(generateObjectMock).not.toHaveBeenCalled()
  })

  it('reports truncation under its own error code', async () => {
    // The caller does not retry this one: the cap was already hit, so a second
    // call spends money to hit it again.
    generateObjectMock.mockRejectedValue(truncationError())
    const r = await verifyClosedVenueArrival({ replyBody: 'See you soon!' })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.errorCode).toBe(VERIFY_CLOSED_VENUE_ARRIVAL_TRUNCATED_ERROR_CODE)
  })

  it('does NOT report a parse failure that stopped normally as truncation', async () => {
    // finishReason 'stop', not 'length'. The model produced something
    // unparseable rather than running out of room, and the caller retries this
    // one. Keying on the message text instead of the SDK's finishReason is
    // what this distinguishes.
    generateObjectMock.mockRejectedValue(parseErrorThatStopped())
    const r = await verifyClosedVenueArrival({ replyBody: 'See you soon!' })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.errorCode).toBe('ai_verify_closed_venue_arrival_failed')
    }
  })

  it('reports a transport failure as a plain failure', async () => {
    generateObjectMock.mockRejectedValue(new Error('socket hang up'))
    const r = await verifyClosedVenueArrival({ replyBody: 'See you soon!' })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.errorCode).toBe('ai_verify_closed_venue_arrival_failed')
  })

  it('asks the model at a low temperature with the capped output', async () => {
    generateObjectMock.mockResolvedValue({
      object: { reasoning: 'r', confirmsArrival: false },
    })
    await verifyClosedVenueArrival({ replyBody: 'See you soon!' })
    expect(generateObjectMock).toHaveBeenCalledWith(
      expect.objectContaining({
        temperature: 0.2,
        maxOutputTokens: VERIFY_CLOSED_VENUE_ARRIVAL_MAX_OUTPUT_TOKENS,
      }),
    )
  })

  it('puts the reply body in the user prompt, not the system prompt', async () => {
    // The system prompt is fixed and cacheable; the body is the variable. A
    // body that leaked into the system position would defeat that and would
    // also put guest text somewhere the prompt-content assertions below scan.
    generateObjectMock.mockResolvedValue({
      object: { reasoning: 'r', confirmsArrival: false },
    })
    await verifyClosedVenueArrival({ replyBody: 'omw see you in five' })
    const call = generateObjectMock.mock.calls[0][0] as { system: string; prompt: string }
    expect(call.prompt).toContain('omw see you in five')
    expect(call.system).not.toContain('omw see you in five')
  })
})

describe('the schema puts reasoning before the verdict', () => {
  it('declares reasoning first', async () => {
    // Load-bearing, not cosmetic: structured output generates in declaration
    // order, so a verdict declared before the analysis is one the model has
    // not reasoned about yet. TAC-301 part 1.5 found exactly that on
    // verify-grounding, where the model emitted a flag and then reasoned its
    // way to the opposite conclusion inside the same object.
    generateObjectMock.mockResolvedValue({
      object: { reasoning: 'r', confirmsArrival: false },
    })
    await verifyClosedVenueArrival({ replyBody: 'See you soon!' })
    const call = generateObjectMock.mock.calls[0][0] as {
      schema: { shape: Record<string, unknown> }
    }
    expect(Object.keys(call.schema.shape)).toEqual(['reasoning', 'confirmsArrival'])
  })
})

describe('prompt content', () => {
  // Two clauses are pinned because the check is useless or harmful without
  // them, and a mocked-model test cannot otherwise tell. Each is pinned as one
  // contiguous clause rather than as disjoint fragments — the TAC-409 lesson
  // that a sentence can be reversed while every fragment it contains survives.
  async function systemPrompt(): Promise<string> {
    generateObjectMock.mockResolvedValue({
      object: { reasoning: 'r', confirmsArrival: false },
    })
    await verifyClosedVenueArrival({ replyBody: 'See you soon!' })
    return (generateObjectMock.mock.calls[0][0] as { system: string }).system
  }

  it('tells the model the venue is closed right now', async () => {
    // Without this the check has no referent: "does this confirm an arrival"
    // is a different and much broader question during service hours.
    expect(await systemPrompt()).toContain('The venue is CLOSED right now.')
  })

  it('exempts a reply that correctly states the venue is closed', async () => {
    // The 2026-09-21 live reply. Flagging it would hold the RIGHT answer and
    // turn a working prose layer into a queue of correct drafts.
    expect(await systemPrompt()).toContain(
      "A reply that says the venue is closed, or names when it opens, and directs the guest to that.",
    )
  })

  it('tells the model not to judge the guest’s own message', async () => {
    // The guest usually HAS said they are heading over. Judging their message
    // rather than the reply would flag every closed-hours arrival turn.
    expect(await systemPrompt()).toContain(
      'The guest may well have said they are heading over. That is not what you are judging.',
    )
  })
})
