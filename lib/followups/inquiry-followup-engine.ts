// TAC-386: the every-minute tick that checks our answer worked out.
//
// Hit by /api/cron/inquiry-followups. SEVENTH concrete cron-processor sibling of
// processDueCommitments, processDueFollowups, processDueKnowledgeGaps,
// processDueCommitmentLifecycle, processInstagramWindowWarnings,
// processDueScanGreetings and processDueWarmCloses. Still
// concrete-not-generic: the shared find-eligible -> claim -> side-effect seam
// stays unextracted, as its six predecessors each say.
//
// A ROUTE OF ITS OWN, for TAC-536's and TAC-560's reason: this SENDS UNPROMPTED
// MESSAGES TO GUESTS, and a dedicated cron-job.org entry can be paused in one
// click without also switching off the operator window warnings.
//
// WHAT IS STORED BETWEEN TICKS IS ONLY THE QUESTION AND ITS MOMENT. Every gate
// is re-evaluated here, on `now`, because every one of them can change in the
// hours between arming and firing: the guest writes again, the venue edits its
// hours, an operator opens a card, someone pauses the venue, Meta's window
// shuts.
//
// ORDER, and it is not arbitrary. Everything meaning "this follow-up should
// never happen" runs BEFORE the claim, because the claim is what spends the
// question's one follow-up. Within that, the PERMANENT refusals come before the
// TRANSIENT holds: a row that should never send must not be left `pending` for
// another tick to reconsider, and a row merely held by spacing must not be
// resolved. The claim runs last, immediately before generation.
//
// THE WINDOW IS CHECKED HERE, unlike in TAC-536 and TAC-560, and the difference
// is the delay. Both of those fire minutes after something the guest did, so
// they can argue the window cannot have shut. This one fires hours later, and up
// to a day later when the venue-hours roll pushed it into the next open period,
// so it has to look. `dispatch-instagram-reply.ts` still re-derives it before
// the send; this check exists so a hopeless row is resolved rather than sent to
// a refusal.

import { randomUUID } from 'node:crypto'

import { createAdminClient } from '@/lib/db/admin'
import { handleFollowup } from '@/lib/agent/handle-followup'
import { isQuietHour } from '@/lib/agent/followup-rules'
import { loadPendingRowsBySlot } from '@/lib/agent/pending-slots'
import { isVenueClosed } from '@/lib/agent/venue-open-state'
import {
  MAX_HISTORY_DAYS,
  MAX_HISTORY_MESSAGES,
} from '@/lib/agent/build-runtime-context'
import { isIntentionBrakeEngaged } from '@/lib/agent/intentions/derive'
import { loadIntentionRows } from '@/lib/agent/intentions/load'
import {
  instagramWindowState,
  loadLastGuestActionAt,
} from '@/lib/messaging/instagram/window'
import { parseFollowupRules, VenueInfoSchema } from '@/lib/schemas'
import { parseIntentionRules } from '@/lib/schemas/intention-rules'
import { isVenueProcessingHalted } from '@/lib/venues/status'
import type { AgentResult } from '@/lib/agent/types'
import {
  claimFollowupLogRows,
  finalizeFollowupLogClaim,
  loadFollowupSnapshotsForVenue,
  releaseFollowupLogClaim,
} from './log'
import {
  computeInquiryFollowupDueAt,
  INQUIRY_FOLLOWUP_DELAY_HOURS,
} from './inquiry-followup-timing'
import {
  claimInquiryFollowup,
  hasInboundSince,
  INQUIRY_FOLLOWUP_HORIZON_MS,
  loadDueInquiryFollowups,
  loadInquiryFollowupVenues,
  loadInquiryGuestFacts,
  loadIntentionRulesRaw,
  loadOurAnswer,
  loadRecentInboundTimes,
  recordInquiryDispatch,
  recordProactiveSend,
  releaseInquiryFollowupClaim,
  resolveInquiryFollowup,
  type DueInquiryFollowup,
  type InquiryFollowupVenue,
} from './inquiry-followup-store'
import { isTooSoonAfterProactive } from './proactive-spacing'

type AdminSupabaseClient = ReturnType<typeof createAdminClient>

/**
 * Why a due row was not sent.
 *
 * Split into two groups by what happens next, because that is the distinction
 * the processor acts on and collapsing it is how a one-shot mechanism either
 * loops or silently stops.
 */
export type InquirySkipReason =
  // ---- permanent: the row is resolved and never reconsidered ----
  | 'opted_out'
  /** They wrote again since the question, so the conversation moved on. */
  | 'guest_wrote_again'
  /** Our answer never reached them, so there is nothing to check on. */
  | 'no_answer_sent'
  /** The venue's weekly follow-up cap is already spent. */
  | 'weekly_cap'
  /** The unanswered-prompt brake is engaged. */
  | 'brake_engaged'
  | 'not_instagram'
  | 'disabled_for_venue'
  /** Meta's window has shut, or the row sat past its own horizon. */
  | 'window_closed'
  | 'past_horizon'
  /** A newer question took the guest's pending slot while this one generated. */
  | 'superseded'
  // ---- transient: the row stays pending for a later tick ----
  | 'venue_closed_now'
  | 'quiet_hours'
  | 'venue_paused'
  | 'card_pending'
  | 'too_soon_after_proactive'
  /** Another tick claimed it first. */
  | 'claim_lost'
  | 'generation_did_not_send'
  | 'guest_unreadable'

export interface ProcessInquiryFollowupsResult {
  scanned: number
  sent: number
  skipped: Record<string, number>
  errored: number
}

/** The venue facts every gate needs, resolved once per venue per tick. */
interface VenueGate {
  venue: InquiryFollowupVenue
  enabled: boolean
  quietHours: boolean
  weeklyCap: number
  conversationWindowMs: number
  unansweredStreak: number
  hours: ReturnType<typeof VenueInfoSchema.parse>['hours'] | null
}

async function resolveVenueGate(
  supabase: AdminSupabaseClient,
  venue: InquiryFollowupVenue,
  now: Date,
): Promise<VenueGate> {
  const rules = parseFollowupRules(venue.followupRules)
  const intentionRaw = await loadIntentionRulesRaw(supabase, venue.id)
  const intentionRules = parseIntentionRules(
    intentionRaw.ok ? intentionRaw.data : null,
  )
  const parsedInfo = VenueInfoSchema.safeParse(venue.venueInfo)
  return {
    venue,
    enabled: rules.inquiry_followup_enabled,
    weeklyCap: rules.weekly_cap,
    conversationWindowMs: rules.recent_conversation_hours * 60 * 60 * 1000,
    unansweredStreak: intentionRules.unanswered_streak,
    // The ONE definition of quiet hours, imported rather than restated, and
    // inheriting its fail-OPEN direction on an unreadable timezone rather than
    // re-deciding it here. Two definitions of "is it the middle of the night" is
    // the worse outcome (TAC-560 made the same call).
    quietHours:
      venue.timezone !== null &&
      isQuietHour(
        now,
        venue.timezone,
        rules.quiet_hours_start_local,
        rules.quiet_hours_end_local,
      ),
    hours: parsedInfo.success ? parsedInfo.data.hours : null,
  }
}

/**
 * Does this agent outcome mean nothing reached the guest and nothing will, so
 * the row should go back for a later tick?
 *
 * A TOTAL MAP over AgentResult['status'], not `status !== 'sent'`, because the
 * answer differs per outcome and a new status must be made to DECIDE rather than
 * inherit. `readonly Status[]` is not exhaustiveness-checked; `satisfies
 * Record<...>` is (root CLAUDE.md).
 */
const RELEASES_CLAIM = {
  sent: false,
  // A card an operator can still approve, which would send it. Releasing here
  // opens a double-send: the card is approved (nothing writes the marker,
  // because dispatchOperatorOutbound knows nothing about this mechanism), and
  // the next tick finds the row pending again and sends a second follow-up.
  // Ruling 7 says one send; keeping the claim costs at most one follow-up never
  // going out if the operator skips the card, which is the cheap direction.
  queued: false,
  // Nothing reached the guest and nothing will on this attempt. A later tick
  // inside the window may do better.
  refused: true,
  failed: true,
  dropped: true,
  silenced: true,
  venue_halted: true,
  // Something already answered this guest, which is better than a check-in and
  // means nothing more is owed. Re-trying would risk the second message the
  // check prevented.
  superseded: false,
  // Neither is reachable from this path (both belong to inbound coalescing and
  // duplicate delivery, and a follow-up has no inbound), but both must say
  // something. `false` is the safe direction: if one became reachable, holding
  // the claim costs a missed follow-up rather than a second one.
  skipped_duplicate: false,
  coalesced: false,
} as const satisfies Record<AgentResult['status'], boolean>

/**
 * One tick. Never throws: a throw handling one row becomes an `errored` count
 * and the rest are still handled, the posture every sibling takes.
 */
export async function processDueInquiryFollowups(
  now: Date = new Date(),
  supabase: AdminSupabaseClient = createAdminClient(),
): Promise<ProcessInquiryFollowupsResult> {
  const result: ProcessInquiryFollowupsResult = {
    scanned: 0,
    sent: 0,
    skipped: {},
    errored: 0,
  }
  const bump = (reason: InquirySkipReason) => {
    result.skipped[reason] = (result.skipped[reason] ?? 0) + 1
  }

  const venues = await loadInquiryFollowupVenues(supabase)
  if (!venues.ok) {
    console.error('[inquiry-followup] could not read venues', {
      error: venues.error,
    })
    result.errored += 1
    return result
  }

  for (const venue of venues.data) {
    // Venue-wide gates first, so a paused or sleeping venue costs one venues row
    // rather than a due scan per tick.
    //
    // A DENY-LIST on status, never an allow-list on 'active': the live pilot
    // venue is `pending` (docs/decisions/0002).
    if (isVenueProcessingHalted(venue.status)) continue
    // Instagram only (ruled 2026-09-30). A venue with no Instagram account can
    // have no Instagram conversation, so skip it whole.
    if (venue.instagramAccountId === null) continue

    const gate = await resolveVenueGate(supabase, venue, now)
    if (!gate.enabled) continue
    if (gate.quietHours) continue

    const due = await loadDueInquiryFollowups(supabase, venue.id, now)
    if (!due.ok) {
      console.error('[inquiry-followup] could not read due rows', {
        venueId: venue.id,
        error: due.error,
      })
      result.errored += 1
      continue
    }

    for (const row of due.data) {
      result.scanned += 1
      try {
        const outcome = await considerRow(supabase, gate, row, now)
        if (outcome === 'sent') {
          result.sent += 1
        } else {
          bump(outcome)
        }
      } catch (e) {
        result.errored += 1
        console.error('[inquiry-followup] row threw', {
          venueId: row.venueId,
          guestId: row.guestId,
          inquiryFollowupId: row.id,
          error: e instanceof Error ? e.message : String(e),
        })
      }
    }
  }

  return result
}

/**
 * Resolve a row permanently, and report the reason back to the caller's counter.
 */
async function resolve(
  supabase: AdminSupabaseClient,
  row: DueInquiryFollowup,
  status: 'skipped' | 'expired',
  reason: InquirySkipReason,
): Promise<InquirySkipReason> {
  const written = await resolveInquiryFollowup(supabase, row.id, status, reason)
  if (!written.ok) {
    console.warn('[inquiry-followup] could not resolve row', {
      inquiryFollowupId: row.id,
      reason,
      error: written.error,
    })
  }
  return reason
}

/**
 * One due row, from "is the window still open" through to the send.
 *
 * Returns 'sent' or the reason it was not. Split out so the loop above reads as
 * scan-and-count and the decision reads as one ordered list.
 */
async function considerRow(
  supabase: AdminSupabaseClient,
  gate: VenueGate,
  row: DueInquiryFollowup,
  now: Date,
): Promise<'sent' | InquirySkipReason> {
  const pastHorizon =
    now.getTime() - row.dueAt.getTime() > INQUIRY_FOLLOWUP_HORIZON_MS

  // ---- Meta's window. Permanent: nothing reopens it but the guest acting. ----
  const lastAction = await loadLastGuestActionAt(
    supabase,
    row.venueId,
    row.guestId,
  )
  if (!lastAction.ok) {
    // A failed read has not shown the window is shut, and treating it as shut
    // would spend the row. Leave it for the next tick.
    console.warn('[inquiry-followup] could not read the guest window', {
      inquiryFollowupId: row.id,
      error: lastAction.error,
    })
    return 'guest_unreadable'
  }
  if (!instagramWindowState(lastAction.value, now).open) {
    return resolve(supabase, row, 'expired', 'window_closed')
  }

  // ---- The hours, re-derived on `now`. ----
  // `due_at` was computed to fall inside an open period, so this only fires when
  // the venue edited its hours, or a tick was late. Transient: the venue may be
  // open again shortly, and `due_at` is already past so the next tick retries.
  if (gate.hours === null || gate.venue.timezone === null) {
    return pastHorizon
      ? resolve(supabase, row, 'expired', 'past_horizon')
      : 'venue_closed_now'
  }
  const venueForHours = {
    venueInfo: { hours: gate.hours },
    timezone: gate.venue.timezone,
  }
  if (isVenueClosed(venueForHours, now)) {
    return pastHorizon
      ? resolve(supabase, row, 'expired', 'past_horizon')
      : 'venue_closed_now'
  }
  // A send that is now outside the window the hours imply is a scheduling
  // mistake rather than a transient one, so re-derive the moment and give up if
  // it can no longer be placed inside Meta's window at all.
  const retimed = computeInquiryFollowupDueAt({
    askedAt: row.askedAt,
    timezone: gate.venue.timezone,
    hours: gate.hours,
    delayHours: INQUIRY_FOLLOWUP_DELAY_HOURS,
    windowClosesAt: row.windowClosesAt,
  })
  if (retimed.kind === 'skip' && retimed.reason === 'past_window') {
    return resolve(supabase, row, 'expired', 'window_closed')
  }

  // ---- Guest facts: one read for the opt-out, the channel and the spacing. ----
  const facts = await loadInquiryGuestFacts(supabase, row.guestId)
  if (!facts.ok) {
    console.warn('[inquiry-followup] guest unreadable; skipping', {
      guestId: row.guestId,
      error: facts.error,
    })
    return 'guest_unreadable'
  }
  if (facts.data.optedOutAt !== null) {
    return resolve(supabase, row, 'skipped', 'opted_out')
  }
  // An Instagram conversation needs an Instagram identifier. Resolving the
  // channel properly is dispatchReply's job and it re-checks.
  if (facts.data.instagramScopedId === null) {
    return resolve(supabase, row, 'skipped', 'not_instagram')
  }

  // ---- Ruling 5(b): they wrote again, so the conversation moved on. ----
  // Against the SOURCE QUESTION's timestamp, per the ruling's wording, not
  // against `due_at` or `now`.
  const wroteAgain = await hasInboundSince(
    supabase,
    row.venueId,
    row.guestId,
    row.askedAt,
  )
  if (!wroteAgain.ok) return 'guest_unreadable'
  if (wroteAgain.data) {
    return resolve(supabase, row, 'skipped', 'guest_wrote_again')
  }

  // ---- Our answer. Read now, not stored at arm time. ----
  const answer = await loadOurAnswer(supabase, row.sourceMessageId)
  if (!answer.ok) return 'guest_unreadable'
  if (answer.data === null) {
    // Generation refused, a card was skipped, or the send failed. A message
    // checking that our help worked out has nothing to say when we never helped.
    return resolve(supabase, row, 'skipped', 'no_answer_sent')
  }

  // ---- The weekly cap. BLOCKS, ruled 2026-09-30. ----
  // This supersedes ruling 6(b) of 2026-09-17 ("counts but is not blocked") for
  // this reason only: a regular who asks something every visit does not get a
  // check-in every visit. Reuses the engine's own rolling-7-day count rather
  // than a second definition of the window.
  const snapshots = await loadFollowupSnapshotsForVenue(
    row.venueId,
    [row.guestId],
    now,
  )
  if (!snapshots.ok) return 'guest_unreadable'
  const weeklyCount = snapshots.data.get(row.guestId)?.weeklyCount ?? 0
  if (weeklyCount >= gate.weeklyCap) {
    return resolve(supabase, row, 'skipped', 'weekly_cap')
  }

  // ---- Ruling 10(b): respect the unanswered-prompt brake, never feed it. ----
  // Nothing here writes a `guest_intention_prompts` row, so this send cannot
  // reset or extend the streak it is reading.
  const brake = await isBrakeEngaged(supabase, gate, row, now)
  if (brake) return resolve(supabase, row, 'skipped', 'brake_engaged')

  // ---- Transient holds, last, so nothing below resolves the row. ----
  // A scan greeting or a warm close reached them within the hour. Come back.
  if (isTooSoonAfterProactive(facts.data.lastProactiveSendAt, now)) {
    return 'too_soon_after_proactive'
  }

  // An operator holding a card for this guest is mid-decision; a follow-up
  // landing under them would answer for them. loadPendingRowsBySlot is the ONE
  // per-guest pending read in the repo (a fresh query here would trip the source
  // guard in pending-slots.test.ts) and it fails OPEN to two empty slots.
  const pending = await loadPendingRowsBySlot(row.venueId, row.guestId)
  if (
    pending !== null &&
    (pending.obligation !== null || pending.conversation.length > 0)
  ) {
    return 'card_pending'
  }

  // ---- Claim, immediately before generating. ----
  const claim = await claimInquiryFollowup(supabase, row.id, now)
  if (claim.status === 'lost') return 'claim_lost'
  if (claim.status === 'failed') {
    throw new Error(`inquiry follow-up claim failed: ${claim.error}`)
  }

  // The audit row, which is also what makes this send count toward the venue's
  // weekly cap on every other path (`loadFollowupSnapshotsForVenue`'s weekly
  // query has no reason filter). Keyed on the source message, so it is
  // once-per-question at the storage layer as well.
  const logClaim = await claimFollowupLogRows([
    {
      venueId: row.venueId,
      guestId: row.guestId,
      reason: 'inquiry_followup',
      dedupKey: `inquiry_followup:${row.sourceMessageId}`,
    },
  ])
  if (!logClaim.ok || !('claimed' in logClaim)) {
    // Either the insert failed, or another tick already owns the audit row for
    // this question (the `conflict` arm). Put ours back and let that one finish.
    await putRowBack(supabase, row)
    return 'claim_lost'
  }
  const logClaimIds = logClaim.claimed.map((c) => c.id)

  const agentRunId = randomUUID()
  const agentResult = await handleFollowup({
    venueId: row.venueId,
    guestId: row.guestId,
    agentRunId,
    trigger: {
      reason: 'inquiry_followup',
      triggeredAt: now,
      inquiryFollowup: {
        question: row.question,
        answer: answer.data.body,
        answerMessageId: answer.data.messageId,
      },
    },
  })

  if (RELEASES_CLAIM[agentResult.status]) {
    await releaseFollowupLogClaim(logClaimIds)
    const back = await putRowBack(supabase, row)
    console.warn('[inquiry-followup] did not send; claim released', {
      agentRunId,
      inquiryFollowupId: row.id,
      status: agentResult.status,
      rowState: back,
    })
    return back === 'superseded' ? 'superseded' : 'generation_did_not_send'
  }

  const messageId =
    'outboundMessageId' in agentResult &&
    typeof agentResult.outboundMessageId === 'string'
      ? agentResult.outboundMessageId
      : null
  if (messageId !== null) {
    await recordInquiryDispatch(supabase, row.id, messageId)
    await finalizeFollowupLogClaim(logClaimIds, messageId)
  }

  // The spacing marker, on a confirmed send only. A queued card is an operator's
  // decision and an operator can see the whole thread, so it writes nothing
  // here. Advisory, never released.
  if (agentResult.status === 'sent') {
    await recordProactiveSend(supabase, row.guestId, now)
  }

  return 'sent'
}

/**
 * Put a claimed row back to `pending`, or record that it cannot go back.
 *
 * The conflict is real and expected: the claim freed the guest's one pending
 * slot, so a question they asked in the meantime may already occupy it.
 */
async function putRowBack(
  supabase: AdminSupabaseClient,
  row: DueInquiryFollowup,
): Promise<'released' | 'superseded' | 'failed'> {
  const released = await releaseInquiryFollowupClaim(supabase, row.id)
  if (released.status === 'superseded') {
    await resolveInquiryFollowup(supabase, row.id, 'skipped', 'superseded')
    return 'superseded'
  }
  if (released.status === 'failed') {
    console.error('[inquiry-followup] could not release the row', {
      inquiryFollowupId: row.id,
      error: released.error,
    })
    return 'failed'
  }
  return 'released'
}

/**
 * Is TAC-380's unanswered-prompt brake engaged for this guest?
 *
 * Composed from the pure predicate and the same history window
 * `build-runtime-context.ts` loads, using ITS exported constants, so the brake
 * sees the same evidence on this path as on the inbound path.
 *
 * Fails OPEN (returns false) when the rows cannot be read: `loadIntentionRows`
 * returns null on any failure, and on the inbound path that means "render
 * nothing". Here the equivalent conservative choice would be to skip, but the
 * brake is a courtesy check on a mechanism that already has a weekly cap, a
 * spacing rule and a one-pending-per-guest rule in front of it, and treating an
 * unreadable table as "brake on" would silently stop every follow-up fleet-wide
 * on a transient error. The direction is stated here rather than inferred.
 */
async function isBrakeEngaged(
  supabase: AdminSupabaseClient,
  gate: VenueGate,
  row: DueInquiryFollowup,
  now: Date,
): Promise<boolean> {
  const rows = await loadIntentionRows(row.venueId, row.guestId)
  if (rows === null) return false
  if (rows.prompted.length === 0) return false

  const historyFrom = new Date(
    now.getTime() - MAX_HISTORY_DAYS * 24 * 60 * 60 * 1000,
  )
  const inbound = await loadRecentInboundTimes(
    supabase,
    row.venueId,
    row.guestId,
    historyFrom,
    MAX_HISTORY_MESSAGES,
  )
  if (!inbound.ok) return false

  return isIntentionBrakeEngaged({
    prompted: rows.prompted,
    inboundTimes: inbound.data,
    conversationWindowMs: gate.conversationWindowMs,
    inboundHistoryFrom: historyFrom,
    streak: gate.unansweredStreak,
  })
}
