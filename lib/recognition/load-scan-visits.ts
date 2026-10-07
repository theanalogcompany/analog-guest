import type { createAdminClient } from '@/lib/db/admin'

// TAC-575: when a guest scanned the counter code. ONE reader, because two
// things have to agree about what a scan day is:
//
//   - lib/agent/retract-reported-visit.ts (TAC-573) refuses to take back a
//     visit on a day the guest scanned;
//   - lib/recognition/load-signals.ts counts a scan day as a visit.
//
// If they read scans differently, a day could count as a visit for recognition
// and still be retractable, or the reverse.
//
// A SCAN IS THE GUEST STANDING AT THE COUNTER (ruled 2026-10-07 for TAC-573,
// and 2026-10-06 for this ticket: "repeat QR scans count as visits"). It is
// recorded in two places, and both count:
//
//   - enrolment by the QR sign: `guests.created_via = 'qr_scan'`, dated by
//     `created_at`;
//   - every Instagram scan since: `instagram_scan_arrivals.scanned_at`.
//
// EVERY ROW COUNTS, WHATEVER ITS OUTCOME. `outcome` says what became of the
// GREETING (sent, suppressed, stale), not whether the guest was there, so a
// scan whose greeting was suppressed is as much a visit as one that was
// greeted.

type AdminSupabaseClient = ReturnType<typeof createAdminClient>

// One greeting per guest per day bounds the rows that matter well below this
// inside the 90-day visit window.
export const SCAN_LOOKUP_LIMIT = 200

export type ScanInstantsResult =
  { ok: true; data: Date[] } | { ok: false; error: string }

/**
 * When this guest's Instagram scans arrived, newest first. Never throws: a
 * thrown read comes back as `ok: false`, and each caller decides which way
 * that fails (retraction fails closed, visit counting falls back to orders).
 */
export async function loadInstagramScanInstants(
  supabase: AdminSupabaseClient,
  input: { venueId: string; guestId: string; sinceIso?: string },
): Promise<ScanInstantsResult> {
  try {
    let query = supabase
      .from('instagram_scan_arrivals')
      .select('scanned_at')
      .eq('venue_id', input.venueId)
      .eq('guest_id', input.guestId)
    if (input.sinceIso !== undefined) {
      query = query.gte('scanned_at', input.sinceIso)
    }
    const { data, error } = await query
      .order('scanned_at', { ascending: false })
      .limit(SCAN_LOOKUP_LIMIT)
    if (error) return { ok: false, error: error.message }
    const instants: Date[] = []
    for (const row of data ?? []) {
      const scannedAt = new Date(row.scanned_at)
      if (Number.isFinite(scannedAt.getTime())) instants.push(scannedAt)
    }
    return { ok: true, data: instants }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

/**
 * Every instant this guest is known to have scanned: the Instagram scans plus
 * the enrolment itself when that was by the QR sign. Pure.
 */
export function scanVisitInstants(input: {
  createdVia: string
  createdAt: Date
  instagramScans: readonly Date[]
}): Date[] {
  const instants = [...input.instagramScans]
  if (
    input.createdVia === 'qr_scan' &&
    Number.isFinite(input.createdAt.getTime())
  ) {
    instants.push(input.createdAt)
  }
  return instants
}
