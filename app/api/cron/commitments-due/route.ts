// TAC-297 hourly cron route. Vercel invokes this on the schedule defined in
// vercel.json ("0 * * * *" = every hour on the hour). Vercel attaches
// `Authorization: Bearer ${env.CRON_SECRET}` automatically when CRON_SECRET
// is set.
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

  const summary = await processDueCommitments(new Date())
  console.log('[cron commitments-due] tick complete', summary)

  return Response.json({ ok: true, ...summary })
}
