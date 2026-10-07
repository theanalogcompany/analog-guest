// TAC-560: sign off a conversation that has gone quiet.
//
// TWO SIGN-OFFS, and the processor decides which per guest (TAC-578, ruled
// 2026-10-07; TAC-575's two were different and both are gone):
//
//   plain   the "always here" close: one short line saying the guest can
//           message anytime. Once per guest EVER, across all conversations
//           (`guests.warm_close_sent_at`). Not on a visit, and not after a
//           question that armed an inquiry follow-up.
//   visit   for a guest who was asked how their order is, never said, chatted
//           about something else and went quiet in the shop: a light line
//           about the visit. Once per visit (a `sign_off` row in
//           `visit_messages`). It carries NO review link.
//
// A guest who SAID it is good is never signed off here: the reply to that
// answer is the sign-off (handleInbound; rule 3 as re-ruled 2026-10-07).
//
// Both are GENERATED.
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
//   Plain: any Instagram conversation that is not a visit, for a guest never
//   closed before.
//   Visit: any Instagram guest with a fresh check-in on the venue-local day
//   that reads neither good nor bad, who has written since being asked.
//
// EVERY CONDITION IS RE-CHECKED HERE, never settled earlier. Nothing is stored
// between ticks except the marker, so there is nothing that could be stale: the
// due set is derived from `messages` on every tick.
//
// ORDER, and it is not arbitrary. Everything that means "this sign-off should
// never happen" runs BEFORE the claim, because the claim is what burns the
// guest's one close, or the visit's one sign-off. The claim runs last,
// immediately before generation.
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
import { loadInstagramScanInstants } from '@/lib/recognition/load-scan-visits'
import type { AgentResult, SignOffKind } from './types'
import {
  checkbackWentUnanswered,
  COUNTER_ARRIVAL_WINDOW_MS,
  isCheckbackTooLate,
  isCheckinFresh,
  lastProactiveWasThisVisit,
  owesCheckback,
  timedSignOffFor,
  type VisitCheckin,
} from './visit-checkin'
import { loadLastInboundAt, loadVisitCheckin } from './visit-checkin-store'
import { isInsideOneMessageGap } from './visit-messages'
import {
  claimVisitMessage,
  hasVisitMessage,
  loadLastSpacedSendAt,
  loadPendingInquiryFollowup,
  releaseVisitMessage,
  settleVisitMessage,
} from './visit-messages-store'
import { handleFollowup } from './handle-followup'
import { loadPendingRowsBySlot } from './pending-slots'
import {
  isWarmCloseDue,
  isWarmCloseTooLate,
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
 * How recently a guest has to have scanned for their conversation to count as
 * a visit, for the plain close. THIRTY-SIX HOURS: the visit and the whole of
 * the next morning's slot, which closes up to twenty-seven hours after an
 * early scan. It was a day, and a guest answered at 08:30 the morning after
 * an 08:00 visit got the close, which then held their once-ever thank-you
 * past its slot (found in review).
 */
const VISIT_LOOKBACK_MS = 36 * 60 * 60 * 1000

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
  /** TAC-578: this visit has had its sign-off. */
  | 'already_signed_off'
  /** TAC-578: they said it is good. No timed sign-off follows an answered check-in. */
  | 'answered_good'
  /** TAC-578: asked how it is, and nothing from them since. Nothing more. */
  | 'nothing_since_checkin'
  /**
   * TAC-578: the guest scanned in the last day, so this is a visit, or one
   * with its own message still to come. No "always here" close, and the
   * once-ever marker is not spent.
   */
  | 'visit_conversation'
  /**
   * TAC-578: a question in this conversation armed an inquiry follow-up, which
   * is the next touch. The once-ever marker is not spent.
   */
  | 'followup_is_next_touch'
  /**
   * TAC-578: a follow-up, a thank-you or a check-in reached this guest within
   * three hours. The close lapses unspent inside its own two-hour bound.
   */
  | 'inside_one_message_gap'
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
    // A venue with no close text is NOT skipped whole (TAC-575). It can still
    // owe a guest a visit sign-off, which needs no text. The text is checked
    // per candidate, on the plain path.

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

  // Today's visit check-in, if this guest has one. It decides which sign-off
  // this is, and whether a check-back still comes first.
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

  // WHICH SIGN-OFF (TAC-578, ruled 2026-10-07). What happened in the
  // conversation decides, where one timer used to close everything alike:
  //
  //   visit   the guest was asked how their order is on THIS visit, never
  //           said good or bad, wrote about something else, and has gone
  //           quiet in the shop. A light line about the visit, once per visit.
  //   plain   anything else: the "always here" close, once per guest ever.
  //
  // AND TWO WAYS A VISIT GETS NEITHER (rule 3 as re-ruled the same day):
  //
  //   they said it is good     the reply to that is the sign-off
  //                            (handleInbound, `signOff: 'answer'`), and no
  //                            timed one follows an answered check-in.
  //   nothing since we asked   the check-back, then silence. Nothing more.
  //
  // Only a check-in from this visit counts (isCheckinFresh): the row is keyed
  // on the day, and a guest who said "so good" this morning and asked about
  // closing time this afternoon is not on the morning's visit. A check-in
  // that reads `bad` is a complaint and is stopped below.
  let visitCheckin: VisitCheckin | null = null
  if (checkin !== null && isCheckinFresh(checkin, now)) {
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
    const timed = timedSignOffFor(checkin, lastInbound.data, now)
    if (timed === 'answered_good' || timed === 'nothing_since_checkin') {
      return timed
    }
    if (timed === 'send') visitCheckin = checkin
  }
  const signOff: SignOffKind = visitCheckin !== null ? 'visit' : 'plain'

  if (visitCheckin !== null) {
    // One sign-off per visit. The claim below is the guarantee; this read
    // just keeps a signed-off visit from costing the reads in between on
    // every tick until the two-hour bound.
    const already = await hasVisitMessage(supabase, {
      venueId: candidate.venueId,
      guestId: candidate.guestId,
      venueLocalDate: visitCheckin.venueLocalDate,
      kinds: ['sign_off'],
    })
    if (!already.ok) {
      console.warn('[warm-close] visit messages unreadable; skipping', {
        guestId: candidate.guestId,
        error: already.error,
      })
      return 'guest_unreadable'
    }
    if (already.data) return 'already_signed_off'
  } else {
    // The plain close: once per guest ever, ACROSS ALL CONVERSATIONS, and only
    // for a venue that has been given one. TAC-560 limited it to a first
    // conversation; ruled 2026-10-07 it is no longer tied to one, because a
    // first conversation that was a visit, or a question that armed a
    // follow-up, no longer spends it.
    if (facts.data.warmCloseSentAt !== null) return 'already_closed'
    if (gate.warmCloseText.trim() === '') return 'no_warm_close_text'

    // NOT A VISIT. A guest who scanned in the last day is on a visit, or was
    // on one that still has its own message coming (the thank-you or the
    // check-in, lib/agent/post-visit-timeout.ts). "Message us anytime" on top
    // of either is the generic line beating the specific one, and it would
    // spend the once-ever close to do it. An unreadable scan record has not
    // shown there was no visit.
    const scans = await loadInstagramScanInstants(supabase, {
      venueId: candidate.venueId,
      guestId: candidate.guestId,
      sinceIso: new Date(now.getTime() - VISIT_LOOKBACK_MS).toISOString(),
    })
    if (!scans.ok) {
      console.warn('[warm-close] scans unreadable; skipping', {
        guestId: candidate.guestId,
        error: scans.error,
      })
      return 'guest_unreadable'
    }
    if (scans.data.length > 0) return 'visit_conversation'

    // A QUESTION THAT ARMED AN INQUIRY FOLLOW-UP GETS NO CLOSE (ruled
    // 2026-10-07): "the follow-up is the next touch. Don't spend the
    // once-ever close here." One pending row at most exists per guest
    // (migration 066), and while it does this guest is not closed. A
    // follow-up that already went is covered by the gap below.
    const followup = await loadPendingInquiryFollowup(
      supabase,
      candidate.guestId,
    )
    if (!followup.ok) {
      console.warn('[warm-close] inquiry follow-up unreadable; skipping', {
        guestId: candidate.guestId,
        error: followup.error,
      })
      return 'guest_unreadable'
    }
    if (followup.data !== null) return 'followup_is_next_touch'

    // THE ONE-MESSAGE RULE (ruled 2026-10-07): no close within three hours of
    // a follow-up, a thank-you or a check-in. The close is the lowest of the
    // four, so it never waits for its turn: its own two-hour bound is shorter
    // than the gap, and it lapses unspent.
    const lastSpaced = await loadLastSpacedSendAt(supabase, {
      venueId: candidate.venueId,
      guestId: candidate.guestId,
    })
    if (!lastSpaced.ok) {
      console.warn('[warm-close] recent sends unreadable; skipping', {
        guestId: candidate.guestId,
        error: lastSpaced.error,
      })
      return 'guest_unreadable'
    }
    if (isInsideOneMessageGap(lastSpaced.data, now)) {
      return 'inside_one_message_gap'
    }
  }

  // TAC-575 (ruled 2026-10-06): a person in the thread, or a complaint in it,
  // means no automated close at all. With the permanent checks, before any
  // claim. An unreadable thread is not "nothing blocks": skip this tick.
  //
  // The stretch read is the conversation this close would end: for a visit,
  // from the earliest a scan for this order could have been; for the plain
  // close, the conversation window (TAC-380 ruling 1's one definition), and no
  // further back than the guest's first contact.
  const conversationStart = new Date(
    Math.max(
      now.getTime() - gate.conversationWindowMs,
      facts.data.firstContactedAt?.getTime() ?? 0,
    ),
  )
  const blockerSince =
    visitCheckin !== null
      ? new Date(visitCheckin.orderedAt.getTime() - COUNTER_ARRIVAL_WINDOW_MS)
      : conversationStart
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
  // so without this the guest who had not tried their drink yet would be
  // signed off instead of being checked back on. And a guest who then ignores
  // the check-back gets nothing more, by ruling.
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

  // An operator holding a card for this guest is mid-decision; a close landing
  // under them would answer for them. loadPendingRowsBySlot is the ONE
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

  // TAC-386: no two proactive messages within the hour (ruled 2026-09-30).
  // This is the rule that also covers the scan greeting, which the three-hour
  // one above does not. A DELAY, not a refusal.
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
  // "never"; from here on something that exists once is spent.
  //
  //   plain   the "always here" close, once per guest ever:
  //           `guests.warm_close_sent_at`.
  //   visit   this visit's sign-off, once per visit: a `sign_off` row in
  //           `visit_messages` (migration 076). TAC-575 claimed it through
  //           `review_asked_at`, because it carried the link; it no longer
  //           does, and it must not touch the guest's one invitation.
  //
  // A visit sign-off does NOT take the warm-close marker. It did under
  // TAC-575, when both were "this guest's close". They are different things
  // now, and a guest signed off in the shop can still be told, once, on some
  // later question, that they can message anytime.
  let visitRowId: string | null = null
  if (visitCheckin !== null) {
    const claim = await claimVisitMessage(supabase, {
      venueId: candidate.venueId,
      guestId: candidate.guestId,
      venueLocalDate: visitCheckin.venueLocalDate,
      kind: 'sign_off',
      slot: null,
      now,
    })
    if (claim.status === 'lost') return 'claim_lost'
    if (claim.status === 'failed') {
      throw new Error(`sign-off claim failed: ${claim.error}`)
    }
    visitRowId = claim.id
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
  }
  const visitRow =
    visitRowId === null
      ? null
      : {
          id: visitRowId,
          venueId: candidate.venueId,
          guestId: candidate.guestId,
        }

  const agentRunId = randomUUID()
  const result = await handleFollowup({
    venueId: candidate.venueId,
    guestId: candidate.guestId,
    agentRunId,
    trigger: {
      reason: 'warm_close',
      triggeredAt: now,
      warmClose: { answersMessageId: candidate.messageId, signOff },
    },
  })

  // A sign-off that will NEVER reach the guest releases what it claimed, so a
  // later tick inside the two-hour window can try again. Without this a
  // refused generation or a shut Meta window would spend the guest's one
  // close, or the visit's one sign-off, on nothing.
  //
  // `queued` DELIBERATELY KEEPS THE CLAIM, and that asymmetry is the whole reason
  // RELEASES_CLAIM is a total map rather than `status !== 'sent'`. A queued
  // sign-off is a card an operator can still approve, which sends it; releasing
  // there opens a double-send. Keeping it costs at most one guest never being
  // closed if the operator skips the card.
  if (RELEASES_CLAIM[result.status]) {
    if (visitRow !== null) await releaseVisitMessage(supabase, visitRow)
    else await releaseWarmCloseClaim(supabase, candidate.guestId, now)
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
    const sentAt = new Date()
    await recordProactiveSend(supabase, candidate.guestId, sentAt)
    if (visitRow !== null) {
      // The row carries the message so a later check-in can be checked
      // against what this sign-off said (loadPriorCheckins).
      await settleVisitMessage(supabase, {
        ...visitRow,
        outcome: 'sent',
        messageId: result.outboundMessageId,
        sentAt,
      })
    }
  } else if (visitRow !== null) {
    await settleVisitMessage(supabase, {
      ...visitRow,
      outcome: 'queued',
      messageId: result.status === 'queued' ? result.outboundMessageId : null,
    })
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
