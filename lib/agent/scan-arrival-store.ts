// TAC-536: the reads and writes behind a pending scan greeting.
//
// Split from scan-arrival.ts, which is the pure half. Everything here is one
// indexed statement against `instagram_scan_arrivals` (migration 064) or the
// two rows the processor has to re-check before it speaks.
//
// THE CLAIM IS THE WHOLE MECHANISM, and it is one UPDATE:
//
//   update instagram_scan_arrivals
//      set claimed_at = now(), venue_local_date = $2
//    where id = $1 and claimed_at is null
//
// against the partial unique index on (venue_id, guest_id, venue_local_date)
// where claimed_at is not null. Three outcomes, and all three matter:
//
//   rowcount 1  this tick owns the greeting
//   rowcount 0  another tick already claimed THIS row
//   23505       this guest already has a claimed row for this venue-local
//               day, from ANY scan: they have been greeted today
//
// So the repeat guard and the endpoint's idempotency are the same statement,
// enforced by Postgres rather than by a read-then-decide. The tick is every
// minute; a read-then-decide at that cadence loses to itself.
//
// CLAIM BEFORE THE SIDE EFFECT, the house rule (window_warning_pushed_at,
// pending_until, followup_log). A process that dies between the claim and the
// send loses one greeting rather than sending two.

import type { SupabaseClient } from '@supabase/supabase-js'

import type { Database } from '@/db/types'

type AdminSupabaseClient = SupabaseClient<Database>

const UNIQUE_VIOLATION = '23505'

/** How many due rows one tick will look at. */
export const SCAN_ARRIVAL_SCAN_LIMIT = 50

/**
 * What a resolved scan became. Mirrors migration 064's CHECK; a value added
 * here without widening that CHECK ships a writer whose every update fails.
 */
export type ScanArrivalOutcome =
  | 'greeted'
  | 'inbound_during_window'
  | 'too_stale'
  | 'venue_paused'
  | 'venue_closed'
  | 'guest_opted_out'
  | 'already_greeted_today'
  | 'errored'

export interface PendingScanArrival {
  id: string
  venueId: string
  guestId: string
  scanMessageId: string | null
  scannedAt: Date
  /**
   * Whether the guest had any message on our record when the scan arrived.
   * Settled at scan time and carried, never recomputed: it picks which of the
   * two greeting instructions renders.
   */
  hadPriorConversation: boolean
}

export type StoreResult<T> = { ok: true; data: T } | { ok: false; error: string }

/**
 * Write the pending row for a saved scan.
 *
 * Reads `provider_sent_at` and `created_at` off the scan's own message row
 * rather than taking a timestamp from the caller. One extra indexed read on a
 * path already inside waitUntil, and it means the pending row's clock and the
 * message row's clock cannot disagree about when the guest scanned.
 *
 * Meta's clock when the delivery carried one, ours when it did not: the five
 * minutes and the staleness bound both run from this, and Meta's is the one
 * the guest's own action happened on.
 */
export async function scheduleScanArrival(
  supabase: AdminSupabaseClient,
  input: {
    messageId: string
    venueId: string
    guestId: string
    hadPriorConversation: boolean
  },
): Promise<StoreResult<string>> {
  const scan = await supabase
    .from('messages')
    .select('provider_sent_at, created_at')
    .eq('id', input.messageId)
    .maybeSingle()
  if (scan.error) return { ok: false, error: scan.error.message }
  if (!scan.data) return { ok: false, error: 'scan message row not found' }

  const scannedAt = scan.data.provider_sent_at ?? scan.data.created_at
  const inserted = await supabase
    .from('instagram_scan_arrivals')
    .insert({
      venue_id: input.venueId,
      guest_id: input.guestId,
      scan_message_id: input.messageId,
      scanned_at: scannedAt,
      had_prior_conversation: input.hadPriorConversation,
    })
    .select('id')
    .single()
  if (inserted.error || !inserted.data) {
    return { ok: false, error: inserted.error?.message ?? 'no row returned' }
  }
  return { ok: true, data: inserted.data.id }
}

/** Unclaimed, unresolved rows, oldest first. */
export async function loadDueScanArrivals(
  supabase: AdminSupabaseClient,
  limit: number = SCAN_ARRIVAL_SCAN_LIMIT,
): Promise<StoreResult<PendingScanArrival[]>> {
  const { data, error } = await supabase
    .from('instagram_scan_arrivals')
    .select('id, venue_id, guest_id, scan_message_id, scanned_at, had_prior_conversation')
    .is('claimed_at', null)
    .is('resolved_at', null)
    .order('scanned_at', { ascending: true })
    .limit(limit)
  if (error) return { ok: false, error: error.message }
  return {
    ok: true,
    data: (data ?? []).map((row) => ({
      id: row.id,
      venueId: row.venue_id,
      guestId: row.guest_id,
      scanMessageId: row.scan_message_id,
      scannedAt: new Date(row.scanned_at),
      hadPriorConversation: row.had_prior_conversation,
    })),
  }
}

export type ClaimResult =
  /** This tick owns the greeting. */
  | { status: 'claimed' }
  /** Another tick claimed this same row first. */
  | { status: 'lost' }
  /** This guest has already been greeted on this venue-local day. */
  | { status: 'already_greeted_today' }
  | { status: 'failed'; error: string }

/**
 * Claim the greeting, and the guest's day with it. See the module header for
 * why one statement does both.
 */
export async function claimScanArrival(
  supabase: AdminSupabaseClient,
  id: string,
  venueLocalDate: string,
  now: Date,
): Promise<ClaimResult> {
  const { data, error } = await supabase
    .from('instagram_scan_arrivals')
    .update({ claimed_at: now.toISOString(), venue_local_date: venueLocalDate })
    .eq('id', id)
    .is('claimed_at', null)
    .select('id')
  if (error) {
    if (error.code === UNIQUE_VIOLATION) return { status: 'already_greeted_today' }
    return { status: 'failed', error: error.message }
  }
  return (data ?? []).length === 1 ? { status: 'claimed' } : { status: 'lost' }
}

/**
 * Record what became of a scan.
 *
 * Deliberately does NOT touch `claimed_at`. A suppressed greeting leaves it
 * null, so the row stays out of the once-per-day index and a later scan that
 * day can still be greeted: the guard is on having been GREETED, not on having
 * scanned.
 */
export async function resolveScanArrival(
  supabase: AdminSupabaseClient,
  id: string,
  outcome: ScanArrivalOutcome,
  now: Date,
): Promise<StoreResult<null>> {
  const { error } = await supabase
    .from('instagram_scan_arrivals')
    .update({ outcome, resolved_at: now.toISOString() })
    .eq('id', id)
  if (error) return { ok: false, error: error.message }
  return { ok: true, data: null }
}

/**
 * The most recent scan for this guest, and the greeting it produced if it did.
 *
 * ONE row, not two queries: the newest scan carries both times, so a greeting
 * read this way necessarily belongs to that scan rather than to an older one.
 * `resolved_at` on a `greeted` row is when the greeting went out.
 *
 * Fails to null, deliberately. This decides whether an inbound counts as
 * at-counter, and the cost of a miss is that `understand_order` does not arm
 * on one turn. The cost of guessing the other way is the agent telling a guest
 * it knows they are in the shop when it does not.
 */
export async function loadScanCarryForward(
  supabase: AdminSupabaseClient,
  venueId: string,
  guestId: string,
): Promise<{ lastScanAt: Date | null; lastGreetingAt: Date | null }> {
  const { data, error } = await supabase
    .from('instagram_scan_arrivals')
    .select('scanned_at, outcome, resolved_at')
    .eq('venue_id', venueId)
    .eq('guest_id', guestId)
    .order('scanned_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (error) {
    console.warn('[agent] scan carry-forward unreadable; treating this turn as ordinary', {
      venueId,
      guestId,
      error: error.message,
    })
    return { lastScanAt: null, lastGreetingAt: null }
  }
  if (!data) return { lastScanAt: null, lastGreetingAt: null }

  const scannedAt = new Date(data.scanned_at)
  if (!Number.isFinite(scannedAt.getTime())) return { lastScanAt: null, lastGreetingAt: null }

  const greetedAt =
    data.outcome === 'greeted' && typeof data.resolved_at === 'string'
      ? new Date(data.resolved_at)
      : null
  return {
    lastScanAt: scannedAt,
    lastGreetingAt: greetedAt !== null && Number.isFinite(greetedAt.getTime()) ? greetedAt : null,
  }
}
