import { NoObjectGeneratedError } from 'ai'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  VERIFY_PROSE_PROMISE_MAX_OUTPUT_TOKENS,
  VERIFY_PROSE_PROMISE_PROMPT_VERSION,
  VERIFY_PROSE_PROMISE_TRUNCATED_ERROR_CODE,
  verifyProsePromise,
} from './verify-prose-promise'

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
    text: '{"reasoning": "The reply tells the guest',
    response: { id: 'r', timestamp: new Date(), modelId: 'm' },
    usage: {
      inputTokens: 900,
      outputTokens: VERIFY_PROSE_PROMISE_MAX_OUTPUT_TOKENS,
      totalTokens: 900 + VERIFY_PROSE_PROMISE_MAX_OUTPUT_TOKENS,
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

describe('verifyProsePromise', () => {
  it('returns the promise, its type and its description on a flagged reply', async () => {
    generateObjectMock.mockResolvedValue({
      object: {
        reasoning: 'The reply tells the guest their next cortado is free.',
        promisesSomething: true,
        commitmentType: 'comp',
        commitmentDescription: 'a replacement cortado',
      },
    })

    const result = await verifyProsePromise({
      replyBody: "sorry about that one. next cortado's on us",
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.data).toEqual({
      promisesSomething: true,
      commitmentType: 'comp',
      commitmentDescription: 'a replacement cortado',
      promptVersion: VERIFY_PROSE_PROMISE_PROMPT_VERSION,
    })
  })

  it('returns a null carrier on a clean reply', async () => {
    generateObjectMock.mockResolvedValue({
      object: {
        reasoning: 'The reply only states the opening time.',
        promisesSomething: false,
        commitmentType: 'none',
        commitmentDescription: '',
      },
    })

    const result = await verifyProsePromise({ replyBody: "we're open at 7 tomorrow" })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.data).toEqual({
      promisesSomething: false,
      commitmentType: null,
      commitmentDescription: null,
      promptVersion: VERIFY_PROSE_PROMISE_PROMPT_VERSION,
    })
  })

  // The ambiguous shape. Trusting the boolean is the whole point: downgrading
  // to promisesSomething=false here is the false negative a fail-closed
  // backstop cannot afford, and it is the exact mutant verify-mechanic-offer
  // shipped and had to have corrected in code review.
  it('keeps promisesSomething true but drops the carrier when the type is none', async () => {
    generateObjectMock.mockResolvedValue({
      object: {
        reasoning: 'It promises something but does not say what.',
        promisesSomething: true,
        commitmentType: 'none',
        commitmentDescription: 'something',
      },
    })

    const result = await verifyProsePromise({ replyBody: "we'll sort you out next time" })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.data.promisesSomething).toBe(true)
    expect(result.data.commitmentType).toBeNull()
    expect(result.data.commitmentDescription).toBeNull()
  })

  it('keeps promisesSomething true but drops the carrier when the description is blank', async () => {
    generateObjectMock.mockResolvedValue({
      object: {
        reasoning: 'It promises a comp but names nothing.',
        promisesSomething: true,
        commitmentType: 'comp',
        commitmentDescription: '   ',
      },
    })

    const result = await verifyProsePromise({ replyBody: "we'll make it right" })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.data.promisesSomething).toBe(true)
    expect(result.data.commitmentType).toBeNull()
    expect(result.data.commitmentDescription).toBeNull()
  })

  it('trims the description', async () => {
    generateObjectMock.mockResolvedValue({
      object: {
        reasoning: 'r',
        promisesSomething: true,
        commitmentType: 'hold',
        commitmentDescription: '  a bag of the Budan  ',
      },
    })

    const result = await verifyProsePromise({ replyBody: "I'll set one aside" })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.data.commitmentDescription).toBe('a bag of the Budan')
  })

  // reasoning is declared FIRST so the verdict follows the analysis rather
  // than preceding it (TAC-301 part 1.5's finding on verify-grounding, where
  // the model emitted a flag and then reasoned to the opposite conclusion
  // inside the same object). Nothing behavioural can observe field order, so
  // this reads the schema the call was made with.
  it('declares reasoning before the verdict in the output schema', async () => {
    generateObjectMock.mockResolvedValue({
      object: {
        reasoning: 'r',
        promisesSomething: false,
        commitmentType: 'none',
        commitmentDescription: '',
      },
    })

    await verifyProsePromise({ replyBody: 'hi' })

    const call = generateObjectMock.mock.calls[0]?.[0] as { schema: { shape: object } }
    const keys = Object.keys(call.schema.shape)
    expect(keys[0]).toBe('reasoning')
    expect(keys.indexOf('reasoning')).toBeLessThan(keys.indexOf('promisesSomething'))
  })

  it('sends only the reply body, never a prompt or venue context', async () => {
    generateObjectMock.mockResolvedValue({
      object: {
        reasoning: 'r',
        promisesSomething: false,
        commitmentType: 'none',
        commitmentDescription: '',
      },
    })

    await verifyProsePromise({ replyBody: "next one's on us" })

    const call = generateObjectMock.mock.calls[0]?.[0] as { prompt: string; system: string }
    // Pinned EXACTLY, not by substring. `VerifyProsePromiseInput` has one
    // field today, so a `not.toContain('## ')` assertion has no venue context
    // in scope to catch and cannot fail for any implementation of the current
    // signature — it would describe a guard it does not provide. Pinning the
    // whole string means widening the input has to change this line, which is
    // the point: the narrow input is what makes the replay harness possible
    // and keeps the check robust to venue persona, so widening it is a
    // decision rather than a detail.
    expect(call.prompt).toBe(
      'Assistant\'s reply, about to be sent: "next one\'s on us"\n\nDoes this reply commit the venue to giving this guest something of value?',
    )
  })

  it('pins the output cap', async () => {
    generateObjectMock.mockResolvedValue({
      object: {
        reasoning: 'r',
        promisesSomething: false,
        commitmentType: 'none',
        commitmentDescription: '',
      },
    })

    await verifyProsePromise({ replyBody: 'hi' })

    const call = generateObjectMock.mock.calls[0]?.[0] as { maxOutputTokens: number }
    // 1000, not verify-mechanic-offer's 300: unbounded `reasoning` is
    // declared first and this call also emits a description, so the tail sits
    // further from the start than either sibling's. Walking it back toward
    // 300 has to delete a test that says why not.
    expect(call.maxOutputTokens).toBe(1000)
    expect(VERIFY_PROSE_PROMISE_MAX_OUTPUT_TOKENS).toBe(1000)
  })

  it('reports truncation under its own errorCode', async () => {
    generateObjectMock.mockRejectedValue(truncationError())

    const result = await verifyProsePromise({ replyBody: "we'll make it right" })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.errorCode).toBe(VERIFY_PROSE_PROMISE_TRUNCATED_ERROR_CODE)
  })

  // The negative half. A parse failure that stopped normally is not a
  // truncation, and the caller retries one and not the other — so mistaking
  // them costs a retry that cannot help, or skips one that would.
  it('does NOT report truncation when the parse failed but finishReason is stop', async () => {
    generateObjectMock.mockRejectedValue(parseErrorThatStopped())

    const result = await verifyProsePromise({ replyBody: "we'll make it right" })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.errorCode).toBe('ai_verify_prose_promise_failed')
  })

  it('reports an ordinary transport failure under the generic errorCode', async () => {
    generateObjectMock.mockRejectedValue(new Error('fetch failed'))

    const result = await verifyProsePromise({ replyBody: "we'll make it right" })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.errorCode).toBe('ai_verify_prose_promise_failed')
    expect(result.error).toBe('fetch failed')
  })

  it('refuses an empty body without calling the model', async () => {
    const result = await verifyProsePromise({ replyBody: '   ' })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toBe('invalid_input')
    expect(generateObjectMock).not.toHaveBeenCalled()
  })
})
