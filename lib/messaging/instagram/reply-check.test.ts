import { describe, expect, it } from 'vitest'

import {
  findAnsweringOutbound,
  findReplyToInbound,
  type ReplyCheckInbound,
  type ReplyCheckOutbound,
} from './reply-check'
import { callsNamed, queryRecorder } from './testing/query-recorder'

const T0 = Date.parse('2026-09-19T10:00:00.000Z')
const at = (seconds: number) => new Date(T0 + seconds * 1000)

// "what time do you close?" at 0s, "and do you have oat milk?" at 5s, both
// saved about 2 seconds after Meta's time, as in production.
const CLOSE_Q: ReplyCheckInbound = { id: 'in-close', providerSentAt: at(0), receivedAt: at(2) }
const OAT_Q: ReplyCheckInbound = { id: 'in-oat', providerSentAt: at(5), receivedAt: at(7) }

function outbound(overrides: Partial<ReplyCheckOutbound> & { id: string }): ReplyCheckOutbound {
  return { replyToMessageId: null, providerSentAt: null, sentAt: at(20), ...overrides }
}

const named = (...rows: ReplyCheckInbound[]) => new Map(rows.map((r) => [r.id, r]))

describe('findAnsweringOutbound (ruled 2026-09-19)', () => {
  it('the oat-milk case: a reply to the EARLIER question does not answer the later one', () => {
    const replyToClose = outbound({ id: 'out-1', replyToMessageId: 'in-close', sentAt: at(22) })
    expect(findAnsweringOutbound(OAT_Q, [replyToClose], named(CLOSE_Q))).toBeNull()
  })

  it('a reply that names this message answers it', () => {
    const reply = outbound({ id: 'out-1', replyToMessageId: 'in-oat', sentAt: at(22) })
    expect(findAnsweringOutbound(OAT_Q, [reply], named())).toBe(reply)
  })

  it('a reply to a LATER message answers this one: it was written after this one existed', () => {
    const replyToOat = outbound({ id: 'out-1', replyToMessageId: 'in-oat', sentAt: at(22) })
    expect(findAnsweringOutbound(CLOSE_Q, [replyToOat], named(OAT_Q))).toBe(replyToOat)
  })

  it('a reply naming no message, which is every reply staff type in the app, answers everything before it', () => {
    const staffEcho = outbound({ id: 'echo-1', providerSentAt: at(9), sentAt: at(9.3) })
    expect(findAnsweringOutbound(CLOSE_Q, [staffEcho], named())).toBe(staffEcho)
    expect(findAnsweringOutbound(OAT_Q, [staffEcho], named())).toBe(staffEcho)
  })

  it('a reply sent before the message answers nothing', () => {
    const early = outbound({ id: 'echo-1', providerSentAt: at(-60), sentAt: at(-59) })
    expect(findAnsweringOutbound(CLOSE_Q, [early], named())).toBeNull()
  })

  it("a reply naming a message it can't read does not count: that is the agent silencing itself", () => {
    const reply = outbound({ id: 'out-1', replyToMessageId: 'in-missing', sentAt: at(22) })
    expect(findAnsweringOutbound(OAT_Q, [reply], named())).toBeNull()
  })

  describe('one clock per comparison', () => {
    it("uses Meta's time when both rows have it, even when our clock disagrees", () => {
      // Staff replied 0.5s after the guest by Meta's clock, but the guest's
      // message took 2.3s to reach us and the echo 0.3s, so on OUR clock the
      // echo looks earlier.
      const question: ReplyCheckInbound = { id: 'in-1', providerSentAt: at(0), receivedAt: at(2.3) }
      const echo = outbound({ id: 'echo-1', providerSentAt: at(0.5), sentAt: at(0.8) })
      expect(findAnsweringOutbound(question, [echo], named())).toBe(echo)
    })

    it("and the reverse: Meta's clock says before, so it doesn't count though ours says after", () => {
      const question: ReplyCheckInbound = { id: 'in-1', providerSentAt: at(10), receivedAt: at(10.2) }
      const echo = outbound({ id: 'echo-1', providerSentAt: at(9), sentAt: at(12) })
      expect(findAnsweringOutbound(question, [echo], named())).toBeNull()
    })

    it("falls back to our clock when the outbound has no Meta time (our own send landed first)", () => {
      const agentRow = outbound({ id: 'out-1', replyToMessageId: 'in-close', providerSentAt: null, sentAt: at(3) })
      expect(findAnsweringOutbound(CLOSE_Q, [agentRow], named())).toBe(agentRow)
      const tooEarly = outbound({ id: 'out-2', replyToMessageId: 'in-close', providerSentAt: null, sentAt: at(1) })
      expect(findAnsweringOutbound(CLOSE_Q, [tooEarly], named())).toBeNull()
    })

    it('falls back to our clock when the inbound has no Meta time', () => {
      const legacy: ReplyCheckInbound = { id: 'in-1', providerSentAt: null, receivedAt: at(2) }
      const echo = outbound({ id: 'echo-1', providerSentAt: at(1), sentAt: at(3) })
      expect(findAnsweringOutbound(legacy, [echo], named())).toBe(echo)
    })
  })
})

describe('findReplyToInbound', () => {
  const inboundRow = {
    id: 'in-oat',
    created_at: at(7).toISOString(),
    provider_sent_at: at(5).toISOString(),
  }

  it('reads only Instagram outbound rows that reached the guest, after the message on either clock', async () => {
    const { client, queries } = queryRecorder({
      messages: [
        { data: inboundRow, error: null },
        { data: [], error: null },
      ],
    })
    const result = await findReplyToInbound(client, { venueId: 'v', guestId: 'g', inboundMessageId: 'in-oat' })
    expect(result).toEqual({ ok: true, value: null })

    const [inboundQuery, candidates] = queries
    expect(callsNamed(inboundQuery!, 'eq')).toEqual([
      ['id', 'in-oat'],
      ['venue_id', 'v'],
      ['guest_id', 'g'],
      ['direction', 'inbound'],
    ])
    expect(callsNamed(candidates!, 'eq')).toEqual([
      ['venue_id', 'v'],
      ['guest_id', 'g'],
      ['direction', 'outbound'],
      ['channel', 'instagram'],
    ])
    expect(callsNamed(candidates!, 'in')).toEqual([['status', ['sending', 'sent', 'delivered']]])
    expect(callsNamed(candidates!, 'or')).toEqual([
      [
        `created_at.gt.${at(7).toISOString()},sent_at.gt.${at(7).toISOString()},provider_sent_at.gt.${at(5).toISOString()}`,
      ],
    ])
  })

  it("finds a staff reply typed in the Instagram app", async () => {
    const { client } = queryRecorder({
      messages: [
        { data: inboundRow, error: null },
        {
          data: [
            {
              id: 'echo-1',
              reply_to_message_id: null,
              provider_sent_at: at(9).toISOString(),
              sent_at: at(9.3).toISOString(),
              created_at: at(9.3).toISOString(),
              review_state: null,
            },
          ],
          error: null,
        },
      ],
    })
    expect(await findReplyToInbound(client, { venueId: 'v', guestId: 'g', inboundMessageId: 'in-oat' })).toEqual({
      ok: true,
      value: { id: 'echo-1' },
    })
  })

  it('never counts a pending card: it has answered nobody', async () => {
    const { client } = queryRecorder({
      messages: [
        { data: inboundRow, error: null },
        {
          data: [
            {
              id: 'card-1',
              reply_to_message_id: null,
              provider_sent_at: null,
              sent_at: at(20).toISOString(),
              created_at: at(20).toISOString(),
              review_state: 'pending',
            },
          ],
          error: null,
        },
      ],
    })
    expect(await findReplyToInbound(client, { venueId: 'v', guestId: 'g', inboundMessageId: 'in-oat' })).toEqual({
      ok: true,
      value: null,
    })
  })

  it("uses sent_at for an operator-approved card, which was CREATED before the message but SENT after it", async () => {
    const { client } = queryRecorder({
      messages: [
        { data: inboundRow, error: null },
        {
          data: [
            {
              id: 'card-1',
              reply_to_message_id: null,
              provider_sent_at: null,
              sent_at: at(30).toISOString(),
              created_at: at(-600).toISOString(),
              review_state: 'approved',
            },
          ],
          error: null,
        },
      ],
    })
    expect(await findReplyToInbound(client, { venueId: 'v', guestId: 'g', inboundMessageId: 'in-oat' })).toEqual({
      ok: true,
      value: { id: 'card-1' },
    })
  })

  it('looks up the messages the candidates name, and applies the ruling', async () => {
    const { client, queries } = queryRecorder({
      messages: [
        { data: inboundRow, error: null },
        {
          data: [
            {
              id: 'out-1',
              reply_to_message_id: 'in-close',
              provider_sent_at: null,
              sent_at: at(22).toISOString(),
              created_at: at(22).toISOString(),
              review_state: 'auto_sent',
            },
          ],
          error: null,
        },
        {
          data: [{ id: 'in-close', created_at: at(2).toISOString(), provider_sent_at: at(0).toISOString() }],
          error: null,
        },
      ],
    })
    // The reply to "what time do you close?" does not answer the oat-milk question.
    expect(await findReplyToInbound(client, { venueId: 'v', guestId: 'g', inboundMessageId: 'in-oat' })).toEqual({
      ok: true,
      value: null,
    })
    expect(callsNamed(queries[2]!, 'in')).toEqual([['id', ['in-close']]])
  })

  it('reports a failed read as an error, never as "no reply"', async () => {
    const { client } = queryRecorder({
      messages: [
        { data: inboundRow, error: null },
        { data: null, error: { message: 'boom' } },
      ],
    })
    expect(await findReplyToInbound(client, { venueId: 'v', guestId: 'g', inboundMessageId: 'in-oat' })).toEqual({
      ok: false,
      error: 'boom',
    })
  })

  it('reports a missing inbound message as an error', async () => {
    const { client } = queryRecorder({ messages: [{ data: null, error: null }] })
    expect(await findReplyToInbound(client, { venueId: 'v', guestId: 'g', inboundMessageId: 'in-x' })).toEqual({
      ok: false,
      error: 'inbound message not found',
    })
  })
})
