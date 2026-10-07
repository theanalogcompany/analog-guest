import { createAdminClient } from '@/lib/db/admin'
import { logger } from '@/lib/observability/logger'
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

// How many of a guest's scans to read when working out which days they
// scanned. A candidate visit sits inside the 90-day visit window, and one
// greeting per guest per day bounds the rows that matter well below this.
const SCAN_DAY_LOOKUP_LIMIT = 200

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
 */
export function retractedInConversation(
  rows: readonly Pick<ReportedVisitRow, 'retracted_at'>[],
  now: Date,
  conversationWindowMs: number,
): boolean {
  return rows.some(
    (row) =>
      row.retracted_at !== null &&
      withinWindow(row.retracted_at, now, conversationWindowMs),
  )
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
  const { data, error } = await supabase
    .from('instagram_scan_arrivals')
    .select('scanned_at')
    .eq('venue_id', input.venueId)
    .eq('guest_id', input.guestId)
    .order('scanned_at', { ascending: false })
    .limit(SCAN_DAY_LOOKUP_LIMIT)
  if (error) {
    logger.warn(
      '[agent] scan days unreadable; no reported visit is retractable this turn',
      { venueId: input.venueId, guestId: input.guestId, error: error.message },
    )
    return null
  }
  const keys = new Set<string>()
  if (input.createdVia === 'qr_scan') {
    keys.add(venueLocalDayKey(input.timezone, input.createdAt))
  }
  for (const row of data ?? []) {
    const scannedAt = new Date(row.scanned_at)
    if (!Number.isFinite(scannedAt.getTime())) continue
    keys.add(venueLocalDayKey(input.timezone, scannedAt))
  }
  return keys
}

export type RetractReportedVisitsOutcome =
  | { kind: 'nothing_to_retract' }
  | {
      kind: 'retracted'
      transactionIds: string[]
      /** What guests.last_visit_at was recomputed to; null when no visit is left. */
      lastVisitAt: string | null
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
 * this is the only place it can move back. It is recomputed from the newest
 * visit still standing, and written only when the cache sits at or after the
 * earliest retracted visit AND ahead of that newest standing one. A cache that
 * already points at a later, real visit is left exactly as it is, precision
 * included. A failed recompute is logged and swallowed: the transaction rows
 * are the record and are already correct.
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

    const { data: newest, error: newestError } = await supabase
      .from('transactions')
      .select('occurred_at, occurred_at_precision')
      .eq('venue_id', ctx.venue.id)
      .eq('guest_id', ctx.guest.id)
      .is('retracted_at', null)
      .order('occurred_at', { ascending: false })
      .limit(1)
      .maybeSingle()
    const transactionIds = retracted.map((r) => r.id)
    if (newestError) {
      logger.warn(
        '[agent] retracted a reported visit but could not recompute last_visit_at',
        { guestId: ctx.guest.id, error: newestError.message },
      )
      return { kind: 'retracted', transactionIds, lastVisitAt: null }
    }

    const earliestRetracted = retracted
      .map((r) => r.occurred_at)
      .reduce((min, iso) =>
        new Date(iso).getTime() < new Date(min).getTime() ? iso : min,
      )
    const lastVisitAt = newest?.occurred_at ?? null
    const walkBack = supabase
      .from('guests')
      .update({
        last_visit_at: lastVisitAt,
        last_visit_precision: newest?.occurred_at_precision ?? null,
      })
      .eq('id', ctx.guest.id)
      .gte('last_visit_at', earliestRetracted)
    const { error: guestError } = await (lastVisitAt === null
      ? walkBack
      : walkBack.gt('last_visit_at', lastVisitAt))
    if (guestError) {
      logger.warn(
        '[agent] retracted a reported visit but last_visit_at update failed',
        { guestId: ctx.guest.id, error: guestError.message },
      )
    }

    return { kind: 'retracted', transactionIds, lastVisitAt }
  } catch (e) {
    return {
      kind: 'failed',
      error: e instanceof Error ? e.message : String(e),
    }
  }
}
