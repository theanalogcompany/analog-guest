import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const processDueCommitmentsMock = vi.fn<
  (now: Date) => Promise<{
    scanned: number
    transitioned: number
    skipped: number
    invalid: number
    errored: number
    pushed: number
  }>
>()
vi.mock('@/lib/guests/commitments-due', () => ({
  processDueCommitments: (now: Date) => processDueCommitmentsMock(now),
}))

import { GET } from './route'

const originalCronSecret = process.env.CRON_SECRET

beforeEach(() => {
  processDueCommitmentsMock.mockReset()
  processDueCommitmentsMock.mockResolvedValue({
    scanned: 2,
    transitioned: 1,
    skipped: 1,
    invalid: 0,
    errored: 0,
    pushed: 1,
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

describe('GET /api/cron/commitments-due', () => {
  it('skips auth in development', async () => {
    vi.stubEnv('NODE_ENV', 'development')
    const req = new Request('http://localhost/api/cron/commitments-due')
    const res = await GET(req)
    expect(res.status).toBe(200)
    expect(processDueCommitmentsMock).toHaveBeenCalledOnce()
  })

  it('returns 401 when CRON_SECRET is missing in production', async () => {
    vi.stubEnv('NODE_ENV', 'production')
    delete process.env.CRON_SECRET
    const req = new Request('http://localhost/api/cron/commitments-due')
    const res = await GET(req)
    expect(res.status).toBe(401)
    expect(processDueCommitmentsMock).not.toHaveBeenCalled()
  })

  it('returns 401 on wrong bearer in production', async () => {
    vi.stubEnv('NODE_ENV', 'production')
    process.env.CRON_SECRET = 'expected-secret'
    const req = new Request('http://localhost/api/cron/commitments-due', {
      headers: { authorization: 'Bearer wrong-secret' },
    })
    const res = await GET(req)
    expect(res.status).toBe(401)
    expect(processDueCommitmentsMock).not.toHaveBeenCalled()
  })

  it('returns 200 with the processor summary on correct bearer', async () => {
    vi.stubEnv('NODE_ENV', 'production')
    process.env.CRON_SECRET = 'expected-secret'
    const req = new Request('http://localhost/api/cron/commitments-due', {
      headers: { authorization: 'Bearer expected-secret' },
    })
    const res = await GET(req)
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>
    expect(body).toMatchObject({
      ok: true,
      scanned: 2,
      transitioned: 1,
      pushed: 1,
    })
    expect(processDueCommitmentsMock).toHaveBeenCalledOnce()
  })
})
