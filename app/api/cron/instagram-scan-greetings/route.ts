// TAC-536: the every-minute tick that greets a guest who scanned the counter
// code and said nothing.
//
// Hit by an external HTTP cron (cron-job.org), NOT by Vercel cron (Hobby caps
// granularity at daily) and NOT by GitHub Actions, which TAC-428 measured
// missing whole hours at a time. Authenticated with EXTERNAL_CRON_SECRET, the
// dedicated third-party secret, never the shared CRON_SECRET the internal
// GitHub Actions crons use.
//
// A ROUTE OF ITS OWN rather than a third processor on /api/cron/pending-timeout,
// which is what TAC-473 chose for its sibling and was right to. The difference
// is what this one does: it SENDS UNPROMPTED MESSAGES TO GUESTS. It is the only
// scheduled path in this repo that talks to a guest with no operator and no
// inbound behind it, and a dedicated job can be paused at cron-job.org in one
// click without also switching off the operator window warnings. The cost is
// one more entry to create and monitor.
//
// IDEMPOTENT, and by a column rather than an interval. Two ticks landing
// together cannot both greet: the processor's claim is a CAS against a partial
// unique index that also enforces one greeting per guest per venue-local day.
// See lib/agent/scan-arrival-store.ts for the single UPDATE that does both.
//
// Returns 200 with a counts summary regardless of per-row outcomes. The
// processor catches everything and the next tick re-examines anything it did
// not claim.
//
// Auth check follows the same dev-skip pattern as the other crons: in dev
// `curl localhost:3000/api/cron/instagram-scan-greetings` works without the
// header so the path can be exercised locally.

import { processDueScanGreetings } from '@/lib/agent/instagram-scan-greeting'

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

  const summary = await processDueScanGreetings(new Date())
  console.log('[cron instagram-scan-greetings] tick complete', summary)
  return Response.json({ ok: true, ...summary })
}
