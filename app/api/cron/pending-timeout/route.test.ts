import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const processDueKnowledgeGapsMock = vi.fn<
  (now: Date) => Promise<{
    scanned: number
    claimed: number
    casLost: number
    sent: number
    fallbackSent: number
    suppressed: number
    errored: number
    invalid: number
  }>
>()
vi.mock('@/lib/agent/knowledge-gap-timeout', () => ({
  processDueKnowledgeGaps: (now: Date) => processDueKnowledgeGapsMock(now),
}))

import { GET } from './route'

const originalExternalCronSecret = process.env.EXTERNAL_CRON_SECRET
const originalCronSecret = process.env.CRON_SECRET

beforeEach(() => {
  processDueKnowledgeGapsMock.mockReset()
  processDueKnowledgeGapsMock.mockResolvedValue({
    scanned: 1,
    claimed: 1,
    casLost: 0,
    sent: 1,
    fallbackSent: 0,
    suppressed: 0,
    errored: 0,
    invalid: 0,
  })
})

afterEach(() => {
  vi.unstubAllEnvs()
  if (originalExternalCronSecret === undefined) {
    delete process.env.EXTERNAL_CRON_SECRET
  } else {
    process.env.EXTERNAL_CRON_SECRET = originalExternalCronSecret
  }
  if (originalCronSecret === undefined) {
    delete process.env.CRON_SECRET
  } else {
    process.env.CRON_SECRET = originalCronSecret
  }
  vi.restoreAllMocks()
})

describe('GET /api/cron/pending-timeout', () => {
  it('skips auth in development', async () => {
    vi.stubEnv('NODE_ENV', 'development')
    const req = new Request('http://localhost/api/cron/pending-timeout')
    const res = await GET(req)
    expect(res.status).toBe(200)
    expect(processDueKnowledgeGapsMock).toHaveBeenCalledOnce()
  })

  it('returns 401 when EXTERNAL_CRON_SECRET is missing in production (fails closed)', async () => {
    vi.stubEnv('NODE_ENV', 'production')
    delete process.env.EXTERNAL_CRON_SECRET
    const req = new Request('http://localhost/api/cron/pending-timeout')
    const res = await GET(req)
    expect(res.status).toBe(401)
    expect(processDueKnowledgeGapsMock).not.toHaveBeenCalled()
  })

  it('returns 401 on wrong bearer in production', async () => {
    vi.stubEnv('NODE_ENV', 'production')
    process.env.EXTERNAL_CRON_SECRET = 'external-secret'
    const req = new Request('http://localhost/api/cron/pending-timeout', {
      headers: { authorization: 'Bearer wrong-secret' },
    })
    const res = await GET(req)
    expect(res.status).toBe(401)
    expect(processDueKnowledgeGapsMock).not.toHaveBeenCalled()
  })

  // The auth change's contract, asserted in the direction that matters: this
  // route is opened ONLY by the dedicated external secret. The shared
  // CRON_SECRET stays internal to the GH Actions crons — if it ever unlocked
  // this route again, a cron-job.org leak of one secret would be a leak of
  // both, which is the exact coupling the split exists to prevent.
  it('rejects the shared internal CRON_SECRET', async () => {
    vi.stubEnv('NODE_ENV', 'production')
    process.env.EXTERNAL_CRON_SECRET = 'external-secret'
    process.env.CRON_SECRET = 'internal-secret'
    const req = new Request('http://localhost/api/cron/pending-timeout', {
      headers: { authorization: 'Bearer internal-secret' },
    })
    const res = await GET(req)
    expect(res.status).toBe(401)
    expect(processDueKnowledgeGapsMock).not.toHaveBeenCalled()
  })

  it('returns 200 with the processor summary on correct bearer', async () => {
    vi.stubEnv('NODE_ENV', 'production')
    process.env.EXTERNAL_CRON_SECRET = 'external-secret'
    const req = new Request('http://localhost/api/cron/pending-timeout', {
      headers: { authorization: 'Bearer external-secret' },
    })
    const res = await GET(req)
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>
    expect(body).toMatchObject({
      ok: true,
      scanned: 1,
      claimed: 1,
      sent: 1,
    })
    expect(processDueKnowledgeGapsMock).toHaveBeenCalledOnce()
  })
})
