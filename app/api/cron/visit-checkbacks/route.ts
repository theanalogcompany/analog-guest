// TAC-575: the every-minute tick that checks back on a guest who was asked how
// their order is and went quiet.
//
// Hit by an external HTTP cron (cron-job.org), NOT by Vercel cron (Hobby caps
// granularity at daily) and NOT by GitHub Actions, which TAC-428 measured
// missing whole hours at a time. Authenticated with EXTERNAL_CRON_SECRET, the
// dedicated third-party secret, never the shared CRON_SECRET the internal
// GitHub Actions crons use.
//
// A ROUTE OF ITS OWN, for the reason /api/cron/warm-close has one: it SENDS
// UNPROMPTED MESSAGES TO GUESTS. A dedicated cron-job.org entry can be paused
// in one click, stopping every timed check-back and nothing else. Pausing it
// does not stop a check-back worked into a reply to a guest who is still
// chatting; that one is the agent answering a message.
//
// TAC-578: IT NOW ALSO CARRIES the first-visit thank-you and the later-visit
// check-in (lib/agent/post-visit-timeout.ts), ruled onto an existing cron
// rather than a new one. So pausing this entry stops those too. To stop only
// those, set `followup_rules.post_visit_message_enabled` to false.
//
// EVERY MINUTE MATTERS HERE more than for the warm close. The check-back is
// due ten minutes after the order and worthless after thirty, so a schedule
// coarser than a minute spends a real share of that window.
//
// IDEMPOTENT, by a column. Two ticks landing together cannot both check back
// on the same visit: the processor claims with a compare-and-set against
// `visit_checkins.checkback_claimed_at is null`. See
// lib/agent/visit-checkin-store.ts.
//
// Returns 200 with a counts summary regardless of per-row outcomes. The
// processor catches everything and the next tick re-reads the due set.
//
// Auth follows the same dev-skip pattern as the other crons: in dev
// `curl localhost:3000/api/cron/visit-checkbacks` works without the header.

import { processDuePostVisitMessages } from '@/lib/agent/post-visit-timeout'
import { processDueVisitCheckbacks } from '@/lib/agent/visit-checkin-timeout'

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

  const summary = await processDueVisitCheckbacks(new Date())
  // TAC-578: the messages that follow a visit ride this tick, after the
  // check-back so the one that is worthless in thirty minutes is never kept
  // waiting. It never throws, and on most ticks reads one venues row and
  // stops: outside the morning and evening slots nothing can be due.
  const postVisit = await processDuePostVisitMessages(new Date())
  console.log('[cron visit-checkbacks] tick complete', {
    ...summary,
    postVisit,
  })
  return Response.json({ ok: true, ...summary, postVisit })
}
