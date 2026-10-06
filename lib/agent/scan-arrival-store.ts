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
//    where id = $1 and claimed_at is null and resolved_at is null
//
// against the partial unique index on (venue_id, guest_id, venue_local_date)
// where claimed_at is not null. Three outcomes, and all three matter:
//
//   rowcount 1  this runner owns the greeting
//   rowcount 0  another runner already claimed THIS row, or resolved it
//               without a greeting
//   23505       this guest already has a claimed row for this venue-local
//               day, from ANY scan: they have been greeted today
//
// So the repeat guard and the endpoint's idempotency are the same statement,
// enforced by Postgres rather than by a read-then-decide. The tick is every
// minute; a read-then-decide at that cadence loses to itself.
//
// TWO RUNNERS NOW REACH EVERY ROW (2026-10-06): the webhook's own fast path,
// about twenty seconds after the scan, and the cron behind it as the
// backstop. They share one per-row function and therefore this one claim, and
// the claim is the only thing that makes a double greeting impossible when
// both arrive together. Nothing else here may be relied on for that.
//
// `resolved_at is null` IS PART OF THE CLAIM for the same reason (ruled
// 2026-10-06). One runner can decide to suppress a scan (the guest wrote, the
// venue closed) in the instant between the other runner's own checks and its
// claim. Without the filter that claim still succeeded and the guest was
// greeted over a decision not to greet them. A suppressed row now comes back
// `lost`.
//
// CLAIM BEFORE THE SIDE EFFECT, the house rule (window_warning_pushed_at,
// pending_until, followup_log). A process that dies between the claim and the
// send loses one greeting rather than sending two.

import type { SupabaseClient } from '@supabase/supabase-js'

import type { Database } from '@/db/types'
import { logger } from '@/lib/observability/logger'

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

export type StoreResult<T> =
  { ok: true; data: T } | { ok: false; error: string }

/**
 * Write the pending row for a saved scan.
 *
 * Reads `provider_sent_at` and `created_at` off the scan's own message row
 * rather than taking a timestamp from the caller. One extra indexed read on a
 * path already inside waitUntil, and it means the pending row's clock and the
 * message row's clock cannot disagree about when the guest scanned.
 *
 * Meta's clock when the delivery carried one, ours when it did not: the
 * greeting delay and the staleness bound both run from this, and Meta's is the
 * one the guest's own action happened on.
 *
 * Returns the row's id AND the `scannedAt` it was written with, so the fast
 * path can time its sleep from the same instant the due check will read
 * without a second round trip.
 */
export async function scheduleScanArrival(
  supabase: AdminSupabaseClient,
  input: {
    messageId: string
    venueId: string
    guestId: string
    hadPriorConversation: boolean
  },
): Promise<StoreResult<{ id: string; scannedAt: Date }>> {
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
  return {
    ok: true,
    data: { id: inserted.data.id, scannedAt: new Date(scannedAt) },
  }
}

const PENDING_COLUMNS =
  'id, venue_id, guest_id, scan_message_id, scanned_at, had_prior_conversation'

function toPendingScanArrival(row: {
  id: string
  venue_id: string
  guest_id: string
  scan_message_id: string | null
  scanned_at: string
  had_prior_conversation: boolean
}): PendingScanArrival {
  return {
    id: row.id,
    venueId: row.venue_id,
    guestId: row.guest_id,
    scanMessageId: row.scan_message_id,
    scannedAt: new Date(row.scanned_at),
    hadPriorConversation: row.had_prior_conversation,
  }
}

/**
 * One pending row by id, for the fast path.
 *
 * The SAME two filters as `loadDueScanArrivals`, on purpose: a row the cron
 * would not pick up is a row the fast path must not act on either. `null` is
 * the ordinary answer when the cron (or anything else) got there first.
 */
export async function loadPendingScanArrival(
  supabase: AdminSupabaseClient,
  id: string,
): Promise<StoreResult<PendingScanArrival | null>> {
  const { data, error } = await supabase
    .from('instagram_scan_arrivals')
    .select(PENDING_COLUMNS)
    .eq('id', id)
    .is('claimed_at', null)
    .is('resolved_at', null)
    .maybeSingle()
  if (error) return { ok: false, error: error.message }
  return { ok: true, data: data ? toPendingScanArrival(data) : null }
}

/** Unclaimed, unresolved rows, oldest first. */
export async function loadDueScanArrivals(
  supabase: AdminSupabaseClient,
  limit: number = SCAN_ARRIVAL_SCAN_LIMIT,
): Promise<StoreResult<PendingScanArrival[]>> {
  const { data, error } = await supabase
    .from('instagram_scan_arrivals')
    .select(PENDING_COLUMNS)
    .is('claimed_at', null)
    .is('resolved_at', null)
    .order('scanned_at', { ascending: true })
    .limit(limit)
  if (error) return { ok: false, error: error.message }
  return { ok: true, data: (data ?? []).map(toPendingScanArrival) }
}

export type ClaimResult =
  /** This runner owns the greeting. */
  | { status: 'claimed' }
  /** Another runner claimed this same row first, or resolved it ungreeted. */
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
    .is('resolved_at', null)
    .select('id')
  if (error) {
    if (error.code === UNIQUE_VIOLATION)
      return { status: 'already_greeted_today' }
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
 *
 * WHO IS WRITING DECIDES THE PREDICATE, because two runners reach every row
 * now and they are not equals once one of them has claimed it:
 *
 *   'unclaimed'    a runner that has NOT claimed the row (every suppression,
 *                  and a throw before the claim). A CAS on
 *                  `claimed_at IS NULL AND resolved_at IS NULL`. Two runners
 *                  that both decide to suppress one scan would otherwise each
 *                  write a ledger row and an event for it, and a runner still
 *                  walking its checks must never resolve a row the other has
 *                  already claimed and is greeting: that would leave a row
 *                  reading `inbound_during_window` for a greeting that went
 *                  out, and cost the guest the thirty-minute anchor
 *                  `loadScanCarryForward` reads off `greeted`.
 *   'claim_owner'  the runner whose claim won. Unconditional by id: the
 *                  greeting is its to record, whatever is on the row.
 *
 * `data` says whether THIS call wrote the row. A caller writing as
 * 'unclaimed' gates its ledger row and event on it.
 */
export async function resolveScanArrival(
  supabase: AdminSupabaseClient,
  id: string,
  outcome: ScanArrivalOutcome,
  now: Date,
  as: 'unclaimed' | 'claim_owner',
): Promise<StoreResult<boolean>> {
  const update = supabase
    .from('instagram_scan_arrivals')
    .update({ outcome, resolved_at: now.toISOString() })
    .eq('id', id)
  const { data, error } = await (
    as === 'claim_owner'
      ? update
      : update.is('claimed_at', null).is('resolved_at', null)
  ).select('id')
  if (error) return { ok: false, error: error.message }
  return { ok: true, data: (data ?? []).length === 1 }
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
    logger.warn(
      '[agent] scan carry-forward unreadable; treating this turn as ordinary',
      {
        venueId,
        guestId,
        error: error.message,
      },
    )
    return { lastScanAt: null, lastGreetingAt: null }
  }
  if (!data) return { lastScanAt: null, lastGreetingAt: null }

  const scannedAt = new Date(data.scanned_at)
  if (!Number.isFinite(scannedAt.getTime()))
    return { lastScanAt: null, lastGreetingAt: null }

  const greetedAt =
    data.outcome === 'greeted' && typeof data.resolved_at === 'string'
      ? new Date(data.resolved_at)
      : null
  return {
    lastScanAt: scannedAt,
    lastGreetingAt:
      greetedAt !== null && Number.isFinite(greetedAt.getTime())
        ? greetedAt
        : null,
  }
}
