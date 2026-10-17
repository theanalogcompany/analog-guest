// GET /api/devices/{deviceId}/print-jobs?since=<ISO>
// The receipt printer's job feed. Returns one job per new Square payment for the
// device's venue, each carrying the FINISHED scan link the printer renders as a
// QR. Auth: Authorization: Bearer <device token>, same as the eink feed.
//
// ONE DEFINITION OF THE LINK, SERVER-SIDE (lib/pos/scan-link.ts). The firmware
// prints `url` verbatim and never assembles it.
//
// FAILURE DIRECTION: closed per job. A payment whose code cannot be issued, or
// whose venue has no usable Instagram handle, is left OUT of the response and
// the cursor stops before it, so the next poll retries it. Handing the printer
// a QR nobody can resolve is worse than a late slip (see lib/pos/scan-code.ts).
// A failed job therefore also holds back the jobs after it: ordering over
// throughput, at one slip per payment.

import { createAdminClient } from '@/lib/db/admin'
import { logger } from '@/lib/observability/logger'
import { verifyDeviceToken } from '@/lib/pos/devices'
import { issueScanCode } from '@/lib/pos/scan-code'
import { buildScanLink } from '@/lib/pos/scan-link'

const MAX_JOBS = 10

type PrintJob = { id: string; at: string; url: string }

function bearer(request: Request): string | null {
  const header = request.headers.get('authorization')
  if (!header) return null
  const [scheme, token] = header.split(' ')
  return scheme?.toLowerCase() === 'bearer' && token ? token : null
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ deviceId: string }> },
): Promise<Response> {
  try {
    const { deviceId } = await params
    const token = bearer(request)
    if (!token) {
      return Response.json({ error: 'unauthorized' }, { status: 401 })
    }

    const supabase = createAdminClient()
    const { data: device, error: deviceError } = await supabase
      .from('pos_devices')
      .select('venue_id, location_external_id, device_token_hash')
      .eq('device_id', deviceId)
      .maybeSingle()
    if (deviceError) {
      logger.error('print feed: device lookup failed', {
        deviceId,
        error: deviceError.message,
      })
      return Response.json({ error: 'internal_error' }, { status: 500 })
    }
    // Uniform 401 for unknown device or bad token.
    if (!device || !verifyDeviceToken(token, device.device_token_hash)) {
      return Response.json({ error: 'unauthorized' }, { status: 401 })
    }

    const { data: venue, error: venueError } = await supabase
      .from('venues')
      .select('instagram_username')
      .eq('id', device.venue_id)
      .maybeSingle()
    if (venueError || !venue) {
      logger.error('print feed: venue lookup failed', {
        deviceId,
        error: venueError?.message ?? 'venue not found',
      })
      return Response.json({ error: 'internal_error' }, { status: 500 })
    }

    const since = new URL(request.url).searchParams.get('since')
    let query = supabase
      .from('transactions')
      .select('id, external_id, occurred_at')
      .eq('venue_id', device.venue_id)
      .eq('source', 'square')
      .is('retracted_at', null)
      .not('external_id', 'is', null)
      .order('occurred_at', { ascending: true })
      .limit(MAX_JOBS)
    if (since) query = query.gt('occurred_at', since)

    const { data: rows, error: txError } = await query
    if (txError) {
      logger.error('print feed: transaction query failed', {
        deviceId,
        error: txError.message,
      })
      return Response.json({ error: 'internal_error' }, { status: 500 })
    }

    const jobs: PrintJob[] = []
    for (const row of rows ?? []) {
      const issued = await issueScanCode({
        venueId: device.venue_id,
        providerPaymentId: row.external_id as string,
        locationExternalId: device.location_external_id,
        supabase,
      })
      if (!issued.ok) {
        logger.error('print feed: scan code issue failed', {
          deviceId,
          transactionId: row.id,
          errorCode: issued.errorCode ?? 'issue_failed',
        })
        break
      }
      const link = buildScanLink({
        instagramUsername: venue.instagram_username,
        code: issued.data.code,
      })
      if (!link.ok) {
        logger.error('print feed: scan link build failed', {
          deviceId,
          transactionId: row.id,
          error: link.error,
        })
        break
      }
      jobs.push({ id: row.id, at: row.occurred_at, url: link.url })
    }

    // Best-effort heartbeat; ignore failure.
    await supabase
      .from('pos_devices')
      .update({ last_seen_at: new Date().toISOString() })
      .eq('device_id', deviceId)

    // Cursor = newest job returned; the device echoes it as ?since.
    const cursor = jobs.length > 0 ? jobs[jobs.length - 1].at : since
    return Response.json({ cursor, jobs })
  } catch (e) {
    logger.error('print feed: unexpected error', {
      error: e instanceof Error ? e.message : String(e),
    })
    return Response.json({ error: 'internal_error' }, { status: 500 })
  }
}
