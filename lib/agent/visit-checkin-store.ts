// TAC-575: the reads and writes behind the same-visit check-in.
//
// Split from visit-checkin.ts, which is the pure half. The table is
// `visit_checkins` (migration 073); its header says what a row means and which
// columns later parts of the ticket own.

import type { SupabaseClient } from '@supabase/supabase-js'

import type { Database } from '@/db/types'
import { DELIVERED_OUTBOUND_STATUSES } from './group-responses'
import type { VisitCheckin, VisitCheckinAnswer } from './visit-checkin'

type AdminSupabaseClient = SupabaseClient<Database>

export type StoreResult<T> =
  { ok: true; data: T } | { ok: false; error: string }

const UNIQUE_VIOLATION = '23505'

const CHECKIN_COLUMNS =
  'id, venue_local_date, ordered_at, asked_at, answer, answered_at, checkback_claimed_at, checkback_sent_at'

interface CheckinRow {
  id: string
  venue_local_date: string
  ordered_at: string
  asked_at: string
  answer: string | null
  answered_at: string | null
  checkback_claimed_at: string | null
  checkback_sent_at: string | null
}

function toVisitCheckin(row: CheckinRow): VisitCheckin {
  return {
    id: row.id,
    venueLocalDate: row.venue_local_date,
    orderedAt: new Date(row.ordered_at),
    askedAt: new Date(row.asked_at),
    answer: isAnswer(row.answer) ? row.answer : null,
    answeredAt: row.answered_at ? new Date(row.answered_at) : null,
    checkbackClaimedAt: row.checkback_claimed_at
      ? new Date(row.checkback_claimed_at)
      : null,
    checkbackSentAt: row.checkback_sent_at
      ? new Date(row.checkback_sent_at)
      : null,
  }
}

function isAnswer(value: string | null): value is VisitCheckinAnswer {
  return value === 'good' || value === 'bad' || value === 'not_yet'
}

/**
 * This guest's check-in for one venue-local day, or null when they have not
 * been asked on it.
 *
 * Returns the error rather than swallowing it. "Not asked yet" and "could not
 * tell" lead to opposite decisions at the one caller that arms the question,
 * so they must not arrive as the same value.
 */
export async function loadVisitCheckin(
  supabase: AdminSupabaseClient,
  venueId: string,
  guestId: string,
  venueLocalDate: string,
): Promise<StoreResult<VisitCheckin | null>> {
  const { data, error } = await supabase
    .from('visit_checkins')
    .select(CHECKIN_COLUMNS)
    .eq('venue_id', venueId)
    .eq('guest_id', guestId)
    .eq('venue_local_date', venueLocalDate)
    .maybeSingle()
  if (error) return { ok: false, error: error.message }
  if (!data) return { ok: true, data: null }
  return { ok: true, data: toVisitCheckin(data) }
}

export type RecordAskedResult =
  /** This write is the visit's check-in. */
  | { ok: true; data: 'recorded' }
  /** A row for this guest and day already exists (the unique index). */
  | { ok: true; data: 'already_asked' }
  | { ok: false; error: string }

/**
 * Open this visit's check-in: the question reached the guest, or their order
 * message already answered it (`answer` set, see orderTurnVerdict).
 *
 * A plain INSERT with no ON CONFLICT, so a second one in a visit surfaces as
 * 23505 instead of quietly overwriting the first.
 */
export async function recordVisitCheckinAsked(
  supabase: AdminSupabaseClient,
  args: {
    venueId: string
    guestId: string
    venueLocalDate: string
    orderMessageId: string | null
    orderedAt: Date
    askedAt: Date
    /** Only when the order message itself said how it is. */
    answer?: VisitCheckinAnswer
  },
): Promise<RecordAskedResult> {
  try {
    const { error } = await supabase.from('visit_checkins').insert({
      venue_id: args.venueId,
      guest_id: args.guestId,
      venue_local_date: args.venueLocalDate,
      order_message_id: args.orderMessageId,
      ordered_at: args.orderedAt.toISOString(),
      asked_at: args.askedAt.toISOString(),
      ...(args.answer === undefined
        ? {}
        : { answer: args.answer, answered_at: args.askedAt.toISOString() }),
    })
    if (!error) return { ok: true, data: 'recorded' }
    if (error.code === UNIQUE_VIOLATION)
      return { ok: true, data: 'already_asked' }
    return { ok: false, error: error.message }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

export type RecordAnswerResult =
  | { ok: true; data: 'recorded' }
  /** The row moved under us; another turn wrote an answer first. */
  | { ok: true; data: 'superseded' }
  | { ok: false; error: string }

/**
 * Write an answer, as a compare-and-set on the answer the caller read.
 *
 * The caller decided what to write from `expected` (nextCheckinAnswer), so the
 * write only lands if the row still says that. Two coalesced turns racing to
 * record "not yet" over "bad" is the case this refuses.
 */
export async function recordVisitCheckinAnswer(
  supabase: AdminSupabaseClient,
  args: {
    id: string
    venueId: string
    guestId: string
    expected: VisitCheckinAnswer | null
    answer: VisitCheckinAnswer
    answeredAt: Date
  },
): Promise<RecordAnswerResult> {
  try {
    const base = supabase
      .from('visit_checkins')
      .update({
        answer: args.answer,
        answered_at: args.answeredAt.toISOString(),
      })
      .eq('id', args.id)
      .eq('venue_id', args.venueId)
      .eq('guest_id', args.guestId)
    const guarded =
      args.expected === null
        ? base.is('answer', null)
        : base.eq('answer', args.expected)
    const { data, error } = await guarded.select('id')
    if (error) return { ok: false, error: error.message }
    return {
      ok: true,
      data: (data ?? []).length === 1 ? 'recorded' : 'superseded',
    }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

// ---------------------------------------------------------------------------
// The check-back (TAC-575, the timed half)
// ---------------------------------------------------------------------------

/** How many rows one tick looks at. */
export const CHECKBACK_SCAN_LIMIT = 50

/** A check-in the timer has to consider, with who it belongs to. */
export interface DueVisitCheckback {
  venueId: string
  guestId: string
  checkin: VisitCheckin
}

/**
 * Check-ins still owed a check-back whose order is old enough for it and not
 * too old to bother, oldest first.
 *
 * The predicate is the partial index's own (migration 073's
 * idx_visit_checkins_checkback_pending), so this stays an index scan. The two
 * time bounds are the timer's delay and its max age; everything else the
 * processor re-checks per row on `now`, because nothing here is settled early.
 */
export async function loadDueVisitCheckbacks(
  supabase: AdminSupabaseClient,
  orderedNoLaterThan: Date,
  orderedNoEarlierThan: Date,
  limit: number = CHECKBACK_SCAN_LIMIT,
): Promise<StoreResult<DueVisitCheckback[]>> {
  const { data, error } = await supabase
    .from('visit_checkins')
    .select(`venue_id, guest_id, ${CHECKIN_COLUMNS}`)
    .is('checkback_claimed_at', null)
    .or('answer.is.null,answer.eq.not_yet')
    .lte('ordered_at', orderedNoLaterThan.toISOString())
    .gte('ordered_at', orderedNoEarlierThan.toISOString())
    .order('ordered_at', { ascending: true })
    .limit(limit)
  if (error) return { ok: false, error: error.message }
  return {
    ok: true,
    data: (data ?? []).map((row) => ({
      venueId: row.venue_id,
      guestId: row.guest_id,
      checkin: toVisitCheckin(row),
    })),
  }
}

export type CheckbackClaimResult =
  /** This caller owns the visit's one check-back. */
  | { status: 'claimed' }
  /** Someone else took it, or the guest answered in the meantime. */
  | { status: 'lost' }
  | { status: 'failed'; error: string }

/**
 * Take this visit's one check-back.
 *
 * A compare-and-set on BOTH things that make it owed: nobody has claimed it,
 * and the guest still has not said good or bad. The second half is what stops
 * a check-back going out a moment after "it's great" landed on another turn.
 * `sent` also stamps checkback_sent_at, for the reply that has already carried
 * the question by the time it claims.
 */
export async function claimVisitCheckback(
  supabase: AdminSupabaseClient,
  args: {
    id: string
    venueId: string
    guestId: string
    now: Date
    /** True when the question has already reached the guest. */
    sent: boolean
  },
): Promise<CheckbackClaimResult> {
  try {
    const at = args.now.toISOString()
    const { data, error } = await supabase
      .from('visit_checkins')
      .update(
        args.sent
          ? { checkback_claimed_at: at, checkback_sent_at: at }
          : { checkback_claimed_at: at },
      )
      .eq('id', args.id)
      .eq('venue_id', args.venueId)
      .eq('guest_id', args.guestId)
      .is('checkback_claimed_at', null)
      .or('answer.is.null,answer.eq.not_yet')
      .select('id')
    if (error) return { status: 'failed', error: error.message }
    return (data ?? []).length === 1
      ? { status: 'claimed' }
      : { status: 'lost' }
  } catch (e) {
    return {
      status: 'failed',
      error: e instanceof Error ? e.message : String(e),
    }
  }
}

/**
 * Give back a claim whose check-back never reached the guest, scoped to the
 * exact timestamp this caller wrote so it cannot release someone else's.
 */
export async function releaseVisitCheckbackClaim(
  supabase: AdminSupabaseClient,
  args: { id: string; venueId: string; guestId: string; claimedAt: Date },
): Promise<void> {
  const { error } = await supabase
    .from('visit_checkins')
    .update({ checkback_claimed_at: null })
    .eq('id', args.id)
    .eq('venue_id', args.venueId)
    .eq('guest_id', args.guestId)
    .eq('checkback_claimed_at', args.claimedAt.toISOString())
    .is('checkback_sent_at', null)
  if (error) {
    console.error('[visit-checkback] claim release failed', {
      id: args.id,
      error: error.message,
    })
  }
}

/** Record that the claimed check-back reached the guest. */
export async function markVisitCheckbackSent(
  supabase: AdminSupabaseClient,
  args: { id: string; venueId: string; guestId: string; now: Date },
): Promise<void> {
  const { error } = await supabase
    .from('visit_checkins')
    .update({ checkback_sent_at: args.now.toISOString() })
    .eq('id', args.id)
    .eq('venue_id', args.venueId)
    .eq('guest_id', args.guestId)
    .is('checkback_sent_at', null)
  if (error) {
    // Logged, not thrown: the message is out. A missing stamp means the warm
    // close may still follow an unanswered check-back, which is visible here.
    console.error('[visit-checkback] sent stamp failed', {
      id: args.id,
      error: error.message,
    })
  }
}

/** The newest message in a guest's thread, as the check-back timer needs it. */
export interface NewestThreadMessage {
  id: string
  direction: 'inbound' | 'outbound'
  createdAt: Date
  /** An outbound that reached the guest. Always false for an inbound. */
  reachedGuest: boolean
}

/**
 * The newest message for this guest at this venue, whatever it is.
 *
 * WHATEVER IT IS, for the reason loadWarmCloseCandidates gives: filtering to
 * delivered outbound rows in SQL would silently promote an older reply of ours
 * to "our last word" when the guest has in fact written since, or when a draft
 * is sitting in the operator's queue. The newest row decides, and the caller
 * reads what kind it is. A counter re-scan is an inbound row too, and
 * correctly counts as the guest acting.
 */
export async function loadNewestThreadMessage(
  supabase: AdminSupabaseClient,
  venueId: string,
  guestId: string,
): Promise<StoreResult<NewestThreadMessage | null>> {
  const { data, error } = await supabase
    .from('messages')
    .select('id, direction, status, review_state, created_at')
    .eq('venue_id', venueId)
    .eq('guest_id', guestId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (error) return { ok: false, error: error.message }
  if (!data) return { ok: true, data: null }
  const outbound = data.direction === 'outbound'
  return {
    ok: true,
    data: {
      id: data.id,
      direction: outbound ? 'outbound' : 'inbound',
      createdAt: new Date(data.created_at),
      reachedGuest:
        outbound &&
        data.review_state !== 'pending' &&
        DELIVERED_OUTBOUND_STATUSES.has(data.status),
    },
  }
}
