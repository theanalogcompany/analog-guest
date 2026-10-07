import { createAdminClient } from '@/lib/db/admin'
import { logger } from '@/lib/observability/logger'
import {
  loadInstagramScanInstants,
  scanVisitInstants,
} from '@/lib/recognition/load-scan-visits'
import { extractRecentVisits } from './extract-recent-visits'
import { venueLocalDayKey } from './extract-reported-order'
import type { RuntimeContext } from './types'
import type { Json } from '@/db/types'

// TAC-573: a guest can take back a visit they told us about.
//
// On 2026-10-06 a guest wrote "my latte was cold", which recorded a visit, and
// then "actually I've never been here". The reply claimed there was "no record
// on our end" (false: the visit was logged), bolted a name ask on, and left the
// visit counted. Ruled the same day:
//
//   1. A contradiction gets ONE gentle check, in the guest's own words.
//   2. If they confirm, believe them, keep any open offer, and mark the visit
//      retracted: the row is kept and stops counting.
//   3. If they say they have been after all, nothing changes.
//   4. Only a visit the guest reported, in this conversation, can be retracted.
//
// HOW IT IS DETECTED. The generation model reports it in
// `reportedVisitCorrection` ('none' | 'checking' | 'retracted'), the same
// self-report shape as complaintIntent and cancelsCommitmentId. The model that
// writes the gentle check is the one that knows it asked, and the chat history
// carries that between the two turns, so there is no state of ours to keep. It
// is deliberately NOT a classifier category: both classifier arms would have to
// learn it, and the category set is a CHECK on `messages`.
//
// WHAT CODE DECIDES, because a self-report is not trusted alone (TAC-350).
// The model is only ever shown, and can only ever retract, the rows
// selectRetractableVisits returns:
//
//   - a guest-reported source. RETRACTABLE_SOURCES is also migration 072's
//     CHECK, so a POS row cannot carry retracted_at whatever any code does;
//   - reported in THIS conversation: created inside ctx.conversationWindowMs,
//     the one definition of "the same conversation" (TAC-380 ruling 1);
//   - not on a day the guest scanned. Ruled 2026-10-07: a scan is the guest
//     standing at the counter, so a visit on a venue-local day with a scan on
//     file is scan-confirmed and stays. The agent still believes them in
//     conversation; the row is simply not offered for retraction, so the block
//     never renders and the field is forced to 'none'.
//
// NOT ENFORCED IN CODE, stated rather than discovered: that the gentle check
// was actually asked before a 'retracted' is honoured. That ordering lives in
// the prompt. The failure directions are why that is acceptable. A false
// retraction keeps the row and is undone by nulling retracted_at; a missed one
// is exactly the behaviour before this ticket.
//
// Retraction is independent of what happened to the reply. What the guest told
// us is true whether our answer was sent, queued or dropped, the same
// separation arrivalCapture already makes (TAC-296).

export const RETRACTABLE_SOURCES = [
  'guest_reported',
  'guest_reported_ongoing',
] as const

/** The columns of a `transactions` row this module reads. */
export interface ReportedVisitRow {
  id: string
  source: string
  occurred_at: string
  created_at: string
  raw_data: Json | null
  retracted_at: string | null
}

export interface RetractableReportedVisit {
  transactionId: string
  occurredAt: Date
  /** Item names as stored; empty when the row's line items do not parse. */
  items: string[]
}

type SupabaseAdminClient = ReturnType<typeof createAdminClient>

function withinWindow(iso: string, now: Date, windowMs: number): boolean {
  const elapsed = now.getTime() - new Date(iso).getTime()
  return Number.isFinite(elapsed) && elapsed >= 0 && elapsed <= windowMs
}

/**
 * The visits this guest could take back on this turn. Pure.
 *
 * `scanDayKeys` is null when the guest's scans could not be read, and that
 * fails CLOSED to nothing retractable: an unreadable scan history is not
 * evidence the guest never scanned, and the cost of the miss is a visit that
 * keeps counting, which is where things stood before this ticket.
 */
export function selectRetractableVisits(
  rows: readonly ReportedVisitRow[],
  input: {
    now: Date
    conversationWindowMs: number
    timezone: string
    scanDayKeys: ReadonlySet<string> | null
  },
): RetractableReportedVisit[] {
  const { scanDayKeys } = input
  if (scanDayKeys === null) return []
  const retractable: RetractableReportedVisit[] = []
  for (const row of rows) {
    if (row.retracted_at !== null) continue
    if (!(RETRACTABLE_SOURCES as readonly string[]).includes(row.source)) {
      continue
    }
    if (!withinWindow(row.created_at, input.now, input.conversationWindowMs)) {
      continue
    }
    const occurredAt = new Date(row.occurred_at)
    if (!Number.isFinite(occurredAt.getTime())) continue
    if (scanDayKeys.has(venueLocalDayKey(input.timezone, occurredAt))) continue
    const [visit] = extractRecentVisits([row], input.now, Infinity)
    retractable.push({
      transactionId: row.id,
      occurredAt,
      items: visit?.items ?? [],
    })
  }
  return retractable
}

/**
 * Did this guest take a visit back earlier in this conversation?
 *
 * Ruled 2026-10-07: after a retraction, `understand_order` does not reopen in
 * that conversation. With the visit no longer counted the intention derives
 * open again, and "what did you get?" is the wrong thing to ask someone who
 * just said they have never been in. It is free to come back in a later one.
 *
 * NO LOWER BOUND, unlike a row's created_at. `retracted_at` is wall-clock at
 * the write, which lands after the retracting turn generated, while `now` is
 * the receipt time of the message being answered. A message the guest sent
 * while that turn was still generating was received BEFORE the stamp, and it
 * is the very next thing we answer, so a retraction "in the future" of this
 * message still belongs to this conversation.
 */
export function retractedInConversation(
  rows: readonly Pick<ReportedVisitRow, 'retracted_at'>[],
  now: Date,
  conversationWindowMs: number,
): boolean {
  return rows.some((row) => {
    if (row.retracted_at === null) return false
    const elapsed = now.getTime() - new Date(row.retracted_at).getTime()
    return Number.isFinite(elapsed) && elapsed <= conversationWindowMs
  })
}

/**
 * Every venue-local day this guest has a scan on file for, or null when that
 * could not be read.
 *
 * Two sources, because a scan is recorded in two places: enrollment by the QR
 * sign (`guests.created_via = 'qr_scan'`, dated by created_at), and every
 * Instagram scan since (`instagram_scan_arrivals.scanned_at`).
 */
export async function loadScanDayKeys(
  supabase: SupabaseAdminClient,
  input: {
    venueId: string
    guestId: string
    timezone: string
    createdVia: string
    createdAt: Date
  },
): Promise<Set<string> | null> {
  // TAC-575: read through the reader recognition counts visits with, so "a day
  // the guest scanned" is one definition (lib/recognition/load-scan-visits.ts).
  // It never throws: a thrown read comes back as an error, which matters here
  // because a throw would surface in buildRuntimeContext and cost the guest
  // their reply over a question that only decides whether a visit may be taken
  // back.
  const scans = await loadInstagramScanInstants(supabase, {
    venueId: input.venueId,
    guestId: input.guestId,
  })
  if (!scans.ok) {
    logger.warn(
      '[agent] scan days unreadable; no reported visit is retractable this turn',
      {
        venueId: input.venueId,
        guestId: input.guestId,
        error: scans.error,
      },
    )
    return null
  }
  const keys = new Set<string>()
  for (const instant of scanVisitInstants({
    createdVia: input.createdVia,
    createdAt: input.createdAt,
    instagramScans: scans.data,
  })) {
    keys.add(venueLocalDayKey(input.timezone, instant))
  }
  return keys
}

export type RetractReportedVisitsOutcome =
  | { kind: 'nothing_to_retract' }
  | {
      kind: 'retracted'
      transactionIds: string[]
      /**
       * What became of `guests.last_visit_at`:
       *   'walked_back'  it pointed at a retracted visit and was rewritten
       *   'left'         it pointed elsewhere, or a later writer got there first
       *   'unreadable'   a read or the write failed; the cache may still point
       *                  at the retracted visit until the next report moves it
       */
      lastVisit: 'walked_back' | 'left' | 'unreadable'
    }
  | { kind: 'failed'; error: string }

/**
 * Mark this turn's retractable visits retracted and walk `guests.last_visit_at`
 * back off them. Never throws.
 *
 * The UPDATE repeats the scope in its own filters (venue, guest, source,
 * still un-retracted) rather than trusting the ids alone, so a second run for
 * the same turn retracts nothing and reports `nothing_to_retract`.
 *
 * `last_visit_at` is the one cache every other writer only moves FORWARD, so
 * this is the only place it can move back. It moves only when BOTH hold:
 *
 *   - the cache sits on the same venue-local day as a retracted visit. Same
 *     day rather than same instant, because a later report merged into an
 *     ongoing row advances the cache to the REPORT's time, not the row's
 *     occurred_at, so the instants need not match. A cache on any other day
 *     belongs to a different visit and is not touched;
 *   - the newest visit still standing is earlier than the cache. A cache that
 *     already equals or trails it is left alone, precision included.
 *
 * It is then rewritten to that newest standing visit, or to null when none is
 * left, compare-and-set on the value that was read so a concurrent forward
 * write wins. One accepted imprecision: a standing visit on the SAME day as
 * the retracted one can see the cache move from a later merged time back to
 * its own occurred_at and precision. Every consumer of the cache is
 * day-granular, so the visit it points at is still the right one.
 *
 * A failure in this half is logged and reported as 'unreadable', never as a
 * failed retraction: the transaction rows are the record and are already
 * correct.
 */
export async function retractReportedVisits(
  ctx: RuntimeContext,
): Promise<RetractReportedVisitsOutcome> {
  try {
    const ids = ctx.retractableReportedVisits.map((v) => v.transactionId)
    if (ids.length === 0) return { kind: 'nothing_to_retract' }

    const supabase = createAdminClient()
    const { data: retracted, error: retractError } = await supabase
      .from('transactions')
      .update({ retracted_at: new Date().toISOString() })
      .in('id', ids)
      .eq('venue_id', ctx.venue.id)
      .eq('guest_id', ctx.guest.id)
      .in('source', [...RETRACTABLE_SOURCES])
      .is('retracted_at', null)
      .select('id, occurred_at')
    if (retractError) return { kind: 'failed', error: retractError.message }
    if (!retracted || retracted.length === 0) {
      return { kind: 'nothing_to_retract' }
    }
    const transactionIds = retracted.map((r) => r.id)

    const [guestResult, newestResult] = await Promise.all([
      supabase
        .from('guests')
        .select('last_visit_at')
        .eq('id', ctx.guest.id)
        .maybeSingle(),
      supabase
        .from('transactions')
        .select('occurred_at, occurred_at_precision')
        .eq('venue_id', ctx.venue.id)
        .eq('guest_id', ctx.guest.id)
        .is('retracted_at', null)
        .order('occurred_at', { ascending: false })
        .limit(1)
        .maybeSingle(),
    ])
    if (guestResult.error || newestResult.error) {
      logger.warn(
        '[agent] retracted a reported visit but could not read last_visit_at',
        {
          guestId: ctx.guest.id,
          error: (guestResult.error ?? newestResult.error)?.message,
        },
      )
      return { kind: 'retracted', transactionIds, lastVisit: 'unreadable' }
    }

    const cached = guestResult.data?.last_visit_at ?? null
    const newest = newestResult.data
    const timezone = ctx.venue.timezone
    const pointsAtRetracted =
      cached !== null &&
      retracted.some(
        (r) =>
          venueLocalDayKey(timezone, new Date(r.occurred_at)) ===
          venueLocalDayKey(timezone, new Date(cached)),
      )
    const standingIsEarlier =
      newest === null ||
      (cached !== null &&
        new Date(newest.occurred_at).getTime() < new Date(cached).getTime())
    if (cached === null || !pointsAtRetracted || !standingIsEarlier) {
      return { kind: 'retracted', transactionIds, lastVisit: 'left' }
    }

    const { data: walked, error: walkError } = await supabase
      .from('guests')
      .update({
        last_visit_at: newest?.occurred_at ?? null,
        last_visit_precision: newest?.occurred_at_precision ?? null,
      })
      .eq('id', ctx.guest.id)
      .eq('last_visit_at', cached)
      .select('id')
    if (walkError) {
      logger.warn(
        '[agent] retracted a reported visit but last_visit_at update failed',
        { guestId: ctx.guest.id, error: walkError.message },
      )
      return { kind: 'retracted', transactionIds, lastVisit: 'unreadable' }
    }
    return {
      kind: 'retracted',
      transactionIds,
      lastVisit: (walked ?? []).length === 1 ? 'walked_back' : 'left',
    }
  } catch (e) {
    return {
      kind: 'failed',
      error: e instanceof Error ? e.message : String(e),
    }
  }
}
