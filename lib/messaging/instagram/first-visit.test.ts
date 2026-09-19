// TAC-492: from Meta's recorded delivery to the first-visit behaviours.
//
// The handler saves a delivery into the test store, and what it wrote is
// handed to the REAL gate the agent uses for the opener,
// computeFirstTouchAfterQrScan (lib/agent/stages.ts). Nothing here restates
// that gate, so a guest the handler labels wrongly, or a gate that stops
// reading created_via, fails this test.
//
// Of the four things the gate reads, only created_via comes from the handler.
// A saved message is what makes currentMessage non-null; recentMessages ([])
// and createdAt (the database default, now) are set here, as they would be on
// a guest's first message.
//
// What is NOT tested, stated so it isn't assumed:
//   - buildRuntimeContext reading guests.created_via into ctx.guest.createdVia
//     (its select and its mapping). Nothing runs buildRuntimeContext for real
//     under test. The code predates TAC-492 and Sendblue guests go through it
//     too.
//   - understand_order. Its arming turns created_via 'qr_scan' into the
//     confirmed-visit date inside buildRuntimeContext. That line is pinned by
//     the source-level test in lib/agent/build-runtime-context.test.ts
//     ("resolves it from QR enrollment ..."), and the arming itself by
//     lib/agent/intentions/derive.test.ts ("arms understand_order on a
//     confirmed visit ..."). With the created_via this test proves, those are
//     the chain, less the first link above. Restating the mapping here would
//     only prove derive works on a date this file computed.
// The end-to-end proof is device QA once TAC-469 turns the agent on for
// Instagram guests.
//
// TAC-495: the opener the gate turns on now has an Instagram variant, and this
// file used to prove only that the gate fires, which meant an Instagram guest
// got the SMS opener ("first message on this number ... who they're texting").
// The last block below goes on from the same saved rows to the channel the
// prompt copy is chosen by (resolveConversationChannel, fed exactly what
// buildRuntimeContext feeds it) and the opener that channel renders. A
// Sendblue-shaped pair of rows is run through the same steps and must still get
// the SMS opener. Not tested here, and pinned at the source instead: that
// buildRuntimeContext selects instagram_scoped_id and hands these values to the
// resolver (build-runtime-context.test.ts), and that handleInbound loads
// messages.channel (handle-inbound.test.ts).

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { resolveConversationChannel } from '@/lib/agent/conversation-channel'
import { computeFirstTouchAfterQrScan } from '@/lib/agent/stages'
import type { RuntimeContext } from '@/lib/agent/types'
import { firstTouchOpenerFor, runtimeToProse } from '@/lib/ai/prompts/serializers'
import { parseMessageChannel } from '@/lib/schemas/message-channel'

import { processInstagramDelivery } from './handle-events'
import { createInstagramDbFake, type FakeRow } from './testing/db-fake'

// stages.ts imports these at module load; the gate under test uses none of them.
vi.mock('@/lib/rag', () => ({}))
vi.mock('@/lib/ai', () => ({}))
vi.mock('@/lib/db/admin', () => ({}))
vi.mock('@/lib/analytics/posthog', () => ({}))

const ACCOUNT_ID = '17841400000000001'
const NOW = '2026-09-18T08:00:00.000Z'

function fixture(name: 'message' | 'postback-referral'): unknown {
  return JSON.parse(readFileSync(join(__dirname, 'fixtures', `${name}.json`), 'utf8'))
}

function withoutReferral(delivery: unknown): unknown {
  const copy = structuredClone(delivery) as { entry: Array<{ messaging: Array<{ postback: Record<string, unknown> }> }> }
  const postback = copy.entry[0]?.messaging[0]?.postback
  if (!postback) throw new Error('fixture has no postback')
  delete postback.referral
  return copy
}

/**
 * Save the delivery, then build the context the agent would have for the
 * guest's first inbound from the rows the handler wrote. created_at is the
 * database default (now), which the handler relies on exactly as Sendblue does.
 */
async function firstTurnContext(delivery: unknown): Promise<RuntimeContext> {
  const db = createInstagramDbFake({ venues: [{ id: 'venue-1', instagram_account_id: ACCOUNT_ID }] })
  await processInstagramDelivery(delivery, db.client)

  const [guest] = db.tables.guests as FakeRow[]
  const [message] = db.tables.messages as FakeRow[]
  if (!guest || !message) throw new Error('the handler saved no guest or no message')

  return {
    guest: { id: guest.id, createdVia: guest.created_via, createdAt: new Date(NOW) },
    currentMessage: { id: message.id, body: message.body },
    recentMessages: [],
  } as unknown as RuntimeContext
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date(NOW))
})

afterEach(() => {
  vi.useRealTimers()
})

describe('the first-visit opener for an Instagram guest', () => {
  it('fires on the recorded icebreaker tap that followed an ig.me link', async () => {
    const ctx = await firstTurnContext(fixture('postback-referral'))
    expect(ctx.guest.createdVia).toBe('qr_scan')
    expect(computeFirstTouchAfterQrScan(ctx, new Date(NOW))).toBe(true)
  })

  it('does not fire on the same tap without the referral', async () => {
    const ctx = await firstTurnContext(withoutReferral(fixture('postback-referral')))
    expect(computeFirstTouchAfterQrScan(ctx, new Date(NOW))).toBe(false)
  })

  it('does not fire on the recorded message, which carries no referral', async () => {
    const ctx = await firstTurnContext(fixture('message'))
    expect(computeFirstTouchAfterQrScan(ctx, new Date(NOW))).toBe(false)
  })

  // The gate's other conditions apply to Instagram exactly as to Sendblue.
  // One case, to show the qr_scan label alone doesn't bypass them. This tests
  // the gate only, on a history built here. That a staff echo reaches that
  // history holds by reading the query (build-runtime-context.ts: venue,
  // guest, non-empty body, no channel or direction filter), not by this test.
  it('does not fire once the thread already has a message', async () => {
    const ctx = await firstTurnContext(fixture('postback-referral'))
    const withReply = {
      ...ctx,
      recentMessages: [{ direction: 'outbound', body: 'ECHO', createdAt: new Date(NOW), delivery: 'delivered' }],
    } as RuntimeContext
    expect(computeFirstTouchAfterQrScan(withReply, new Date(NOW))).toBe(false)
  })
})

// TAC-495: from the saved rows to the opener the guest's prompt carries.
describe('the first-visit opener an Instagram guest gets is the Instagram one', () => {
  // Exactly what buildRuntimeContext hands the resolver: the inbound message's
  // parsed channel, and whether the guest row holds each identifier.
  function channelFor(guest: FakeRow, message: FakeRow) {
    return resolveConversationChannel({
      inboundChannel: parseMessageChannel(message.channel as string | null | undefined),
      hasPhone: typeof guest.phone_number === 'string',
      hasInstagramId: typeof guest.instagram_scoped_id === 'string',
    }).channel
  }

  function openerRendered(channel: ReturnType<typeof channelFor>): string {
    return runtimeToProse(
      {
        inboundMessage: 'hi',
        mechanics: [],
        openIntentions: ["You haven't heard what this guest ordered yet."],
        firstTouchAfterQrScan: true,
      },
      'reply',
      new Date(NOW),
      channel,
    )
  }

  it("resolves the recorded icebreaker tap's rows to the instagram channel and renders its opener", async () => {
    const db = createInstagramDbFake({ venues: [{ id: 'venue-1', instagram_account_id: ACCOUNT_ID }] })
    await processInstagramDelivery(fixture('postback-referral'), db.client)
    const [guest] = db.tables.guests as FakeRow[]
    const [message] = db.tables.messages as FakeRow[]
    if (!guest || !message) throw new Error('the handler saved no guest or no message')

    const channel = channelFor(guest, message)
    expect(channel).toBe('instagram')
    const out = openerRendered(channel)
    expect(out).toContain(firstTouchOpenerFor('instagram'))
    expect(out).not.toContain(firstTouchOpenerFor('text'))
    expect(out).not.toMatch(/\bthis number\b|\btexting\b/)
  })

  // The control: a guest who texted a phone number, shaped as the Sendblue
  // route saves them, still gets the SMS opener word for word.
  it('a Sendblue guest and message resolve to text and keep the SMS opener', () => {
    const guest: FakeRow = { id: 'guest-sms', phone_number: '+15555550123', instagram_scoped_id: null }
    const message: FakeRow = { id: 'msg-sms', channel: 'text' }

    const channel = channelFor(guest, message)
    expect(channel).toBe('text')
    expect(openerRendered(channel)).toContain(
      "This is the guest's first message on this number, sent right after they scanned your sign at pickup. They've already ordered and have it in hand. You don't know what it was. Say hello and let them know who they're texting, in your own words.",
    )
  })
})
