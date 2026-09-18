// The webhook-silence alarm is the only liveness check on Sendblue's webhook.
// Since TAC-468, Instagram inbound rows land in the same `messages` table, so
// the alarm must look at text messages only: one Instagram DM a day would
// otherwise hide a complete Sendblue outage.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { GET } from './route'

const mocks = vi.hoisted(() => ({
  createAdminClient: vi.fn(),
  captureWebhookSilence: vi.fn(),
}))
vi.mock('@/lib/db/admin', () => ({ createAdminClient: mocks.createAdminClient }))
vi.mock('@/lib/analytics/posthog', () => ({
  captureWebhookSilence: mocks.captureWebhookSilence,
  WEBHOOK_SILENCE_THRESHOLD_HOURS: 24,
}))

type Filter = [method: string, column: string, value: unknown]

/**
 * Answers the route's two queries: venues (awaited directly) and the newest
 * inbound message (via maybeSingle). Records every filter on the messages
 * query, and returns `newestInbound` only if the filters would really select
 * it, so a query that drops the channel filter reads the Instagram row.
 */
function fakeDb(rows: Array<{ created_at: string; channel: string; direction: string }>) {
  const messageFilters: Filter[] = []
  const client = {
    from(table: string) {
      if (table === 'venues') {
        return { select: () => ({ eq: async () => ({ data: [{ id: 'venue-1' }], error: null }) }) }
      }
      const chain = {
        select: () => chain,
        eq: (column: string, value: unknown) => {
          messageFilters.push(['eq', column, value])
          return chain
        },
        in: (column: string, value: unknown) => {
          messageFilters.push(['in', column, value])
          return chain
        },
        order: () => chain,
        limit: () => chain,
        maybeSingle: async () => {
          const eqs = messageFilters.filter(([m]) => m === 'eq')
          const match = rows
            .filter((row) => eqs.every(([, column, value]) => (row as Record<string, unknown>)[column] === value))
            .sort((a, b) => b.created_at.localeCompare(a.created_at))[0]
          return { data: match ? { created_at: match.created_at } : null, error: null }
        },
      }
      return chain
    },
  }
  return { client, messageFilters }
}

const NOW = new Date('2026-09-18T12:00:00.000Z')
const hoursAgo = (h: number): string => new Date(NOW.getTime() - h * 3_600_000).toISOString()

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW)
  mocks.createAdminClient.mockReset()
  mocks.captureWebhookSilence.mockReset()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('GET /api/cron/webhook-silence', () => {
  it('alarms on a silent Sendblue webhook even when Instagram messages are arriving', async () => {
    const db = fakeDb([
      { created_at: hoursAgo(30), channel: 'text', direction: 'inbound' },
      { created_at: hoursAgo(1), channel: 'instagram', direction: 'inbound' },
    ])
    mocks.createAdminClient.mockReturnValue(db.client)

    const res = await GET(new Request('http://localhost/api/cron/webhook-silence'))

    expect(await res.json()).toMatchObject({ ok: true, hoursWithoutWebhook: 30 })
    expect(mocks.captureWebhookSilence).toHaveBeenCalledWith({
      hoursWithoutWebhook: 30,
      lastWebhookAt: hoursAgo(30),
    })
    expect(db.messageFilters).toContainEqual(['eq', 'channel', 'text'])
  })

  it('stays quiet while text messages keep arriving', async () => {
    const db = fakeDb([{ created_at: hoursAgo(2), channel: 'text', direction: 'inbound' }])
    mocks.createAdminClient.mockReturnValue(db.client)

    await GET(new Request('http://localhost/api/cron/webhook-silence'))

    expect(mocks.captureWebhookSilence).not.toHaveBeenCalled()
  })
})
