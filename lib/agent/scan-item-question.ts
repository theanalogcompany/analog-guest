// TAC-588: ask a receipt scanner how they liked what they ordered, about twenty
// minutes after the order.
//
// THE FLOW (ruled 2026-10-14). A scan of a receipt code binds the order and the
// hello compliments it, asking nothing. "How'd you like the cortado?" then goes
// at the order + twenty minutes, never sooner than five minutes after the
// hello (scanItemQuestionDueAt). It REPLACES the counter flow's "how is it so
// far?" and its ten-to-thirty-minute check-back for that visit, and becomes the
// visit's check-in: once it reaches the guest a `visit_checkins` row is written
// with the check-back already spent, so the answer is read as good / bad / not
// yet exactly as today, and the warm close, the review link and the complaint
// path follow it unchanged.
//
// IF THE GUEST WRITES BACK FIRST, THE TIMER IS CANCELLED FOR GOOD: the claim is
// taken with no send. Their reply's turn can ask instead, when it fits (the
// `scan_order_liked` intention).
//
// Called every minute from the check-back's own cron route,
// /api/cron/visit-checkbacks, right after processDueVisitCheckbacks, so pausing
// check-backs pauses this too: it is the check-back for a scan visit. EIGHTH
// concrete cron-processor sibling; the find-eligible -> claim -> side-effect
// seam stays unextracted.
//
// EVERY CONDITION IS RE-CHECKED HERE on `now`, in the check-back's order and
// for its reasons: everything that means "not now" or "never" runs before the
// claim, and the claim runs last, immediately before generation.
//
// THE ONE-HOUR SPACING RULE DOES NOT APPLY AGAINST THIS SCAN'S OWN HELLO
// (ruled 2026-10-14). It still applies against everything else
// (lastProactiveWasThisScan).
//
// WHAT IS NOT CHECKED HERE: Meta's 24-hour reply window, which the scan's own
// row opened and dispatch-instagram-reply.ts re-derives before every send.

import { randomUUID } from 'node:crypto'

import { createAdminClient } from '@/lib/db/admin'
import {
  loadInquiryGuestFacts,
  recordProactiveSend,
} from '@/lib/followups/inquiry-followup-store'
import { isTooSoonAfterProactive } from '@/lib/followups/proactive-spacing'
import { venueLocalDate } from '@/lib/schemas'
import { handleFollowup } from './handle-followup'
import { loadPendingRowsBySlot } from './pending-slots'
import {
  isScanItemQuestionTooLate,
  lastProactiveWasThisScan,
  SCAN_ITEM_QUESTION_AFTER_HELLO_MS,
} from './scan-arrival'
import {
  claimScanItemQuestion,
  guestHasWrittenSince,
  loadDueScanItemQuestions,
  recordScanItemQuestionOutcome,
  releaseScanItemQuestionClaim,
  settleScanItemQuestion,
  type DueScanItemQuestion,
} from './scan-arrival-store'
import { loadScanOrder, pickComplimentItem } from './scan-order'
import { COUNTER_ARRIVAL_WINDOW_MS } from './visit-checkin'
import {
  loadNewestThreadMessage,
  recordVisitCheckinAsked,
} from './visit-checkin-store'
import {
  venueBlocks,
  type VisitCheckbackSkipReason,
} from './visit-checkin-timeout'
import {
  loadWarmCloseBlocker,
  loadWarmCloseVenues,
  type WarmCloseVenue,
} from './warm-close-store'
import { RELEASES_CLAIM } from './warm-close-timeout'

type AdminSupabaseClient = ReturnType<typeof createAdminClient>

/**
 * Why a due question was not sent this tick. The first group leaves the row
 * due, so a later tick tries again; the second settles it for good.
 */
export type ScanItemQuestionSkipReason =
  // Retried next tick.
  | VisitCheckbackSkipReason
  // Settled: claimed with no send.
  /** The guest wrote after the hello. The timer is cancelled. */
  | 'guest_replied'
  /** Held past SCAN_ITEM_QUESTION_MAX_AGE_MS. Given up, not sent late. */
  | 'too_late'
  /** The order no longer resolves to an item (re-bound, retracted). */
  | 'no_item'
  /**
   * Generation refused the question (a pre-send check failing closed). That
   * refusal is deterministic for this turn's inputs, so it is settled, not
   * retried every minute for two hours.
   */
  | 'refused'
  /** The hello reached the guest less than five minutes ago (it was held). */
  | 'hello_too_recent'

export interface ProcessScanItemQuestionsResult {
  scanned: number
  asked: number
  skipped: Record<string, number>
  errored: number
}

/** One tick. Never throws, like every sibling. */
export async function processDueScanItemQuestions(
  now: Date = new Date(),
  supabase: AdminSupabaseClient = createAdminClient(),
): Promise<ProcessScanItemQuestionsResult> {
  const result: ProcessScanItemQuestionsResult = {
    scanned: 0,
    asked: 0,
    skipped: {},
    errored: 0,
  }

  const due = await loadDueScanItemQuestions(supabase, now)
  if (!due.ok) {
    console.error('[scan-item-question] could not read due rows', {
      error: due.error,
    })
    result.errored += 1
    return result
  }
  if (due.data.length === 0) return result

  const venues = await loadWarmCloseVenues(supabase)
  if (!venues.ok) {
    console.error('[scan-item-question] could not read venues', {
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
      if (outcome === 'asked') result.asked += 1
      else result.skipped[outcome] = (result.skipped[outcome] ?? 0) + 1
    } catch (e) {
      result.errored += 1
      console.error('[scan-item-question] row threw', {
        scanArrivalId: row.id,
        error: e instanceof Error ? e.message : String(e),
      })
    }
  }
  return result
}

/**
 * Settle a question that will never be asked, so no later tick looks again.
 * A lost claim means another runner settled it first; either way it is done.
 */
async function settleUnasked(
  supabase: AdminSupabaseClient,
  row: DueScanItemQuestion,
  now: Date,
  reason: 'guest_replied' | 'too_late' | 'no_item',
): Promise<ScanItemQuestionSkipReason> {
  // The outcome is what lets the reply path ask after a CANCEL and never
  // after a send: the claim alone looks the same for both.
  const claim = await settleScanItemQuestion(
    supabase,
    row.id,
    now,
    reason === 'guest_replied' ? 'cancelled' : reason,
  )
  if (claim.status === 'failed') {
    throw new Error(`scan item question claim failed: ${claim.error}`)
  }
  console.log('[scan-item-question] not asked', {
    event:
      reason === 'guest_replied'
        ? 'scan_item_question_cancelled'
        : 'scan_item_question_dropped',
    reason,
    scanArrivalId: row.id,
    venueId: row.venueId,
    guestId: row.guestId,
  })
  return claim.status === 'claimed' ? reason : 'claim_lost'
}

async function considerRow(
  supabase: AdminSupabaseClient,
  venue: WarmCloseVenue | null,
  row: DueScanItemQuestion,
  now: Date,
): Promise<'asked' | ScanItemQuestionSkipReason> {
  // The venue first, quiet hours included: a question held overnight waits
  // for the morning, and is given up once it is too late (below).
  const blocked = venueBlocks(venue, now)
  if (blocked !== null) {
    if (blocked === 'quiet_hours' && isScanItemQuestionTooLate(row.dueAt, now))
      return settleUnasked(supabase, row, now, 'too_late')
    return blocked
  }
  if (venue === null) return 'venue_unknown'
  if (isScanItemQuestionTooLate(row.dueAt, now))
    return settleUnasked(supabase, row, now, 'too_late')

  const facts = await loadInquiryGuestFacts(supabase, row.guestId)
  if (!facts.ok) return 'guest_unreadable'
  if (facts.data.optedOutAt !== null) return 'opted_out'
  if (facts.data.instagramScopedId === null) return 'not_instagram'

  // THE CANCELLATION. Anything the guest wrote after the hello ends the timer
  // for good; their reply's own turn may ask instead. Fails closed (an
  // unreadable read cancels), the direction that never asks over them.
  if (
    await guestHasWrittenSince(
      supabase,
      row.venueId,
      row.guestId,
      row.helloClaimedAt,
    )
  )
    return settleUnasked(supabase, row, now, 'guest_replied')

  // What to ask about: the item the hello complimented, picked again from
  // the same order and menu.
  const order = await loadScanOrder(supabase, row)
  const pick =
    order.kind === 'bound'
      ? pickComplimentItem({
          lineItemNames: order.lineItemNames,
          discoveredLabel: order.discoveredLabel,
          menuItems: venue.menuItems,
        })
      : null
  if (order.kind !== 'bound' || pick === null)
    return settleUnasked(supabase, row, now, 'no_item')

  const newest = await loadNewestThreadMessage(
    supabase,
    row.venueId,
    row.guestId,
  )
  if (!newest.ok) return 'guest_unreadable'
  if (newest.data === null || newest.data.direction === 'inbound')
    return 'guest_wrote_last'
  // The hello is still on an operator's desk, or did not go.
  if (!newest.data.reachedGuest) return 'last_message_not_delivered'
  // The ruled floor is five minutes after the hello REACHED them. The due
  // time was set from when the hello was claimed, and a hello held for an
  // operator can be approved much later: our newest message since the scan
  // is then that hello, and the question waits out its five minutes.
  if (
    newest.data.createdAt.getTime() >= row.scannedAt.getTime() &&
    now.getTime() - newest.data.createdAt.getTime() <
      SCAN_ITEM_QUESTION_AFTER_HELLO_MS
  ) {
    return 'hello_too_recent'
  }

  const pending = await loadPendingRowsBySlot(row.venueId, row.guestId)
  if (
    pending !== null &&
    (pending.obligation !== null || pending.conversation.length > 0)
  ) {
    return 'card_pending'
  }

  // Staff in the thread, or a complaint in it, means no automated message:
  // the check-back's rule, through the same check. Scoped from half an hour
  // before the scan, the counter window, rather than from the order: for a
  // slip scanned the next morning the order-anchored window would reach back
  // across a whole day of unrelated thread.
  const blocker = await loadWarmCloseBlocker(
    supabase,
    row.venueId,
    row.guestId,
    new Date(row.scannedAt.getTime() - COUNTER_ARRIVAL_WINDOW_MS),
  )
  if (!blocker.ok) return 'guest_unreadable'
  if (blocker.data !== null) return blocker.data

  // The hour rule, except against this scan's own hello. A delay, not a
  // refusal: the row comes round again.
  if (
    isTooSoonAfterProactive(facts.data.lastProactiveSendAt, now) &&
    !lastProactiveWasThisScan(facts.data.lastProactiveSendAt, row.scannedAt)
  ) {
    return 'too_soon_after_proactive'
  }

  const claim = await claimScanItemQuestion(supabase, row.id, now)
  if (claim.status === 'lost') return 'claim_lost'
  if (claim.status === 'failed') {
    throw new Error(`scan item question claim failed: ${claim.error}`)
  }

  const agentRunId = randomUUID()
  const result = await handleFollowup({
    venueId: row.venueId,
    guestId: row.guestId,
    agentRunId,
    trigger: {
      reason: 'visit_checkback',
      triggeredAt: now,
      visitCheckback: { answersMessageId: newest.data.id, scanItem: pick.item },
    },
  })

  // The check-back's map and its asymmetry: nothing reached the guest gives
  // the claim back; a card queued for an operator keeps it, because approving
  // the card sends it and a released claim would send a second.
  if (result.status === 'refused') {
    await recordRefusal(supabase, row, agentRunId)
    return 'refused'
  }
  if (RELEASES_CLAIM[result.status]) {
    await releaseScanItemQuestionClaim(supabase, row.id, now)
    console.warn('[scan-item-question] did not send; claim released', {
      agentRunId,
      scanArrivalId: row.id,
      status: result.status,
    })
    return 'send_failed'
  }

  // On a confirmed send: the sent stamp, the spacing marker so the other
  // unprompted mechanisms can see this one, and the visit's check-in. A fresh
  // clock, not the tick's: `now` was read before generation and the send.
  if (result.status !== 'sent') {
    await recordScanItemQuestionOutcome(supabase, row.id, {
      kind: 'kept',
      status: result.status,
    })
  }
  if (result.status === 'sent') {
    const sentAt = new Date()
    await recordScanItemQuestionOutcome(supabase, row.id, {
      kind: 'sent',
      sentAt,
    })
    await recordProactiveSend(supabase, row.guestId, sentAt)
    const localDate =
      (venue.timezone !== null
        ? venueLocalDate(sentAt, venue.timezone)
        : null) ?? venueLocalDate(sentAt, 'UTC')
    if (localDate !== null) {
      const recorded = await recordVisitCheckinAsked(supabase, {
        venueId: row.venueId,
        guestId: row.guestId,
        venueLocalDate: localDate,
        orderMessageId: null,
        orderedAt: order.orderedAt,
        askedAt: sentAt,
        checkbackSpentAt: sentAt,
      })
      if (!recorded.ok) {
        console.error('[scan-item-question] visit check-in write failed', {
          agentRunId,
          scanArrivalId: row.id,
          error: recorded.error,
        })
      }
    }
  }

  console.log('[scan-item-question] asked', {
    event: 'scan_item_question_asked',
    agentRunId,
    scanArrivalId: row.id,
    venueId: row.venueId,
    guestId: row.guestId,
    status: result.status,
    minutesSinceOrder: Math.round(
      (now.getTime() - order.orderedAt.getTime()) / 60000,
    ),
  })
  return 'asked'
}

/**
 * A refused question keeps its claim, with the outcome `refused`, and is never
 * tried again. Deliberately unlike the check-back, whose thirty-minute window
 * bounds its retries: this one's window is two hours of every-minute ticks.
 */
async function recordRefusal(
  supabase: AdminSupabaseClient,
  row: DueScanItemQuestion,
  agentRunId: string,
): Promise<void> {
  const { error } = await supabase
    .from('instagram_scan_arrivals')
    .update({ item_question_outcome: 'refused' })
    .eq('id', row.id)
  console.warn('[scan-item-question] refused; given up', {
    event: 'scan_item_question_dropped',
    reason: 'refused',
    agentRunId,
    scanArrivalId: row.id,
    error: error?.message ?? null,
  })
}
