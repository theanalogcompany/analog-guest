// TAC-516: the token-refresh cron route's auth, mirroring commitments-due.
//
// The load-bearing case is "a wrong bearer while exactly ONE secret is set".
// CLAUDE.md records that the obvious `!expected || presented === ...` form
// passes every 401 test written with no Authorization header at all, because
// those return before the comparison is ever reached. Only this shape catches
// it.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const processMock = vi.fn()
vi.mock('@/lib/messaging/instagram/refresh-tokens', () => ({
  processInstagramTokenRefresh: (now: Date) => processMock(now),
}))

import { GET } from './route'

const originalCronSecret = process.env.CRON_SECRET
const originalExternalCronSecret = process.env.EXTERNAL_CRON_SECRET

const SUMMARY = {
  scanned: 1,
  refreshed: 1,
  skippedTooYoung: 0,
  expiredUnrecoverable: 0,
  failed: 0,
  errored: 0,
}

beforeEach(() => {
  processMock.mockReset()
  processMock.mockResolvedValue(SUMMARY)
  vi.spyOn(console, 'log').mockImplementation(() => {})
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

describe('GET /api/cron/instagram-token-refresh', () => {
  it('skips auth in development', async () => {
    vi.stubEnv('NODE_ENV', 'development')
    const res = await GET(new Request('http://localhost/api/cron/instagram-token-refresh'))
    expect(res.status).toBe(200)
    expect(processMock).toHaveBeenCalledOnce()
  })

  it('returns 401 when NEITHER secret is set in production (fails closed)', async () => {
    vi.stubEnv('NODE_ENV', 'production')
    delete process.env.CRON_SECRET
    delete process.env.EXTERNAL_CRON_SECRET
    const res = await GET(new Request('http://localhost/api/cron/instagram-token-refresh'))
    expect(res.status).toBe(401)
    expect(processMock).not.toHaveBeenCalled()
  })

  // THE ONE THAT CATCHES THE BAD IDIOM. A header is presented and exactly one
  // secret is configured, so the comparison actually runs.
  it('returns 401 on a wrong bearer while only one secret is configured', async () => {
    vi.stubEnv('NODE_ENV', 'production')
    process.env.CRON_SECRET = 'expected-secret'
    delete process.env.EXTERNAL_CRON_SECRET
    const res = await GET(
      new Request('http://localhost/api/cron/instagram-token-refresh', {
        headers: { authorization: 'Bearer wrong-secret' },
      }),
    )
    expect(res.status).toBe(401)
    expect(processMock).not.toHaveBeenCalled()
  })

  it('returns 401 on a wrong bearer while both secrets are configured', async () => {
    vi.stubEnv('NODE_ENV', 'production')
    process.env.CRON_SECRET = 'expected-secret'
    process.env.EXTERNAL_CRON_SECRET = 'external-secret'
    const res = await GET(
      new Request('http://localhost/api/cron/instagram-token-refresh', {
        headers: { authorization: 'Bearer wrong-secret' },
      }),
    )
    expect(res.status).toBe(401)
    expect(processMock).not.toHaveBeenCalled()
  })

  it('accepts CRON_SECRET, the bearer the GitHub workflow sends', async () => {
    vi.stubEnv('NODE_ENV', 'production')
    process.env.CRON_SECRET = 'expected-secret'
    delete process.env.EXTERNAL_CRON_SECRET
    const res = await GET(
      new Request('http://localhost/api/cron/instagram-token-refresh', {
        headers: { authorization: 'Bearer expected-secret' },
      }),
    )
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ ok: true, ...SUMMARY })
    expect(processMock).toHaveBeenCalledOnce()
  })

  // cron-job.org is the PRIMARY trigger and holds only this one.
  it('accepts EXTERNAL_CRON_SECRET, the bearer cron-job.org sends', async () => {
    vi.stubEnv('NODE_ENV', 'production')
    delete process.env.CRON_SECRET
    process.env.EXTERNAL_CRON_SECRET = 'external-secret'
    const res = await GET(
      new Request('http://localhost/api/cron/instagram-token-refresh', {
        headers: { authorization: 'Bearer external-secret' },
      }),
    )
    expect(res.status).toBe(200)
    expect(processMock).toHaveBeenCalledOnce()
  })
})
