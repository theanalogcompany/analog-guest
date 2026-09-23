// TAC-297 hourly cron route.
//
// TAC-428: the PRIMARY trigger is an external hourly cron on cron-job.org, not
// GitHub Actions. Measured 2026-09-22, GH landed a run inside the venue's
// firing hour on 2 of the last 7 days and 6 of the 26 since 2026-08-27, so the
// day-prep push simply did not happen on most days. The GH workflow still
// fires as a redundant net; both triggers are safe together because every
// transition is CAS-gated (see lib/guests/commitments-due.ts).
//
// Delegates to lib/guests/commitments-due.ts → processDueCommitments(now).
// Returns 200 with a counts summary regardless of per-row outcomes —
// individual failures log + continue (the cron doesn't retry; the next
// hourly tick will re-attempt any rows that errored).
//
// Auth check follows the same dev-skip pattern as the webhook-silence cron:
// in dev `curl localhost:3000/api/cron/commitments-due` works without the
// header so the operator can exercise the path locally.

import { processDueCommitments } from '@/lib/guests/commitments-due'

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
// `commitments-due`, `followups-due` and `pending-timeout`, and nothing else.
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

  const summary = await processDueCommitments(new Date())
  console.log('[cron commitments-due] tick complete', summary)

  return Response.json({ ok: true, ...summary })
}
