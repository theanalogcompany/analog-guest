// TAC-386. The auth tests are the load-bearing ones here: this route sends an
// unprompted message to a guest and is reachable from the public internet.
//
// Deliberately a near-copy of app/api/cron/warm-close/route.test.ts. The two
// routes have the same auth contract, and the alternative to duplicating the
// cases was a shared helper that would make a missing case in one route
// invisible in the other.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const processDueInquiryFollowupsMock = vi.fn()
vi.mock('@/lib/followups/inquiry-followup-engine', () => ({
  processDueInquiryFollowups: (now: Date) =>
    processDueInquiryFollowupsMock(now),
}))

import { GET } from './route'

const SUMMARY = {
  scanned: 2,
  sent: 1,
  skipped: { too_soon_after_proactive: 1 },
  errored: 0,
}

const originalExternalCronSecret = process.env.EXTERNAL_CRON_SECRET
const originalCronSecret = process.env.CRON_SECRET

beforeEach(() => {
  processDueInquiryFollowupsMock.mockReset()
  processDueInquiryFollowupsMock.mockResolvedValue(SUMMARY)
})

afterEach(() => {
  vi.unstubAllEnvs()
  if (originalExternalCronSecret === undefined)
    delete process.env.EXTERNAL_CRON_SECRET
  else process.env.EXTERNAL_CRON_SECRET = originalExternalCronSecret
  if (originalCronSecret === undefined) delete process.env.CRON_SECRET
  else process.env.CRON_SECRET = originalCronSecret
  vi.restoreAllMocks()
})

describe('GET /api/cron/inquiry-followups', () => {
  it('skips auth in development', async () => {
    vi.stubEnv('NODE_ENV', 'development')
    const res = await GET(
      new Request('http://localhost/api/cron/inquiry-followups'),
    )
    expect(res.status).toBe(200)
    expect(processDueInquiryFollowupsMock).toHaveBeenCalledOnce()
  })

  it('fails closed when EXTERNAL_CRON_SECRET is not set in production', async () => {
    vi.stubEnv('NODE_ENV', 'production')
    delete process.env.EXTERNAL_CRON_SECRET
    const res = await GET(
      new Request('http://localhost/api/cron/inquiry-followups', {
        headers: { authorization: 'Bearer anything' },
      }),
    )
    expect(res.status).toBe(401)
    expect(processDueInquiryFollowupsMock).not.toHaveBeenCalled()
  })

  it('refuses a request with no Authorization header', async () => {
    vi.stubEnv('NODE_ENV', 'production')
    process.env.EXTERNAL_CRON_SECRET = 'the-secret'
    const res = await GET(
      new Request('http://localhost/api/cron/inquiry-followups'),
    )
    expect(res.status).toBe(401)
    expect(processDueInquiryFollowupsMock).not.toHaveBeenCalled()
  })

  // The bearer has to be COMPARED, not merely present. Without a wrong-bearer
  // case every 401 test above passes against a route that returns before the
  // comparison ever runs, which is the trap TAC-428 recorded on the two-secret
  // routes.
  it('refuses a wrong bearer', async () => {
    vi.stubEnv('NODE_ENV', 'production')
    process.env.EXTERNAL_CRON_SECRET = 'the-secret'
    const res = await GET(
      new Request('http://localhost/api/cron/inquiry-followups', {
        headers: { authorization: 'Bearer not-the-secret' },
      }),
    )
    expect(res.status).toBe(401)
    expect(processDueInquiryFollowupsMock).not.toHaveBeenCalled()
  })

  // The SHARED CRON_SECRET must not open this route. It is the secret the
  // internal GitHub Actions crons carry, and this one is called by a third
  // party; accepting both would make cron-job.org a single point of compromise
  // for every cron route.
  it('does not accept the shared CRON_SECRET', async () => {
    vi.stubEnv('NODE_ENV', 'production')
    process.env.EXTERNAL_CRON_SECRET = 'the-external-secret'
    process.env.CRON_SECRET = 'the-shared-secret'
    const res = await GET(
      new Request('http://localhost/api/cron/inquiry-followups', {
        headers: { authorization: 'Bearer the-shared-secret' },
      }),
    )
    expect(res.status).toBe(401)
    expect(processDueInquiryFollowupsMock).not.toHaveBeenCalled()
  })

  it('runs the processor and returns its counts on a good bearer', async () => {
    vi.stubEnv('NODE_ENV', 'production')
    process.env.EXTERNAL_CRON_SECRET = 'the-secret'
    const res = await GET(
      new Request('http://localhost/api/cron/inquiry-followups', {
        headers: { authorization: 'Bearer the-secret' },
      }),
    )
    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toEqual({ ok: true, ...SUMMARY })
  })
})
