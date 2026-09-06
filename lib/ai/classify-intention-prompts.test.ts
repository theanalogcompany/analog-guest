import { afterEach, describe, expect, it, vi } from 'vitest'
import { classifyIntentionPrompts } from './classify-intention-prompts'

// Mock the AI SDK and the model client so no real Anthropic call goes out.
// Mirrors extract-reported-order.test.ts's setup exactly.
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

const BOTH_INTENTIONS = [
  { key: 'learn_first_order', description: 'asks the guest what they ordered' },
  { key: 'invite_contact_save', description: 'tells the guest to save this number' },
]

describe('classifyIntentionPrompts', () => {
  it('returns raisedKeys and a promptVersion on success', async () => {
    generateObjectMock.mockResolvedValue({ object: { raisedKeys: ['learn_first_order'] } })

    const result = await classifyIntentionPrompts({
      sentBody: "hey! what'd you end up getting, and how was it?",
      openIntentions: BOTH_INTENTIONS,
    })

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.data.raisedKeys).toEqual(['learn_first_order'])
      expect(result.data.promptVersion).toEqual(expect.any(String))
    }
  })

  it('returns an empty raisedKeys array unchanged when the message raises nothing', async () => {
    generateObjectMock.mockResolvedValue({ object: { raisedKeys: [] } })

    const result = await classifyIntentionPrompts({
      sentBody: 'we close at 8 tonight',
      openIntentions: BOTH_INTENTIONS,
    })

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.data.raisedKeys).toEqual([])
    }
  })

  it('passes the sent body into the prompt', async () => {
    generateObjectMock.mockResolvedValue({ object: { raisedKeys: [] } })

    await classifyIntentionPrompts({
      sentBody: 'save this number and text me anytime',
      openIntentions: [BOTH_INTENTIONS[1]],
    })

    const callArgs = generateObjectMock.mock.calls[0]?.[0] as { prompt?: string } | undefined
    expect(callArgs?.prompt).toContain('save this number and text me anytime')
  })

  // MAJOR finding from TAC-324 code review: the description is now carried
  // on the input itself (definitions.ts owns it), not looked up from a
  // second, independently-maintained lib/ai-side map. This locks that the
  // caller's description string actually reaches the system prompt.
  it('passes each open intention\'s description into the system prompt', async () => {
    generateObjectMock.mockResolvedValue({ object: { raisedKeys: [] } })

    await classifyIntentionPrompts({
      sentBody: 'text',
      openIntentions: BOTH_INTENTIONS,
    })

    const callArgs = generateObjectMock.mock.calls[0]?.[0] as { system?: string } | undefined
    expect(callArgs?.system).toContain('learn_first_order: asks the guest what they ordered')
    expect(callArgs?.system).toContain('invite_contact_save: tells the guest to save this number')
  })

  it('constrains raisedKeys to only the passed-in open keys via a per-call z.enum', async () => {
    generateObjectMock.mockResolvedValue({ object: { raisedKeys: [] } })

    await classifyIntentionPrompts({
      sentBody: 'text',
      openIntentions: [BOTH_INTENTIONS[1]],
    })

    const callArgs = generateObjectMock.mock.calls[0]?.[0] as { schema?: unknown } | undefined
    // z.enum-backed schema should reject a key that wasn't in the input set.
    const parsed = (
      callArgs?.schema as { safeParse: (v: unknown) => { success: boolean } } | undefined
    )?.safeParse({ raisedKeys: ['learn_first_order'] })
    expect(parsed?.success).toBe(false)
  })

  it('returns ok:false for empty sentBody without calling the model', async () => {
    const result = await classifyIntentionPrompts({
      sentBody: '',
      openIntentions: [BOTH_INTENTIONS[0]],
    })
    expect(result.ok).toBe(false)
    expect(generateObjectMock).not.toHaveBeenCalled()
  })

  it('returns ok:true with empty raisedKeys for an empty openIntentions set, without calling the model', async () => {
    // z.enum requires a non-empty tuple — this guard exists independent of
    // caller discipline (the caller already gates on openIntentions.length > 0).
    const result = await classifyIntentionPrompts({ sentBody: 'hello', openIntentions: [] })
    expect(result).toEqual({
      ok: true,
      data: { raisedKeys: [], promptVersion: expect.any(String) },
    })
    expect(generateObjectMock).not.toHaveBeenCalled()
  })

  it('returns ok:false with an error code when generateObject throws', async () => {
    generateObjectMock.mockRejectedValue(new Error('anthropic timeout'))

    const result = await classifyIntentionPrompts({
      sentBody: 'text',
      openIntentions: [BOTH_INTENTIONS[0]],
    })

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toContain('anthropic timeout')
      expect(result.errorCode).toBe('ai_classify_intention_prompts_failed')
    }
  })
})
