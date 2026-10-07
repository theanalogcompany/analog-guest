// TAC-575: the reads and writes behind the same-visit check-in.
//
// Split from visit-checkin.ts, which is the pure half. The table is
// `visit_checkins` (migration 073); its header says what a row means and which
// columns later parts of the ticket own.

import type { SupabaseClient } from '@supabase/supabase-js'

import type { Database } from '@/db/types'
import type { VisitCheckin, VisitCheckinAnswer } from './visit-checkin'

type AdminSupabaseClient = SupabaseClient<Database>

export type StoreResult<T> =
  { ok: true; data: T } | { ok: false; error: string }

const UNIQUE_VIOLATION = '23505'

const CHECKIN_COLUMNS =
  'id, venue_local_date, ordered_at, asked_at, answer, answered_at'

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
  return {
    ok: true,
    data: {
      id: data.id,
      venueLocalDate: data.venue_local_date,
      orderedAt: new Date(data.ordered_at),
      askedAt: new Date(data.asked_at),
      answer: isAnswer(data.answer) ? data.answer : null,
      answeredAt: data.answered_at ? new Date(data.answered_at) : null,
    },
  }
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
