import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const processDueFollowupsMock = vi.fn<(now: Date) => Promise<unknown>>()
vi.mock('@/lib/followups/engine', () => ({
  processDueFollowups: (now: Date) => processDueFollowupsMock(now),
}))

import { GET } from './route'

const originalCronSecret = process.env.CRON_SECRET
const originalExternalCronSecret = process.env.EXTERNAL_CRON_SECRET

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
  if (originalExternalCronSecret === undefined) {
    delete process.env.EXTERNAL_CRON_SECRET
  } else {
    process.env.EXTERNAL_CRON_SECRET = originalExternalCronSecret
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

  it('returns 401 when NEITHER cron secret is set in production (fails closed)', async () => {
    vi.stubEnv('NODE_ENV', 'production')
    delete process.env.CRON_SECRET
    delete process.env.EXTERNAL_CRON_SECRET
    const req = new Request('http://localhost/api/cron/followups-due')
    const res = await GET(req)
    expect(res.status).toBe(401)
    expect(processDueFollowupsMock).not.toHaveBeenCalled()
  })

  it('returns 401 on wrong bearer in production', async () => {
    vi.stubEnv('NODE_ENV', 'production')
    process.env.CRON_SECRET = 'expected-secret'
    process.env.EXTERNAL_CRON_SECRET = 'external-secret'
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
  // TAC-428. cron-job.org is the primary trigger and holds only
  // EXTERNAL_CRON_SECRET; the GitHub workflow is the redundant net and holds
  // only CRON_SECRET. Both must work, and the route must still fail closed
  // when neither variable is set.
  it('accepts EXTERNAL_CRON_SECRET, the bearer cron-job.org sends (TAC-428)', async () => {
    vi.stubEnv('NODE_ENV', 'production')
    delete process.env.CRON_SECRET
    process.env.EXTERNAL_CRON_SECRET = 'external-secret'
    const req = new Request('http://localhost/api/cron/followups-due', {
      headers: { authorization: 'Bearer external-secret' },
    })
    const res = await GET(req)
    expect(res.status).toBe(200)
    expect(processDueFollowupsMock).toHaveBeenCalledOnce()
  })

  it('still accepts CRON_SECRET, so the GitHub workflow keeps firing (TAC-428)', async () => {
    vi.stubEnv('NODE_ENV', 'production')
    process.env.CRON_SECRET = 'workflow-secret'
    process.env.EXTERNAL_CRON_SECRET = 'external-secret'
    const req = new Request('http://localhost/api/cron/followups-due', {
      headers: { authorization: 'Bearer workflow-secret' },
    })
    const res = await GET(req)
    expect(res.status).toBe(200)
    expect(processDueFollowupsMock).toHaveBeenCalledOnce()
  })
  // TAC-428 regression. The 401-when-neither-is-set test above sends NO
  // Authorization header, so it returns before the comparison loop and cannot
  // see a fall-open inside it. This one presents a bearer while only ONE of
  // the two secrets is configured — a real production state, since
  // cron-job.org and the workflow hold different secrets and either could be
  // removed alone. Mutation-verified: `if (!expected || ...)` in place of
  // `if (expected && ...)` passes every other test in this file and fails
  // this one.
  it('rejects a wrong bearer when only one of the two secrets is set (TAC-428)', async () => {
    vi.stubEnv('NODE_ENV', 'production')
    delete process.env.CRON_SECRET
    process.env.EXTERNAL_CRON_SECRET = 'external-secret'
    const req = new Request('http://localhost/api/cron/followups-due', {
      headers: { authorization: 'Bearer wrong-secret' },
    })
    const res = await GET(req)
    expect(res.status).toBe(401)
    expect(processDueFollowupsMock).not.toHaveBeenCalled()
  })
})
