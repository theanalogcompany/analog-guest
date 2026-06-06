import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const processDueFollowupsMock = vi.fn<(now: Date) => Promise<unknown>>()
vi.mock('@/lib/followups/engine', () => ({
  processDueFollowups: (now: Date) => processDueFollowupsMock(now),
}))

import { GET } from './route'

const originalCronSecret = process.env.CRON_SECRET

beforeEach(() => {
  processDueFollowupsMock.mockReset()
  processDueFollowupsMock.mockResolvedValue({
    venuesScanned: 3,
    venuesDispatching: 1,
    guestsEvaluated: 5,
    guestsDue: 2,
    guestsDispatched: 1,
    guestsSuppressed: 1,
    suppressedBy: {
      opted_out: 0,
      quiet_hours: 0,
      recent_conversation: 1,
      weekly_cap: 0,
      per_reason_dedup: 0,
    },
    guestsConflicted: 0,
    guestsDispatchFailed: 0,
    perVenue: [],
  })
})

afterEach(() => {
  vi.unstubAllEnvs()
  if (originalCronSecret === undefined) {
    delete process.env.CRON_SECRET
  } else {
    process.env.CRON_SECRET = originalCronSecret
  }
  vi.restoreAllMocks()
})

describe('GET /api/cron/followups-due', () => {
  it('skips auth in development', async () => {
    vi.stubEnv('NODE_ENV', 'development')
    const req = new Request('http://localhost/api/cron/followups-due')
    const res = await GET(req)
    expect(res.status).toBe(200)
    expect(processDueFollowupsMock).toHaveBeenCalledOnce()
  })

  it('returns 401 when CRON_SECRET is missing in production', async () => {
    vi.stubEnv('NODE_ENV', 'production')
    delete process.env.CRON_SECRET
    const req = new Request('http://localhost/api/cron/followups-due')
    const res = await GET(req)
    expect(res.status).toBe(401)
    expect(processDueFollowupsMock).not.toHaveBeenCalled()
  })

  it('returns 401 on wrong bearer in production', async () => {
    vi.stubEnv('NODE_ENV', 'production')
    process.env.CRON_SECRET = 'expected-secret'
    const req = new Request('http://localhost/api/cron/followups-due', {
      headers: { authorization: 'Bearer wrong-secret' },
    })
    const res = await GET(req)
    expect(res.status).toBe(401)
    expect(processDueFollowupsMock).not.toHaveBeenCalled()
  })

  it('returns 200 with the processor summary on correct bearer', async () => {
    vi.stubEnv('NODE_ENV', 'production')
    process.env.CRON_SECRET = 'expected-secret'
    const req = new Request('http://localhost/api/cron/followups-due', {
      headers: { authorization: 'Bearer expected-secret' },
    })
    const res = await GET(req)
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>
    expect(body).toMatchObject({
      ok: true,
      venuesScanned: 3,
      guestsDispatched: 1,
      guestsSuppressed: 1,
    })
    expect(processDueFollowupsMock).toHaveBeenCalledOnce()
  })
})
