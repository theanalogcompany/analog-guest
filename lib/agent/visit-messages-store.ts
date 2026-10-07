// TAC-578: the reads and writes behind the messages a visit ends in.
//
// Split from visit-messages.ts, which is the pure half.
//
// `visit_messages` (migration 076) holds one row per unprompted message tied to
// a visit. THE INSERT IS THE CLAIM: a plain insert with no ON CONFLICT, taken
// immediately before generating, so a second tick surfaces as 23505 instead of
// quietly sharing the row. Claim before the side effect, the house rule
// (instagram_scan_arrivals, followup_log, visit_checkins).
//
// Every read here returns its error rather than swallowing it. "Nothing on
// file" and "could not tell" lead to opposite decisions for an unprompted
// message, and the callers all take the second as "send nothing this tick".

import type { SupabaseClient } from '@supabase/supabase-js'

import type { Database } from '@/db/types'
import { venueLocalDate } from '@/lib/schemas/venue-hours'
import { extractRecentVisits, type Visit } from './extract-recent-visits'
import { DELIVERED_OUTBOUND_STATUSES } from './group-responses'
import { loadLastGuestActionAt } from '@/lib/messaging/instagram/window'
import {
  PRIOR_CHECKIN_LIMIT,
  resolvePostVisitSlot,
  type PostVisitSlot,
  type VisitMessageKind,
} from './visit-messages'
import type { WarmCloseBlockerRow } from './warm-close'

type AdminSupabaseClient = SupabaseClient<Database>

export type StoreResult<T> =
  { ok: true; data: T } | { ok: false; error: string }

/** Postgres unique-violation. */
const UNIQUE_VIOLATION = '23505'

/** How many scan rows one tick reads per venue. */
export const VISIT_SCAN_LIMIT = 200

/** How far back a guest's orders are read to find their visit days. */
const ORDER_LOOKBACK_DAYS = 90

/** How many of a guest's orders are read. */
const ORDER_ROW_LIMIT = 60

/** How many rows of one visit's thread are read. */
const VISIT_THREAD_ROW_LIMIT = 60

// ---------------------------------------------------------------------------
// The claim
// ---------------------------------------------------------------------------

export type VisitMessageClaim =
  | { status: 'claimed'; id: string }
  /** Another tick owns it, or this visit already has one of this kind. */
  | { status: 'lost' }
  | { status: 'failed'; error: string }

/** Claim one message for one visit. See the module header. */
export async function claimVisitMessage(
  supabase: AdminSupabaseClient,
  args: {
    venueId: string
    guestId: string
    venueLocalDate: string
    kind: VisitMessageKind
    slot: PostVisitSlot | null
    now: Date
  },
): Promise<VisitMessageClaim> {
  try {
    const { data, error } = await supabase
      .from('visit_messages')
      .insert({
        venue_id: args.venueId,
        guest_id: args.guestId,
        venue_local_date: args.venueLocalDate,
        kind: args.kind,
        slot: args.slot,
        claimed_at: args.now.toISOString(),
      })
      .select('id')
      .single()
    if (!error && data) return { status: 'claimed', id: data.id }
    if (error?.code === UNIQUE_VIOLATION) return { status: 'lost' }
    return { status: 'failed', error: error?.message ?? 'no row returned' }
  } catch (e) {
    return {
      status: 'failed',
      error: e instanceof Error ? e.message : String(e),
    }
  }
}

/**
 * Give back a claim whose message never reached the guest, so a later tick
 * inside the slot can try again. Deletes only a row still `claimed`: a row
 * that was settled in the meantime is somebody's record.
 */
export async function releaseVisitMessage(
  supabase: AdminSupabaseClient,
  args: { id: string; venueId: string; guestId: string },
): Promise<void> {
  try {
    const { error } = await supabase
      .from('visit_messages')
      .delete()
      .eq('id', args.id)
      .eq('venue_id', args.venueId)
      .eq('guest_id', args.guestId)
      .eq('outcome', 'claimed')
    if (error) {
      console.error('[visit-messages] claim release failed', {
        id: args.id,
        error: error.message,
      })
    }
  } catch (e) {
    console.error('[visit-messages] claim release threw', {
      id: args.id,
      error: e instanceof Error ? e.message : String(e),
    })
  }
}

/**
 * Settle a claimed row: it went out, it is on a card, or it was deliberately
 * not sent. Logs and carries on if the write fails; the message has already
 * gone, and the cost of a row left `claimed` is that this visit is not looked
 * at again, which is the safe direction.
 */
export async function settleVisitMessage(
  supabase: AdminSupabaseClient,
  args: {
    id: string
    venueId: string
    guestId: string
    outcome: 'sent' | 'queued' | 'skipped'
    messageId?: string | null
    sentAt?: Date
    angle?: string | null
    skipReason?: string
  },
): Promise<void> {
  try {
    const { error } = await supabase
      .from('visit_messages')
      .update({
        outcome: args.outcome,
        ...(args.messageId ? { message_id: args.messageId } : {}),
        ...(args.sentAt ? { sent_at: args.sentAt.toISOString() } : {}),
        ...(args.angle ? { angle: args.angle } : {}),
        ...(args.skipReason ? { skip_reason: args.skipReason } : {}),
      })
      .eq('id', args.id)
      .eq('venue_id', args.venueId)
      .eq('guest_id', args.guestId)
    if (error) {
      console.error('[visit-messages] settle failed', {
        id: args.id,
        outcome: args.outcome,
        error: error.message,
      })
    }
  } catch (e) {
    console.error('[visit-messages] settle threw', {
      id: args.id,
      error: e instanceof Error ? e.message : String(e),
    })
  }
}

// ---------------------------------------------------------------------------
// The due set
// ---------------------------------------------------------------------------

/** A guest's visit on one venue-local day. */
export interface VisitCandidate {
  guestId: string
  venueLocalDate: string
}

/**
 * Every guest who scanned at this venue on one of `dates`, once per day.
 *
 * A VISIT IS A COUNTER SCAN, the 2026-10-06 ruling's definition ("a detected
 * visit is a counter scan"), and the same rows recognition counts as visit
 * days. `instagram_scan_arrivals` can hold several rows for one guest and day,
 * so they are folded here.
 *
 * READ BY `scanned_at`, NOT BY `venue_local_date`. That column is nullable and
 * is written when a greeting is claimed, so a scan whose greeting never went
 * out has none, and it is as much a visit (lib/recognition/load-scan-visits.ts
 * reads the instant for the same reason). The day is derived here.
 */
export async function loadVisitCandidates(
  supabase: AdminSupabaseClient,
  venueId: string,
  timezone: string,
  dates: readonly string[],
  since: Date,
): Promise<StoreResult<VisitCandidate[]>> {
  if (dates.length === 0) return { ok: true, data: [] }
  const { data, error } = await supabase
    .from('instagram_scan_arrivals')
    .select('guest_id, scanned_at')
    .eq('venue_id', venueId)
    .gte('scanned_at', since.toISOString())
    .order('scanned_at', { ascending: false })
    .limit(VISIT_SCAN_LIMIT)
  if (error) return { ok: false, error: error.message }
  const seen = new Set<string>()
  const candidates: VisitCandidate[] = []
  for (const row of data ?? []) {
    const day = venueLocalDate(new Date(row.scanned_at), timezone)
    if (day === null || !dates.includes(day)) continue
    const key = `${row.guest_id}|${day}`
    if (seen.has(key)) continue
    seen.add(key)
    candidates.push({ guestId: row.guest_id, venueLocalDate: day })
  }
  return { ok: true, data: candidates }
}

/**
 * The `guest|date` keys that already have a thank-you or a check-in row, in
 * any outcome. One read per venue per tick, so a settled visit costs nothing
 * more.
 */
export async function loadSettledVisits(
  supabase: AdminSupabaseClient,
  venueId: string,
  dates: readonly string[],
): Promise<StoreResult<Set<string>>> {
  if (dates.length === 0) return { ok: true, data: new Set() }
  const { data, error } = await supabase
    .from('visit_messages')
    .select('guest_id, venue_local_date')
    .eq('venue_id', venueId)
    .in('venue_local_date', [...dates])
    .in('kind', ['first_visit_thanks', 'visit_checkin'])
  if (error) return { ok: false, error: error.message }
  return {
    ok: true,
    data: new Set(
      (data ?? []).map((r) => `${r.guest_id}|${r.venue_local_date}`),
    ),
  }
}

/** Does this visit have any row of this kind? The sign-off's "already sent". */
export async function hasVisitMessage(
  supabase: AdminSupabaseClient,
  args: {
    venueId: string
    guestId: string
    venueLocalDate: string
    kinds: readonly VisitMessageKind[]
  },
): Promise<StoreResult<boolean>> {
  const { data, error } = await supabase
    .from('visit_messages')
    .select('id')
    .eq('venue_id', args.venueId)
    .eq('guest_id', args.guestId)
    .eq('venue_local_date', args.venueLocalDate)
    .in('kind', [...args.kinds])
    .limit(1)
  if (error) return { ok: false, error: error.message }
  return { ok: true, data: (data ?? []).length > 0 }
}

// ---------------------------------------------------------------------------
// What the guest's record says
// ---------------------------------------------------------------------------

/** The guest facts every gate needs, in one read. */
export interface PostVisitGuestFacts {
  optedOutAt: Date | null
  instagramScopedId: string | null
  reviewAskedAt: Date | null
  createdVia: string
  createdAt: Date
}

export async function loadPostVisitGuestFacts(
  supabase: AdminSupabaseClient,
  venueId: string,
  guestId: string,
): Promise<StoreResult<PostVisitGuestFacts>> {
  const { data, error } = await supabase
    .from('guests')
    .select(
      'opted_out_at, instagram_scoped_id, review_asked_at, created_via, created_at',
    )
    .eq('id', guestId)
    .eq('venue_id', venueId)
    .maybeSingle()
  if (error) return { ok: false, error: error.message }
  if (!data) return { ok: false, error: `guest ${guestId} not found` }
  const date = (v: string | null) => (v ? new Date(v) : null)
  return {
    ok: true,
    data: {
      optedOutAt: date(data.opted_out_at),
      instagramScopedId: data.instagram_scoped_id ?? null,
      reviewAskedAt: date(data.review_asked_at),
      createdVia: data.created_via,
      createdAt: new Date(data.created_at),
    },
  }
}

/** Where a guest has been, by venue-local day. */
export interface GuestVisitRecord {
  /** Every venue-local day with a scan or a recorded order. */
  visitDays: string[]
  /** Recorded orders, newest first, each with the day it fell on. */
  orders: (Visit & { localDate: string })[]
}

/**
 * This guest's visit days and orders, from the sources recognition counts: the
 * Instagram scans, the enrolment itself when it was by the counter sign, and
 * recorded orders that have not been taken back (lib/recognition/load-signals.ts).
 *
 * NOT loadSignals itself, which returns counts over a fixed window and folds
 * today away for a reason of its own (a guest stays new on their first visit
 * day). This needs the days, to ask whether one came before another.
 */
export async function loadGuestVisitRecord(
  supabase: AdminSupabaseClient,
  args: {
    venueId: string
    guestId: string
    timezone: string
    createdVia: string
    createdAt: Date
    now: Date
  },
): Promise<StoreResult<GuestVisitRecord>> {
  const [scans, orders] = await Promise.all([
    supabase
      .from('instagram_scan_arrivals')
      .select('scanned_at')
      .eq('venue_id', args.venueId)
      .eq('guest_id', args.guestId)
      .order('scanned_at', { ascending: false })
      .limit(VISIT_SCAN_LIMIT),
    supabase
      .from('transactions')
      .select('occurred_at, raw_data')
      .eq('venue_id', args.venueId)
      .eq('guest_id', args.guestId)
      .is('retracted_at', null)
      .gte(
        'occurred_at',
        new Date(
          args.now.getTime() - ORDER_LOOKBACK_DAYS * 24 * 60 * 60 * 1000,
        ).toISOString(),
      )
      .order('occurred_at', { ascending: false })
      .limit(ORDER_ROW_LIMIT),
  ])
  if (scans.error) return { ok: false, error: scans.error.message }
  if (orders.error) return { ok: false, error: orders.error.message }

  const days = new Set<string>()
  for (const row of scans.data ?? []) {
    const day = venueLocalDate(new Date(row.scanned_at), args.timezone)
    if (day !== null) days.add(day)
  }
  if (args.createdVia === 'qr_scan') {
    const day = venueLocalDate(args.createdAt, args.timezone)
    if (day !== null) days.add(day)
  }
  const dated: (Visit & { localDate: string })[] = []
  for (const visit of extractRecentVisits(
    orders.data ?? [],
    args.now,
    ORDER_LOOKBACK_DAYS,
  )) {
    const day = venueLocalDate(visit.visitedAt, args.timezone)
    if (day === null) continue
    dated.push({ ...visit, localDate: day })
  }
  // An order with no readable items is still a day they were in.
  for (const row of orders.data ?? []) {
    const at = new Date(row.occurred_at)
    if (!Number.isFinite(at.getTime())) continue
    const day = venueLocalDate(at, args.timezone)
    if (day !== null) days.add(day)
  }
  return { ok: true, data: { visitDays: [...days], orders: dated } }
}

/** One visit's thread, oldest first, as complaintStanding reads it. */
export type VisitThreadRow = WarmCloseBlockerRow & {
  createdAt: Date
  reviewReason: string | null
}

export async function loadVisitThread(
  supabase: AdminSupabaseClient,
  venueId: string,
  guestId: string,
  since: Date,
): Promise<StoreResult<VisitThreadRow[]>> {
  const { data, error } = await supabase
    .from('messages')
    .select(
      'direction, status, generated_by, review_state, review_reason, category, created_at',
    )
    .eq('venue_id', venueId)
    .eq('guest_id', guestId)
    .gte('created_at', since.toISOString())
    // NEWEST first under the limit, then turned round. Oldest-first would drop
    // the newest rows of a long day, and the newest rows are where a late
    // complaint and its still-open question are (found in review).
    .order('created_at', { ascending: false })
    .limit(VISIT_THREAD_ROW_LIMIT)
  if (error) return { ok: false, error: error.message }
  return {
    ok: true,
    data: [...(data ?? [])].reverse().map((row) => ({
      direction: row.direction,
      status: row.status,
      generatedBy: row.generated_by ?? null,
      reviewState: row.review_state ?? null,
      reviewReason: row.review_reason ?? null,
      category: row.category ?? null,
      createdAt: new Date(row.created_at),
    })),
  }
}

/** An earlier check-in that reached this guest. */
export interface PriorCheckin {
  body: string
  /** `visit_messages.angle`, as stored. Null on a row the judge never named. */
  angle: string | null
}

/**
 * The check-ins that have reached this guest, newest first, with what each
 * said. This is what "fresh" is measured against, in the prompt and in the
 * checks.
 *
 * Two reads rather than an embedded select: `message_id` is ON DELETE SET
 * NULL, and a row whose message has gone should drop out, not fail the read.
 *
 * `alsoSignOffOn` adds that day's in-shop sign-off body, so a check-in cannot
 * repeat what the guest was told on the way out.
 */
export async function loadPriorCheckins(
  supabase: AdminSupabaseClient,
  args: { venueId: string; guestId: string; alsoSignOffOn: string },
): Promise<
  StoreResult<{ checkins: PriorCheckin[]; signOffBody: string | null }>
> {
  const { data: rows, error } = await supabase
    .from('visit_messages')
    .select('kind, venue_local_date, angle, message_id, claimed_at')
    .eq('venue_id', args.venueId)
    .eq('guest_id', args.guestId)
    .in('outcome', ['sent', 'queued'])
    .in('kind', ['visit_checkin', 'sign_off'])
    .not('message_id', 'is', null)
    .order('claimed_at', { ascending: false })
    .limit(PRIOR_CHECKIN_LIMIT * 3)
  if (error) return { ok: false, error: error.message }

  const wanted = (rows ?? []).filter(
    (r) =>
      r.kind === 'visit_checkin' ||
      (r.kind === 'sign_off' && r.venue_local_date === args.alsoSignOffOn),
  )
  const ids = wanted.flatMap((r) => (r.message_id ? [r.message_id] : []))
  if (ids.length === 0) {
    return { ok: true, data: { checkins: [], signOffBody: null } }
  }
  const { data: messages, error: messagesError } = await supabase
    .from('messages')
    .select('id, body, status, review_state')
    .in('id', ids)
  if (messagesError) return { ok: false, error: messagesError.message }
  // Only what the guest actually read: a card still waiting, or one an
  // operator skipped, is not something we have said to them.
  const bodyById = new Map<string, string>()
  for (const m of messages ?? []) {
    if (m.review_state === 'pending') continue
    if (!DELIVERED_OUTBOUND_STATUSES.has(m.status)) continue
    if (typeof m.body === 'string' && m.body.trim() !== '') {
      bodyById.set(m.id, m.body)
    }
  }
  const checkins: PriorCheckin[] = []
  let signOffBody: string | null = null
  for (const row of wanted) {
    const body = row.message_id ? bodyById.get(row.message_id) : undefined
    if (body === undefined) continue
    if (row.kind === 'sign_off') signOffBody = body
    else if (checkins.length < PRIOR_CHECKIN_LIMIT) {
      checkins.push({ body, angle: row.angle ?? null })
    }
  }
  return { ok: true, data: { checkins, signOffBody } }
}

// ---------------------------------------------------------------------------
// The one-message rule's reads
// ---------------------------------------------------------------------------

/** An inquiry follow-up still waiting to go out for this guest. */
export interface PendingInquiryFollowup {
  dueAt: Date
  askedAt: Date
}

/**
 * The guest's pending inquiry follow-up, if one is armed. At most one exists
 * (migration 066's per-guest partial unique index).
 */
export async function loadPendingInquiryFollowup(
  supabase: AdminSupabaseClient,
  guestId: string,
): Promise<StoreResult<PendingInquiryFollowup | null>> {
  const { data, error } = await supabase
    .from('inquiry_followups')
    .select('due_at, asked_at')
    .eq('guest_id', guestId)
    .eq('status', 'pending')
    .limit(1)
    .maybeSingle()
  if (error) return { ok: false, error: error.message }
  if (!data) return { ok: true, data: null }
  return {
    ok: true,
    data: { dueAt: new Date(data.due_at), askedAt: new Date(data.asked_at) },
  }
}

/**
 * When a follow-up, a thank-you, a check-in or the "always here" close last
 * reached this guest: the newest of the three records that say so.
 *
 * DERIVED FROM THREE TABLES RATHER THAN READ OFF `guests.last_proactive_send_at`,
 * and it has to be. That column is also written by the scan greeting and the
 * same-visit check-back, which this rule does not cover, and it does not say
 * which mechanism wrote it. The three-hour gap applied to it would hold a
 * thank-you because the guest was greeted at the counter.
 *
 * The in-shop sign-off is not counted either: it belongs to the visit, and
 * the evening slot is already three hours after the visit's last message.
 */
export async function loadLastSpacedSendAt(
  supabase: AdminSupabaseClient,
  args: { venueId: string; guestId: string },
): Promise<StoreResult<Date | null>> {
  const [visit, held, inquiry, guest] = await Promise.all([
    supabase
      .from('visit_messages')
      .select('sent_at')
      .eq('venue_id', args.venueId)
      .eq('guest_id', args.guestId)
      .in('kind', ['first_visit_thanks', 'visit_checkin'])
      .not('sent_at', 'is', null)
      .order('sent_at', { ascending: false })
      .limit(1)
      .maybeSingle(),
    // A message that was HELD and approved later never gets `sent_at` on its
    // row: the approval path does not know this table. Its own `messages` row
    // does carry when it went, so the newest held one is read through that.
    // Without this an approved thank-you was invisible to the rule (found in
    // review), which matters because held is the default.
    supabase
      .from('visit_messages')
      .select('message_id')
      .eq('venue_id', args.venueId)
      .eq('guest_id', args.guestId)
      .in('kind', ['first_visit_thanks', 'visit_checkin'])
      .eq('outcome', 'queued')
      .not('message_id', 'is', null)
      .order('claimed_at', { ascending: false })
      .limit(1)
      .maybeSingle(),
    supabase
      .from('inquiry_followups')
      .select('dispatched_at')
      .eq('venue_id', args.venueId)
      .eq('guest_id', args.guestId)
      .eq('status', 'dispatched')
      .not('dispatched_at', 'is', null)
      .order('dispatched_at', { ascending: false })
      .limit(1)
      .maybeSingle(),
    supabase
      .from('guests')
      .select('warm_close_sent_at')
      .eq('id', args.guestId)
      .eq('venue_id', args.venueId)
      .maybeSingle(),
  ])
  if (visit.error) return { ok: false, error: visit.error.message }
  if (held.error) return { ok: false, error: held.error.message }
  if (inquiry.error) return { ok: false, error: inquiry.error.message }
  if (guest.error) return { ok: false, error: guest.error.message }
  let heldSentAt: string | null = null
  if (held.data?.message_id) {
    const { data: message, error } = await supabase
      .from('messages')
      .select('sent_at, status, review_state')
      .eq('id', held.data.message_id)
      .maybeSingle()
    if (error) return { ok: false, error: error.message }
    if (
      message &&
      message.review_state !== 'pending' &&
      DELIVERED_OUTBOUND_STATUSES.has(message.status)
    ) {
      heldSentAt = message.sent_at
    }
  }
  const times = [
    visit.data?.sent_at,
    heldSentAt,
    inquiry.data?.dispatched_at,
    guest.data?.warm_close_sent_at,
  ]
    .map((t) => (t ? new Date(t).getTime() : null))
    .filter((t): t is number => t !== null && Number.isFinite(t))
  return {
    ok: true,
    data: times.length === 0 ? null : new Date(Math.max(...times)),
  }
}

/**
 * Which of these outbound rows are a thank-you or a check-in?
 *
 * The warm close asks, for the reason it asks isInquiryFollowupMessage: such a
 * message is not part of a conversation the guest is IN, so it must not become
 * "our last word" and start the pause timer. Without it a thank-you an
 * operator approved was followed ten minutes later by "message us anytime"
 * (found in review). A sign-off row is not returned: that one does end a
 * conversation, and the timer's own `already_signed_off` handles it.
 */
export async function isPostVisitMessage(
  supabase: AdminSupabaseClient,
  messageIds: readonly string[],
): Promise<StoreResult<Set<string>>> {
  if (messageIds.length === 0) return { ok: true, data: new Set() }
  const { data, error } = await supabase
    .from('visit_messages')
    .select('message_id')
    .in('kind', ['first_visit_thanks', 'visit_checkin'])
    .in('message_id', [...messageIds])
  if (error) return { ok: false, error: error.message }
  const out = new Set<string>()
  for (const row of data ?? []) {
    if (row.message_id) out.add(row.message_id)
  }
  return { ok: true, data: out }
}

/**
 * How long a row may sit `claimed` before it is taken to be orphaned. A claim
 * is held for one generation and one send; the function running it is killed
 * long before this.
 */
export const STALE_CLAIM_MS = 15 * 60 * 1000

/**
 * Delete thank-you and check-in rows left `claimed` by a run that died between
 * the claim and the send, so the visit can be tried again inside its slot.
 *
 * Without it such a row read as settled for ever and the guest's one
 * thank-you was spent on nothing (found in review). It cannot give back the
 * review marker that run may also have claimed, which is keyed on a timestamp
 * only that run knew: the retried thank-you goes out without the invitation.
 * Logged, never thrown: a failure here costs a retry, not a send.
 */
export async function releaseStaleVisitClaims(
  supabase: AdminSupabaseClient,
  args: { venueId: string; dates: readonly string[]; now: Date },
): Promise<void> {
  if (args.dates.length === 0) return
  try {
    const { data, error } = await supabase
      .from('visit_messages')
      .delete()
      .eq('venue_id', args.venueId)
      .in('venue_local_date', [...args.dates])
      .in('kind', ['first_visit_thanks', 'visit_checkin'])
      .eq('outcome', 'claimed')
      .lt(
        'claimed_at',
        new Date(args.now.getTime() - STALE_CLAIM_MS).toISOString(),
      )
      .select('id')
    if (error) {
      console.error('[visit-messages] stale claim release failed', {
        venueId: args.venueId,
        error: error.message,
      })
    } else if ((data ?? []).length > 0) {
      console.warn('[visit-messages] released orphaned claims', {
        venueId: args.venueId,
        count: (data ?? []).length,
      })
    }
  } catch (e) {
    console.error('[visit-messages] stale claim release threw', {
      error: e instanceof Error ? e.message : String(e),
    })
  }
}

/** How recent a first scan has to be for its thank-you to still be possible. */
const FIRST_VISIT_THANKS_HORIZON_MS = 36 * 60 * 60 * 1000

/**
 * Is this guest's first-visit thank-you still to come?
 *
 * The inquiry follow-up asks before it sends (the one-message rule: the
 * thank-you outranks it, and a follow-up sent an hour ahead of the morning
 * slot would push the once-ever thank-you out of it).
 *
 * True only while ALL of these hold, so the follow-up never waits for a
 * thank-you that cannot come (an earlier version checked only the first two,
 * and a follow-up could wait out Meta's window behind a visit whose slot had
 * already passed; found in review):
 *
 *   the venue sends them at all   `post_visit_message_enabled`
 *   this is their first visit     every scan they have made is inside the
 *                                 last thirty-six hours
 *   it has not been sent or       no thank-you row exists for them
 *   settled
 *   a slot is still open or       resolvePostVisitSlot for that visit, on the
 *   ahead                         guest's newest message, does not say skip
 *
 * AN APPROXIMATION, stated: it reads scans and not recorded orders, so a guest
 * whose only earlier visit was a card payment with no scan reads as on their
 * first; and it does not see the stops only the processor reads (staff in the
 * thread, an unresolved complaint). The cost of either is a follow-up that
 * waits until the slot has gone.
 */
export async function firstVisitThanksStillOwed(
  supabase: AdminSupabaseClient,
  args: {
    venueId: string
    guestId: string
    now: Date
    enabled: boolean
    timezone: string | null
    earliestLocal: string
    latestLocal: string
  },
): Promise<StoreResult<boolean>> {
  if (!args.enabled || args.timezone === null) return { ok: true, data: false }
  const { data: scans, error } = await supabase
    .from('instagram_scan_arrivals')
    .select('scanned_at')
    .eq('venue_id', args.venueId)
    .eq('guest_id', args.guestId)
    .order('scanned_at', { ascending: true })
    .limit(1)
  if (error) return { ok: false, error: error.message }
  const first = scans?.[0]?.scanned_at
  if (!first) return { ok: true, data: false }
  const firstAt = new Date(first)
  const age = args.now.getTime() - firstAt.getTime()
  if (!Number.isFinite(age) || age > FIRST_VISIT_THANKS_HORIZON_MS) {
    return { ok: true, data: false }
  }
  const { data: rows, error: rowsError } = await supabase
    .from('visit_messages')
    .select('id')
    .eq('venue_id', args.venueId)
    .eq('guest_id', args.guestId)
    .eq('kind', 'first_visit_thanks')
    .limit(1)
  if (rowsError) return { ok: false, error: rowsError.message }
  if ((rows ?? []).length > 0) return { ok: true, data: false }

  const visitLocalDate = venueLocalDate(firstAt, args.timezone)
  if (visitLocalDate === null) return { ok: true, data: false }
  const [lastInbound, newest] = await Promise.all([
    loadLastGuestActionAt(supabase, args.venueId, args.guestId),
    supabase
      .from('messages')
      .select('created_at')
      .eq('venue_id', args.venueId)
      .eq('guest_id', args.guestId)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle(),
  ])
  if (!lastInbound.ok) return { ok: false, error: lastInbound.error }
  if (newest.error) return { ok: false, error: newest.error.message }
  const slot = resolvePostVisitSlot({
    visitLocalDate,
    timezone: args.timezone,
    earliestLocal: args.earliestLocal,
    latestLocal: args.latestLocal,
    lastInboundAt: lastInbound.value,
    threadQuietSince: newest.data ? new Date(newest.data.created_at) : null,
    guestId: args.guestId,
    now: args.now,
  })
  return { ok: true, data: slot.kind !== 'skip' }
}
