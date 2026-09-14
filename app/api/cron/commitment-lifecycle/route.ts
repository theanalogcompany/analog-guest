// TAC-341 hourly cron route. Triggered by GitHub Actions
// (.github/workflows/commitment-lifecycle-cron.yml), NOT vercel.json — the
// project is on Vercel Hobby, whose cron tier caps at daily, so anything
// sub-daily lives on GH Actions. Same posture as commitments-due and
// followups-due.
//
// Delegates to lib/guests/commitment-lifecycle-due.ts →
// processCommitmentLifecycle(now). Returns 200 with a counts summary
// regardless of per-row outcomes — individual failures log and continue, and
// the next hourly tick re-attempts anything that errored.
//
// GH Actions scheduled runs lag under platform load (CLAUDE.md documents
// min 22m / median 36m / max 117m on the 5-minute cron). That is tolerable
// here for the same reason it is on commitments-due: the windows are
// hour-scale. A hold can sit open a couple of hours past close — but its
// escalation fires BEFORE close, which is where a human actually enters, so
// the lag costs a late tidy-up rather than a missed alert.
//
// Auth follows the same dev-skip pattern as the sibling crons: in dev,
// `curl localhost:3000/api/cron/commitment-lifecycle` works without a header.
// Reuses CRON_SECRET — no new env var, so no new validator.

import { processCommitmentLifecycle } from '@/lib/guests/commitment-lifecycle-due'

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

  const summary = await processCommitmentLifecycle(new Date())
  console.log('[cron commitment-lifecycle] tick complete', summary)

  return Response.json({ ok: true, ...summary })
}
