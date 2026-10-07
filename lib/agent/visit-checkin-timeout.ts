// TAC-575: check back once on a guest who was asked how their order is and
// then went quiet.
//
// Called every minute by the external HTTP cron (cron-job.org) that hits
// /api/cron/visit-checkbacks. SEVENTH concrete cron-processor sibling of
// processDueWarmCloses and the six before it. Still concrete-not-generic: the
// shared find-eligible -> claim -> side-effect seam stays unextracted.
//
// A ROUTE OF ITS OWN, for TAC-536's reason: this SENDS UNPROMPTED MESSAGES TO
// GUESTS, and a dedicated cron-job.org entry can be paused in one click without
// also switching off the warm close or the scan greeting.
//
// WHO IT IS FOR (ruled 2026-10-06). A guest named their order at the counter,
// was asked how it is, and either said they had not tried it yet or did not
// reply. About ten minutes after the order, if they are still quiet, they get
// one short check-back. If they do not answer that, nothing more is sent.
//
// A guest who is STILL CHATTING is not this processor's: it needs our message
// to be the newest in the thread. Their check-back is worked into a reply
// instead (the check_back_on_order intention), and that reply takes the same
// claim this does, so exactly one of the two ever asks.
//
// EVERY CONDITION IS RE-CHECKED HERE on `now`, never settled earlier. The due
// set is one indexed read of `visit_checkins`; everything about the guest, the
// venue and the thread is read fresh per row.
//
// ORDER, as in warm-close-timeout.ts and for its reason: everything that means
// "not now" or "never" runs BEFORE the claim, because the claim is the visit's
// one check-back. The claim runs last, immediately before generation.
//
// THE ONE-HOUR SPACING RULE DOES NOT APPLY AGAINST THIS VISIT'S OWN GREETING
// (ruled 2026-10-06). It still applies against everything else. See
// lastProactiveWasThisVisit.
//
// WHAT IS NOT CHECKED HERE: Meta's 24-hour reply window.
// dispatch-instagram-reply.ts re-derives it immediately before every Instagram
// send, and thirty minutes after the guest's own message is well inside it.

import { randomUUID } from 'node:crypto'

import { createAdminClient } from '@/lib/db/admin'
import {
  loadInquiryGuestFacts,
  recordProactiveSend,
} from '@/lib/followups/inquiry-followup-store'
import { isTooSoonAfterProactive } from '@/lib/followups/proactive-spacing'
import { parseFollowupRules } from '@/lib/schemas'
import { isVenueProcessingHalted } from '@/lib/venues/status'
import { isQuietHour } from './followup-rules'
import { handleFollowup } from './handle-followup'
import { loadPendingRowsBySlot } from './pending-slots'
import {
  CHECKBACK_DELAY_MS,
  CHECKBACK_MAX_AGE_MS,
  hasBeenQuietLongEnough,
  lastProactiveWasThisVisit,
} from './visit-checkin'
import {
  claimVisitCheckback,
  loadDueVisitCheckbacks,
  loadNewestThreadMessage,
  markVisitCheckbackSent,
  releaseVisitCheckbackClaim,
  type DueVisitCheckback,
} from './visit-checkin-store'
import { loadWarmCloseVenues, type WarmCloseVenue } from './warm-close-store'
import { RELEASES_CLAIM } from './warm-close-timeout'

type AdminSupabaseClient = ReturnType<typeof createAdminClient>

/**
 * Why a due check-back was not sent this tick. Each is a distinct cause with a
 * distinct fix. All but `claim_lost` leave the row unclaimed, so it comes
 * round again next tick until the order is too old (CHECKBACK_MAX_AGE_MS).
 */
export type VisitCheckbackSkipReason =
  | 'venue_unknown'
  | 'venue_paused'
  | 'quiet_hours'
  /** The venue has no Instagram account, or the guest no Instagram identifier. */
  | 'not_instagram'
  | 'guest_unreadable'
  | 'opted_out'
  /** The guest's message is the newest. Their reply carries the check-back. */
  | 'guest_wrote_last'
  /** Our newest message has not reached them: a card is waiting, or it failed. */
  | 'last_message_not_delivered'
  /** Our last message is too fresh to follow with another. */
  | 'not_quiet_yet'
  /** An operator has a card for this guest. */
  | 'card_pending'
  /** An unprompted message from OUTSIDE this visit went out within the hour. */
  | 'too_soon_after_proactive'
  /** Someone else claimed it, the guest answered, or the send did not happen. */
  | 'claim_lost'

export interface ProcessVisitCheckbacksResult {
  /** Due rows considered. */
  scanned: number
  /** Check-backs this run claimed and sent or queued. */
  checkedBack: number
  /** Rows skipped, by reason. */
  skipped: Record<string, number>
  /** Rows that threw. */
  errored: number
}

/**
 * One tick. Never throws: a throw handling one row becomes an `errored` count
 * and the rest are still handled, the posture every sibling takes.
 */
export async function processDueVisitCheckbacks(
  now: Date = new Date(),
  supabase: AdminSupabaseClient = createAdminClient(),
): Promise<ProcessVisitCheckbacksResult> {
  const result: ProcessVisitCheckbacksResult = {
    scanned: 0,
    checkedBack: 0,
    skipped: {},
    errored: 0,
  }

  // The due read first: on almost every tick it is empty, and an empty tick
  // should cost one indexed read and no venue scan.
  const due = await loadDueVisitCheckbacks(
    supabase,
    new Date(now.getTime() - CHECKBACK_DELAY_MS),
    new Date(now.getTime() - CHECKBACK_MAX_AGE_MS),
  )
  if (!due.ok) {
    console.error('[visit-checkback] could not read due rows', {
      error: due.error,
    })
    result.errored += 1
    return result
  }
  if (due.data.length === 0) return result

  const venues = await loadWarmCloseVenues(supabase)
  if (!venues.ok) {
    console.error('[visit-checkback] could not read venues', {
      error: venues.error,
    })
    result.errored += 1
    return result
  }
  const venueById = new Map(venues.data.map((v) => [v.id, v]))

  for (const row of due.data) {
    result.scanned += 1
    try {
      const outcome = await considerRow(
        supabase,
        venueById.get(row.venueId) ?? null,
        row,
        now,
      )
      if (outcome === 'checked_back') {
        result.checkedBack += 1
      } else {
        result.skipped[outcome] = (result.skipped[outcome] ?? 0) + 1
      }
    } catch (e) {
      result.errored += 1
      console.error('[visit-checkback] row threw', {
        venueId: row.venueId,
        guestId: row.guestId,
        error: e instanceof Error ? e.message : String(e),
      })
    }
  }

  return result
}

/** The venue-wide gates, in the warm close's order and for its reasons. */
function venueBlocks(
  venue: WarmCloseVenue | null,
  now: Date,
): VisitCheckbackSkipReason | null {
  if (venue === null) return 'venue_unknown'
  // A DENY-LIST on status, never an allow-list on 'active': the live pilot
  // venue is `pending` (docs/decisions/0002).
  if (isVenueProcessingHalted(venue.status)) return 'venue_paused'
  if (venue.instagramAccountId === null) return 'not_instagram'
  const rules = parseFollowupRules(venue.followupRules)
  // The ONE definition of quiet hours. Fails OPEN on an unreadable timezone,
  // the direction the follow-up engine and the warm close both take.
  if (
    venue.timezone !== null &&
    isQuietHour(
      now,
      venue.timezone,
      rules.quiet_hours_start_local,
      rules.quiet_hours_end_local,
    )
  ) {
    return 'quiet_hours'
  }
  return null
}

/**
 * One due row, from "may it go now" through to the send.
 *
 * Returns 'checked_back' or the reason it was not.
 */
async function considerRow(
  supabase: AdminSupabaseClient,
  venue: WarmCloseVenue | null,
  row: DueVisitCheckback,
  now: Date,
): Promise<'checked_back' | VisitCheckbackSkipReason> {
  const blocked = venueBlocks(venue, now)
  if (blocked !== null) return blocked

  // The opt-out, the channel identifier and the spacing marker, in one read.
  // TAC-572 is what makes the first of those mean anything: before it nothing
  // wrote `opted_out_at`, and this is an unprompted message.
  const facts = await loadInquiryGuestFacts(supabase, row.guestId)
  if (!facts.ok) {
    console.warn('[visit-checkback] guest unreadable; skipping', {
      guestId: row.guestId,
      error: facts.error,
    })
    return 'guest_unreadable'
  }
  if (facts.data.optedOutAt !== null) return 'opted_out'
  if (facts.data.instagramScopedId === null) return 'not_instagram'

  // The thread, newest message first. This is what "the guest has gone quiet"
  // means, and it is also what keeps this off a guest whose reply is carrying
  // the check-back already, and off a thread staff are typing into.
  const newest = await loadNewestThreadMessage(
    supabase,
    row.venueId,
    row.guestId,
  )
  if (!newest.ok) {
    console.warn('[visit-checkback] thread unreadable; skipping', {
      guestId: row.guestId,
      error: newest.error,
    })
    return 'guest_unreadable'
  }
  if (newest.data === null || newest.data.direction === 'inbound') {
    return 'guest_wrote_last'
  }
  if (!newest.data.reachedGuest) return 'last_message_not_delivered'
  if (!hasBeenQuietLongEnough(newest.data.createdAt, now))
    return 'not_quiet_yet'

  // loadPendingRowsBySlot is the ONE per-guest pending read in the repo and it
  // fails OPEN to two empty slots.
  const pending = await loadPendingRowsBySlot(row.venueId, row.guestId)
  if (
    pending !== null &&
    (pending.obligation !== null || pending.conversation.length > 0)
  ) {
    return 'card_pending'
  }

  // The hour rule, except against this visit's own greeting. A DELAY, not a
  // refusal, as in the warm close: the row comes round again.
  if (
    isTooSoonAfterProactive(facts.data.lastProactiveSendAt, now) &&
    !lastProactiveWasThisVisit(
      facts.data.lastProactiveSendAt,
      row.checkin.orderedAt,
    )
  ) {
    return 'too_soon_after_proactive'
  }

  // Claim last, immediately before generating. It is a compare-and-set on the
  // row still being owed, so "it's great" landing on another turn a moment ago
  // loses here rather than getting a check-back on top of it.
  const claim = await claimVisitCheckback(supabase, {
    id: row.checkin.id,
    venueId: row.venueId,
    guestId: row.guestId,
    now,
    sent: false,
  })
  if (claim.status === 'lost') return 'claim_lost'
  if (claim.status === 'failed') {
    throw new Error(`visit check-back claim failed: ${claim.error}`)
  }

  const agentRunId = randomUUID()
  const result = await handleFollowup({
    venueId: row.venueId,
    guestId: row.guestId,
    agentRunId,
    trigger: {
      reason: 'visit_checkback',
      triggeredAt: now,
      visitCheckback: { answersMessageId: newest.data.id },
    },
  })

  // The warm close's own map and its own asymmetry: a check-back that will
  // never reach the guest gives the claim back, and one QUEUED for an operator
  // keeps it, because approving that card sends it and a released claim would
  // then send a second.
  if (RELEASES_CLAIM[result.status]) {
    await releaseVisitCheckbackClaim(supabase, {
      id: row.checkin.id,
      venueId: row.venueId,
      guestId: row.guestId,
      claimedAt: now,
    })
    console.warn('[visit-checkback] did not send; claim released', {
      agentRunId,
      guestId: row.guestId,
      status: result.status,
    })
    return 'claim_lost'
  }

  // Only on a confirmed send: the sent stamp is what tells the warm close an
  // unanswered check-back ended the visit, and the spacing marker is what lets
  // the other unprompted mechanisms see this one.
  if (result.status === 'sent') {
    await markVisitCheckbackSent(supabase, {
      id: row.checkin.id,
      venueId: row.venueId,
      guestId: row.guestId,
      now,
    })
    await recordProactiveSend(supabase, row.guestId, now)
  }

  console.log('[visit-checkback] checked back', {
    agentRunId,
    venueId: row.venueId,
    guestId: row.guestId,
    status: result.status,
    minutesSinceOrder: Math.round(
      (now.getTime() - row.checkin.orderedAt.getTime()) / 60000,
    ),
  })
  return 'checked_back'
}
