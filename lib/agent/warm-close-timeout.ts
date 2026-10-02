// TAC-560: send the warm "line is open" close after a first conversation goes
// quiet.
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
// SCOPE, ruled 2026-09-29 and narrower than the ticket's first draft:
//
//   Instagram only. The text arm is one refusal, recorded as a follow-up.
//   First-visit QR scans only (`created_via = 'qr_scan'`). A guest who first
//   DM'd without scanning is not eligible.
//
// EVERY CONDITION IS RE-CHECKED HERE, never settled earlier. Nothing is stored
// between ticks except the marker, so there is nothing that could be stale: the
// due set is derived from `messages` on every tick.
//
// ORDER, and it is not arbitrary. Everything that means "this close should never
// happen" runs BEFORE the claim, because the claim is what burns the guest's one
// close, for ever. The claim runs last, immediately before generation.
//
// WHAT IS NOT CHECKED HERE: Meta's 24-hour reply window.
// dispatch-instagram-reply.ts re-derives it unconditionally immediately before
// every Instagram send, and a second copy would be a second definition of the
// same deadline. Two hours is well inside it anyway.

import { randomUUID } from 'node:crypto'

import { createAdminClient } from '@/lib/db/admin'
import { parseFollowupRules } from '@/lib/schemas'
import { isVenueProcessingHalted } from '@/lib/venues/status'
import {
  captureWarmCloseSent,
  captureWarmCloseSkipped,
} from '@/lib/analytics/posthog'
import { recordProactiveSend } from '@/lib/followups/inquiry-followup-store'
import { isTooSoonAfterProactive } from '@/lib/followups/proactive-spacing'
import { isQuietHour } from './followup-rules'
import type { AgentResult } from './types'
import { handleFollowup } from './handle-followup'
import { loadPendingRowsBySlot } from './pending-slots'
import {
  isFirstConversation,
  isWarmCloseDue,
  isWarmCloseTooLate,
  warmCloseFloorMs,
  weAskedAQuestion,
} from './warm-close'
import {
  claimWarmClose,
  loadLastInboundCategory,
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
  /** Their last inbound was a sign-off, so the in-conversation close went out. */
  | 'closed_in_conversation'
  /** Not a counter-scan guest. */
  | 'not_a_scan_guest'
  /** Past their first conversation. */
  | 'not_first_conversation'
  | 'opted_out'
  | 'venue_paused'
  | 'quiet_hours'
  /** An operator has a card for this guest. */
  | 'card_pending'
  /** Not an Instagram conversation. */
  | 'not_instagram'
  /**
   * TAC-568: this venue has no `followup_rules.warm_close_text`, so there is no
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
  /** TAC-568: the fixed text this venue's close sends, '' when unconfigured. */
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
    // TAC-568: no configured close, nothing to send. Checked venue-wide and
    // BEFORE the candidate scan, for the reason the gates above are: a venue
    // that can never close anyone should cost one venues row per tick, not a
    // scan. handleFollowup re-checks it, because the config can change between
    // this tick and the run.
    if (gate.warmCloseText.trim() === '') {
      bump('no_warm_close_text')
      continue
    }

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
 * A TOTAL MAP over AgentResult['status'], not `status !== 'sent'`, because the
 * answer is not the same for every non-sent outcome and a new status must be
 * made to decide rather than inherit. `readonly Status[]` would not be
 * exhaustiveness-checked; `satisfies Record<...>` is (root CLAUDE.md).
 */
const RELEASES_CLAIM = {
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

  // One read for the marker, the origin, the opt-out and the channel.
  const facts = await loadWarmCloseGuestFacts(supabase, candidate.guestId)
  if (!facts.ok) {
    console.warn('[warm-close] guest unreadable; skipping', {
      guestId: candidate.guestId,
      error: facts.error,
    })
    return 'guest_unreadable'
  }

  if (facts.data.warmCloseSentAt !== null) return 'already_closed'
  if (facts.data.optedOutAt !== null) return 'opted_out'
  // Ruled 2026-09-29: first-visit QR scans only. `qr_scan` is set at guest
  // creation and never after (TAC-492), so this is the guest's ORIGIN, not a
  // claim about the current turn.
  if (facts.data.createdVia !== 'qr_scan') return 'not_a_scan_guest'
  // Instagram only. An Instagram conversation needs an Instagram identifier;
  // resolving the channel properly is dispatchReply's job and it re-checks.
  if (facts.data.instagramScopedId === null) return 'not_instagram'
  if (facts.data.firstContactedAt === null) return 'not_first_conversation'
  if (
    !isFirstConversation(
      facts.data.firstContactedAt,
      now,
      gate.conversationWindowMs,
    )
  ) {
    return 'not_first_conversation'
  }

  // The belt behind the model's own self-report. See loadLastInboundCategory.
  if (
    (await loadLastInboundCategory(
      supabase,
      candidate.venueId,
      candidate.guestId,
    )) === 'acknowledgment'
  ) {
    return 'closed_in_conversation'
  }

  // An operator holding a card for this guest is mid-decision; a warm close
  // landing under them would answer for them. loadPendingRowsBySlot is the ONE
  // per-guest pending read in the repo (a fresh query here would trip the source
  // guard in pending-slots.test.ts) and it fails OPEN to two empty slots.
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

  // TAC-386: no two proactive messages within the hour (ruled 2026-09-30). This
  // sits with `card_pending` below rather than with the permanent checks above
  // because it is a DELAY, not a refusal: the close comes round again on a later
  // tick inside its own two-hour bound.
  if (isTooSoonAfterProactive(facts.data.lastProactiveSendAt, now)) {
    return 'too_soon_after_proactive'
  }

  // Claim last, immediately before generating. Everything above could have said
  // "never"; from here on the guest's one close is spent.
  const claim = await claimWarmClose(supabase, candidate.guestId, now)
  if (claim.status === 'lost') return 'claim_lost'
  if (claim.status === 'failed') {
    console.error('[warm-close] claim failed', {
      guestId: candidate.guestId,
      error: claim.error,
    })
    throw new Error(`warm-close claim failed: ${claim.error}`)
  }

  const agentRunId = randomUUID()
  const result = await handleFollowup({
    venueId: candidate.venueId,
    guestId: candidate.guestId,
    agentRunId,
    trigger: {
      reason: 'warm_close',
      triggeredAt: now,
      warmClose: { answersMessageId: candidate.messageId },
    },
  })

  // A close that will NEVER reach the guest releases the claim, so a later tick
  // inside the two-hour window can try again. Without this a refused generation
  // or a shut Meta window would spend the guest's one close on nothing.
  //
  // `queued` DELIBERATELY KEEPS THE CLAIM, and that asymmetry is the whole reason
  // this is a total map rather than `status !== 'sent'`. A queued close is a card
  // an operator can still approve, which sends it; releasing the claim there
  // opens a double-send: the card is approved (no marker written, because
  // dispatchOperatorOutbound knows nothing about this mechanism), the card leaves
  // the queue, and the next tick inside the window finds a null marker and no
  // pending card and closes the guest a second time. Keeping the claim costs at
  // most one guest never being closed, if the operator skips the card, which is
  // the cheap direction this whole mechanism is biased toward.
  if (RELEASES_CLAIM[result.status]) {
    await releaseWarmCloseClaim(supabase, candidate.guestId, now)
    console.warn('[warm-close] close did not send; claim released', {
      agentRunId,
      guestId: candidate.guestId,
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

  // TAC-386: the spacing marker, so the other two proactive mechanisms can see
  // this close. Only on a confirmed send: a `queued` card is an operator's
  // decision and an operator can see the whole thread.
  if (result.status === 'sent') {
    await recordProactiveSend(supabase, candidate.guestId, now)
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
