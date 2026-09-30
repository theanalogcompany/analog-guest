// TAC-386: the every-minute tick that checks our answer worked out.
//
// Hit by an external HTTP cron (cron-job.org), NOT by Vercel cron (Hobby caps
// granularity at daily) and NOT by GitHub Actions, which TAC-428 measured
// missing whole hours at a time. Authenticated with EXTERNAL_CRON_SECRET, the
// dedicated third-party secret, never the shared CRON_SECRET the internal
// GitHub Actions crons use.
//
// A ROUTE OF ITS OWN rather than a passenger on /api/cron/followups-due, for
// TAC-536's and TAC-560's reason: it SENDS UNPROMPTED MESSAGES TO GUESTS. A
// dedicated cron-job.org entry can be paused in one click, stopping every
// inquiry follow-up and nothing else. The cost is one more entry to create and
// monitor.
//
// It is also the WRONG passenger for that route specifically:
// /api/cron/followups-due runs the DAILY engine, which looks at each venue once
// per day at its own local hour. Sharing it would either hold this processor to
// that cadence or give that route two unrelated schedules.
//
// IDEMPOTENT, by a status CAS rather than an interval. Two ticks landing
// together cannot both send one row: the processor claims with
// `where status = 'pending'`, and migration 066's unique index on
// `source_message_id` makes it once-per-question even across claims. See
// lib/followups/inquiry-followup-store.ts.
//
// Returns 200 with a counts summary regardless of per-row outcomes. The
// processor catches everything and the next tick re-derives the due set, so
// nothing is lost by answering 200 on a partial tick.
//
// Auth follows the same dev-skip pattern as the other crons: in dev
// `curl localhost:3000/api/cron/inquiry-followups` works without the header so
// the path can be exercised locally.

import { processDueInquiryFollowups } from '@/lib/followups/inquiry-followup-engine'

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

  const summary = await processDueInquiryFollowups(new Date())
  console.log('[cron inquiry-followups] tick complete', summary)
  return Response.json({ ok: true, ...summary })
}
