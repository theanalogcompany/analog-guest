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
      guestInboundBody: null,
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

    const result = await verifyProsePromise({ replyBody: "we're open at 7 tomorrow", guestInboundBody: null })

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

    const result = await verifyProsePromise({ replyBody: "we'll sort you out next time", guestInboundBody: null })

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

    const result = await verifyProsePromise({ replyBody: "we'll make it right", guestInboundBody: null })

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

    const result = await verifyProsePromise({ replyBody: "I'll set one aside", guestInboundBody: null })

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

    await verifyProsePromise({ replyBody: 'hi', guestInboundBody: null })

    const call = generateObjectMock.mock.calls[0]?.[0] as { schema: { shape: object } }
    const keys = Object.keys(call.schema.shape)
    expect(keys[0]).toBe('reasoning')
    expect(keys.indexOf('reasoning')).toBeLessThan(keys.indexOf('promisesSomething'))
  })

  // TAC-527. This test was written to force exactly the edit this ticket
  // made: its predecessor pinned the whole prompt string and said in as many
  // words that widening the input has to change this line. It still pins the
  // whole string, so the next widening is a decision rather than a detail.
  it('sends the reply body alone when there is no guest message', async () => {
    generateObjectMock.mockResolvedValue({
      object: {
        reasoning: 'r',
        promisesSomething: false,
        commitmentType: 'none',
        commitmentDescription: '',
      },
    })

    await verifyProsePromise({ replyBody: "next one's on us", guestInboundBody: null })

    const call = generateObjectMock.mock.calls[0]?.[0] as { prompt: string; system: string }
    // BYTE-IDENTICAL to v1.0.0's prompt. This is the assertion behind the
    // claim that proactive turns are unchanged and that TAC-401's 220-fixture
    // replay stays comparable: both pass null, and null must render nothing.
    expect(call.prompt).toBe(
      'Assistant\'s reply, about to be sent: "next one\'s on us"\n\nDoes this reply commit the venue to giving this guest something of value?',
    )
  })

  it('renders the guest message BEFORE the reply when there is one', async () => {
    generateObjectMock.mockResolvedValue({
      object: {
        reasoning: 'r',
        promisesSomething: true,
        commitmentType: 'comp',
        commitmentDescription: 'a replacement gulab jamun',
      },
    })

    await verifyProsePromise({
      replyBody: "ugh, that's on us too. really sorry",
      guestInboundBody: 'the gulab jamun was stale too',
    })

    const call = generateObjectMock.mock.calls[0]?.[0] as { prompt: string }
    // Pinned whole, and the ORDER is the substance rather than presentation:
    // the model has to read what the guest said before what we are about to
    // say back, or "too" has nothing to resolve against.
    expect(call.prompt).toBe(
      'Guest\'s message, which this reply is answering: "the gulab jamun was stale too"\n\n' +
        'Assistant\'s reply, about to be sent: "ugh, that\'s on us too. really sorry"\n\n' +
        'Does this reply commit the venue to giving this guest something of value?',
    )
  })

  // A blank inbound is not a guest message. Without this, a whitespace-only
  // body would render an empty quoted line and ask the model to resolve "too"
  // against nothing.
  it.each(['', '   ', '\n'])('renders no guest line for a blank inbound (%j)', async (blank) => {
    generateObjectMock.mockResolvedValue({
      object: {
        reasoning: 'r',
        promisesSomething: false,
        commitmentType: 'none',
        commitmentDescription: '',
      },
    })

    await verifyProsePromise({ replyBody: 'hi', guestInboundBody: blank })

    const call = generateObjectMock.mock.calls[0]?.[0] as { prompt: string }
    expect(call.prompt).toBe(
      'Assistant\'s reply, about to be sent: "hi"\n\nDoes this reply commit the venue to giving this guest something of value?',
    )
  })

  // TAC-527: the input widened by exactly ONE string and no more. TAC-415
  // measured this check at 27/60 on one persona and 4/220 at Le Mil's, so
  // what is kept OUT is what keeps it from being tuned to a venue's voice.
  it('never sends venue context, persona, mechanics or retrieved knowledge', async () => {
    generateObjectMock.mockResolvedValue({
      object: {
        reasoning: 'r',
        promisesSomething: false,
        commitmentType: 'none',
        commitmentDescription: '',
      },
    })

    await verifyProsePromise({
      replyBody: "next one's on us",
      guestInboundBody: 'my cortado was cold',
    })

    const call = generateObjectMock.mock.calls[0]?.[0] as { prompt: string; system: string }
    // The prompt is pinned whole above, so this asserts the one thing that
    // assertion cannot: that no prompt SECTION shape reaches either string.
    expect(call.prompt).not.toContain('## ')
    expect(call.system).not.toContain('## ')
    expect(call.prompt).not.toContain('# ')
  })

  describe('the approved rule (TAC-527)', () => {
    async function systemPrompt(guestInboundBody: string | null): Promise<string> {
      generateObjectMock.mockResolvedValue({
        object: {
          reasoning: 'r',
          promisesSomething: false,
          commitmentType: 'none',
          commitmentDescription: '',
        },
      })
      await verifyProsePromise({ replyBody: 'hi', guestInboundBody })
      return (generateObjectMock.mock.calls[0]?.[0] as { system: string }).system
    }

    // THE REGRESSION GUARD, and it is the reason the rule renders conditionally
    // at all. Written unconditionally, it moved TAC-401's apology-idiom rate
    // from a recorded 0/20 to 8/20 on the 220-body replay — which runs
    // body-only, the configuration EVERY proactive turn uses. Both offending
    // bodies were engine followups apologising about a past drink.
    //
    // Transcribed from v1.0.0 rather than built from the live constants: a test
    // that assembled the expected string the same way the source does could
    // only confirm the source equals itself.
    it('composes the v1.0.0 system prompt EXACTLY when there is no guest message', async () => {
      const prompt = await systemPrompt(null)
      expect(prompt).toContain(
        '- An apology that gives nothing. "We\'ll do better next time", "that one\'s on us to get right", "sorry that happened". "On us" in an apology about responsibility is not "on us" as in free.\n',
      )
      expect(prompt).not.toContain('But when the guest\'s message names a specific thing')
      expect(prompt).not.toContain('You may also be shown')
      // The sentence the base prompt ends that paragraph with, immediately
      // followed by the next one, so an inserted paragraph fails here too.
      expect(prompt).toContain(
        'Only whether it was offered.\n\nSomething of value means the guest ends up with product',
      )
    })

    // ONE contiguous literal, not fragments. The TAC-409 lesson: a sentence
    // can be reversed while every asserted fragment survives, and three
    // mutants passed a fragment-pinned version of exactly this kind of
    // assertion. The clause that matters here is the carve-out, so the
    // carve-out is what is pinned whole.
    it('carves the accepted-complaint case out of the apology rule, in one piece', async () => {
      expect(await systemPrompt('the gulab jamun was stale')).toContain(
        '"On us" in an apology about responsibility is not "on us" as in free. But when the guest\'s message names a specific thing that was wrong and the reply accepts it with "that\'s on us", "that one too", "same for that one" or similar, the venue is promising to make that specific thing good. Name it in commitmentDescription, taking the item from the guest\'s message.',
      )
    })

    // The guard that keeps the widened input from becoming a licence. Without
    // it, a guest ASKING for something free is one step from reading as a
    // promise. Pinned whole for the same reason as above.
    it('scopes what the guest message may be used for, in one piece', async () => {
      expect(await systemPrompt('the gulab jamun was stale')).toContain(
        'Use it for ONE thing: resolving what a short reply refers to. Which item "that one", "that", or "too" points at, and whether the guest reported something was wrong. The promise itself must still be in the assistant\'s own words. A guest ASKING for something free is not a promise, and a reply that does not accept it is not a promise no matter what the guest asked for.',
      )
    })
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

    await verifyProsePromise({ replyBody: 'hi', guestInboundBody: null })

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

    const result = await verifyProsePromise({ replyBody: "we'll make it right", guestInboundBody: null })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.errorCode).toBe(VERIFY_PROSE_PROMISE_TRUNCATED_ERROR_CODE)
  })

  // The negative half. A parse failure that stopped normally is not a
  // truncation, and the caller retries one and not the other — so mistaking
  // them costs a retry that cannot help, or skips one that would.
  it('does NOT report truncation when the parse failed but finishReason is stop', async () => {
    generateObjectMock.mockRejectedValue(parseErrorThatStopped())

    const result = await verifyProsePromise({ replyBody: "we'll make it right", guestInboundBody: null })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.errorCode).toBe('ai_verify_prose_promise_failed')
  })

  it('reports an ordinary transport failure under the generic errorCode', async () => {
    generateObjectMock.mockRejectedValue(new Error('fetch failed'))

    const result = await verifyProsePromise({ replyBody: "we'll make it right", guestInboundBody: null })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.errorCode).toBe('ai_verify_prose_promise_failed')
    expect(result.error).toBe('fetch failed')
  })

  it('refuses an empty body without calling the model', async () => {
    const result = await verifyProsePromise({ replyBody: '   ', guestInboundBody: null })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toBe('invalid_input')
    expect(generateObjectMock).not.toHaveBeenCalled()
  })
})
