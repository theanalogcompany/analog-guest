// TAC-536. The auth tests are the load-bearing ones here: this route is the
// only scheduled path in the repo that sends an unprompted message to a guest,
// and it is reachable from the public internet.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const processDueScanGreetingsMock = vi.fn()
vi.mock('@/lib/agent/instagram-scan-greeting', () => ({
  processDueScanGreetings: (now: Date) => processDueScanGreetingsMock(now),
}))

import { GET } from './route'

const SUMMARY = {
  scanned: 2,
  notYet: 1,
  greeted: 1,
  suppressed: {},
  casLost: 0,
  errored: 0,
}

const originalExternalCronSecret = process.env.EXTERNAL_CRON_SECRET
const originalCronSecret = process.env.CRON_SECRET

beforeEach(() => {
  processDueScanGreetingsMock.mockReset()
  processDueScanGreetingsMock.mockResolvedValue(SUMMARY)
})

afterEach(() => {
  vi.unstubAllEnvs()
  if (originalExternalCronSecret === undefined) delete process.env.EXTERNAL_CRON_SECRET
  else process.env.EXTERNAL_CRON_SECRET = originalExternalCronSecret
  if (originalCronSecret === undefined) delete process.env.CRON_SECRET
  else process.env.CRON_SECRET = originalCronSecret
  vi.restoreAllMocks()
})

describe('GET /api/cron/instagram-scan-greetings', () => {
  it('skips auth in development', async () => {
    vi.stubEnv('NODE_ENV', 'development')
    const res = await GET(new Request('http://localhost/api/cron/instagram-scan-greetings'))
    expect(res.status).toBe(200)
    expect(processDueScanGreetingsMock).toHaveBeenCalledOnce()
  })

  it('fails closed when EXTERNAL_CRON_SECRET is not set in production', async () => {
    vi.stubEnv('NODE_ENV', 'production')
    delete process.env.EXTERNAL_CRON_SECRET
    const res = await GET(
      new Request('http://localhost/api/cron/instagram-scan-greetings', {
        headers: { authorization: 'Bearer anything' },
      }),
    )
    expect(res.status).toBe(401)
    expect(processDueScanGreetingsMock).not.toHaveBeenCalled()
  })

  it('refuses a request with no Authorization header', async () => {
    vi.stubEnv('NODE_ENV', 'production')
    process.env.EXTERNAL_CRON_SECRET = 'the-secret'
    const res = await GET(new Request('http://localhost/api/cron/instagram-scan-greetings'))
    expect(res.status).toBe(401)
    expect(processDueScanGreetingsMock).not.toHaveBeenCalled()
  })

  // The bearer has to be COMPARED, not merely present. Without a wrong-bearer
  // case every 401 test above passes against a route that returns before the
  // comparison ever runs, which is the trap TAC-428 recorded on the two-secret
  // routes.
  it('refuses a wrong bearer', async () => {
    vi.stubEnv('NODE_ENV', 'production')
    process.env.EXTERNAL_CRON_SECRET = 'the-secret'
    const res = await GET(
      new Request('http://localhost/api/cron/instagram-scan-greetings', {
        headers: { authorization: 'Bearer not-the-secret' },
      }),
    )
    expect(res.status).toBe(401)
    expect(processDueScanGreetingsMock).not.toHaveBeenCalled()
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
      new Request('http://localhost/api/cron/instagram-scan-greetings', {
        headers: { authorization: 'Bearer the-shared-secret' },
      }),
    )
    expect(res.status).toBe(401)
    expect(processDueScanGreetingsMock).not.toHaveBeenCalled()
  })

  it('runs the processor and returns its counts on a good bearer', async () => {
    vi.stubEnv('NODE_ENV', 'production')
    process.env.EXTERNAL_CRON_SECRET = 'the-secret'
    const res = await GET(
      new Request('http://localhost/api/cron/instagram-scan-greetings', {
        headers: { authorization: 'Bearer the-secret' },
      }),
    )
    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toEqual({ ok: true, ...SUMMARY })
  })
})
