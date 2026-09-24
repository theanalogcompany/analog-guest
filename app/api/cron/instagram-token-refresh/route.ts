// TAC-516 / TAC-460: refresh every venue's Instagram token before it expires.
//
// DAILY, and triggered by cron-job.org rather than GitHub Actions. TAC-428
// measured GH's scheduled workflows landing hours late and, on most days, not
// at all — which for this job would mean a missed refresh window, and a missed
// window is unrecoverable (Meta cannot refresh an expired token). The GH
// workflow beside this stays as a redundant net: the processor is idempotent,
// so two triggers in a day cost one extra no-op scan.
//
// Auth accepts EITHER secret, like commitments-due and followups-due since
// TAC-428: EXTERNAL_CRON_SECRET is what cron-job.org sends, CRON_SECRET is
// what the GH workflow sends. The loop form matters — `!expected || presented
// === ...` would authorize everything whenever a secret happened to be unset,
// and every 401 test would still pass because they send no header at all
// (CLAUDE.md records that exact trap on these routes).
//
// Returns 200 with a counts summary whatever the per-venue outcomes are. The
// processor catches everything and the next tick retries; there are many more
// attempts inside the ten-day margin.

import { processInstagramTokenRefresh } from '@/lib/messaging/instagram/refresh-tokens'

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

  const summary = await processInstagramTokenRefresh(new Date())
  console.log('[cron instagram-token-refresh] tick complete', summary)

  return Response.json({ ok: true, ...summary })
}
