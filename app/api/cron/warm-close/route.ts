// TAC-560: the every-minute tick that closes a first conversation that went
// quiet.
//
// Hit by an external HTTP cron (cron-job.org), NOT by Vercel cron (Hobby caps
// granularity at daily) and NOT by GitHub Actions, which TAC-428 measured
// missing whole hours at a time. Authenticated with EXTERNAL_CRON_SECRET, the
// dedicated third-party secret, never the shared CRON_SECRET the internal
// GitHub Actions crons use.
//
// A ROUTE OF ITS OWN rather than a passenger on /api/cron/pending-timeout, for
// TAC-536's reason: it SENDS UNPROMPTED MESSAGES TO GUESTS. A dedicated
// cron-job.org entry can be paused in one click, stopping every warm close and
// nothing else. The cost is one more entry to create and monitor.
//
// IDEMPOTENT, and by a column rather than an interval. Two ticks landing
// together cannot both close the same guest: the processor claims with a CAS
// against `guests.warm_close_sent_at is null`, which is the same predicate that
// makes the close once per guest EVER. See lib/agent/warm-close-store.ts.
//
// Returns 200 with a counts summary regardless of per-candidate outcomes. The
// processor catches everything and the next tick re-derives the due set, so
// nothing is lost by answering 200 on a partial tick.
//
// Auth follows the same dev-skip pattern as the other crons: in dev
// `curl localhost:3000/api/cron/warm-close` works without the header so the
// path can be exercised locally.

import { processDueWarmCloses } from '@/lib/agent/warm-close-timeout'

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

  const summary = await processDueWarmCloses(new Date())
  console.log('[cron warm-close] tick complete', summary)
  return Response.json({ ok: true, ...summary })
}
