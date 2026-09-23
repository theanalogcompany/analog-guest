// TAC-123 hourly follow-up engine route. Venue-local dispatch happens in JS
// inside processDueFollowups (the cron fires hourly UTC and the processor
// filters per-venue against followup_rules.cron_hour_local).
//
// TAC-428: the PRIMARY trigger is an external hourly cron on cron-job.org, not
// GitHub Actions. Measured 2026-09-22, GH landed a run inside the venue's
// 10:00 local hour on 2 of the last 7 days. The GH workflow still fires as a
// redundant net; both triggers are safe together because the followup_log
// claim is a UNIQUE insert, so the second tick of a day is a no-op per guest.
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

// TAC-428: two accepted bearers, not one. cron-job.org is the PRIMARY trigger
// for this route now (the GitHub Actions workflow stays as a redundant net, see
// its own header), and it authenticates with the dedicated
// `EXTERNAL_CRON_SECRET` that TAC-308 introduced for exactly this reason: a
// third-party caller must not hold the secret every internal cron route
// accepts. `CRON_SECRET` still works so the workflow keeps firing.
//
// Both are checked, so an unset variable cannot make the route fall open: a
// missing secret simply never matches, and with neither set the function
// returns false. `webhook-silence`, `pos-tap-reconcile` and
// `commitment-lifecycle` are deliberately NOT extended — cron-job.org reaches
// this route, `followups-due` and `pending-timeout`, and nothing else.
function isAuthorized(request: Request): boolean {
  if (process.env.NODE_ENV !== 'production') return true
  const presented = request.headers.get('authorization')
  if (!presented) return false
  for (const expected of [process.env.CRON_SECRET, process.env.EXTERNAL_CRON_SECRET]) {
    if (expected && presented === `Bearer ${expected}`) return true
  }
  return false
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
    guestsTasked: summary.guestsTasked,
    guestsSuppressed: summary.guestsSuppressed,
    guestsConflicted: summary.guestsConflicted,
    guestsDispatchFailed: summary.guestsDispatchFailed,
  })

  return Response.json({ ok: true, ...summary })
}
