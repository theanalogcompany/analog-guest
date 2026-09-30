// TAC-386: every database read and write the inquiry follow-up makes.
//
// Split from the processor for the reason TAC-536 and TAC-560 split theirs: the
// processor is then a readable ordered list of gates, and the store is where the
// column names live, so a schema change touches one file.
//
// THE CLAIM IS A STATUS CAS, the same shape as TAC-560's marker CAS:
//
//   update inquiry_followups set status = 'dispatched', dispatched_at = now
//    where id = $1 and status = 'pending'
//
// rowcount 1 owns the send. Because the predicate is `status = 'pending'` and
// the claim moves the row out of that status, two ticks landing together cannot
// both dispatch one row, and nothing needs a lock.
//
// RELEASING CAN CONFLICT, and that is not a bug to swallow. Migration 066 has a
// partial unique index on `(guest_id) where status = 'pending'` (one pending
// follow-up per guest, ruled 2026-09-30). A claim moves this row out of
// 'pending', which frees the slot, so a later inbound can arm a NEW question
// before a failed send releases the old one. The release then violates the
// index. That is the correct outcome and `releaseInquiryFollowupClaim` reports
// it, so the processor can mark this row superseded rather than retry a question
// the guest has already moved past.

import type { SupabaseClient } from '@supabase/supabase-js'

import type { Database } from '@/db/types'

type AdminSupabaseClient = SupabaseClient<Database>

/** How many due rows one tick looks at, per venue. */
export const INQUIRY_FOLLOWUP_SCAN_LIMIT = 50

/**
 * How long past `due_at` a row keeps trying before it is given up on.
 *
 * Meta's window is the real bound and is checked directly, so this is the
 * backstop for the case the window check cannot see: a row whose venue hours
 * became unreadable, which would otherwise sit `pending` for ever holding the
 * guest's one pending slot.
 */
export const INQUIRY_FOLLOWUP_HORIZON_MS = 24 * 60 * 60 * 1000

export type StoreResult<T> =
  { ok: true; data: T } | { ok: false; error: string }

/** A venue the scan has to consider. */
export interface InquiryFollowupVenue {
  id: string
  timezone: string | null
  status: string | null
  instagramAccountId: string | null
  followupRules: unknown
  /** `venue_configs.venue_info.hours`, for the dispatch-time hours re-check. */
  venueInfo: unknown
}

/** An armed question waiting for its moment. */
export interface DueInquiryFollowup {
  id: string
  venueId: string
  guestId: string
  sourceMessageId: string
  question: string
  askedAt: Date
  windowClosesAt: Date
  dueAt: Date
}

/** The guest facts every gate needs, in one read. */
export interface InquiryGuestFacts {
  optedOutAt: Date | null
  instagramScopedId: string | null
  lastProactiveSendAt: Date | null
}

/**
 * Venues that could have a due row.
 *
 * EVERY COLUMN IN THIS SELECT IS READ BY A GATE, and that is worth stating
 * because of how it fails otherwise: dropping one from the string makes its gate
 * read `undefined` and go inert, and the test double ignores its select
 * argument, so no behavioural test can see it. TAC-560's store learned this and
 * has its processor test capture the string; this one is captured the same way.
 */
export async function loadInquiryFollowupVenues(
  supabase: AdminSupabaseClient,
): Promise<StoreResult<InquiryFollowupVenue[]>> {
  const { data, error } = await supabase
    .from('venues')
    .select(
      'id, timezone, status, instagram_account_id, venue_configs(followup_rules, venue_info)',
    )
  if (error) return { ok: false, error: error.message }

  return {
    ok: true,
    data: (data ?? []).map((row) => {
      // PostgREST returns an embedded one-to-one as an object OR a one-element
      // array depending on the relationship's shape. Both are handled for the
      // reason the follow-up engine and TAC-560's store both handle both.
      const configRaw = (row as { venue_configs?: unknown }).venue_configs
      const config = Array.isArray(configRaw) ? configRaw[0] : configRaw
      const cfg = (config ?? null) as {
        followup_rules?: unknown
        venue_info?: unknown
      } | null
      return {
        id: row.id,
        timezone: row.timezone ?? null,
        status: row.status ?? null,
        instagramAccountId:
          (row as { instagram_account_id?: string | null })
            .instagram_account_id ?? null,
        followupRules: cfg?.followup_rules ?? null,
        venueInfo: cfg?.venue_info ?? null,
      }
    }),
  }
}

/** Armed questions at this venue whose moment has come. */
export async function loadDueInquiryFollowups(
  supabase: AdminSupabaseClient,
  venueId: string,
  now: Date,
): Promise<StoreResult<DueInquiryFollowup[]>> {
  const { data, error } = await supabase
    .from('inquiry_followups')
    .select(
      'id, venue_id, guest_id, source_message_id, question, asked_at, window_closes_at, due_at',
    )
    .eq('venue_id', venueId)
    .eq('status', 'pending')
    .lte('due_at', now.toISOString())
    .order('due_at', { ascending: true })
    .limit(INQUIRY_FOLLOWUP_SCAN_LIMIT)
  if (error) return { ok: false, error: error.message }

  return {
    ok: true,
    data: (data ?? []).map((row) => ({
      id: row.id,
      venueId: row.venue_id,
      guestId: row.guest_id,
      sourceMessageId: row.source_message_id,
      question: row.question,
      askedAt: new Date(row.asked_at),
      windowClosesAt: new Date(row.window_closes_at),
      dueAt: new Date(row.due_at),
    })),
  }
}

/** The opt-out, the channel identifier and the spacing marker, in one read. */
export async function loadInquiryGuestFacts(
  supabase: AdminSupabaseClient,
  guestId: string,
): Promise<StoreResult<InquiryGuestFacts>> {
  const { data, error } = await supabase
    .from('guests')
    .select('opted_out_at, instagram_scoped_id, last_proactive_send_at')
    .eq('id', guestId)
    .maybeSingle()
  if (error) return { ok: false, error: error.message }
  if (!data) return { ok: false, error: `guest ${guestId} not found` }

  return {
    ok: true,
    data: {
      optedOutAt: data.opted_out_at ? new Date(data.opted_out_at) : null,
      instagramScopedId: data.instagram_scoped_id ?? null,
      lastProactiveSendAt: data.last_proactive_send_at
        ? new Date(data.last_proactive_send_at)
        : null,
    },
  }
}

/**
 * Has the guest written to us since they asked?
 *
 * Ruling 5(b): if they have, the conversation moved on and the nudge is
 * redundant. Compared against the SOURCE QUESTION's own timestamp, per the
 * ruling's wording, not against `due_at` or `now`.
 *
 * A DIRECT `messages` READ, and it has to be. `guests.last_inbound_at` looks
 * exactly like the column for this and is commented DO NOT READ in migration
 * 051: it is written once at guest creation, so it holds FIRST CONTACT. It is
 * always older than the question, so a comparison against it would be false on
 * every row and this gate would never fire while looking like it did.
 */
export async function hasInboundSince(
  supabase: AdminSupabaseClient,
  venueId: string,
  guestId: string,
  after: Date,
): Promise<StoreResult<boolean>> {
  const { data, error } = await supabase
    .from('messages')
    .select('id')
    .eq('venue_id', venueId)
    .eq('guest_id', guestId)
    .eq('direction', 'inbound')
    .gt('created_at', after.toISOString())
    .limit(1)
  if (error) return { ok: false, error: error.message }
  return { ok: true, data: (data ?? []).length > 0 }
}

/** What we told them, and which row said it. */
export interface OurAnswer {
  messageId: string
  body: string
}

/**
 * The outbound that answered this question, or null if none ever reached them.
 *
 * READ AT DISPATCH, not stored when the row was armed, and that is a decision
 * rather than convenience: at arm time the reply is still in flight, and a card
 * an operator later edits would leave a stored copy claiming we said something
 * we did not. This reads what actually went out.
 *
 * Null is a real and reachable answer: generation can refuse below the fidelity
 * floor, a card can be skipped, a send can fail. The processor skips the row in
 * that case, because a message checking that our help worked out has nothing to
 * say when we never helped.
 */
export async function loadOurAnswer(
  supabase: AdminSupabaseClient,
  sourceMessageId: string,
): Promise<StoreResult<OurAnswer | null>> {
  const { data, error } = await supabase
    .from('messages')
    .select('id, body, status')
    .eq('reply_to_message_id', sourceMessageId)
    .eq('direction', 'outbound')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (error) return { ok: false, error: error.message }
  if (!data) return { ok: true, data: null }
  const body = (data.body ?? '').trim()
  if (body.length === 0) return { ok: true, data: null }
  return { ok: true, data: { messageId: data.id, body } }
}

export type InquiryClaimResult =
  | { status: 'claimed' }
  | { status: 'lost' }
  | { status: 'failed'; error: string }

/**
 * Take the row, immediately before generating.
 *
 * Everything the processor checks before this could say "never"; from here on
 * the question's one follow-up is spent.
 */
export async function claimInquiryFollowup(
  supabase: AdminSupabaseClient,
  id: string,
  now: Date,
): Promise<InquiryClaimResult> {
  const { data, error } = await supabase
    .from('inquiry_followups')
    .update({ status: 'dispatched', dispatched_at: now.toISOString() })
    .eq('id', id)
    .eq('status', 'pending')
    .select('id')
  if (error) return { status: 'failed', error: error.message }
  return (data ?? []).length === 1 ? { status: 'claimed' } : { status: 'lost' }
}

/** Record which outbound row the follow-up became. */
export async function recordInquiryDispatch(
  supabase: AdminSupabaseClient,
  id: string,
  messageId: string,
): Promise<StoreResult<null>> {
  const { error } = await supabase
    .from('inquiry_followups')
    .update({ dispatched_message_id: messageId })
    .eq('id', id)
  if (error) return { ok: false, error: error.message }
  return { ok: true, data: null }
}

export type InquiryReleaseResult =
  | { status: 'released' }
  /**
   * The guest has a NEWER armed question occupying their one pending slot, so
   * this row cannot go back to 'pending'. Not an error: the processor marks it
   * superseded instead of retrying a question they have moved past.
   */
  | { status: 'superseded' }
  | { status: 'failed'; error: string }

/** Postgres unique-violation. */
const UNIQUE_VIOLATION = '23505'

/**
 * Put the row back for a later tick, after a send that will never reach the
 * guest.
 */
export async function releaseInquiryFollowupClaim(
  supabase: AdminSupabaseClient,
  id: string,
): Promise<InquiryReleaseResult> {
  const { error } = await supabase
    .from('inquiry_followups')
    .update({ status: 'pending', dispatched_at: null })
    .eq('id', id)
  if (!error) return { status: 'released' }
  if (error.code === UNIQUE_VIOLATION) return { status: 'superseded' }
  return { status: 'failed', error: error.message }
}

/** Give up on the row, with the gate that said so. */
export async function resolveInquiryFollowup(
  supabase: AdminSupabaseClient,
  id: string,
  status: 'skipped' | 'expired',
  skipReason: string,
): Promise<StoreResult<null>> {
  const { error } = await supabase
    .from('inquiry_followups')
    .update({ status, skip_reason: skipReason })
    .eq('id', id)
  if (error) return { ok: false, error: error.message }
  return { ok: true, data: null }
}

/**
 * Stamp the proactive-send spacing marker.
 *
 * ADVISORY, NOT A CLAIM, so nothing releases it: it is written only after a send
 * that reached the guest, and a send that did not reach them should leave no
 * trace here. Ruled 2026-09-30, read by all three proactive mechanisms before
 * their own claim.
 */
export async function recordProactiveSend(
  supabase: AdminSupabaseClient,
  guestId: string,
  now: Date,
): Promise<StoreResult<null>> {
  const { error } = await supabase
    .from('guests')
    .update({ last_proactive_send_at: now.toISOString() })
    .eq('id', guestId)
  if (error) return { ok: false, error: error.message }
  return { ok: true, data: null }
}

/**
 * Is a message id one of our own inquiry follow-ups?
 *
 * Read by TAC-560's warm close, which must not treat a follow-up as the outbound
 * a guest went quiet after. Without this, a follow-up three hours out would open
 * a FRESH two-hour warm-close window, and the guest would get a second proactive
 * message an hour later: the 60-minute spacing rule only delays that, it does
 * not prevent it.
 */
export async function isInquiryFollowupMessage(
  supabase: AdminSupabaseClient,
  messageIds: readonly string[],
): Promise<StoreResult<Set<string>>> {
  if (messageIds.length === 0) return { ok: true, data: new Set() }
  const { data, error } = await supabase
    .from('inquiry_followups')
    .select('dispatched_message_id')
    .in('dispatched_message_id', [...messageIds])
  if (error) return { ok: false, error: error.message }
  const out = new Set<string>()
  for (const row of data ?? []) {
    if (row.dispatched_message_id) out.add(row.dispatched_message_id)
  }
  return { ok: true, data: out }
}

/**
 * This guest's recent inbound timestamps, newest first.
 *
 * Feeds `isIntentionBrakeEngaged`, which needs to know which of our prompts went
 * unanswered. The window matches what `build-runtime-context.ts` loads for the
 * same judgment, using ITS exported constants rather than numbers restated here,
 * so the brake sees the same history on this path as on the inbound path.
 */
export async function loadRecentInboundTimes(
  supabase: AdminSupabaseClient,
  venueId: string,
  guestId: string,
  from: Date,
  limit: number,
): Promise<StoreResult<Date[]>> {
  const { data, error } = await supabase
    .from('messages')
    .select('created_at')
    .eq('venue_id', venueId)
    .eq('guest_id', guestId)
    .eq('direction', 'inbound')
    .gte('created_at', from.toISOString())
    .order('created_at', { ascending: false })
    .limit(limit)
  if (error) return { ok: false, error: error.message }
  return {
    ok: true,
    data: (data ?? [])
      .map((row) => new Date(row.created_at))
      .filter((d) => !Number.isNaN(d.getTime())),
  }
}

/** `venue_configs.intention_rules` for one venue, raw for the schema to parse. */
export async function loadIntentionRulesRaw(
  supabase: AdminSupabaseClient,
  venueId: string,
): Promise<StoreResult<unknown>> {
  const { data, error } = await supabase
    .from('venue_configs')
    .select('intention_rules')
    .eq('venue_id', venueId)
    .maybeSingle()
  if (error) return { ok: false, error: error.message }
  return { ok: true, data: data?.intention_rules ?? null }
}
