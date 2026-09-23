import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { GenerateMessageResult } from '@/lib/ai'
import { callsNamed, queryRecorder } from '@/lib/messaging/instagram/testing/query-recorder'
import { INSTAGRAM_WINDOW_MARGIN_MS } from '@/lib/messaging/instagram/window'

const captureSendFailedMock = vi.fn()
const captureSupersededMock = vi.fn()
const fireRedAlertMock = vi.fn()
const persistOrRegenMock = vi.fn()
const loadPendingRowsMock = vi.fn()
const guestReadMock = vi.fn()

vi.mock('@/lib/analytics/posthog', () => ({
  captureInstagramSendFailed: (...a: unknown[]) => captureSendFailedMock(...a),
  captureInstagramReplySuperseded: (...a: unknown[]) => captureSupersededMock(...a),
}))
vi.mock('./alerts', () => ({
  fireRedAlert: (...a: unknown[]) => fireRedAlertMock(...a),
}))
// The card writer's database reads and writes. buildOutboundInsert and the
// slot decision stay REAL, so the row shape and the slot rule under test are
// the shipped ones, not a mock's opinion of them.
vi.mock('./schedule-and-send', async () => {
  const actual = await vi.importActual<typeof import('./schedule-and-send')>('./schedule-and-send')
  return { ...actual, persistOrRegenQueuedDraft: (...a: unknown[]) => persistOrRegenMock(...a) }
})
vi.mock('./pending-slots', async () => {
  const actual = await vi.importActual<typeof import('./pending-slots')>('./pending-slots')
  return { ...actual, loadPendingRowsBySlot: (...a: unknown[]) => loadPendingRowsMock(...a) }
})
vi.mock('@/lib/db/admin', () => ({
  createAdminClient: () => ({
    from: () => ({
      select: () => ({ eq: () => ({ maybeSingle: () => guestReadMock() }) }),
    }),
  }),
}))

import {
  dispatchInstagramReply,
  fitBubblesToInstagramCap,
  insertOrReconcileEcho,
  INSTAGRAM_SEND_FAILED_REVIEW_REASON,
  PROVIDER_MESSAGE_ID_UNIQUE_CONSTRAINT,
  writeInstagramSendFailureCard,
  type InstagramDispatchDeps,
} from './dispatch-instagram-reply'
import type { OpenIntention } from './intentions/derive'
import type { RuntimeContext } from './types'

const HOUR = 60 * 60 * 1000
const NOW = new Date('2026-09-19T18:00:00.000Z')
const TARGET = { accountId: '17841400000000001', recipientId: '1000000000000001', token: 'tok' }
const RENDERED: OpenIntention[] = [
  { key: 'learn_name', promptLine: "you don't know their name yet", eligibleAt: new Date('2026-09-19T17:00:00.000Z') } as OpenIntention,
]

function makeCtx(): RuntimeContext {
  return {
    agentRunId: 'run-1',
    venue: { id: 'venue-1' } as RuntimeContext['venue'],
    guest: { id: 'guest-1', firstName: 'Sam', isDemo: false } as RuntimeContext['guest'],
    currentMessage: { id: 'in-1', providerMessageId: 'mid-in', body: 'hi', receivedAt: NOW, channel: 'instagram', referralSource: null },
    followupTrigger: null,
    conversationChannel: 'instagram',
    pendingQuestion: null,
    recentMessages: [],
    recognition: { state: 'new', score: 0, computedAt: NOW } as RuntimeContext['recognition'],
    mechanics: [],
    recentVisits: [],
    activeCommitments: [],
    openIntentions: [],
    intentionDerivation: { newlyEligible: [], brakeEngaged: false },
    corpus: null,
    knowledgeCorpus: null,
    classification: {
      category: 'new_question',
      classifierConfidence: 0.9,
      reasoning: 'r',
      crisisSafety: false,
      correctsPendingReply: false,
    },
    trace: { id: 'trace-1' } as RuntimeContext['trace'],
  }
}

function generation(body: string, overrides: Partial<GenerateMessageResult> = {}): GenerateMessageResult {
  return {
    body,
    voiceFidelity: 0.8,
    reasoning: 'r',
    unverifiedUrls: [],
    requiresOperatorApproval: false,
    approvalReason: '',
    complaintIntent: 'none',
    knowledgeGap: false,
    contextUpdate: {},
    commitment: {},
    arrivalCapture: {},
    cancelsCommitmentId: '',
    attempts: 1,
    attemptScores: [0.8],
    attemptHistory: [],
    systemPrompt: '',
    userPrompt: '',
    promptVersion: 'v-test',
    dashViolationPersisted: false,
    selfTalkViolationPersisted: false,
    emojiDirectiveViolated: false,
    ...overrides,
  }
}

type Mocked<T> = { [K in keyof T]: ReturnType<typeof vi.fn> }

function deps(overrides: Partial<InstagramDispatchDeps> = {}): InstagramDispatchDeps & Mocked<InstagramDispatchDeps> {
  let mid = 0
  let row = 0
  const base = {
    loadTarget: vi.fn(async () => ({ ok: true as const, target: TARGET })),
    loadLastGuestActionAt: vi.fn(async () => ({ ok: true as const, value: new Date(NOW.getTime() - 30_000) })),
    findReplyToInbound: vi.fn(async () => ({ ok: true as const, value: null })),
    sendText: vi.fn(async () => ({ ok: true as const, mid: `mid-${++mid}` })),
    saveMessage: vi.fn(async () => ({ ok: true as const, id: `row-${++row}`, reconciled: false })),
    writeCard: vi.fn(async () => ({ ok: true as const, cardId: 'card-1' })),
    materializeCommitment: vi.fn(async () => {}),
    applyCancellation: vi.fn(async () => {}),
    now: vi.fn(() => NOW),
    sleep: vi.fn(async () => {}),
  }
  return { ...base, ...overrides } as InstagramDispatchDeps & Mocked<InstagramDispatchDeps>
}

const INBOUND_REPLY = { replyCheck: { inboundMessageId: 'in-1' }, onUndelivered: 'card' as const }
const ONE_BLOCK = () => 0.99 // resolveDispatchBubbles: the coin says don't split
const SPLIT = () => 0 // the coin says split

beforeEach(() => {
  captureSendFailedMock.mockReset()
  captureSupersededMock.mockReset()
  fireRedAlertMock.mockReset()
  persistOrRegenMock.mockReset()
  loadPendingRowsMock.mockReset()
  guestReadMock.mockReset()
})

function sentTexts(d: Mocked<InstagramDispatchDeps>): string[] {
  return d.sendText.mock.calls.map((c) => (c[0] as { text: string }).text)
}

function savedRows(d: Mocked<InstagramDispatchDeps>): Array<Record<string, unknown>> {
  return d.saveMessage.mock.calls.map((c) => c[0] as Record<string, unknown>)
}

describe('dispatchInstagramReply: the window is open', () => {
  it('sends over Instagram and saves an Instagram row with the mid', async () => {
    const d = deps()
    const result = await dispatchInstagramReply(
      makeCtx(),
      generation('Open until 3 today.'),
      { ...INBOUND_REPLY, renderedIntentions: RENDERED, rng: ONE_BLOCK },
      d,
    )

    expect(result).toMatchObject({ kind: 'sent', outboundMessageId: 'row-1', providerMessageId: 'mid-1', bubbleCount: 1, undelivered: null })
    expect(d.sendText).toHaveBeenCalledWith({ ...TARGET, text: 'Open until 3 today.' })
    const [row] = savedRows(d)
    expect(row).toMatchObject({
      channel: 'instagram',
      direction: 'outbound',
      status: 'sent',
      review_state: 'auto_sent',
      provider_message_id: 'mid-1',
      body: 'Open until 3 today.',
      reply_to_message_id: 'in-1',
      generated_by: 'llm',
    })
    expect(row!.rendered_intentions).not.toBeNull()
    expect(d.materializeCommitment).toHaveBeenCalledWith(expect.anything(), expect.anything(), 'row-1')
    expect(d.writeCard).not.toHaveBeenCalled()
    expect(captureSendFailedMock).not.toHaveBeenCalled()
  })

  it('sends a split reply as separate messages, rendered intentions on the first row only', async () => {
    const d = deps()
    await dispatchInstagramReply(
      makeCtx(),
      generation('Open until 3. Oat milk too.'),
      { ...INBOUND_REPLY, renderedIntentions: RENDERED, rng: SPLIT },
      d,
    )
    expect(sentTexts(d)).toEqual(['Open until 3', 'Oat milk too'])
    const rows = savedRows(d)
    expect(rows[0]!.rendered_intentions).not.toBeNull()
    expect(rows[1]!.rendered_intentions).toBeNull()
    expect(rows[0]!.generation_id).toBe(rows[1]!.generation_id)
    expect(d.sleep).toHaveBeenCalledTimes(1)
  })

  it('skips the gap between messages when asked, as the text arm does', async () => {
    const d = deps()
    await dispatchInstagramReply(makeCtx(), generation('Open until 3. Oat milk too.'), { ...INBOUND_REPLY, rng: SPLIT, skipHumanFeelDelay: true }, d)
    expect(d.sleep).not.toHaveBeenCalled()
  })
})

describe('dispatchInstagramReply: what the row says it answers', () => {
  it("names the run's own inbound by default", async () => {
    const d = deps()
    await dispatchInstagramReply(makeCtx(), generation('Open until 3'), INBOUND_REPLY, d)
    expect(savedRows(d)[0]!.reply_to_message_id).toBe('in-1')
  })

  // The holding message's context has no currentMessage, so without this the
  // row would name nothing, and the reply check reads a row naming nothing as
  // answering everything before it: the holding message would silence the
  // agent's own reply to whatever the guest asked while it was written.
  it('names the question a holding message is holding, not nothing', async () => {
    const d = deps()
    const ctx = { ...makeCtx(), currentMessage: null } as RuntimeContext
    await dispatchInstagramReply(
      ctx,
      generation('still checking on that'),
      { replyCheck: { inboundMessageId: 'question-1' }, answersInboundId: 'question-1', onUndelivered: 'none' },
      d,
    )
    expect(savedRows(d)[0]!.reply_to_message_id).toBe('question-1')
  })

  // EVERY row, not just the first: a holding message is often two sentences
  // and the coin splits it, and a second row naming nothing would silence the
  // agent's next reply exactly as the first one would have.
  it('names it on every message of a split holding message', async () => {
    const d = deps()
    const ctx = { ...makeCtx(), currentMessage: null } as RuntimeContext
    await dispatchInstagramReply(
      ctx,
      generation('Still checking on that. I will come back to you.'),
      { replyCheck: { inboundMessageId: 'question-1' }, answersInboundId: 'question-1', onUndelivered: 'none', rng: SPLIT },
      d,
    )
    const rows = savedRows(d)
    expect(rows).toHaveLength(2)
    expect(rows.map((r) => r.reply_to_message_id)).toEqual(['question-1', 'question-1'])
  })
})

describe('dispatchInstagramReply: what reached the guest', () => {
  it('reports the whole reply when it all went out', async () => {
    const d = deps()
    const result = await dispatchInstagramReply(makeCtx(), generation('Open until 3. Oat milk too.'), { ...INBOUND_REPLY, rng: SPLIT }, d)
    expect(result).toMatchObject({ kind: 'sent', deliveredBody: 'Open until 3 Oat milk too' })
  })

  // What the intention recorder judges: an ask that sat in the message that
  // never went out must not be recorded as asked.
  it('reports only the messages that went out when a later one failed', async () => {
    let n = 0
    const d = deps({
      sendText: vi.fn(async () =>
        ++n === 1 ? { ok: true as const, mid: 'mid-1' } : { ok: false as const, kind: 'rate_limited' as const, failure: null },
      ),
    })
    const result = await dispatchInstagramReply(makeCtx(), generation('Open until 3. Oat milk too.'), { ...INBOUND_REPLY, rng: SPLIT }, d)
    expect(result).toMatchObject({ kind: 'sent', deliveredBody: 'Open until 3' })
  })
})

describe('dispatchInstagramReply: the window is closed', () => {
  it("cards the whole reply when the guest's last action is over 24 hours old, sending nothing", async () => {
    const d = deps({
      loadLastGuestActionAt: vi.fn(async () => ({ ok: true as const, value: new Date(NOW.getTime() - 25 * HOUR) })),
    })
    const gen = generation('Open until 3 today.', { commitment: { type: 'recommendation', description: 'cortado' } })
    const result = await dispatchInstagramReply(makeCtx(), gen, { ...INBOUND_REPLY, renderedIntentions: RENDERED }, d)

    expect(result).toEqual({ kind: 'carded', reason: 'window_closed_by_gate', cardId: 'card-1' })
    expect(d.sendText).not.toHaveBeenCalled()
    // The whole reply, with its commitment and rendered intentions, so an
    // approved card does what the auto-send would have.
    expect(d.writeCard).toHaveBeenCalledWith(
      expect.objectContaining({ generation: gen, carrier: true, renderedIntentions: RENDERED }),
    )
    expect(captureSendFailedMock).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'window_closed_by_gate', scope: 'whole_reply', windowRemainingMs: -HOUR, cardId: 'card-1' }),
    )
  })

  it('closes at the margin, before Meta does', async () => {
    const d = deps({
      loadLastGuestActionAt: vi.fn(async () => ({
        ok: true as const,
        value: new Date(NOW.getTime() - 24 * HOUR + INSTAGRAM_WINDOW_MARGIN_MS),
      })),
    })
    const result = await dispatchInstagramReply(makeCtx(), generation('hi'), INBOUND_REPLY, d)
    expect(result.kind).toBe('carded')
    expect(d.sendText).not.toHaveBeenCalled()
  })

  it('cards the reply when the guest has never acted', async () => {
    const d = deps({ loadLastGuestActionAt: vi.fn(async () => ({ ok: true as const, value: null })) })
    const result = await dispatchInstagramReply(makeCtx(), generation('hi'), INBOUND_REPLY, d)
    expect(result).toMatchObject({ kind: 'carded', reason: 'window_closed_by_gate' })
  })

  it('is reopened by a newer guest action', async () => {
    const d = deps({ loadLastGuestActionAt: vi.fn(async () => ({ ok: true as const, value: new Date(NOW.getTime() - 5 * 60 * 1000) })) })
    const result = await dispatchInstagramReply(makeCtx(), generation('hi'), INBOUND_REPLY, d)
    expect(result.kind).toBe('sent')
  })

  it('sends anyway when the window cannot be read, and lets Meta decide', async () => {
    const d = deps({ loadLastGuestActionAt: vi.fn(async () => ({ ok: false as const, error: 'db down' })) })
    const result = await dispatchInstagramReply(makeCtx(), generation('hi'), INBOUND_REPLY, d)
    expect(result.kind).toBe('sent')
  })

  it('re-checks the window before each message and cards the rest when it closes mid-reply', async () => {
    const edge = new Date(NOW.getTime() - 24 * HOUR + INSTAGRAM_WINDOW_MARGIN_MS + 1000)
    let calls = 0
    const d = deps({
      loadLastGuestActionAt: vi.fn(async () => ({ ok: true as const, value: edge })),
      // Open for the first message; 2 seconds later, past the margin.
      now: vi.fn(() => new Date(NOW.getTime() + (calls++ < 2 ? 0 : 2000))),
    })
    const result = await dispatchInstagramReply(makeCtx(), generation('Open until 3. Oat milk too.'), { ...INBOUND_REPLY, rng: SPLIT }, d)
    expect(sentTexts(d)).toEqual(['Open until 3'])
    expect(result).toMatchObject({ kind: 'sent', undelivered: { reason: 'window_closed_by_gate', cardId: 'card-1' } })
  })
})

describe('dispatchInstagramReply: the 1000-byte cap', () => {
  const sentence = (char: string, bytes: number) => `${char.repeat(bytes - 1)}.`

  it('repacks whole sentences across messages when the reply is over the cap, dropping nothing', async () => {
    const reply = `${sentence('A', 600)} ${sentence('B', 600)}`
    const d = deps()
    await dispatchInstagramReply(makeCtx(), generation(reply), { ...INBOUND_REPLY, rng: ONE_BLOCK }, d)
    const texts = sentTexts(d)
    expect(texts).toHaveLength(2)
    expect(texts.join(' ')).toBe(reply)
    for (const text of texts) expect(Buffer.byteLength(text, 'utf8')).toBeLessThanOrEqual(1000)
  })

  it('cards a reply whose one sentence is over the cap, and never cuts it', async () => {
    const d = deps()
    const result = await dispatchInstagramReply(makeCtx(), generation(sentence('A', 1200)), INBOUND_REPLY, d)
    expect(result).toEqual({ kind: 'carded', reason: 'sentence_over_cap', cardId: 'card-1' })
    expect(d.sendText).not.toHaveBeenCalled()
  })

  it('cards a reply that would need more than three messages', async () => {
    const reply = ['A', 'B', 'C', 'D'].map((c) => sentence(c, 900)).join(' ')
    const d = deps()
    const result = await dispatchInstagramReply(makeCtx(), generation(reply), INBOUND_REPLY, d)
    expect(result).toMatchObject({ kind: 'carded', reason: 'too_many_messages' })
    expect(d.sendText).not.toHaveBeenCalled()
  })

  it('counts bytes, not characters', () => {
    const emoji = '\u{1F600}'
    // 600 of .length, 1200 bytes, one sentence.
    expect(emoji.repeat(300).length).toBe(600)
    expect(fitBubblesToInstagramCap([emoji.repeat(300)], emoji.repeat(300))).toEqual({ ok: false, reason: 'sentence_over_cap' })
    expect(fitBubblesToInstagramCap([emoji.repeat(250)], emoji.repeat(250))).toEqual({ ok: true, bubbles: [emoji.repeat(250)] })
  })

  it('leaves messages already under the cap exactly as they were', () => {
    expect(fitBubblesToInstagramCap(['Open until 3', 'Oat milk too'], 'Open until 3. Oat milk too.')).toEqual({
      ok: true,
      bubbles: ['Open until 3', 'Oat milk too'],
    })
  })
})

describe('dispatchInstagramReply: send failures become cards (rule 4)', () => {
  it("cards the reply when Meta refuses the first message, with Meta's codes on the event", async () => {
    const d = deps({
      sendText: vi.fn(async () => ({
        ok: false as const,
        kind: 'window_closed' as const,
        failure: { reason: 'graph_error' as const, httpStatus: 400, code: 10, subcode: 2534022, type: 'IGApiException', fbtraceId: 'Ab' },
      })),
    })
    const result = await dispatchInstagramReply(makeCtx(), generation('hi'), INBOUND_REPLY, d)
    expect(result).toEqual({ kind: 'carded', reason: 'window_closed', cardId: 'card-1' })
    expect(d.saveMessage).not.toHaveBeenCalled()
    expect(captureSendFailedMock).toHaveBeenCalledWith(
      expect.objectContaining({ metaCode: 10, metaSubcode: 2534022, fbtraceId: 'Ab', outcomeUnknown: false, undeliveredBody: 'hi' }),
    )
  })

  it('marks a Meta 5xx as possibly delivered: its side failed, it may have taken the message', async () => {
    const d = deps({
      sendText: vi.fn(async () => ({
        ok: false as const,
        kind: 'graph_error' as const,
        failure: { reason: 'graph_error' as const, httpStatus: 503, code: 2, subcode: null, type: 'OAuthException', fbtraceId: null },
      })),
    })
    await dispatchInstagramReply(makeCtx(), generation('hi'), INBOUND_REPLY, d)
    expect(captureSendFailedMock).toHaveBeenCalledWith(expect.objectContaining({ reason: 'graph_error', outcomeUnknown: true }))
  })

  it('marks a Meta 4xx as definitely not delivered', async () => {
    const d = deps({
      sendText: vi.fn(async () => ({
        ok: false as const,
        kind: 'graph_error' as const,
        failure: { reason: 'graph_error' as const, httpStatus: 400, code: 100, subcode: null, type: 'IGApiException', fbtraceId: null },
      })),
    })
    await dispatchInstagramReply(makeCtx(), generation('hi'), INBOUND_REPLY, d)
    expect(captureSendFailedMock).toHaveBeenCalledWith(expect.objectContaining({ outcomeUnknown: false }))
  })

  it('marks a timed-out send as possibly delivered', async () => {
    const d = deps({ sendText: vi.fn(async () => ({ ok: false as const, kind: 'timeout' as const, failure: { reason: 'timeout' as const } })) })
    await dispatchInstagramReply(makeCtx(), generation('hi'), INBOUND_REPLY, d)
    expect(captureSendFailedMock).toHaveBeenCalledWith(expect.objectContaining({ reason: 'timeout', outcomeUnknown: true }))
  })

  it('cards the rest of a split reply when a later message fails, and creates the commitment from the first', async () => {
    let n = 0
    const d = deps({
      sendText: vi.fn(async () =>
        ++n === 1
          ? { ok: true as const, mid: 'mid-1' }
          : { ok: false as const, kind: 'rate_limited' as const, failure: null },
      ),
    })
    const gen = generation('Open until 3. Oat milk too.', { commitment: { type: 'recommendation', description: 'oat latte' } })
    const result = await dispatchInstagramReply(makeCtx(), gen, { ...INBOUND_REPLY, renderedIntentions: RENDERED, rng: SPLIT }, d)

    expect(result).toMatchObject({ kind: 'sent', outboundMessageId: 'row-1', undelivered: { reason: 'rate_limited', cardId: 'card-1' } })
    expect(d.materializeCommitment).toHaveBeenCalledWith(expect.anything(), gen, 'row-1')
    // The remainder carries neither the commitment (created already) nor the
    // rendered intentions (recorded with the first message).
    const cardInput = d.writeCard.mock.calls[0]![0] as { generation: GenerateMessageResult; carrier: boolean }
    expect(cardInput.carrier).toBe(false)
    expect(cardInput.generation.body).toBe('Oat milk too')
    expect(captureSendFailedMock).toHaveBeenCalledWith(expect.objectContaining({ scope: 'remainder', deliveredBubbles: 1, bubbleCount: 2 }))
  })

  it('cards a reply when the venue has no Instagram account connected', async () => {
    const d = deps({ loadTarget: vi.fn(async () => ({ ok: false as const, problem: 'venue_has_no_instagram_account' as const })) })
    const result = await dispatchInstagramReply(makeCtx(), generation('hi'), INBOUND_REPLY, d)
    expect(result).toMatchObject({ kind: 'carded', reason: 'venue_has_no_instagram_account' })
    expect(d.sendText).not.toHaveBeenCalled()
  })

  it('reports nothing sent when the card itself could not be written, with the text on the event', async () => {
    const d = deps({
      loadLastGuestActionAt: vi.fn(async () => ({ ok: true as const, value: null })),
      writeCard: vi.fn(async () => ({ ok: false as const, skipped: 'slot_occupied' as const })),
    })
    const result = await dispatchInstagramReply(makeCtx(), generation('Open until 3.'), INBOUND_REPLY, d)
    expect(result).toEqual({ kind: 'not_sent', reason: 'window_closed_by_gate' })
    expect(captureSendFailedMock).toHaveBeenCalledWith(
      expect.objectContaining({ cardId: null, cardSkipped: 'slot_occupied', undeliveredBody: 'Open until 3.' }),
    )
  })

  it('writes no card on a path that asked for none (the holding message)', async () => {
    const d = deps({ loadLastGuestActionAt: vi.fn(async () => ({ ok: true as const, value: null })) })
    const result = await dispatchInstagramReply(makeCtx(), generation('still checking'), { replyCheck: { inboundMessageId: 'in-1' }, onUndelivered: 'none' }, d)
    expect(result).toEqual({ kind: 'not_sent', reason: 'window_closed_by_gate' })
    expect(d.writeCard).not.toHaveBeenCalled()
  })

  it('alerts and reports unrecorded when a sent message cannot be saved', async () => {
    const d = deps({ saveMessage: vi.fn(async () => ({ ok: false as const, error: 'db down' })) })
    const result = await dispatchInstagramReply(makeCtx(), generation('hi'), INBOUND_REPLY, d)
    expect(result).toEqual({ kind: 'sent_unrecorded', providerMessageId: 'mid-1', reason: 'persist_failed' })
    expect(fireRedAlertMock).toHaveBeenCalledWith(expect.objectContaining({ stage: 'persist' }))
    expect(d.materializeCommitment).not.toHaveBeenCalled()
  })
})

describe('dispatchInstagramReply: the reply check (rule 3)', () => {
  it('sends nothing when the message already has a reply, usually from staff in the app', async () => {
    const d = deps({ findReplyToInbound: vi.fn(async () => ({ ok: true as const, value: { id: 'echo-1' } })) })
    const result = await dispatchInstagramReply(makeCtx(), generation('hi'), INBOUND_REPLY, d)
    expect(result).toEqual({ kind: 'superseded', byMessageId: 'echo-1' })
    expect(d.sendText).not.toHaveBeenCalled()
    expect(d.writeCard).not.toHaveBeenCalled()
    expect(captureSupersededMock).toHaveBeenCalledWith(
      expect.objectContaining({ inboundMessageId: 'in-1', answeredByMessageId: 'echo-1' }),
    )
  })

  // Runs before the window and the configuration checks: a message staff
  // already answered needs no card, however the rest of the send would have
  // gone. With a missing token, every inbound would otherwise card a reply.
  it('is checked before the window and the account, so an answered message cards nothing', async () => {
    const d = deps({
      findReplyToInbound: vi.fn(async () => ({ ok: true as const, value: { id: 'echo-1' } })),
      loadTarget: vi.fn(async () => ({ ok: false as const, problem: 'token_missing' as const })),
      loadLastGuestActionAt: vi.fn(async () => ({ ok: true as const, value: null })),
    })
    const result = await dispatchInstagramReply(makeCtx(), generation('hi'), INBOUND_REPLY, d)
    expect(result).toEqual({ kind: 'superseded', byMessageId: 'echo-1' })
    expect(d.writeCard).not.toHaveBeenCalled()
    expect(captureSendFailedMock).not.toHaveBeenCalled()
  })

  it('asks about the message this reply answers', async () => {
    const d = deps()
    await dispatchInstagramReply(makeCtx(), generation('hi'), INBOUND_REPLY, d)
    expect(d.findReplyToInbound).toHaveBeenCalledWith({ venueId: 'venue-1', guestId: 'guest-1', inboundMessageId: 'in-1' })
  })

  it('exempts the crisis-safety reply: it always sends (ruled 2026-09-19)', async () => {
    const d = deps({ findReplyToInbound: vi.fn(async () => ({ ok: true as const, value: { id: 'echo-1' } })) })
    const result = await dispatchInstagramReply(makeCtx(), generation('resources'), { replyCheck: 'exempt', onUndelivered: 'card' }, d)
    expect(result.kind).toBe('sent')
    expect(d.findReplyToInbound).not.toHaveBeenCalled()
  })

  it('sends anyway when the check cannot be read: two answers beat none', async () => {
    const d = deps({ findReplyToInbound: vi.fn(async () => ({ ok: false as const, error: 'db down' })) })
    const result = await dispatchInstagramReply(makeCtx(), generation('hi'), INBOUND_REPLY, d)
    expect(result.kind).toBe('sent')
  })
})

describe('insertOrReconcileEcho: the echo got here first (rule 6)', () => {
  const payload = {
    venue_id: 'venue-1',
    guest_id: 'guest-1',
    channel: 'instagram',
    direction: 'outbound',
    status: 'sent',
    body: 'Open until 3',
    generated_by: 'llm',
    voice_fidelity: 0.8,
    prompt_version: 'v-test',
    category: 'new_question',
    reply_to_message_id: 'in-1',
    langfuse_trace_id: 'trace-1',
    generation_id: 'gen-1',
    review_state: 'auto_sent',
    review_reason: null,
    sent_at: NOW.toISOString(),
    provider_message_id: 'mid-1',
    rendered_intentions: null,
  }

  it('saves our row when it lands first', async () => {
    const { client } = queryRecorder({ messages: [{ data: { id: 'row-1' }, error: null }] })
    expect(await insertOrReconcileEcho(client, payload)).toEqual({ ok: true, id: 'row-1', reconciled: false })
  })

  it('fills in the echo row when the mid collides, keeping what the echo recorded', async () => {
    const { client, queries } = queryRecorder({
      messages: [
        {
          data: null,
          error: { code: '23505', message: `duplicate key value violates unique constraint "${PROVIDER_MESSAGE_ID_UNIQUE_CONSTRAINT}"` },
        },
        { data: [{ id: 'echo-row' }], error: null },
      ],
    })
    expect(await insertOrReconcileEcho(client, payload)).toEqual({ ok: true, id: 'echo-row', reconciled: true })

    const update = queries[1]!
    const [patch] = callsNamed(update, 'update')[0] as [Record<string, unknown>]
    expect(patch).toEqual({
      status: 'sent',
      generated_by: 'llm',
      voice_fidelity: 0.8,
      prompt_version: 'v-test',
      category: 'new_question',
      reply_to_message_id: 'in-1',
      langfuse_trace_id: 'trace-1',
      generation_id: 'gen-1',
      review_state: 'auto_sent',
      review_reason: null,
      sent_at: NOW.toISOString(),
      rendered_intentions: null,
    })
    // Only the echo: the same mid, this guest, this venue, outbound, and not
    // already an agent row.
    expect(callsNamed(update, 'eq')).toEqual([
      ['provider_message_id', 'mid-1'],
      ['venue_id', 'venue-1'],
      ['guest_id', 'guest-1'],
      ['direction', 'outbound'],
    ])
    expect(callsNamed(update, 'is')).toEqual([['generated_by', null]])
  })

  it('does not treat a collision on any other constraint as the echo', async () => {
    const { client, queries } = queryRecorder({
      messages: [{ data: null, error: { code: '23505', message: 'duplicate key value violates unique constraint "idx_messages_one_pending_conversation_per_guest"' } }],
    })
    expect((await insertOrReconcileEcho(client, payload)).ok).toBe(false)
    expect(queries).toHaveLength(1)
  })

  it('fails when the mid collides but no echo row matches', async () => {
    const { client } = queryRecorder({
      messages: [
        { data: null, error: { code: '23505', message: PROVIDER_MESSAGE_ID_UNIQUE_CONSTRAINT } },
        { data: [], error: null },
      ],
    })
    expect(await insertOrReconcileEcho(client, payload)).toMatchObject({ ok: false })
  })

  it("names migration 006's constraint exactly", () => {
    const migration = readFileSync(
      join(__dirname, '..', '..', 'db', 'migrations', '006_idempotency_and_inbound_message_origin.sql'),
      'utf8',
    )
    expect(migration).toContain(`add constraint ${PROVIDER_MESSAGE_ID_UNIQUE_CONSTRAINT}`)
  })
})

describe('writeInstagramSendFailureCard', () => {
  const gen = generation('Open until 3.', { commitment: { type: 'recommendation', description: 'cortado' } })

  beforeEach(() => {
    guestReadMock.mockResolvedValue({ data: { opted_out_at: null }, error: null })
    loadPendingRowsMock.mockResolvedValue({ obligation: null, conversation: null })
    persistOrRegenMock.mockResolvedValue({ action: 'inserted', outboundMessageId: 'card-9', priorReviewReason: null })
  })

  it('writes the whole reply as a card with its commitment and rendered intentions', async () => {
    const result = await writeInstagramSendFailureCard({ ctx: makeCtx(), generation: gen, carrier: true, renderedIntentions: RENDERED })
    expect(result).toEqual({ ok: true, cardId: 'card-9' })
    expect(persistOrRegenMock).toHaveBeenCalledWith(
      expect.anything(),
      gen,
      INSTAGRAM_SEND_FAILED_REVIEW_REASON,
      null,
      { callerPolicy: 'never_regen', renderedIntentions: RENDERED, pendingCancellation: null },
    )
  })

  it('writes the remainder of a reply without the commitment or the rendered intentions', async () => {
    await writeInstagramSendFailureCard({ ctx: makeCtx(), generation: gen, carrier: false, renderedIntentions: RENDERED })
    const [, cardGen, , , options] = persistOrRegenMock.mock.calls[0]!
    expect((cardGen as GenerateMessageResult).commitment).toEqual({})
    expect(options).toEqual({
      callerPolicy: 'never_regen',
      renderedIntentions: undefined,
      pendingCancellation: null,
    })
  })

  // TAC-513: the card an operator later approves is what says the comp is off,
  // so it has to carry the cancellation. Without it, approving the card sends
  // the sentence and cancels nothing — the 2026-09-21 incident with a human's
  // approval on it. Pinned with the resolved value, not merely with null,
  // because null is what a fixture produces by accident.
  it('carries a resolved cancellation onto the whole-reply card', async () => {
    const TONIC = {
      id: 'cfa37ed7-1041-4679-a258-92062726f4c2',
      type: 'comp' as const,
      description: 'replacement blossom tonic',
      code: 'GWPZ',
      status: 'open' as const,
      expected_arrival: null,
      arrival_signal: null,
      created_at: '2026-09-21T22:49:02.075Z',
    }
    const cancelling = generation("that one's off then", { cancelsCommitmentId: TONIC.id })
    const ctx = { ...makeCtx(), activeCommitments: [TONIC] }

    await writeInstagramSendFailureCard({ ctx, generation: cancelling, carrier: true })

    const [, , , , options] = persistOrRegenMock.mock.calls[0]!
    expect((options as { pendingCancellation: unknown }).pendingCancellation).toEqual({
      commitmentId: TONIC.id,
    })
  })

  // The remainder card is text the whole-reply card already accounted for, so
  // it must not cancel a second time.
  it('does NOT carry the cancellation onto a remainder card', async () => {
    const TONIC_ID = 'cfa37ed7-1041-4679-a258-92062726f4c2'
    const cancelling = generation("that one's off then", { cancelsCommitmentId: TONIC_ID })
    const ctx = {
      ...makeCtx(),
      activeCommitments: [
        {
          id: TONIC_ID,
          type: 'comp' as const,
          description: 'replacement blossom tonic',
          code: 'GWPZ',
          status: 'open' as const,
          expected_arrival: null,
          arrival_signal: null,
          created_at: '2026-09-21T22:49:02.075Z',
        },
      ],
    }

    await writeInstagramSendFailureCard({ ctx, generation: cancelling, carrier: false })

    const [, , , , options] = persistOrRegenMock.mock.calls[0]!
    expect((options as { pendingCancellation: unknown }).pendingCancellation).toBeNull()
  })

  it('writes no card for a guest who opted out', async () => {
    guestReadMock.mockResolvedValue({ data: { opted_out_at: NOW.toISOString() }, error: null })
    expect(await writeInstagramSendFailureCard({ ctx: makeCtx(), generation: gen, carrier: true })).toEqual({
      ok: false,
      skipped: 'opted_out',
    })
    expect(persistOrRegenMock).not.toHaveBeenCalled()
  })

  it("never overwrites a card already in the slot, such as the operator's knowledge-gap question", async () => {
    loadPendingRowsMock.mockResolvedValue({
      obligation: null,
      conversation: { id: 'gap-card', pending_commitment: null, pending_until: NOW.toISOString(), review_reason: 'knowledge_gap' },
    })
    expect(await writeInstagramSendFailureCard({ ctx: makeCtx(), generation: gen, carrier: true })).toEqual({
      ok: false,
      skipped: 'slot_occupied',
    })
    expect(persistOrRegenMock).not.toHaveBeenCalled()
  })

  it('reports a card that lost a race for the slot', async () => {
    persistOrRegenMock.mockResolvedValue({ action: 'dropped', outboundMessageId: null, reason: 'slot_occupied', protectedDraftId: 'x' })
    expect(await writeInstagramSendFailureCard({ ctx: makeCtx(), generation: gen, carrier: true })).toMatchObject({
      ok: false,
      skipped: 'slot_occupied',
    })
  })

  it('never throws', async () => {
    persistOrRegenMock.mockRejectedValue(new Error('db down'))
    expect(await writeInstagramSendFailureCard({ ctx: makeCtx(), generation: gen, carrier: true })).toEqual({
      ok: false,
      skipped: 'write_failed',
      error: 'db down',
    })
  })
})

// ---------------------------------------------------------------------------
// TAC-513: the cancellation rides BOTH transports
// ---------------------------------------------------------------------------
//
// materializeInlineCommitment's own docstring says creating the row "is the
// same act whichever channel carried the message", which is exactly as true of
// cancelling one. It was applied on the text arm and not here, so a demo guest
// on Instagram — the channel Le Mil's is moving to — could be told a comp was
// off while nothing cancelled it. That is this ticket's own incident, on the
// one path the fix had not reached.
describe('dispatchInstagramReply — cancellation (TAC-513)', () => {
  it('applies the cancellation beside the commitment, anchored to the first row', async () => {
    const d = deps()
    const gen = generation("that one's off then", {
      cancelsCommitmentId: 'cfa37ed7-1041-4679-a258-92062726f4c2',
    })

    await dispatchInstagramReply(makeCtx(), gen, INBOUND_REPLY, d)

    expect(d.materializeCommitment).toHaveBeenCalledWith(expect.anything(), gen, 'row-1')
    expect(d.applyCancellation).toHaveBeenCalledWith(expect.anything(), gen, 'row-1')
  })

  it('does not cancel when nothing was sent', async () => {
    const d = deps({
      sendText: vi.fn(async () => ({ ok: false as const, kind: 'rate_limited' as const, failure: null })),
    })
    const gen = generation("that one's off then", {
      cancelsCommitmentId: 'cfa37ed7-1041-4679-a258-92062726f4c2',
    })

    await dispatchInstagramReply(makeCtx(), gen, INBOUND_REPLY, d)

    expect(d.applyCancellation).not.toHaveBeenCalled()
  })
})
