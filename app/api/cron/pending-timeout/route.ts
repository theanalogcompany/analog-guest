// TAC-308 knowledge-gap timeout route. Hit every minute by cron-job.org
// (external HTTP cron) — NOT by Vercel cron (Hobby caps granularity at daily)
// and no longer by GitHub Actions: this route shipped on a GH Actions `*/5`
// schedule, but GH queues scheduled workflows at low priority and the measured
// cadence was min 22m / median 36m / max 117m between runs — guests waited
// 37-38 minutes for a message the product promises "after at least 5". With an
// every-minute external trigger the holding message lands within ~6 minutes of
// `pending_until`. The floor semantics are unchanged: it can still never fire
// early.
//
// Auth is a DEDICATED secret, `EXTERNAL_CRON_SECRET`, not the shared
// `CRON_SECRET` the internal GH Actions crons use. This route's caller is a
// third-party service; giving it the shared secret would make cron-job.org a
// single point of compromise for every cron route, and a dedicated secret
// rotates independently. Manual UAT firing is a curl with the same bearer
// (the old workflow_dispatch path is gone with the workflow).
//
// TWO JOBS, and the route's NAME only describes the first. Read
// "pending-timeout" as "a pending card is timing out", which is true of both:
//
//   1. lib/agent/knowledge-gap-timeout.ts → processDueKnowledgeGaps. The
//      original job, and INERT: TAC-484 disabled the holding message
//      permanently after one fired with nothing to hold, so this returns an
//      all-zero summary without touching the database. The code stays because
//      the mechanism returns in a dynamic form under its own ticket.
//   2. lib/agent/instagram-window-warning.ts → processInstagramWindowWarnings
//      (TAC-473). Warns an operator when a held Instagram draft has an hour
//      left in Meta's 24-hour reply window.
//
// TAC-473 reused this route rather than adding a third cron-job.org entry
// (ruled 2026-09-23): it already fires every minute, already carries
// EXTERNAL_CRON_SECRET, and until (2) landed it did nothing at all. Renaming it
// would mean re-pointing the cron-job.org entry, which is an operational step
// for a cosmetic gain.
//
// Returns 200 with a counts summary regardless of per-card outcomes; the
// processor catches everything and the next tick re-attempts anything it
// didn't claim. Overlapping or repeated fires are safe: the processor's CAS
// claim on `pending_until` means at most one tick ever wins a given card.
//
// Auth check follows the same dev-skip pattern as the other three crons: in
// dev `curl localhost:3000/api/cron/pending-timeout` works without the header
// so the path can be exercised locally.

import { processInstagramWindowWarnings } from '@/lib/agent/instagram-window-warning'
import { processDueKnowledgeGaps } from '@/lib/agent/knowledge-gap-timeout'

function isAuthorized(request: Request): boolean {
  if (process.env.NODE_ENV !== 'production') return true
  const expected = process.env.EXTERNAL_CRON_SECRET
  if (!expected) return false
  return request.headers.get('authorization') === `Bearer ${expected}`
}

export async function GET(request: Request): Promise<Response> {
  if (!isAuthorized(request)) {
    return new Response('Unauthorized', { status: 401 })
  }

  const now = new Date()

  // TWO PROCESSORS, INDEPENDENTLY ISOLATED. allSettled, not Promise.all: they
  // share only this trigger, and a throw in one must not cost the other its
  // tick. Each already catches internally, so a rejection here means something
  // unexpected got past that — which is exactly when the other one still
  // running matters.
  const [knowledgeGaps, instagramWindows] = await Promise.allSettled([
    processDueKnowledgeGaps(now),
    processInstagramWindowWarnings(now),
  ])

  if (knowledgeGaps.status === 'rejected') {
    console.error('[cron pending-timeout] knowledge-gap processor threw', {
      error: String(knowledgeGaps.reason),
    })
  }
  if (instagramWindows.status === 'rejected') {
    console.error('[cron pending-timeout] instagram window processor threw', {
      error: String(instagramWindows.reason),
    })
  }

  const summary = {
    knowledgeGaps: knowledgeGaps.status === 'fulfilled' ? knowledgeGaps.value : null,
    instagramWindows: instagramWindows.status === 'fulfilled' ? instagramWindows.value : null,
  }
  console.log('[cron pending-timeout] tick complete', summary)

  return Response.json({ ok: true, ...summary })
}
