// Tap-reconcile cron. Expires pending pos_tap_events that never received a
// send within the TTL (guest tapped but didn't text, or texted without the
// token). Triggered from GitHub Actions, NOT Vercel cron — the project is on
// Vercel Hobby (daily-only cron), same posture as commitments-due /
// followups-due. Auth + dev-skip mirror the other cron routes.

import { logger } from '@/lib/observability/logger'
import { expireStalePendingTaps } from '@/lib/pos/reconcile-tap'
import { SCAN_CODE_TTL_MS } from '@/lib/pos/scan-code'

// Pending taps and scan codes older than this are abandoned. TWENTY-FOUR HOURS
// since TAC-588: it was thirty minutes, sized for the NFC tap, and receipt
// codes inherited it, but a slip is scanned on the walk out, at home or the
// next morning. One value for both (NFC is not live); the reasoning lives on
// SCAN_CODE_TTL_MS. The bind checks a code's age itself, so this cron only
// tidies the pending index; it is not what makes a late code do nothing.
const TAP_TTL_MINUTES = SCAN_CODE_TTL_MS / 60_000

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
    logger.error('[cron pos-tap-reconcile] failed', { error: result.error })
    return Response.json({ ok: false, error: result.error }, { status: 500 })
  }

  logger.info('[cron pos-tap-reconcile] tick complete', {
    summary: result.data,
  })
  return Response.json({ ok: true, ...result.data })
}
