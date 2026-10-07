// TAC-560: the reads and writes behind the warm "line is open" close.
//
// Split from warm-close.ts, which is the pure half.
//
// THERE IS NO SCHEDULING TABLE, and that is the design rather than an omission.
// TAC-536 needed `instagram_scan_arrivals` because a scan is an event nothing
// else records. Here the event is OUR OWN LAST OUTBOUND, already a row in
// `messages`, so the due set is derived (the TAC-476 lesson: a derived answer
// cannot drift, and needs no write site on a live send path). The only thing
// that needs storage is the marker, and one nullable column does that.
//
// THE MARKER IS ALSO THE CLAIM. One statement:
//
//   update guests set warm_close_sent_at = now()
//    where id = $1 and warm_close_sent_at is null
//
//   rowcount 1  this tick owns the close
//   rowcount 0  another tick already took it, or the guest was closed earlier
//
// So the once-per-guest-ever guarantee and the every-minute idempotency are the
// same predicate, enforced by Postgres rather than by a read-then-decide. The
// tick is every minute; a read-then-decide at that cadence loses to itself.
//
// CLAIM BEFORE THE SIDE EFFECT, the house rule (window_warning_pushed_at,
// pending_until, followup_log, instagram_scan_arrivals). A process that dies
// between the claim and the send loses one close rather than sending two.

import type { SupabaseClient } from '@supabase/supabase-js'

import type { Database } from '@/db/types'
import { isInquiryFollowupMessage } from '@/lib/followups/inquiry-followup-store'
import { DELIVERED_OUTBOUND_STATUSES } from './group-responses'
import { warmCloseBlocker, type WarmCloseBlocker } from './warm-close'

type AdminSupabaseClient = SupabaseClient<Database>

/** How many candidate outbound rows one tick looks at, per venue. */
export const WARM_CLOSE_SCAN_LIMIT = 50

export type StoreResult<T> =
  { ok: true; data: T } | { ok: false; error: string }

/** A venue the scan has to consider. */
export interface WarmCloseVenue {
  id: string
  timezone: string | null
  status: string | null
  instagramAccountId: string | null
  followupRules: unknown
}

/**
 * The last thing we said to this guest, as the timer sees it.
 *
 * `body` is the LAST bubble of the response, not the whole response: TAC-554
 * puts a getting-to-know-you question in its own final message, so that is where
 * a question would be. It is therefore the WHOLE question signal — see
 * weAskedAQuestion, which TAC-568 reduced to reading this one field after the
 * rendered-intentions arm proved unable to fire correctly in either direction.
 */
export interface WarmCloseCandidate {
  venueId: string
  guestId: string
  /** The newest delivered outbound row's id, for the reply-check and the ledger. */
  messageId: string
  sentAt: Date
  body: string
}

/** The guest facts every check needs, in one read. */
export interface WarmCloseGuestFacts {
  /**
   * TAC-386: when a proactive message last reached this guest, from ANY of the
   * three mechanisms. Read before the claim to keep PROACTIVE_SPACING_MINUTES
   * between two of them.
   */
  lastProactiveSendAt: Date | null
  firstContactedAt: Date | null
  warmCloseSentAt: Date | null
  optedOutAt: Date | null
  instagramScopedId: string | null
  phoneNumber: string | null
}

/**
 * Venues that could have a candidate.
 *
 * Mirrors the follow-up engine's own venue scan, including its lesson: every
 * column here is read by a gate, and dropping one from this string makes that
 * gate read `undefined` and go inert.
 */
export async function loadWarmCloseVenues(
  supabase: AdminSupabaseClient,
): Promise<StoreResult<WarmCloseVenue[]>> {
  const { data, error } = await supabase
    .from('venues')
    .select(
      'id, timezone, status, instagram_account_id, venue_configs(followup_rules)',
    )
  if (error) return { ok: false, error: error.message }

  return {
    ok: true,
    data: (data ?? []).map((row) => {
      // PostgREST returns an embedded one-to-one as an object or a one-element
      // array depending on the relationship's shape; the engine handles both and
      // so does this.
      const configs = (row as { venue_configs?: unknown }).venue_configs
      const config = Array.isArray(configs) ? configs[0] : configs
      return {
        id: row.id,
        timezone: row.timezone ?? null,
        status: row.status ?? null,
        instagramAccountId: row.instagram_account_id ?? null,
        followupRules:
          (config as { followup_rules?: unknown } | null)?.followup_rules ??
          null,
      }
    }),
  }
}

/**
 * The newest message for each guest at this venue inside the candidate window,
 * folded to one candidate per guest.
 *
 * WHY IT READS BOTH DIRECTIONS rather than filtering to outbound in SQL: the
 * candidate is only valid if our outbound is the guest's LAST message. Reading
 * outbound alone cannot tell "the guest has not replied" from "the guest replied
 * and we have not answered yet" — so an inbound newer than our outbound has to
 * be visible here, where it disqualifies the guest. That is also what makes the
 * timer reset on a reply: the guest's own message becomes the newest row and no
 * candidate is produced.
 *
 * THE REACHED-GUEST FILTER IS APPLIED IN TS, NOT SQL, and deliberately: a
 * PENDING or SKIPPED draft is a message the guest never saw, so it must not
 * start the timer, but it must still be VISIBLE here, because a row newer than
 * our last delivered outbound means something happened after it. Filtering it
 * out in SQL would silently promote an older delivered row to "our last word".
 *
 * Window-bounded by maxAge so the scan stays small: with a two-hour bound this
 * is a handful of rows per venue per tick, and it rides
 * idx_messages_created_at (venue_id, created_at desc).
 */
export async function loadWarmCloseCandidates(
  supabase: AdminSupabaseClient,
  venueId: string,
  windowStart: Date,
  limit: number = WARM_CLOSE_SCAN_LIMIT,
): Promise<StoreResult<WarmCloseCandidate[]>> {
  const { data, error } = await supabase
    .from('messages')
    .select(
      'id, guest_id, direction, status, review_state, body, created_at, generation_id',
    )
    .eq('venue_id', venueId)
    .eq('channel', 'instagram')
    .gte('created_at', windowStart.toISOString())
    .order('created_at', { ascending: false })
    .limit(limit)
  if (error) return { ok: false, error: error.message }

  // TAC-386: AN INQUIRY FOLLOW-UP IS NOT AN ANCHOR.
  //
  // A follow-up is an outbound row, so without this it would become "our last
  // word" and open a FRESH two-hour warm-close window three hours after the
  // original one expired. The guest would then get a second proactive message
  // ten minutes later. The 60-minute spacing rule only DELAYS that by an hour.
  //
  // The premise is this mechanism's own: a warm close closes a conversation the
  // guest is IN, and an unprompted follow-up is not one.
  //
  // Checked HERE rather than in the processor, and that placement is the point.
  // The loop below marks a guest `seen` on their newest row whatever it is, so
  // hitting this test and continuing DISQUALIFIES the guest for this tick. A
  // filter applied earlier would instead let an OLDER delivered row stand in as
  // the anchor, which is exactly what the `seen` comment below warns against.
  const outboundIds = (data ?? [])
    .filter((row) => row.direction === 'outbound')
    .map((row) => row.id)
  const proactive = await isInquiryFollowupMessage(supabase, outboundIds)
  if (!proactive.ok) {
    // A failed read has not shown these are ordinary outbounds. Reporting the
    // error costs a delayed close; guessing costs a double send.
    return {
      ok: false,
      error: `loadWarmCloseCandidates (provenance): ${proactive.error}`,
    }
  }

  const seen = new Set<string>()
  const candidates: WarmCloseCandidate[] = []
  for (const row of data ?? []) {
    const guestId = row.guest_id
    if (guestId === null || seen.has(guestId)) continue
    // The newest row for this guest decides, whatever it is. Marking the guest
    // seen on an inbound (or an undelivered draft) is what disqualifies them
    // rather than letting an older delivered row stand in as our last word.
    seen.add(guestId)
    if (row.direction !== 'outbound') continue
    if (proactive.data.has(row.id)) {
      console.log(
        '[warm-close] newest outbound is a follow-up; not an anchor',
        {
          venueId,
          guestId,
          messageId: row.id,
        },
      )
      continue
    }
    if (row.review_state === 'pending') continue
    if (!DELIVERED_OUTBOUND_STATUSES.has(row.status)) continue

    const sentAt = new Date(row.created_at)
    if (!Number.isFinite(sentAt.getTime())) continue

    candidates.push({
      venueId,
      guestId,
      messageId: row.id,
      sentAt,
      body: typeof row.body === 'string' ? row.body : '',
    })
  }
  return { ok: true, data: candidates }
}

/** Every guest fact the checks need, in one round trip. */
export async function loadWarmCloseGuestFacts(
  supabase: AdminSupabaseClient,
  guestId: string,
): Promise<StoreResult<WarmCloseGuestFacts>> {
  const { data, error } = await supabase
    .from('guests')
    .select(
      'first_contacted_at, warm_close_sent_at, opted_out_at, instagram_scoped_id, phone_number, last_proactive_send_at',
    )
    .eq('id', guestId)
    .maybeSingle()
  if (error) return { ok: false, error: error.message }
  if (!data) return { ok: false, error: 'guest not found' }

  const firstContactedAt =
    typeof data.first_contacted_at === 'string'
      ? new Date(data.first_contacted_at)
      : null
  const warmCloseSentAt =
    typeof data.warm_close_sent_at === 'string'
      ? new Date(data.warm_close_sent_at)
      : null

  return {
    ok: true,
    data: {
      lastProactiveSendAt:
        typeof data.last_proactive_send_at === 'string' &&
        Number.isFinite(new Date(data.last_proactive_send_at).getTime())
          ? new Date(data.last_proactive_send_at)
          : null,
      firstContactedAt:
        firstContactedAt !== null && Number.isFinite(firstContactedAt.getTime())
          ? firstContactedAt
          : null,
      warmCloseSentAt:
        warmCloseSentAt !== null && Number.isFinite(warmCloseSentAt.getTime())
          ? warmCloseSentAt
          : null,
      optedOutAt:
        typeof data.opted_out_at === 'string'
          ? new Date(data.opted_out_at)
          : null,
      instagramScopedId: data.instagram_scoped_id ?? null,
      phoneNumber: data.phone_number ?? null,
    },
  }
}

/**
 * The guest's most recent inbound category, or null.
 *
 * The belt behind the model's own `closedTheConversation` self-report: a last
 * inbound that classified `acknowledgment` IS the sign-off turn Le Mil's rule 15
 * fires on, so the in-conversation close has already gone out and the timer
 * stands down. Independent of the self-report and venue-neutral, on an existing
 * column.
 *
 * Fails to null, which means "no signal" and lets the other checks decide. The
 * marker is the authoritative guard; this only catches the case where the
 * self-report missed.
 */
export async function loadLastInboundCategory(
  supabase: AdminSupabaseClient,
  venueId: string,
  guestId: string,
): Promise<string | null> {
  const { data, error } = await supabase
    .from('messages')
    .select('category')
    .eq('venue_id', venueId)
    .eq('guest_id', guestId)
    .eq('direction', 'inbound')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (error) {
    console.warn('[warm-close] last inbound category unreadable', {
      venueId,
      guestId,
      error: error.message,
    })
    return null
  }
  return data?.category ?? null
}

/** How many of a first conversation's rows the blocker read looks at. */
export const WARM_CLOSE_BLOCKER_ROW_LIMIT = 200

/**
 * TAC-575: is there a reason this first conversation gets no automated close?
 *
 * One read of the guest's rows since the conversation began, handed to the
 * pure warmCloseBlocker. Called by BOTH paths before they claim the marker, so
 * the timer and the goodbye cannot disagree about what blocks a close.
 *
 * FAILS CLOSED, as an error rather than as "nothing blocks": the answer decides
 * whether a message goes out under a member of staff or on top of a complaint,
 * and an unreadable thread has not shown that neither is there. The callers
 * treat an error as "do not close now". The timer comes round again next tick.
 *
 * Newest first with a cap: past WARM_CLOSE_BLOCKER_ROW_LIMIT rows in one first
 * conversation the oldest are not read. A conversation that long has a person
 * in it by any reasonable reading, and the cap keeps the read bounded.
 */
export async function loadWarmCloseBlocker(
  supabase: AdminSupabaseClient,
  venueId: string,
  guestId: string,
  conversationStartedAt: Date,
): Promise<StoreResult<WarmCloseBlocker | null>> {
  const { data, error } = await supabase
    .from('messages')
    .select('direction, status, generated_by, review_state, category')
    .eq('venue_id', venueId)
    .eq('guest_id', guestId)
    .eq('direction', 'outbound')
    .gte('created_at', conversationStartedAt.toISOString())
    .order('created_at', { ascending: false })
    .limit(WARM_CLOSE_BLOCKER_ROW_LIMIT)
  if (error) return { ok: false, error: error.message }
  return {
    ok: true,
    data: warmCloseBlocker(
      (data ?? []).map((row) => ({
        direction: row.direction,
        status: row.status,
        generatedBy: row.generated_by ?? null,
        reviewState: row.review_state ?? null,
        category: row.category ?? null,
      })),
      DELIVERED_OUTBOUND_STATUSES,
    ),
  }
}

export type WarmCloseClaimResult =
  /** This tick owns the close. */
  | { status: 'claimed' }
  /** Already sent, or another tick took it between the read and the write. */
  | { status: 'lost' }
  | { status: 'failed'; error: string }

/**
 * Claim the close. See the module header for why one statement does both jobs.
 *
 * `now` is written rather than `now()` so the processor's single clock decides,
 * the same reason every sibling processor threads one.
 */
export async function claimWarmClose(
  supabase: AdminSupabaseClient,
  guestId: string,
  now: Date,
): Promise<WarmCloseClaimResult> {
  const { data, error } = await supabase
    .from('guests')
    .update({ warm_close_sent_at: now.toISOString() })
    .eq('id', guestId)
    .is('warm_close_sent_at', null)
    .select('id')
  if (error) return { status: 'failed', error: error.message }
  return (data ?? []).length === 1 ? { status: 'claimed' } : { status: 'lost' }
}

/**
 * Release a claim this tick took and could not use.
 *
 * Only for a close that never reached the guest. A released claim lets a later
 * tick try again inside the two-hour window, which is the right outcome: the
 * guest has not been closed, so the marker should not say they have.
 *
 * Scoped to the exact timestamp this tick wrote, so it can never clear a marker
 * some other path set in between.
 */
export async function releaseWarmCloseClaim(
  supabase: AdminSupabaseClient,
  guestId: string,
  claimedAt: Date,
): Promise<void> {
  const { error } = await supabase
    .from('guests')
    .update({ warm_close_sent_at: null })
    .eq('id', guestId)
    .eq('warm_close_sent_at', claimedAt.toISOString())
  if (error) {
    console.warn(
      '[warm-close] could not release claim; this guest will not be closed again',
      {
        guestId,
        error: error.message,
      },
    )
  }
}

/**
 * Mark the close as sent from the IN-CONVERSATION path.
 *
 * Not a CAS: by the time this runs the message has already reached the guest, so
 * the only question is whether the marker records it. `is null` still guards, so
 * a guest closed by the timer moments earlier keeps that earlier timestamp
 * rather than having it overwritten.
 */
export async function markWarmCloseSent(
  supabase: AdminSupabaseClient,
  guestId: string,
  now: Date,
): Promise<StoreResult<'marked' | 'already_marked'>> {
  const { data, error } = await supabase
    .from('guests')
    .update({ warm_close_sent_at: now.toISOString() })
    .eq('id', guestId)
    .is('warm_close_sent_at', null)
    .select('id')
  if (error) return { ok: false, error: error.message }
  return {
    ok: true,
    data: (data ?? []).length === 1 ? 'marked' : 'already_marked',
  }
}
