// Tap-reconcile cron. Expires pending pos_tap_events that never received a
// send within the TTL (guest tapped but didn't text, or texted without the
// token). Triggered from GitHub Actions, NOT Vercel cron — the project is on
// Vercel Hobby (daily-only cron), same posture as commitments-due /
// followups-due. Auth + dev-skip mirror the other cron routes.

import { expireStalePendingTaps } from '@/lib/pos/reconcile-tap'

// Pending taps older than this with no send are abandoned. Generous enough to
// tolerate Square webhook lag + the guest taking a moment to hit send.
const TAP_TTL_MINUTES = 30

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

  const result = await expireStalePendingTaps({
    now: new Date(),
    ttlMinutes: TAP_TTL_MINUTES,
  })
  if (!result.ok) {
    console.error('[cron pos-tap-reconcile] failed', { error: result.error })
    return Response.json({ ok: false, error: result.error }, { status: 500 })
  }

  console.log('[cron pos-tap-reconcile] tick complete', result.data)
  return Response.json({ ok: true, ...result.data })
}
