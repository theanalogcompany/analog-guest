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
// Delegates to lib/agent/knowledge-gap-timeout.ts → processDueKnowledgeGaps.
// Returns 200 with a counts summary regardless of per-card outcomes; the
// processor catches everything and the next tick re-attempts anything it
// didn't claim. Overlapping or repeated fires are safe: the processor's CAS
// claim on `pending_until` means at most one tick ever wins a given card.
//
// Auth check follows the same dev-skip pattern as the other three crons: in
// dev `curl localhost:3000/api/cron/pending-timeout` works without the header
// so the path can be exercised locally.

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

  const summary = await processDueKnowledgeGaps(new Date())
  console.log('[cron pending-timeout] tick complete', summary)

  return Response.json({ ok: true, ...summary })
}
