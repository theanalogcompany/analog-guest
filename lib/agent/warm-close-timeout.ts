// TAC-560: sign off a conversation that has gone quiet.
//
// TWO SIGN-OFFS since TAC-575, and the processor decides which per guest:
//
//   plain   the warm "line is open" close after a FIRST conversation goes
//           quiet. Once per guest ever (`guests.warm_close_sent_at`).
//   happy   for a guest whose visit check-in reads good: the sign-off carries
//           the review invitation. Once per guest ever too, but of a different
//           thing (`guests.review_asked_at`), and NOT limited to a first
//           conversation: a regular who says "so good" and goes quiet is
//           invited as well.
//
// Both are GENERATED. TAC-568 sent the plain close as a fixed per-venue string;
// TAC-575 reversed that, and the venue's text is now a guide to its content.
//
// Called every minute by the external HTTP cron (cron-job.org) that hits
// /api/cron/warm-close. SIXTH concrete cron-processor sibling of
// processDueCommitments, processDueFollowups, processDueKnowledgeGaps,
// processDueCommitmentLifecycle, processInstagramWindowWarnings and
// processDueScanGreetings. Still concrete-not-generic: the shared
// find-eligible -> claim -> side-effect seam stays unextracted.
//
// A ROUTE OF ITS OWN, for TAC-536's reason: this SENDS UNPROMPTED MESSAGES TO
// GUESTS, and a dedicated cron-job.org entry can be paused in one click without
// also switching off the operator window warnings.
//
// SCOPE:
//
//   Instagram only (ruled 2026-09-29). The text arm is one refusal, recorded as
//   a follow-up.
//   Plain: any first Instagram conversation (TAC-575, ruled 2026-10-06). It
//   was first-visit QR scans only; a guest who simply DMs and then goes quiet
//   is now closed the same way, because the in-conversation close no longer
//   rides on a stored name and nothing else would reach them.
//   Happy: any Instagram guest with a good check-in on the venue-local day,
//   never before asked for a review, at a venue with a review link.
//
// EVERY CONDITION IS RE-CHECKED HERE, never settled earlier. Nothing is stored
// between ticks except the marker, so there is nothing that could be stale: the
// due set is derived from `messages` on every tick.
//
// ORDER, and it is not arbitrary. Everything that means "this sign-off should
// never happen" runs BEFORE the claim, because the claim is what burns the
// guest's one close, or their one review invitation, for ever. The claim runs
// last, immediately before generation.
//
// WHAT IS NOT CHECKED HERE: Meta's 24-hour reply window.
// dispatch-instagram-reply.ts re-derives it unconditionally immediately before
// every Instagram send, and a second copy would be a second definition of the
// same deadline. Two hours is well inside it anyway.

import { randomUUID } from 'node:crypto'

import { createAdminClient } from '@/lib/db/admin'
import { parseFollowupRules, venueLocalDate } from '@/lib/schemas'
import { isVenueProcessingHalted } from '@/lib/venues/status'
import {
  captureWarmCloseSent,
  captureWarmCloseSkipped,
} from '@/lib/analytics/posthog'
import { recordProactiveSend } from '@/lib/followups/inquiry-followup-store'
import { isTooSoonAfterProactive } from '@/lib/followups/proactive-spacing'
import { isQuietHour } from './followup-rules'
import type { AgentResult, SignOffKind } from './types'
import {
  deriveSignOffReviewAsk,
  markReviewAsked,
  releaseReviewAskClaim,
} from './review-ask'
import {
  checkbackWentUnanswered,
  COUNTER_ARRIVAL_WINDOW_MS,
  isCheckbackTooLate,
  isCheckinFresh,
  lastComplaintFollowupAt,
  lastProactiveWasThisVisit,
  owesAfterComplaintReviewAsk,
  owesCheckback,
  visitStartFor,
  type VisitCheckin,
} from './visit-checkin'
import {
  loadComplaintCheckins,
  loadLastInboundAt,
  loadVisitCheckin,
} from './visit-checkin-store'
import { handleFollowup } from './handle-followup'
import { loadPendingRowsBySlot } from './pending-slots'
import {
  isFirstConversation,
  isWarmCloseDue,
  isWarmCloseTooLate,
  WARM_CLOSE_MAX_AGE_MS,
  warmCloseFloorMs,
  weAskedAQuestion,
} from './warm-close'
import {
  claimWarmClose,
  loadWarmCloseBlocker,
  loadWarmCloseCandidates,
  loadWarmCloseGuestFacts,
  loadWarmCloseVenues,
  releaseWarmCloseClaim,
  type WarmCloseCandidate,
  type WarmCloseVenue,
} from './warm-close-store'

type AdminSupabaseClient = ReturnType<typeof createAdminClient>

/**
 * Why a candidate was not closed. Every one is a distinct cause with a distinct
 * fix, which is why none is collapsed into a neighbour: "we asked them
 * something" and "they already got the close" are answered differently.
 */
export type WarmCloseSkipReason =
  /** The floor has not elapsed. Comes round again next tick. */
  | 'not_yet'
  /** Past the two-hour bound. */
  | 'too_late'
  /** Already closed, from either path. */
  | 'already_closed'
  /** Past their first conversation. */
  | 'not_first_conversation'
  /** TAC-575: staff answered this guest by hand. No automated close at all. */
  | 'staff_replied'
  /** TAC-575: the conversation contains a complaint. No automated close at all. */
  | 'complaint_in_conversation'
  /**
   * TAC-575: this visit is still owed its check-back. Transient: the check-back
   * and the close both key on about ten quiet minutes, and the check-back goes
   * first.
   */
  | 'checkback_pending'
  /**
   * TAC-575: the check-back went out and the guest did not answer it. Ruled
   * 2026-10-06: "send nothing more".
   */
  | 'checkback_unanswered'
  | 'opted_out'
  | 'venue_paused'
  | 'quiet_hours'
  /** An operator has a card for this guest. */
  | 'card_pending'
  /** Not an Instagram conversation. */
  | 'not_instagram'
  /**
   * This venue has no `followup_rules.warm_close_text`, so there is no plain
   * close to send. Counted rather than silent: an unconfigured venue should be
   * visible in the tick summary, not indistinguishable from one with no
   * candidates.
   */
  | 'no_warm_close_text'
  /**
   * TAC-386: a proactive message reached this guest within the last hour, so
   * the close waits rather than stacking on it. Transient; it comes round again
   * inside the two-hour bound.
   */
  | 'too_soon_after_proactive'

  /** Another tick claimed it first. */
  | 'claim_lost'
  | 'guest_unreadable'

export interface ProcessWarmClosesResult {
  /** Candidate outbound rows considered. */
  scanned: number
  /** Guests this run claimed and closed. */
  closed: number
  /** Candidates skipped before the claim, by reason. */
  skipped: Record<string, number>
  /** Candidates that threw. */
  errored: number
}

/** The venue facts every gate needs, resolved once per venue per tick. */
interface VenueGate {
  venue: WarmCloseVenue
  pauseMs: number
  conversationWindowMs: number
  quietHours: boolean
  /** What this venue's plain close covers, '' when unconfigured (no plain close). */
  warmCloseText: string
}

function resolveVenueGate(venue: WarmCloseVenue, now: Date): VenueGate {
  const rules = parseFollowupRules(venue.followupRules)
  return {
    venue,
    pauseMs: rules.warm_close_pause_minutes * 60 * 1000,
    conversationWindowMs: rules.recent_conversation_hours * 60 * 60 * 1000,
    warmCloseText: rules.warm_close_text,
    // The ONE definition of quiet hours, imported rather than restated. Note it
    // fails OPEN on an unreadable timezone (returns false, so the close is
    // allowed): that direction is inherited from the follow-up engine
    // deliberately rather than re-decided here, because two definitions of
    // "is it the middle of the night" is the worse outcome.
    quietHours:
      venue.timezone !== null &&
      isQuietHour(
        now,
        venue.timezone,
        rules.quiet_hours_start_local,
        rules.quiet_hours_end_local,
      ),
  }
}

/**
 * One tick. Never throws: a throw handling one candidate becomes an `errored`
 * count and the rest are still handled, the posture every sibling takes.
 */
export async function processDueWarmCloses(
  now: Date = new Date(),
  supabase: AdminSupabaseClient = createAdminClient(),
): Promise<ProcessWarmClosesResult> {
  const result: ProcessWarmClosesResult = {
    scanned: 0,
    closed: 0,
    skipped: {},
    errored: 0,
  }
  const bump = (reason: WarmCloseSkipReason) => {
    result.skipped[reason] = (result.skipped[reason] ?? 0) + 1
  }

  const venues = await loadWarmCloseVenues(supabase)
  if (!venues.ok) {
    console.error('[warm-close] could not read venues', { error: venues.error })
    result.errored += 1
    return result
  }

  for (const venue of venues.data) {
    const gate = resolveVenueGate(venue, now)

    // Venue-wide gates first, so a paused or sleeping venue costs one venues row
    // rather than a candidate scan per tick.
    //
    // A DENY-LIST on status, never an allow-list on 'active': the live pilot
    // venue is `pending` (docs/decisions/0002).
    if (isVenueProcessingHalted(venue.status)) continue
    if (gate.quietHours) continue
    // Instagram only (ruled 2026-09-29). A venue with no Instagram account can
    // have no Instagram conversation, so skip it whole.
    if (venue.instagramAccountId === null) continue
    // TAC-575: a venue with no close text is NOT skipped whole any more. Such a
    // venue can still owe a guest a happy sign-off, which needs the review link
    // and not the text. The text is checked per candidate, on the plain path.

    // The window is bounded by the max age, so the scan is small: at two hours
    // this is a handful of rows per venue.
    const windowStart = new Date(now.getTime() - 2 * 60 * 60 * 1000)
    const candidates = await loadWarmCloseCandidates(
      supabase,
      venue.id,
      windowStart,
    )
    if (!candidates.ok) {
      console.error('[warm-close] could not read candidates', {
        venueId: venue.id,
        error: candidates.error,
      })
      result.errored += 1
      continue
    }

    for (const candidate of candidates.data) {
      result.scanned += 1
      try {
        const outcome = await considerCandidate(supabase, gate, candidate, now)
        if (outcome === 'closed') {
          result.closed += 1
        } else {
          bump(outcome)
          if (outcome !== 'not_yet') {
            await captureWarmCloseSkipped({
              venueId: candidate.venueId,
              guestId: candidate.guestId,
              messageId: candidate.messageId,
              reason: outcome,
            })
          }
        }
      } catch (e) {
        result.errored += 1
        console.error('[warm-close] candidate threw', {
          venueId: candidate.venueId,
          guestId: candidate.guestId,
          error: e instanceof Error ? e.message : String(e),
        })
      }
    }
  }

  return result
}

/**
 * Does this outcome mean the close will never reach the guest, so the claim
 * should be released and a later tick allowed to try again?
 *
 * Exported for the timed check-back (visit-checkin-timeout.ts), which claims
 * before sending in the same way and has the same answer for every status.
 *
 * A TOTAL MAP over AgentResult['status'], not `status !== 'sent'`, because the
 * answer is not the same for every non-sent outcome and a new status must be
 * made to decide rather than inherit. `readonly Status[]` would not be
 * exhaustiveness-checked; `satisfies Record<...>` is (root CLAUDE.md).
 */
export const RELEASES_CLAIM = {
  // It went out. The marker is correct.
  sent: false,
  // A card an operator can still approve, which would send it with no marker
  // written. Releasing here is a double-send. See the call site.
  queued: false,
  // Generation refused, dropped, silenced, or the run failed: nothing reached the
  // guest and nothing will. Let a later tick inside the window try again.
  refused: true,
  failed: true,
  dropped: true,
  silenced: true,
  // The venue was paused between this processor's own status check and the run.
  // Nothing sent, and the venue may be unpaused inside the window.
  venue_halted: true,
  // Something already answered this guest, which is as good as a close having
  // happened for the purpose of not talking over anyone. Nothing more is owed,
  // and re-trying would risk exactly the second message the check prevented.
  superseded: false,
  // Neither is reachable from this path (both belong to the inbound coalescing
  // and duplicate-delivery paths, and a warm close has no inbound), but both have
  // to say something. `false` is the safe direction: if one ever became
  // reachable, holding the marker costs a missed close rather than a second one.
  skipped_duplicate: false,
  coalesced: false,
  // TAC-572: inbound-only as well. This path checks the opt-out itself before
  // it ever runs the agent, and `false` is the same safe direction.
  guest_opted_out: false,
} as const satisfies Record<AgentResult['status'], boolean>

/**
 * One candidate, from "is it time" through to the send.
 *
 * Returns 'closed' or the reason it was not. Split out so the loop above reads
 * as scan-and-count and the decision reads as one ordered list.
 */
async function considerCandidate(
  supabase: AdminSupabaseClient,
  gate: VenueGate,
  candidate: WarmCloseCandidate,
  now: Date,
): Promise<'closed' | WarmCloseSkipReason> {
  // Cheapest first, and both are pure.
  if (isWarmCloseTooLate(candidate.sentAt, now)) return 'too_late'

  const askedQuestion = weAskedAQuestion(candidate.body)
  const floorMs = warmCloseFloorMs(gate.pauseMs, askedQuestion)
  if (!isWarmCloseDue(candidate.sentAt, now, floorMs)) return 'not_yet'

  // One read for the two markers, the opt-out and the channel.
  const facts = await loadWarmCloseGuestFacts(supabase, candidate.guestId)
  if (!facts.ok) {
    console.warn('[warm-close] guest unreadable; skipping', {
      guestId: candidate.guestId,
      error: facts.error,
    })
    return 'guest_unreadable'
  }
  if (facts.data.optedOutAt !== null) return 'opted_out'
  // Instagram only. An Instagram conversation needs an Instagram identifier;
  // resolving the channel properly is dispatchReply's job and it re-checks.
  if (facts.data.instagramScopedId === null) return 'not_instagram'

  // TAC-575: today's visit check-in, if this guest has one. It decides which
  // sign-off this is, and whether a check-back still comes first.
  let checkin: VisitCheckin | null = null
  const closeLocalDate =
    gate.venue.timezone !== null
      ? venueLocalDate(now, gate.venue.timezone)
      : null
  if (closeLocalDate !== null) {
    const loaded = await loadVisitCheckin(
      supabase,
      candidate.venueId,
      candidate.guestId,
      closeLocalDate,
    )
    if (!loaded.ok) {
      console.warn('[warm-close] visit check-in unreadable; skipping', {
        guestId: candidate.guestId,
        error: loaded.error,
      })
      return 'guest_unreadable'
    }
    checkin = loaded.data
  }

  // WHICH SIGN-OFF. A guest whose check-in reads good, who has never been
  // asked, at a venue with a review link, gets the invitation as their
  // sign-off (ruled 2026-10-06), in a first conversation or not: every guest
  // who answers "how is it?" is eventually offered it. Everyone else gets the
  // plain close, and only inside the rules that have always bounded it.
  //
  // Only a check-in from THIS visit counts (isCheckinFresh): the row is keyed
  // on the day, and a guest who said "so good" this morning and asked about
  // closing time this afternoon is not signing off the morning's drink.
  //
  // TAC-575 PR 5: AND A GUEST WHOSE COMPLAINT HAS BEEN FOLLOWED UP gets the
  // invitation too, with no happiness condition (ruled 2026-10-06): they wrote
  // at least once this visit and did not complain again
  // (owesAfterComplaintReviewAsk). Read only while the once-ever marker is
  // unspent, since nothing else here depends on it. An unreadable complaint
  // history skips the tick rather than reading as "no complaint": the wrong
  // guess sends this guest a plain close and they are never invited.
  const freshAnswer =
    checkin !== null && isCheckinFresh(checkin, now) ? checkin.answer : null
  let followedUpAt: Date | null = null
  let afterComplaint = false
  if (facts.data.reviewAskedAt === null) {
    const complaints = await loadComplaintCheckins(
      supabase,
      candidate.venueId,
      candidate.guestId,
    )
    if (!complaints.ok) {
      console.warn('[warm-close] complaint check-ins unreadable; skipping', {
        guestId: candidate.guestId,
        error: complaints.error,
      })
      return 'guest_unreadable'
    }
    followedUpAt = lastComplaintFollowupAt(complaints.data)
    if (followedUpAt !== null) {
      const lastInbound = await loadLastInboundAt(
        supabase,
        candidate.venueId,
        candidate.guestId,
      )
      if (!lastInbound.ok) {
        console.warn('[warm-close] last inbound unreadable; skipping', {
          guestId: candidate.guestId,
          error: lastInbound.error,
        })
        return 'guest_unreadable'
      }
      afterComplaint = owesAfterComplaintReviewAsk({
        followedUpAt,
        todaysCheckin: checkin,
        lastInboundAt: lastInbound.data,
        now,
      })
    }
  }
  const reviewAsk = deriveSignOffReviewAsk({
    checkinAnswer: freshAnswer,
    afterComplaint,
    reviewAskedAt: facts.data.reviewAskedAt,
    links: gate.venue.links,
  })
  // `happy` wins when both hold: a followed-up guest who says today's order is
  // good is, by then, exactly who the happy block describes.
  const signOff: SignOffKind =
    reviewAsk === null
      ? 'plain'
      : freshAnswer === 'good'
        ? 'happy'
        : 'after_complaint'
  const firstConversation =
    facts.data.firstContactedAt !== null &&
    isFirstConversation(
      facts.data.firstContactedAt,
      now,
      gate.conversationWindowMs,
    )
  if (reviewAsk === null) {
    // The plain close: once per guest ever, first conversation only, and only
    // for a venue that has been given one.
    if (facts.data.warmCloseSentAt !== null) return 'already_closed'
    if (!firstConversation) return 'not_first_conversation'
    if (gate.warmCloseText.trim() === '') return 'no_warm_close_text'
  }

  // TAC-575 (ruled 2026-10-06): a person in the thread, or a complaint in it,
  // means no automated close at all. With the permanent checks, before any
  // claim. An unreadable thread is not "nothing blocks": skip this tick.
  //
  // The stretch read is the conversation this close would end: all of a first
  // conversation, or, for a returning guest's happy sign-off, this visit, which
  // starts no earlier than the counter window before the order.
  //
  // A FOLLOWED-UP COMPLAINT IS NOT "A COMPLAINT IN THIS CONVERSATION". For a
  // guest whose complaint has been followed up, the stretch is this visit even
  // inside a first conversation: read from first contact it would find the
  // very complaint the follow-up answered and refuse the invitation the ruling
  // sends them. A NEW complaint this visit is still inside the stretch.
  const visitStart =
    checkin !== null
      ? new Date(checkin.orderedAt.getTime() - COUNTER_ARRIVAL_WINDOW_MS)
      : followedUpAt !== null
        ? visitStartFor(followedUpAt)
        : new Date(now.getTime() - WARM_CLOSE_MAX_AGE_MS)
  const blockerSince =
    reviewAsk !== null && followedUpAt !== null
      ? visitStart
      : firstConversation && facts.data.firstContactedAt !== null
        ? facts.data.firstContactedAt
        : visitStart
  const blocker = await loadWarmCloseBlocker(
    supabase,
    candidate.venueId,
    candidate.guestId,
    blockerSince,
  )
  if (!blocker.ok) {
    console.warn('[warm-close] thread unreadable; skipping', {
      guestId: candidate.guestId,
      error: blocker.error,
    })
    return 'guest_unreadable'
  }
  if (blocker.data !== null) return blocker.data

  // TAC-575: the check-back comes first, and an unanswered one ends the visit.
  //
  // Both this close and the timed check-back fire on about ten quiet minutes,
  // so without this the guest who had not tried their drink yet would get "the
  // line is open" instead of being checked back on. And a guest who then
  // ignores the check-back gets nothing more, by ruling.
  //
  // "Unanswered" is read from the guest's side: nothing of theirs has arrived
  // since the check-back went out (checkbackWentUnanswered says why it is not
  // a comparison between two of our own timestamps).
  if (checkin !== null) {
    if (owesCheckback(checkin) && !isCheckbackTooLate(checkin.orderedAt, now)) {
      return 'checkback_pending'
    }
    if (checkin.checkbackClaimedAt !== null) {
      const lastInbound = await loadLastInboundAt(
        supabase,
        candidate.venueId,
        candidate.guestId,
      )
      if (!lastInbound.ok) {
        console.warn('[warm-close] last inbound unreadable; skipping', {
          guestId: candidate.guestId,
          error: lastInbound.error,
        })
        return 'guest_unreadable'
      }
      if (checkbackWentUnanswered(checkin, lastInbound.data)) {
        return 'checkback_unanswered'
      }
    }
  }

  // NO "ALREADY CLOSED IN CONVERSATION" CHECK ANY MORE. TAC-560 stood the timer
  // down when the guest's last message was a sign-off, because the goodbye
  // reply had carried the close. Ruled 2026-10-06, no reply carries one: a
  // guest who says "bye" is signed off HERE, ten quiet minutes later, so that
  // check would now refuse exactly the guests this is for.

  // An operator holding a card for this guest is mid-decision; a warm close
  // landing under them would answer for them. loadPendingRowsBySlot is the ONE
  // per-guest pending read in the repo and it fails OPEN to two empty slots.
  const pending = await loadPendingRowsBySlot(
    candidate.venueId,
    candidate.guestId,
  )
  if (
    pending !== null &&
    (pending.obligation !== null || pending.conversation.length > 0)
  ) {
    return 'card_pending'
  }

  // TAC-386: no two proactive messages within the hour (ruled 2026-09-30). A
  // DELAY, not a refusal: the close comes round again on a later tick inside
  // its own two-hour bound.
  //
  // TAC-575 (ruled 2026-10-06): EXCEPT against this visit's own greeting and
  // check-back. The three belong to one visit and are not spaced against each
  // other; the rule still applies against everything else.
  if (
    isTooSoonAfterProactive(facts.data.lastProactiveSendAt, now) &&
    !(
      checkin !== null &&
      lastProactiveWasThisVisit(
        facts.data.lastProactiveSendAt,
        checkin.orderedAt,
      )
    )
  ) {
    return 'too_soon_after_proactive'
  }

  // CLAIM LAST, immediately before generating. Everything above could have said
  // "never"; from here on something of the guest's that exists once is spent.
  //
  // WHICH marker depends on the sign-off, because each kind is once of a
  // different thing:
  //
  //   plain   the warm close, once per guest ever: `warm_close_sent_at`.
  //   happy   the review invitation, once per guest ever: `review_asked_at`.
  //           markReviewAsked is already the compare-and-set. The praise ask
  //           stamps that marker AFTER the send; this path cannot, because two
  //           ticks a minute apart would both find the guest unasked.
  //
  // A happy sign-off in a first conversation ALSO takes the warm-close marker,
  // best effort: it is that guest's close, and a plain one must not follow it.
  // Losing that second claim does not stop the send.
  let reviewClaimedAt: Date | null = null
  let warmCloseClaimed = false
  if (reviewAsk !== null) {
    const marked = await markReviewAsked({
      venueId: candidate.venueId,
      guestId: candidate.guestId,
      now,
    })
    if (!marked.ok) {
      throw new Error(`sign-off review claim failed: ${marked.error}`)
    }
    if (marked.data === 'already_marked') return 'claim_lost'
    reviewClaimedAt = now
    if (firstConversation && facts.data.warmCloseSentAt === null) {
      const alsoClose = await claimWarmClose(supabase, candidate.guestId, now)
      warmCloseClaimed = alsoClose.status === 'claimed'
    }
  } else {
    const claim = await claimWarmClose(supabase, candidate.guestId, now)
    if (claim.status === 'lost') return 'claim_lost'
    if (claim.status === 'failed') {
      console.error('[warm-close] claim failed', {
        guestId: candidate.guestId,
        error: claim.error,
      })
      throw new Error(`warm-close claim failed: ${claim.error}`)
    }
    warmCloseClaimed = true
  }

  const agentRunId = randomUUID()
  const result = await handleFollowup({
    venueId: candidate.venueId,
    guestId: candidate.guestId,
    agentRunId,
    trigger: {
      reason: 'warm_close',
      triggeredAt: now,
      warmClose:
        reviewAsk !== null && reviewClaimedAt !== null
          ? {
              answersMessageId: candidate.messageId,
              signOff,
              reviewAsk,
              reviewClaimedAt,
            }
          : { answersMessageId: candidate.messageId, signOff: 'plain' },
    },
  })

  // A sign-off that will NEVER reach the guest releases what it claimed, so a
  // later tick inside the two-hour window can try again. Without this a refused
  // generation or a shut Meta window would spend the guest's one close, or
  // their one review invitation, on nothing.
  //
  // `queued` DELIBERATELY KEEPS THE CLAIM, and that asymmetry is the whole reason
  // RELEASES_CLAIM is a total map rather than `status !== 'sent'`. A queued
  // sign-off is a card an operator can still approve, which sends it; releasing
  // there opens a double-send. Keeping it costs at most one guest never being
  // closed, or never being asked, if the operator skips the card (the second
  // accepted 2026-10-06 rather than add a claim column of its own).
  if (RELEASES_CLAIM[result.status]) {
    if (warmCloseClaimed) {
      await releaseWarmCloseClaim(supabase, candidate.guestId, now)
    }
    if (reviewClaimedAt !== null) {
      await releaseReviewAskClaim({
        venueId: candidate.venueId,
        guestId: candidate.guestId,
        claimedAt: reviewClaimedAt,
      })
    }
    console.warn('[warm-close] sign-off did not send; claim released', {
      agentRunId,
      guestId: candidate.guestId,
      signOff,
      status: result.status,
    })
    await captureWarmCloseSkipped({
      venueId: candidate.venueId,
      guestId: candidate.guestId,
      messageId: candidate.messageId,
      reason: 'claim_lost',
      agentStatus: result.status,
    })
    return 'claim_lost'
  }

  // TAC-386: the spacing marker, so the other proactive mechanisms can see this
  // close. Only on a confirmed send: a `queued` card is an operator's decision
  // and an operator can see the whole thread. A fresh clock, for the reason the
  // check-back uses one: `now` predates the message it would describe.
  if (result.status === 'sent') {
    await recordProactiveSend(supabase, candidate.guestId, new Date())
  }

  await captureWarmCloseSent({
    agentRunId,
    venueId: candidate.venueId,
    guestId: candidate.guestId,
    via: 'pause_timer',
    answersMessageId: candidate.messageId,
    pauseMs: now.getTime() - candidate.sentAt.getTime(),
    weAskedAQuestion: askedQuestion,
  })
  return 'closed'
}
