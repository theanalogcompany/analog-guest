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
import { DELIVERED_OUTBOUND_STATUSES } from './group-responses'
import { latestGreetings, type ScanArrivalTiming } from './scan-arrival'

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

export interface PendingScanArrival extends ScanArrivalTiming {
  id: string
  venueId: string
  guestId: string
  scanMessageId: string | null
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
    /**
     * TAC-588: the scan carried a receipt code and a stamp run is starting
     * for it, so the hello waits for that run (scanGreetingDueAt).
     */
    awaitsPassport: boolean
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
      awaits_passport: input.awaitsPassport,
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
  'id, venue_id, guest_id, scan_message_id, scanned_at, had_prior_conversation, awaits_passport, passport_settled_at, passport_sent_at'

/** A stored timestamp, or null when it is absent or unreadable. */
function dateOrNull(value: string | null): Date | null {
  if (value === null) return null
  const date = new Date(value)
  return Number.isFinite(date.getTime()) ? date : null
}

function toPendingScanArrival(row: {
  id: string
  venue_id: string
  guest_id: string
  scan_message_id: string | null
  scanned_at: string
  had_prior_conversation: boolean
  awaits_passport: boolean
  passport_settled_at: string | null
  passport_sent_at: string | null
}): PendingScanArrival {
  return {
    id: row.id,
    venueId: row.venue_id,
    guestId: row.guest_id,
    scanMessageId: row.scan_message_id,
    scannedAt: new Date(row.scanned_at),
    hadPriorConversation: row.had_prior_conversation,
    awaitsPassport: row.awaits_passport,
    passportSettledAt: dateOrNull(row.passport_settled_at),
    passportSentAt: dateOrNull(row.passport_sent_at),
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

/**
 * TAC-588: record how this scan's stamp run ended, which is what the hello is
 * timed from (scanGreetingDueAt).
 *
 * `sentAt` is when both images reached the guest, or null when the run ended
 * without sending them. Written once, by the run's own chain in the webhook,
 * and only on a row still waiting (`passport_settled_at is null`), so a late
 * duplicate cannot move a hello that has already been timed.
 *
 * Returns the error rather than throwing. A settle that fails leaves the row
 * looking like a run still in progress, and the hello goes at the cap
 * (PASSPORT_WAIT_CAP_MS) instead: a late hello, never a lost one.
 */
export async function settleScanPassport(
  supabase: AdminSupabaseClient,
  id: string,
  settled: { settledAt: Date; sentAt: Date | null },
): Promise<StoreResult<void>> {
  try {
    const { error } = await supabase
      .from('instagram_scan_arrivals')
      .update({
        passport_settled_at: settled.settledAt.toISOString(),
        passport_sent_at: settled.sentAt?.toISOString() ?? null,
      })
      .eq('id', id)
      .is('passport_settled_at', null)
    if (error) return { ok: false, error: error.message }
    return { ok: true, data: undefined }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
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

// A greeting is at most a few bubbles, so this many rows always holds the
// newest PRIOR_GREETING_LIMIT greetings.
const PRIOR_GREETING_ROW_LIMIT = 12

/**
 * TAC-575: the last greetings that reached this guest, newest first, for the
 * next greeting not to repeat. See PRIOR_GREETING_LIMIT in scan-arrival.ts.
 *
 * Read by `category = 'guest_arrived'`, which is what handleFollowup stores a
 * scan greeting under and nothing else uses. Only rows that reached the guest:
 * a greeting an operator skipped is not something the guest has heard.
 *
 * Returns the error rather than an empty list, so the caller chooses the
 * direction. It chooses "no priors": a greeting that might repeat itself is
 * what every greeting was before this, and is better than no greeting.
 */
export async function loadPriorGreetings(
  supabase: AdminSupabaseClient,
  venueId: string,
  guestId: string,
): Promise<StoreResult<string[]>> {
  try {
    const { data, error } = await supabase
      .from('messages')
      .select('id, generation_id, body, created_at')
      .eq('venue_id', venueId)
      .eq('guest_id', guestId)
      .eq('direction', 'outbound')
      .eq('category', 'guest_arrived')
      .in('status', [...DELIVERED_OUTBOUND_STATUSES])
      .order('created_at', { ascending: false })
      .limit(PRIOR_GREETING_ROW_LIMIT)
    if (error) return { ok: false, error: error.message }
    return {
      ok: true,
      data: latestGreetings(
        (data ?? []).map((row) => ({
          id: row.id,
          generationId: row.generation_id,
          body: row.body,
          createdAt: new Date(row.created_at),
        })),
      ),
    }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

// ---------------------------------------------------------------------------
// The item question (TAC-588)
// ---------------------------------------------------------------------------
//
// Timed off the greeted scan's own row (migration 089): `item_question_due_at`
// is written when the hello goes, `item_question_claimed_at` is the claim
// taken before the send (or with no send, when the timer is cancelled or
// given up), and `item_question_sent_at` says it reached the guest.

/** How many due questions one tick looks at. */
export const SCAN_ITEM_QUESTION_SCAN_LIMIT = 50

/**
 * Owe this greeted scan its item question.
 *
 * Only on a row that does not have one yet, so a second runner reaching the
 * same greeting cannot move a due time already set.
 */
export async function scheduleScanItemQuestion(
  supabase: AdminSupabaseClient,
  id: string,
  dueAt: Date,
): Promise<StoreResult<void>> {
  try {
    const { error } = await supabase
      .from('instagram_scan_arrivals')
      .update({ item_question_due_at: dueAt.toISOString() })
      .eq('id', id)
      .is('item_question_due_at', null)
    if (error) return { ok: false, error: error.message }
    return { ok: true, data: undefined }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

/** A greeted scan owed its item question, as the timer sees it. */
export interface DueScanItemQuestion {
  id: string
  venueId: string
  guestId: string
  scanMessageId: string | null
  scannedAt: Date
  /** When the hello went: the row's `resolved_at` on a `greeted` row. */
  helloAt: Date
  dueAt: Date
}

/**
 * Greeted scans whose item question is due and unclaimed, oldest first.
 * Everything else is re-checked per row on `now`.
 */
export async function loadDueScanItemQuestions(
  supabase: AdminSupabaseClient,
  now: Date,
  limit: number = SCAN_ITEM_QUESTION_SCAN_LIMIT,
): Promise<StoreResult<DueScanItemQuestion[]>> {
  const { data, error } = await supabase
    .from('instagram_scan_arrivals')
    .select(
      'id, venue_id, guest_id, scan_message_id, scanned_at, resolved_at, item_question_due_at',
    )
    .eq('outcome', 'greeted')
    .is('item_question_claimed_at', null)
    .lte('item_question_due_at', now.toISOString())
    .order('item_question_due_at', { ascending: true })
    .limit(limit)
  if (error) return { ok: false, error: error.message }
  const rows: DueScanItemQuestion[] = []
  for (const row of data ?? []) {
    const dueAt = dateOrNull(row.item_question_due_at)
    const helloAt = dateOrNull(row.resolved_at)
    const scannedAt = dateOrNull(row.scanned_at)
    if (dueAt === null || helloAt === null || scannedAt === null) continue
    rows.push({
      id: row.id,
      venueId: row.venue_id,
      guestId: row.guest_id,
      scanMessageId: row.scan_message_id,
      scannedAt,
      helloAt,
      dueAt,
    })
  }
  return { ok: true, data: rows }
}

/**
 * Take this scan's one item question: a compare-and-set on it still being
 * unclaimed. Also how a cancelled or given-up question is settled, with no
 * send, so no later tick looks at it again.
 */
export async function claimScanItemQuestion(
  supabase: AdminSupabaseClient,
  id: string,
  now: Date,
): Promise<ClaimResult> {
  const { data, error } = await supabase
    .from('instagram_scan_arrivals')
    .update({ item_question_claimed_at: now.toISOString() })
    .eq('id', id)
    .is('item_question_claimed_at', null)
    .select('id')
  if (error) return { status: 'failed', error: error.message }
  return (data ?? []).length === 1 ? { status: 'claimed' } : { status: 'lost' }
}

/**
 * Give the claim back when nothing reached the guest. Scoped to the claim's
 * own timestamp and to an unsent question, so it can only undo itself.
 */
export async function releaseScanItemQuestionClaim(
  supabase: AdminSupabaseClient,
  id: string,
  claimedAt: Date,
): Promise<void> {
  const { error } = await supabase
    .from('instagram_scan_arrivals')
    .update({ item_question_claimed_at: null })
    .eq('id', id)
    .eq('item_question_claimed_at', claimedAt.toISOString())
    .is('item_question_sent_at', null)
  if (error) {
    logger.warn('[scan-item-question] claim release failed', {
      scanArrivalId: id,
      error: error.message,
    })
  }
}

/** The question reached the guest. */
export async function markScanItemQuestionSent(
  supabase: AdminSupabaseClient,
  id: string,
  sentAt: Date,
): Promise<void> {
  const { error } = await supabase
    .from('instagram_scan_arrivals')
    .update({ item_question_sent_at: sentAt.toISOString() })
    .eq('id', id)
  if (error) {
    logger.warn('[scan-item-question] sent stamp failed', {
      scanArrivalId: id,
      error: error.message,
    })
  }
}

/**
 * The guest's newest still-owed item question, for the warm close to wait
 * on (`scan_question_pending`). Owed means: greeted, due time set, unclaimed,
 * and not yet past its max age. Whether the guest has written since its hello
 * is the caller's to check, because that cancels it.
 */
export async function loadOwedScanItemQuestion(
  supabase: AdminSupabaseClient,
  venueId: string,
  guestId: string,
  dueNoEarlierThan: Date,
): Promise<StoreResult<{ helloAt: Date } | null>> {
  const { data, error } = await supabase
    .from('instagram_scan_arrivals')
    .select('resolved_at')
    .eq('venue_id', venueId)
    .eq('guest_id', guestId)
    .eq('outcome', 'greeted')
    .is('item_question_claimed_at', null)
    .gte('item_question_due_at', dueNoEarlierThan.toISOString())
    .order('item_question_due_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (error) return { ok: false, error: error.message }
  const helloAt = dateOrNull(data?.resolved_at ?? null)
  return { ok: true, data: helloAt === null ? null : { helloAt } }
}

/**
 * Has the guest sent anything since this instant? A real message: a scan row
 * carries no provider message id, so a second scan is not the guest writing.
 * Fails CLOSED to true, the direction instagram-scan-greeting.ts takes: the
 * cost is one question not asked, never one asked over them.
 */
export async function guestHasWrittenSince(
  supabase: AdminSupabaseClient,
  venueId: string,
  guestId: string,
  since: Date,
): Promise<boolean> {
  const { data, error } = await supabase
    .from('messages')
    .select('id')
    .eq('venue_id', venueId)
    .eq('guest_id', guestId)
    .eq('direction', 'inbound')
    .not('provider_message_id', 'is', null)
    .gte('created_at', since.toISOString())
    .limit(1)
    .maybeSingle()
  if (error) {
    logger.warn(
      '[scan-item-question] inbound-since read failed; reading as written',
      {
        venueId,
        guestId,
        error: error.message,
      },
    )
    return true
  }
  return data !== null
}

/** The guest's newest greeted receipt scan, as a reply turn sees it. */
export interface ScanOrderVisit {
  id: string
  scanMessageId: string | null
  scannedAt: Date
  helloAt: Date
  itemQuestionSentAt: Date | null
}

/**
 * TAC-588: the guest's newest greeted scan whose hello complimented a bound
 * order. `item_question_due_at` is set on exactly those rows (it is written
 * when such a hello goes), which is what makes it the marker. Null when there
 * is none. Returns the error so the caller picks the direction.
 */
export async function loadScanOrderVisit(
  supabase: AdminSupabaseClient,
  venueId: string,
  guestId: string,
): Promise<StoreResult<ScanOrderVisit | null>> {
  const { data, error } = await supabase
    .from('instagram_scan_arrivals')
    .select(
      'id, scan_message_id, scanned_at, resolved_at, item_question_sent_at',
    )
    .eq('venue_id', venueId)
    .eq('guest_id', guestId)
    .eq('outcome', 'greeted')
    .not('item_question_due_at', 'is', null)
    .order('scanned_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (error) return { ok: false, error: error.message }
  if (!data) return { ok: true, data: null }
  const scannedAt = dateOrNull(data.scanned_at)
  const helloAt = dateOrNull(data.resolved_at)
  if (scannedAt === null || helloAt === null) return { ok: true, data: null }
  return {
    ok: true,
    data: {
      id: data.id,
      scanMessageId: data.scan_message_id,
      scannedAt,
      helloAt,
      itemQuestionSentAt: dateOrNull(data.item_question_sent_at),
    },
  }
}
