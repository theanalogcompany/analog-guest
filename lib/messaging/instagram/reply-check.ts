// TAC-469: has a guest's Instagram message already been answered?
//
// Staff can reply by hand in the Instagram app, and that reply arrives as an
// echo, saved by the webhook as an outbound row with no reply_to_message_id and
// no generated_by. When one exists, the agent must not send a second answer:
// a person already has. Any outbound counts, whoever wrote it (TAC-469 rule 3).
//
// WHAT A ROW ANSWERS (ruled 2026-09-19). An outbound row sent after inbound X
// answers X when EITHER
//   - it names no inbound (reply_to_message_id is null): every reply staff type
//     in the app. It counts for everything the guest sent before it; OR
//   - it names X, or an inbound later than X: it was written after X existed.
// It does NOT answer X when it names an inbound EARLIER than X. That reply was
// written before X existed, so it cannot have answered it. This is the reading
// of rule 3, not a change to it: the rule exists so staff answering by hand
// silences the agent, never so the agent silences itself. Without it, "do you
// have oat milk?" sent five seconds after "what time do you close?" would get
// no reply once the first answer landed, a bug Sendblue does not have.
// Keyed on what the row says it answered, never on who wrote it.
//
// "SENT AFTER" uses one clock per comparison: Meta's (`provider_sent_at`) when
// both rows have it, otherwise ours. Our time for an outbound row is `sent_at`,
// falling back to `created_at`; `created_at` alone is wrong for an operator-
// approved card, which is created when the draft was queued, not when it went
// out. Our time for an inbound row is `created_at`, when the webhook saved it.
//
// Only rows that reached the guest count: sending, sent or delivered, and never
// a pending draft. A card waiting for an operator has answered nothing.
//
// KNOWN RACE, NOT ENGINEERED AROUND (ruled): echoes are asynchronous. A reply
// staff type in the seconds before the agent sends, whose echo has not arrived
// yet (about 2 seconds in production), is not seen, and the guest gets both.
//
// Instagram-only, like the window: Sendblue has no client staff can type into.

import type { SupabaseClient } from '@supabase/supabase-js'

import type { Database } from '@/db/types'
import { DELIVERED_OUTBOUND_STATUSES } from '@/lib/agent/group-responses'

type AdminSupabaseClient = SupabaseClient<Database>

/** An inbound row, on both clocks. */
export type ReplyCheckInbound = {
  id: string
  /** Meta's time, or null for a row saved without one. */
  providerSentAt: Date | null
  /** Our receipt time (created_at). */
  receivedAt: Date
}

/** An outbound row that reached the guest, on both clocks. */
export type ReplyCheckOutbound = {
  id: string
  replyToMessageId: string | null
  /** Meta's time: set on echo rows, null on a row our own send wrote first. */
  providerSentAt: Date | null
  /** Our time: sent_at, else created_at. */
  sentAt: Date
}

function isAfter(
  later: { providerSentAt: Date | null; ours: Date },
  earlier: { providerSentAt: Date | null; ours: Date },
): boolean {
  if (later.providerSentAt !== null && earlier.providerSentAt !== null) {
    return later.providerSentAt.getTime() > earlier.providerSentAt.getTime()
  }
  return later.ours.getTime() > earlier.ours.getTime()
}

function inboundClock(row: ReplyCheckInbound) {
  return { providerSentAt: row.providerSentAt, ours: row.receivedAt }
}

/**
 * Pure. The first outbound row that answers `inbound`, or null.
 *
 * `namedInbounds` holds the inbound rows the candidates name (their
 * reply_to_message_id), for the earlier-or-later comparison. A candidate naming
 * an inbound missing from it does not count: every row that names an inbound
 * was written by the agent or an operator card, and treating an unreadable one
 * as an answer is how the agent would silence itself.
 */
export function findAnsweringOutbound(
  inbound: ReplyCheckInbound,
  outbound: readonly ReplyCheckOutbound[],
  namedInbounds: ReadonlyMap<string, ReplyCheckInbound>,
): ReplyCheckOutbound | null {
  for (const row of outbound) {
    if (!isAfter({ providerSentAt: row.providerSentAt, ours: row.sentAt }, inboundClock(inbound))) continue
    if (row.replyToMessageId === null || row.replyToMessageId === inbound.id) return row
    const named = namedInbounds.get(row.replyToMessageId)
    if (named !== undefined && isAfter(inboundClock(named), inboundClock(inbound))) return row
  }
  return null
}

/** How many candidate rows are read. A guest's replies after one message are few. */
const REPLY_CHECK_ROW_LIMIT = 50

function dateOrNull(value: unknown): Date | null {
  if (typeof value !== 'string') return null
  const at = new Date(value)
  return Number.isNaN(at.getTime()) ? null : at
}

function toInbound(row: { id: string; created_at: string; provider_sent_at: string | null }): ReplyCheckInbound | null {
  const receivedAt = dateOrNull(row.created_at)
  if (receivedAt === null) return null
  return { id: row.id, providerSentAt: dateOrNull(row.provider_sent_at), receivedAt }
}

/**
 * The outbound Instagram row that already answered `inboundMessageId`, or null.
 * An error means the check could not be made; the caller decides what that
 * means (the agent path sends anyway: a guest getting two answers is better
 * than none).
 */
export async function findReplyToInbound(
  supabase: AdminSupabaseClient,
  input: { venueId: string; guestId: string; inboundMessageId: string },
): Promise<{ ok: true; value: { id: string } | null } | { ok: false; error: string }> {
  const { data: inboundRow, error: inboundError } = await supabase
    .from('messages')
    .select('id, created_at, provider_sent_at')
    .eq('id', input.inboundMessageId)
    .eq('venue_id', input.venueId)
    .eq('guest_id', input.guestId)
    .eq('direction', 'inbound')
    .maybeSingle()
  if (inboundError) return { ok: false, error: inboundError.message }
  if (!inboundRow) return { ok: false, error: 'inbound message not found' }
  const inbound = toInbound(inboundRow)
  if (inbound === null) return { ok: false, error: 'inbound message has no readable created_at' }

  // Candidates: anything that could be after the inbound on either clock. The
  // pure check decides; this only keeps the read small.
  const since = inbound.receivedAt.toISOString()
  const afterFilters = [`created_at.gt.${since}`, `sent_at.gt.${since}`]
  if (inbound.providerSentAt !== null) {
    afterFilters.push(`provider_sent_at.gt.${inbound.providerSentAt.toISOString()}`)
  }
  const { data: rows, error: rowsError } = await supabase
    .from('messages')
    .select('id, reply_to_message_id, provider_sent_at, sent_at, created_at, review_state')
    .eq('venue_id', input.venueId)
    .eq('guest_id', input.guestId)
    .eq('direction', 'outbound')
    .eq('channel', 'instagram')
    .in('status', [...DELIVERED_OUTBOUND_STATUSES])
    .or(afterFilters.join(','))
    .order('created_at', { ascending: false })
    .limit(REPLY_CHECK_ROW_LIMIT)
  if (rowsError) return { ok: false, error: rowsError.message }

  const outbound: ReplyCheckOutbound[] = []
  for (const row of rows ?? []) {
    // A pending draft reached nobody. Filtered here rather than in the query:
    // PostgREST's `neq` drops NULLs, and every echo row's review_state is NULL.
    if (row.review_state === 'pending') continue
    const sentAt = dateOrNull(row.sent_at) ?? dateOrNull(row.created_at)
    if (sentAt === null) continue
    outbound.push({
      id: row.id,
      replyToMessageId: row.reply_to_message_id,
      providerSentAt: dateOrNull(row.provider_sent_at),
      sentAt,
    })
  }

  const namedIds = [
    ...new Set(
      outbound
        .map((o) => o.replyToMessageId)
        .filter((id): id is string => id !== null && id !== inbound.id),
    ),
  ]
  const namedInbounds = new Map<string, ReplyCheckInbound>()
  if (namedIds.length > 0) {
    const { data: named, error: namedError } = await supabase
      .from('messages')
      .select('id, created_at, provider_sent_at')
      .in('id', namedIds)
    if (namedError) return { ok: false, error: namedError.message }
    for (const row of named ?? []) {
      const parsed = toInbound(row)
      if (parsed !== null) namedInbounds.set(parsed.id, parsed)
    }
  }

  const answering = findAnsweringOutbound(inbound, outbound, namedInbounds)
  return { ok: true, value: answering === null ? null : { id: answering.id } }
}
