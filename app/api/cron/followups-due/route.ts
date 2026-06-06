// TAC-123 hourly follow-up engine route. GH Actions hits this on the same
// schedule as the commitments-due cron — venue-local 10am dispatch happens
// in JS inside processDueFollowups (the cron fires hourly UTC and the
// processor filters per-venue against followup_rules.cron_hour_local).
//
// Auth check matches the commitments-due / webhook-silence dev-skip
// pattern: in dev `curl localhost:3000/api/cron/followups-due` works
// without the header so the operator can exercise the path locally.
// Bearer is the same CRON_SECRET shared with the commitments cron — see
// .github/workflows/followups-due-cron.yml.
//
// Delegates to lib/followups/engine.ts → processDueFollowups(now).
// Returns 200 with a counts summary regardless of per-row outcomes —
// per-venue / per-guest failures log + continue (the cron doesn't retry;
// the next hourly tick re-evaluates).

import { processDueFollowups } from '@/lib/followups/engine'

function isAuthorized(request: Request): boolean {
  if (process.env.NODE_ENV !== 'production') return true
  const expected = process.env.CRON_SECRET
  if (!expected) return false
  return request.headers.get('authorization') === `Bearer ${expected}`
}

export async function GET(request: Request): Promise<Response> {
  if (!isAuthorized(request)) {
    return new Response('Unauthorized', { status: 401 })
  }

  const summary = await processDueFollowups(new Date())
  console.log('[cron followups-due] tick complete', {
    venuesScanned: summary.venuesScanned,
    venuesDispatching: summary.venuesDispatching,
    guestsEvaluated: summary.guestsEvaluated,
    guestsDue: summary.guestsDue,
    guestsDispatched: summary.guestsDispatched,
    guestsSuppressed: summary.guestsSuppressed,
    guestsConflicted: summary.guestsConflicted,
    guestsDispatchFailed: summary.guestsDispatchFailed,
  })

  return Response.json({ ok: true, ...summary })
}
