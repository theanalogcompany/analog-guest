import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { GenerateMessageResult } from '@/lib/ai'

const scheduleAndSendMock = vi.fn()
const dispatchInstagramReplyMock = vi.fn()
const fireRedAlertMock = vi.fn()

vi.mock('./schedule-and-send', () => ({
  scheduleAndSend: (...a: unknown[]) => scheduleAndSendMock(...a),
}))
vi.mock('./dispatch-instagram-reply', () => ({
  dispatchInstagramReply: (...a: unknown[]) => dispatchInstagramReplyMock(...a),
}))
vi.mock('./alerts', () => ({
  fireRedAlert: (...a: unknown[]) => fireRedAlertMock(...a),
}))

import { dispatchReply } from './dispatch-reply'
import type { RuntimeContext } from './types'

const GENERATION = { body: 'Open until 3' } as GenerateMessageResult
const OPTIONS = {
  skipHumanFeelDelay: true,
  reviewReason: 'demo_bypass',
  rng: () => 0.5,
  renderedIntentions: [],
  replyCheck: { inboundMessageId: 'in-1' },
  onUndelivered: 'card' as const,
}

function ctx(conversationChannel: RuntimeContext['conversationChannel']): RuntimeContext {
  return {
    agentRunId: 'run-1',
    venue: { id: 'venue-1' },
    guest: { id: 'guest-1' },
    followupTrigger: null,
    conversationChannel,
  } as unknown as RuntimeContext
}

beforeEach(() => {
  scheduleAndSendMock.mockReset()
  dispatchInstagramReplyMock.mockReset()
  fireRedAlertMock.mockReset()
})

describe('dispatchReply (TAC-469)', () => {
  it("sends a text conversation's reply through scheduleAndSend, exactly as before", async () => {
    scheduleAndSendMock.mockResolvedValue({ outboundMessageId: 'row-1', providerMessageId: 'h1', generationId: 'g', bubbleCount: 1 })
    const result = await dispatchReply(ctx('text'), GENERATION, OPTIONS)

    expect(result).toEqual({
      kind: 'sent',
      outboundMessageId: 'row-1',
      providerMessageId: 'h1',
      generationId: 'g',
      bubbleCount: 1,
      undelivered: null,
    })
    // Only scheduleAndSend's own options: nothing Instagram-shaped reaches the
    // text arm.
    expect(scheduleAndSendMock).toHaveBeenCalledWith(expect.anything(), GENERATION, {
      skipHumanFeelDelay: true,
      reviewReason: 'demo_bypass',
      rng: OPTIONS.rng,
      renderedIntentions: [],
    })
    expect(dispatchInstagramReplyMock).not.toHaveBeenCalled()
  })

  it("lets the text arm's throw through, so its callers' failure handling is unchanged", async () => {
    scheduleAndSendMock.mockRejectedValue(new Error('scheduleAndSend: sendMessage failed: boom'))
    await expect(dispatchReply(ctx('text'), GENERATION, OPTIONS)).rejects.toThrow('sendMessage failed')
  })

  it("sends an Instagram conversation's reply through the Instagram arm", async () => {
    dispatchInstagramReplyMock.mockResolvedValue({ kind: 'superseded', byMessageId: 'echo-1' })
    const result = await dispatchReply(ctx('instagram'), GENERATION, OPTIONS)
    expect(result).toEqual({ kind: 'superseded', byMessageId: 'echo-1' })
    expect(dispatchInstagramReplyMock).toHaveBeenCalledWith(expect.anything(), GENERATION, OPTIONS)
    expect(scheduleAndSendMock).not.toHaveBeenCalled()
  })

  it('refuses to route on an unknown channel, and alerts', async () => {
    const result = await dispatchReply(ctx(null), GENERATION, OPTIONS)
    expect(result).toEqual({ kind: 'not_sent', reason: 'channel_unresolved' })
    expect(scheduleAndSendMock).not.toHaveBeenCalled()
    expect(dispatchInstagramReplyMock).not.toHaveBeenCalled()
    expect(fireRedAlertMock).toHaveBeenCalledWith(expect.objectContaining({ stage: 'send' }))
  })
})
