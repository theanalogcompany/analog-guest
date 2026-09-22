import { NoObjectGeneratedError } from 'ai'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  VERIFY_CANCELLATION_CLAIM_MAX_OUTPUT_TOKENS,
  VERIFY_CANCELLATION_CLAIM_PROMPT_VERSION,
  VERIFY_CANCELLATION_CLAIM_TRUNCATED_ERROR_CODE,
  verifyCancellationClaim,
} from './verify-cancellation-claim'

const generateObjectMock = vi.fn()
// The REAL NoObjectGeneratedError is passed through from the SDK rather than
// stubbed, for the reason verify-grounding.test.ts and verify-prose-promise.
// test.ts both give: the truncation carve-out keys on
// `NoObjectGeneratedError.isInstance(e)`, so a hand-rolled stub would test our
// own identity check instead of the SDK's and would keep passing if the real
// class's shape changed underneath us.
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

function usage(outputTokens: number) {
  return {
    inputTokens: 900,
    outputTokens,
    totalTokens: 900 + outputTokens,
    inputTokenDetails: {
      noCacheTokens: undefined,
      cacheReadTokens: undefined,
      cacheWriteTokens: undefined,
    },
    outputTokenDetails: { textTokens: undefined, reasoningTokens: undefined },
  }
}

function truncationError(): NoObjectGeneratedError {
  return new NoObjectGeneratedError({
    message: 'No object generated: could not parse the response.',
    cause: new Error('AI_JSONParseError'),
    text: '{"reasoning": "The reply tells the guest the comp',
    response: { id: 'r', timestamp: new Date(), modelId: 'm' },
    usage: usage(VERIFY_CANCELLATION_CLAIM_MAX_OUTPUT_TOKENS),
    finishReason: 'length',
  })
}

function parseErrorThatStopped(): NoObjectGeneratedError {
  return new NoObjectGeneratedError({
    message: 'No object generated: could not parse the response.',
    cause: new Error('AI_JSONParseError'),
    text: 'I cannot answer that.',
    response: { id: 'r', timestamp: new Date(), modelId: 'm' },
    usage: usage(12),
    finishReason: 'stop',
  })
}

describe('verifyCancellationClaim (TAC-513)', () => {
  it('flags a reply that says a promised comp is cancelled', async () => {
    // The 2026-09-21 reply, verbatim.
    generateObjectMock.mockResolvedValue({
      object: {
        reasoning: 'The reply states the comp for the blossom tonic is cancelled.',
        claimsCancellation: true,
      },
    })
    const r = await verifyCancellationClaim({
      replyBody:
        'got it, just the cortado then. the comp for the blossom tonic is cancelled. and how was the Pink Panther?',
    })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.data.claimsCancellation).toBe(true)
      expect(r.data.promptVersion).toBe(VERIFY_CANCELLATION_CLAIM_PROMPT_VERSION)
    }
  })

  it('returns a boolean and NOTHING actionable', async () => {
    // The safety property. Naming a commitment here would invite minting a
    // cancellation from a second reading of prose, which is destructive where
    // TAC-401's minting is protective. Pinned as an exact key set so a later
    // "while we are here, return which one" is a failure rather than a drift.
    generateObjectMock.mockResolvedValue({
      object: { reasoning: 'yes', claimsCancellation: true },
    })
    const r = await verifyCancellationClaim({ replyBody: "that one's off then" })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(Object.keys(r.data).sort()).toEqual(['claimsCancellation', 'promptVersion'])
    }
  })

  it('passes a clean reply through', async () => {
    generateObjectMock.mockResolvedValue({
      object: { reasoning: 'Nothing is withdrawn.', claimsCancellation: false },
    })
    const r = await verifyCancellationClaim({
      replyBody: "the cortado comp still stands, come by whenever",
    })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.data.claimsCancellation).toBe(false)
  })

  it('sends the reply body and nothing else to the model', async () => {
    // The narrow input is what keeps this replayable against fixed bodies and
    // robust to venue persona, exactly as TAC-401's is. It is also why the
    // active commitments are NOT passed: with the list in hand the model would
    // be tempted to answer whether the cancellation is correct, which is the
    // gate's job.
    generateObjectMock.mockResolvedValue({
      object: { reasoning: 'no', claimsCancellation: false },
    })
    await verifyCancellationClaim({ replyBody: 'hello there' })
    const call = generateObjectMock.mock.calls[0]?.[0] as { prompt: string; system: string }
    expect(call.prompt).toContain('hello there')
    expect(call.prompt).not.toContain('id:')
    expect(call.system).toContain('no longer happening')
  })

  it('declares reasoning FIRST in the schema', async () => {
    // Structured output generates in declaration order, so a verdict declared
    // before the analysis is one the model has not reasoned about yet.
    // TAC-301 part 1.5 found exactly that on verify-grounding.
    generateObjectMock.mockResolvedValue({
      object: { reasoning: 'r', claimsCancellation: false },
    })
    await verifyCancellationClaim({ replyBody: 'anything' })
    const call = generateObjectMock.mock.calls[0]?.[0] as {
      schema: { shape: Record<string, unknown> }
    }
    expect(Object.keys(call.schema.shape)).toEqual(['reasoning', 'claimsCancellation'])
  })

  it('reports truncation under its own error code', async () => {
    generateObjectMock.mockRejectedValue(truncationError())
    const r = await verifyCancellationClaim({ replyBody: 'anything' })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.errorCode).toBe(VERIFY_CANCELLATION_CLAIM_TRUNCATED_ERROR_CODE)
  })

  it('does NOT report a parse failure that stopped normally as truncation', async () => {
    // finishReason 'stop', not 'length'. The caller retries this one and not
    // the other, so conflating them spends a call to hit the same cap again.
    generateObjectMock.mockRejectedValue(parseErrorThatStopped())
    const r = await verifyCancellationClaim({ replyBody: 'anything' })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.errorCode).toBe('ai_verify_cancellation_claim_failed')
      expect(r.errorCode).not.toBe(VERIFY_CANCELLATION_CLAIM_TRUNCATED_ERROR_CODE)
    }
  })

  it('reports a transport error as a plain failure', async () => {
    generateObjectMock.mockRejectedValue(new Error('socket hang up'))
    const r = await verifyCancellationClaim({ replyBody: 'anything' })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.errorCode).toBe('ai_verify_cancellation_claim_failed')
  })

  it('refuses an empty body without calling the model', async () => {
    const r = await verifyCancellationClaim({ replyBody: '   ' })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toBe('invalid_input')
    expect(generateObjectMock).not.toHaveBeenCalled()
  })

  it('pins the output cap, so walking it down has to delete a test', async () => {
    expect(VERIFY_CANCELLATION_CLAIM_MAX_OUTPUT_TOKENS).toBe(600)
    generateObjectMock.mockResolvedValue({
      object: { reasoning: 'r', claimsCancellation: false },
    })
    await verifyCancellationClaim({ replyBody: 'anything' })
    const call = generateObjectMock.mock.calls[0]?.[0] as { maxOutputTokens: number }
    expect(call.maxOutputTokens).toBe(VERIFY_CANCELLATION_CLAIM_MAX_OUTPUT_TOKENS)
  })
})

// The prompt's own boundaries. These pin CONTIGUOUS clauses rather than
// disjoint fragments, per TAC-409: its first version of an equivalent test let
// three sentence-inverting mutants through while every fragment survived.
describe('verifyCancellationClaim — prompt boundaries (TAC-513)', () => {
  async function systemPrompt(): Promise<string> {
    generateObjectMock.mockResolvedValue({
      object: { reasoning: 'r', claimsCancellation: false },
    })
    await verifyCancellationClaim({ replyBody: 'anything' })
    const call = generateObjectMock.mock.calls[0]?.[0] as { system: string }
    return call.system
  }

  it('asks whether a promise is off, not whether withdrawing it was right', async () => {
    expect(await systemPrompt()).toContain(
      'You are not deciding whether the venue was right to withdraw it, whether the guest will mind, or whether the promise existed in the first place. Only whether this reply says it is off.',
    )
  })

  it('does not require the word "cancel"', async () => {
    expect(await systemPrompt()).toContain(
      'The wording does not matter and the reply does not have to use the word "cancel".',
    )
  })

  it('excludes a refusal, which is not a withdrawal', async () => {
    // The boundary most likely to produce a false positive: the agent declining
    // to give something reads like taking something away if you squint.
    expect(await systemPrompt()).toContain(
      'Refusing to give something is not withdrawing something already given.',
    )
  })

  it('excludes stock and availability', async () => {
    expect(await systemPrompt()).toContain(
      'A reply that says something is unavailable, sold out, or off the menu today. That is about stock, not about a promise to this guest.',
    )
  })

  it('excludes a reply that CONFIRMS a promise still stands', async () => {
    // "the cortado comp still stands" appeared in the incident thread itself,
    // one turn before the false cancellation, so this boundary is not
    // hypothetical.
    expect(await systemPrompt()).toContain(
      'including reassuring the guest it still stands. "The cortado comp still stands" is the opposite of a cancellation.',
    )
  })

  it('excludes a venue-side cancellation that is not a promise to this guest', async () => {
    expect(await systemPrompt()).toContain(
      'an event being cancelled, a closure, a delivery not arriving. Those are not promises of something to this guest.',
    )
  })

  it('treats a detail change as a cancellation only when the first is said to be off', async () => {
    expect(await systemPrompt()).toContain(
      'Swapping one promised item for another counts as a cancellation ONLY if the reply says the first one is off.',
    )
  })
})
