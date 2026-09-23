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

// TAC-473: the second processor on this route.
const processInstagramWindowWarningsMock = vi.fn()
vi.mock('@/lib/agent/instagram-window-warning', () => ({
  processInstagramWindowWarnings: (now: Date) => processInstagramWindowWarningsMock(now),
}))

const INSTAGRAM_SUMMARY = {
  scanned: 2,
  due: 1,
  claimed: 1,
  casLost: 0,
  pushed: 1,
  notYet: 1,
  expired: 0,
  windowUnknown: 0,
  errored: 0,
}

import { GET } from './route'

const originalExternalCronSecret = process.env.EXTERNAL_CRON_SECRET
const originalCronSecret = process.env.CRON_SECRET

beforeEach(() => {
  processInstagramWindowWarningsMock.mockReset()
  processInstagramWindowWarningsMock.mockResolvedValue(INSTAGRAM_SUMMARY)
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
    // TAC-473 NESTED the two summaries. They share counter names (`scanned`,
    // `claimed`, `errored`), so spreading both would silently collide and
    // spreading one while nesting the other reads as an accident. Nothing
    // parses this body — cron-job.org reads the status — so the shape is free
    // to say which processor a number came from.
    expect(body).toMatchObject({
      ok: true,
      knowledgeGaps: { scanned: 1, claimed: 1, sent: 1 },
      instagramWindows: INSTAGRAM_SUMMARY,
    })
    expect(processDueKnowledgeGapsMock).toHaveBeenCalledOnce()
  })

  // TAC-473 ------------------------------------------------------------------
  describe('the two processors are independently isolated', () => {
    async function tick(): Promise<{ status: number; body: Record<string, unknown> }> {
      vi.stubEnv('NODE_ENV', 'production')
      process.env.EXTERNAL_CRON_SECRET = 'external-secret'
      const res = await GET(
        new Request('http://localhost/api/cron/pending-timeout', {
          headers: { authorization: 'Bearer external-secret' },
        }),
      )
      return { status: res.status, body: (await res.json()) as Record<string, unknown> }
    }

    it('runs both on one tick, with the same clock', async () => {
      await tick()
      expect(processDueKnowledgeGapsMock).toHaveBeenCalledOnce()
      expect(processInstagramWindowWarningsMock).toHaveBeenCalledOnce()
      // One `now` for both: two Date() calls could straddle a minute boundary
      // and make the tick's two halves disagree about when it ran.
      expect(processDueKnowledgeGapsMock.mock.calls[0]![0]).toBe(
        processInstagramWindowWarningsMock.mock.calls[0]![0],
      )
    })

    it('still runs and reports the Instagram half when the knowledge-gap half throws', async () => {
      // allSettled, not Promise.all. Each processor catches internally, so a
      // rejection here means something unexpected got past that — which is
      // exactly when the other one still running matters.
      vi.spyOn(console, 'error').mockImplementation(() => {})
      processDueKnowledgeGapsMock.mockRejectedValueOnce(new Error('boom'))
      const { status, body } = await tick()
      expect(status).toBe(200)
      expect(processInstagramWindowWarningsMock).toHaveBeenCalledOnce()
      expect(body).toMatchObject({ ok: true, knowledgeGaps: null, instagramWindows: INSTAGRAM_SUMMARY })
    })

    it('still runs and reports the knowledge-gap half when the Instagram half throws', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => {})
      processInstagramWindowWarningsMock.mockRejectedValueOnce(new Error('boom'))
      const { status, body } = await tick()
      expect(status).toBe(200)
      expect(processDueKnowledgeGapsMock).toHaveBeenCalledOnce()
      expect(body).toMatchObject({ ok: true, instagramWindows: null })
      expect(body.knowledgeGaps).toMatchObject({ scanned: 1 })
    })

    it('never runs the Instagram half without the bearer', async () => {
      vi.stubEnv('NODE_ENV', 'production')
      process.env.EXTERNAL_CRON_SECRET = 'external-secret'
      const res = await GET(new Request('http://localhost/api/cron/pending-timeout'))
      expect(res.status).toBe(401)
      expect(processInstagramWindowWarningsMock).not.toHaveBeenCalled()
    })
  })
})
