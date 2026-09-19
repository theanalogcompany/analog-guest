// TAC-492: from Meta's recorded delivery to the first-visit behaviours.
//
// The handler saves a delivery into the test store, and the rows it wrote are
// handed to the REAL gate the agent uses for the opener,
// computeFirstTouchAfterQrScan (lib/agent/stages.ts). Nothing here restates
// that gate, so a guest the handler labels wrongly, or a gate that stops
// reading created_via, fails this test.
//
// What it does NOT cover, stated so it isn't assumed: understand_order. Its
// arming turns created_via 'qr_scan' into the confirmed-visit date inside
// buildRuntimeContext, which nothing runs for real under test. That link is
// pinned by the source-level test in lib/agent/build-runtime-context.test.ts
// ("resolves it from QR enrollment ..."), and the arming itself by
// lib/agent/intentions/derive.test.ts ("arms understand_order on a confirmed
// visit ..."). Together with the created_via this test proves, those are the
// chain. Restating the mapping here would only prove derive works on a date
// this file computed. The end-to-end proof is device QA once TAC-469 turns
// the agent on for Instagram guests.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { computeFirstTouchAfterQrScan } from '@/lib/agent/stages'
import type { RuntimeContext } from '@/lib/agent/types'

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
  // One case, to show the qr_scan label alone doesn't bypass them.
  it('does not fire once the thread already has a message, such as a staff reply', async () => {
    const ctx = await firstTurnContext(fixture('postback-referral'))
    const withReply = {
      ...ctx,
      recentMessages: [{ direction: 'outbound', body: 'ECHO', createdAt: new Date(NOW), delivery: 'delivered' }],
    } as RuntimeContext
    expect(computeFirstTouchAfterQrScan(withReply, new Date(NOW))).toBe(false)
  })
})
