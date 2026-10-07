// TAC-578: write to a guest once about a visit that is over.
//
// TWO MESSAGES, and a visit gets at most one of them (ruled 2026-10-07):
//
//   first_visit_thanks  after a guest's FIRST visit, once per guest ever:
//                       thanks for coming in, one thing from the visit, and
//                       the review invitation.
//   visit_checkin       after a LATER visit: a compliment on the order that
//                       shows we know them. Sent only when it is specific and
//                       new; otherwise nothing goes out that day.
//
// Called every minute from /api/cron/visit-checkbacks, after the timed
// check-back, rather than from a route of its own (ruled: reuse a cron). EIGHTH
// concrete cron-processor sibling. Pausing that cron-job.org entry stops both;
// `followup_rules.post_visit_message_enabled` stops only this.
//
// NOTHING IS SCHEDULED. The due set is derived on every tick from the scans of
// today and yesterday, and the slot is recomputed from the guest's newest
// message each time (resolvePostVisitSlot), so a guest who writes again after
// the visit moves their own slot and nothing stored goes stale.
//
// ORDER, as in warm-close-timeout.ts and for its reason: everything that means
// "not now" or "never" runs BEFORE the claim. The claim is a row in
// `visit_messages`, and for a thank-you it is the guest's one.
//
// INSTAGRAM ONLY, like every unprompted send. The slot is chosen against
// Meta's 24-hour window, which a text conversation does not have.
//
// WHAT IS NOT CHECKED HERE: Meta's window at the instant of the send.
// dispatch-instagram-reply.ts re-derives it. The slot was chosen to be inside
// it; that is planning, and the send's own check is the guarantee.

import { randomUUID } from 'node:crypto'

import { createAdminClient } from '@/lib/db/admin'
import { verifyVisitCheckin } from '@/lib/ai/verify-visit-checkin'
import { recordProactiveSend } from '@/lib/followups/inquiry-followup-store'
import { venueLocalInstant } from '@/lib/guests/commitment-expiry'
import { loadLastGuestActionAt } from '@/lib/messaging/instagram/window'
import {
  findReviewLink,
  parseFollowupRules,
  parseVenueLinks,
  venueLocalDate,
  venueLocalMinutes,
} from '@/lib/schemas'
import { isVenueProcessingHalted } from '@/lib/venues/status'
import { isComplaintClarificationOpen } from './complaint-thread'
import { isQuietHour } from './followup-rules'
import { DELIVERED_OUTBOUND_STATUSES } from './group-responses'
import { handleFollowup } from './handle-followup'
import { loadPendingRowsBySlot } from './pending-slots'
import { markReviewAsked, releaseReviewAskClaim } from './review-ask'
import {
  loadNewestThreadMessage,
  loadVisitCheckin,
} from './visit-checkin-store'
import {
  checkinAngleRejection,
  checkinWordingRejection,
  complaintStanding,
  decodeAngle,
  encodeAngle,
  EVENING_SLOT_START_MINUTES,
  isFirstVisitDay,
  isInsideOneMessageGap,
  MORNING_OFFSET_MAX_MINUTES,
  MORNING_SLOT_MINUTES,
  parseLocalMinutes,
  resolvePostVisitSlot,
  standsDownFor,
  VISIT_WHEN,
  type CheckinAngle,
  type CheckinRejection,
  type PostVisitKind,
  type PostVisitSkipReason,
} from './visit-messages'
import {
  claimVisitMessage,
  loadGuestVisitRecord,
  loadLastSpacedSendAt,
  loadPendingInquiryFollowup,
  loadPostVisitGuestFacts,
  loadPriorCheckins,
  loadSettledVisits,
  loadVisitCandidates,
  loadVisitThread,
  releaseStaleVisitClaims,
  releaseVisitMessage,
  settleVisitMessage,
  type VisitCandidate,
} from './visit-messages-store'
import { warmCloseBlocker } from './warm-close'
import { loadWarmCloseVenues, type WarmCloseVenue } from './warm-close-store'
import { RELEASES_CLAIM } from './warm-close-timeout'

type AdminSupabaseClient = ReturnType<typeof createAdminClient>

/**
 * Why a visit got no message this tick. Each is a distinct cause. The ones
 * marked transient come round again next tick until the slot has gone; the
 * rest are final for the visit, by a kept row or by the slot passing.
 */
export type PostVisitOutcome =
  | 'sent'
  | 'queued'
  // ---- transient ----
  /** The slot has not opened, or the thread has not been still long enough. */
  | 'not_yet'
  | 'guest_wrote_last'
  | 'last_message_not_delivered'
  | 'card_pending'
  /** A complaint on this visit has not been put right by a person yet. */
  | 'complaint_unresolved'
  /** A follow-up, thank-you, check-in or close reached them inside the gap. */
  | 'inside_one_message_gap'
  /** A message that outranks this one is due inside the gap. */
  | 'yields_to_followup'
  | 'guest_unreadable'
  | 'send_failed'
  // ---- final ----
  | PostVisitSkipReason
  | 'opted_out'
  | 'not_instagram'
  /** Staff wrote to this guest by hand on the visit, and nothing went wrong. */
  | 'staff_replied'
  /** A later visit with a complaint on it gets no compliment on the order. */
  | 'complaint_visit'
  /** A later visit with no order on record, or none before it. */
  | 'no_order_history'
  | 'claim_lost'
  /** The check-in was written and was not fresh. Nothing was sent. */
  | `not_fresh:${CheckinRejection | 'judge_failed'}`

export interface ProcessPostVisitResult {
  /** Visits considered. */
  scanned: number
  /** Messages sent or put on a card. */
  sent: number
  skipped: Record<string, number>
  errored: number
}

/** A venue's send hours for this message, resolved once per tick. */
interface VenueGate {
  venue: WarmCloseVenue
  timezone: string
  earliestLocal: string
  latestLocal: string
  /** The visit days whose slot could be open right now. */
  dates: string[]
}

/** `YYYY-MM-DD` one day before the given one. */
function dayBefore(localDate: string): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(localDate)
  if (!m) return null
  return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]) - 1))
    .toISOString()
    .slice(0, 10)
}

/**
 * The venue-wide gates, and which visit days are worth reading at this hour.
 * Null means nothing at this venue can go out on this tick, which is most
 * ticks: outside the morning and evening slots this costs no query at all.
 */
function resolveVenueGate(venue: WarmCloseVenue, now: Date): VenueGate | null {
  // A DENY-LIST on status, never an allow-list on 'active' (decision 0002).
  if (isVenueProcessingHalted(venue.status)) return null
  if (venue.instagramAccountId === null) return null
  // Fails toward NOT sending on an unreadable clock, unlike isQuietHour below:
  // see resolvePostVisitSlot.
  if (venue.timezone === null) return null
  const rules = parseFollowupRules(venue.followupRules)
  if (!rules.post_visit_message_enabled) return null
  if (
    isQuietHour(
      now,
      venue.timezone,
      rules.quiet_hours_start_local,
      rules.quiet_hours_end_local,
    )
  ) {
    return null
  }
  const today = venueLocalDate(now, venue.timezone)
  const nowMinutes = venueLocalMinutes(venue.timezone, now)
  const earliest = parseLocalMinutes(rules.visit_message_earliest_local)
  const latest = parseLocalMinutes(rules.visit_message_latest_local)
  if (
    today === null ||
    nowMinutes === null ||
    earliest === null ||
    latest === null
  ) {
    return null
  }
  if (nowMinutes < earliest || nowMinutes > latest) return null

  const dates: string[] = []
  // Yesterday's visits, while the morning slot could still be open.
  const yesterday = dayBefore(today)
  if (
    yesterday !== null &&
    nowMinutes <= earliest + MORNING_SLOT_MINUTES + MORNING_OFFSET_MAX_MINUTES
  ) {
    dates.push(yesterday)
  }
  // Today's, once the evening slot could be.
  if (nowMinutes >= Math.max(EVENING_SLOT_START_MINUTES, earliest)) {
    dates.push(today)
  }
  if (dates.length === 0) return null
  return {
    venue,
    timezone: venue.timezone,
    earliestLocal: rules.visit_message_earliest_local,
    latestLocal: rules.visit_message_latest_local,
    dates,
  }
}

/**
 * One tick. Never throws: a throw handling one visit becomes an `errored`
 * count and the rest are still handled, the posture every sibling takes.
 */
export async function processDuePostVisitMessages(
  now: Date = new Date(),
  supabase: AdminSupabaseClient = createAdminClient(),
): Promise<ProcessPostVisitResult> {
  const result: ProcessPostVisitResult = {
    scanned: 0,
    sent: 0,
    skipped: {},
    errored: 0,
  }

  const venues = await loadWarmCloseVenues(supabase)
  if (!venues.ok) {
    console.error('[post-visit] could not read venues', { error: venues.error })
    result.errored += 1
    return result
  }

  for (const venue of venues.data) {
    const gate = resolveVenueGate(venue, now)
    if (gate === null) continue

    // A run that died between its claim and its send left a row that reads as
    // settled. Give those back first, so the visit is tried again in its slot.
    await releaseStaleVisitClaims(supabase, {
      venueId: venue.id,
      dates: gate.dates,
      now,
    })
    const [candidates, settled] = await Promise.all([
      loadVisitCandidates(
        supabase,
        venue.id,
        gate.timezone,
        gate.dates,
        // Two days covers yesterday's whole venue-local day in any zone.
        new Date(now.getTime() - 48 * 60 * 60 * 1000),
      ),
      loadSettledVisits(supabase, venue.id, gate.dates),
    ])
    if (!candidates.ok || !settled.ok) {
      console.error('[post-visit] could not read visits', {
        venueId: venue.id,
        error: !candidates.ok
          ? candidates.error
          : !settled.ok
            ? settled.error
            : null,
      })
      result.errored += 1
      continue
    }

    for (const visit of candidates.data) {
      if (settled.data.has(`${visit.guestId}|${visit.venueLocalDate}`)) continue
      result.scanned += 1
      try {
        const outcome = await considerVisit(supabase, gate, visit, now)
        if (outcome === 'sent' || outcome === 'queued') {
          result.sent += 1
        } else {
          result.skipped[outcome] = (result.skipped[outcome] ?? 0) + 1
          if (outcome !== 'not_yet') {
            console.log('[post-visit] no message', {
              venueId: venue.id,
              guestId: visit.guestId,
              visitLocalDate: visit.venueLocalDate,
              reason: outcome,
            })
          }
        }
      } catch (e) {
        result.errored += 1
        console.error('[post-visit] visit threw', {
          venueId: venue.id,
          guestId: visit.guestId,
          error: e instanceof Error ? e.message : String(e),
        })
      }
    }
  }

  return result
}

/** One visit, from "is it time" through to the send. */
async function considerVisit(
  supabase: AdminSupabaseClient,
  gate: VenueGate,
  visit: VisitCandidate,
  now: Date,
): Promise<PostVisitOutcome> {
  const { venue, timezone } = gate
  const unreadable = (what: string, error: string): PostVisitOutcome => {
    console.warn(`[post-visit] ${what} unreadable; skipping`, {
      guestId: visit.guestId,
      error,
    })
    return 'guest_unreadable'
  }

  const facts = await loadPostVisitGuestFacts(supabase, venue.id, visit.guestId)
  if (!facts.ok) return unreadable('guest', facts.error)
  if (facts.data.optedOutAt !== null) return 'opted_out'
  if (facts.data.instagramScopedId === null) return 'not_instagram'

  // ---- Is it time? The slot, from the guest's own newest message. ----
  const [lastInbound, newest] = await Promise.all([
    loadLastGuestActionAt(supabase, venue.id, visit.guestId),
    loadNewestThreadMessage(supabase, venue.id, visit.guestId),
  ])
  if (!lastInbound.ok) return unreadable('window', lastInbound.error)
  if (!newest.ok) return unreadable('thread', newest.error)

  const slot = resolvePostVisitSlot({
    visitLocalDate: visit.venueLocalDate,
    timezone,
    earliestLocal: gate.earliestLocal,
    latestLocal: gate.latestLocal,
    lastInboundAt: lastInbound.value,
    threadQuietSince: newest.data?.createdAt ?? null,
    guestId: visit.guestId,
    now,
  })
  if (slot.kind === 'wait') return 'not_yet'
  if (slot.kind === 'skip') return slot.reason

  // Our message has to be the newest, and to have reached them. A guest who
  // has written since is in a conversation, and a draft waiting on an
  // operator is somebody mid-decision.
  if (newest.data === null || newest.data.direction === 'inbound') {
    return 'guest_wrote_last'
  }
  if (!newest.data.reachedGuest) return 'last_message_not_delivered'
  // loadPendingRowsBySlot fails OPEN (null) for the callers that are answering
  // a guest. This one is starting an unprompted conversation, so an
  // unreadable queue is not "no card": wait a tick.
  const pending = await loadPendingRowsBySlot(venue.id, visit.guestId)
  if (pending === null) return 'guest_unreadable'
  if (pending.obligation !== null || pending.conversation.length > 0) {
    return 'card_pending'
  }

  // ---- Which message: first visit, or a later one? ----
  const record = await loadGuestVisitRecord(supabase, {
    venueId: venue.id,
    guestId: visit.guestId,
    timezone,
    createdVia: facts.data.createdVia,
    createdAt: facts.data.createdAt,
    now,
  })
  if (!record.ok) return unreadable('visit record', record.error)
  const kind: PostVisitKind = isFirstVisitDay(
    visit.venueLocalDate,
    record.data.visitDays,
  )
    ? 'first_visit_thanks'
    : 'visit_checkin'

  // ---- Did anything go wrong on the visit, and was it put right? ----
  const day = /^(\d{4})-(\d{2})-(\d{2})$/.exec(visit.venueLocalDate)
  const visitStart =
    day === null
      ? null
      : venueLocalInstant(
          timezone,
          Number(day[1]),
          Number(day[2]),
          Number(day[3]),
          0,
        )
  if (visitStart === null) return 'clock_unreadable'
  const [thread, checkin] = await Promise.all([
    loadVisitThread(supabase, venue.id, visit.guestId, visitStart),
    loadVisitCheckin(supabase, venue.id, visit.guestId, visit.venueLocalDate),
  ])
  if (!thread.ok) return unreadable('visit thread', thread.error)
  if (!checkin.ok) return unreadable('check-in', checkin.error)
  const rules = parseFollowupRules(venue.followupRules)
  const standing = complaintStanding({
    rows: thread.data,
    deliveredStatuses: DELIVERED_OUTBOUND_STATUSES,
    checkinSaidBad: checkin.data?.answer === 'bad',
    checkinBadAt:
      checkin.data?.answer === 'bad' ? checkin.data.answeredAt : null,
    // The one definition of "a complaint's clarifying question is still open"
    // (complaint-thread.ts), handed the same thread newest first.
    openClarification: isComplaintClarificationOpen(
      [...thread.data].reverse().map((r) => ({
        direction: r.direction,
        status: r.status,
        review_state: r.reviewState,
        review_reason: r.reviewReason,
        category: r.category,
        created_at: r.createdAt.toISOString(),
      })),
      now,
      rules.recent_conversation_hours * 60 * 60 * 1000,
    ),
  })
  // Ruled 2026-10-07: unresolved, no thank-you and no ask; and if the slot has
  // gone by the time it is resolved, skip. Waiting here does exactly that.
  if (standing === 'unresolved') return 'complaint_unresolved'
  if (standing === 'none') {
    // A person in the thread with nothing wrong: no automated message, as the
    // close and the check-back already rule.
    if (
      warmCloseBlocker(thread.data, DELIVERED_OUTBOUND_STATUSES) ===
      'staff_replied'
    ) {
      return 'staff_replied'
    }
  } else if (kind === 'visit_checkin') {
    // A compliment on an order the guest complained about is the wrong
    // message however well the complaint was handled.
    return 'complaint_visit'
  }

  // ---- The check-in needs an order to compliment and a history behind it. ----
  let order = ''
  let earlierOrders: string[] = []
  let priorCheckins: { body: string; angle: CheckinAngle | null }[] = []
  let signOffBody: string | null = null
  if (kind === 'visit_checkin') {
    const todays = record.data.orders.filter(
      (o) => o.localDate === visit.venueLocalDate,
    )
    const before = record.data.orders.filter(
      (o) => o.localDate < visit.venueLocalDate,
    )
    if (todays.length === 0 || before.length === 0) return 'no_order_history'
    order = [...new Set(todays.flatMap((o) => o.items))].join(', ')
    earlierOrders = before.map((o) => `${o.localDate}: ${o.items.join(', ')}`)
    const prior = await loadPriorCheckins(supabase, {
      venueId: venue.id,
      guestId: visit.guestId,
      alsoSignOffOn: visit.venueLocalDate,
    })
    if (!prior.ok) return unreadable('earlier check-ins', prior.error)
    priorCheckins = prior.data.checkins.map((c) => ({
      body: c.body,
      angle: decodeAngle(c.angle),
    }))
    signOffBody = prior.data.signOffBody
  }

  // ---- The one-message rule. ----
  const lastSpaced = await loadLastSpacedSendAt(supabase, {
    venueId: venue.id,
    guestId: visit.guestId,
  })
  if (!lastSpaced.ok) return unreadable('recent sends', lastSpaced.error)
  if (isInsideOneMessageGap(lastSpaced.data, now)) {
    return 'inside_one_message_gap'
  }
  const followup = await loadPendingInquiryFollowup(supabase, visit.guestId)
  if (!followup.ok) return unreadable('inquiry follow-up', followup.error)
  if (
    followup.data !== null &&
    standsDownFor(kind, now, [
      { kind: 'inquiry_followup', dueAt: followup.data.dueAt },
    ]) !== null
  ) {
    return 'yields_to_followup'
  }

  // ---- Claim, last, immediately before generating. ----
  const claim = await claimVisitMessage(supabase, {
    venueId: venue.id,
    guestId: visit.guestId,
    venueLocalDate: visit.venueLocalDate,
    kind,
    slot: slot.slot,
    now,
  })
  if (claim.status === 'lost') return 'claim_lost'
  if (claim.status === 'failed') {
    throw new Error(`post-visit claim failed: ${claim.error}`)
  }
  const row = { id: claim.id, venueId: venue.id, guestId: visit.guestId }

  // The review invitation rides the thank-you, resolved complaint or not
  // (ruled 2026-10-07: the same sentence). Once ever, by the marker the praise
  // ask shares, claimed here because two ticks would otherwise both find the
  // guest unasked. Losing it sends the thank-you without the invitation.
  let reviewAsk: { url: string; label: string } | undefined
  let reviewClaimedAt: Date | null = null
  if (kind === 'first_visit_thanks' && facts.data.reviewAskedAt === null) {
    const link = findReviewLink(parseVenueLinks(venue.links))
    if (link !== null) {
      const marked = await markReviewAsked({
        venueId: venue.id,
        guestId: visit.guestId,
        now,
      })
      if (marked.ok && marked.data === 'marked') {
        reviewAsk = { url: link.url, label: link.label }
        reviewClaimedAt = now
      } else if (!marked.ok) {
        console.warn('[post-visit] review claim failed; sending without it', {
          guestId: visit.guestId,
          error: marked.error,
        })
      }
    }
  }

  // The check-in's freshness check, run on the draft before a card or a send
  // exists. What it found is kept for the row.
  let rejection: PostVisitOutcome | null = null
  let angle: CheckinAngle | null = null
  const beforeSend =
    kind !== 'visit_checkin'
      ? undefined
      : async (draft: { body: string }) => {
          const verdict = await judgeCheckin({
            draft: draft.body,
            order,
            earlierOrders,
            earlier: priorCheckins,
            signOffBody,
          })
          angle = verdict.angle
          if (verdict.rejection === null) return { send: true as const }
          rejection = `not_fresh:${verdict.rejection}`
          return { send: false as const, reason: rejection }
        }

  const agentRunId = randomUUID()
  const result = await handleFollowup({
    venueId: venue.id,
    guestId: visit.guestId,
    agentRunId,
    beforeSend,
    trigger: {
      reason: 'post_visit',
      triggeredAt: now,
      postVisit: {
        kind,
        when: VISIT_WHEN[slot.slot],
        answersMessageId: newest.data.id,
        afterResolvedComplaint: standing === 'resolved',
        reviewAsk,
        order,
        priorCheckins: priorCheckins.map((c) => c.body),
      },
    },
  })
  // `angle` and `rejection` are written inside the callback; TypeScript
  // narrows both to null here, so read them back through their declared types.
  const judgedAngle = angle as CheckinAngle | null
  const notFresh = rejection as PostVisitOutcome | null

  // NOT FRESH IS A DECISION, NOT A FAILURE. The row is kept as `skipped` so
  // this visit is settled: a later tick writing a second draft and sending
  // that one would be a retry by another name, and the ruling is to send
  // nothing that day.
  if (notFresh !== null) {
    await settleVisitMessage(supabase, {
      ...row,
      outcome: 'skipped',
      skipReason: notFresh,
      angle: judgedAngle === null ? null : encodeAngle(judgedAngle),
    })
    return notFresh
  }

  // The warm close's own map and its own asymmetry: a message that will never
  // reach the guest gives back what it claimed, and one QUEUED for an operator
  // keeps it, because approving that card sends it.
  if (RELEASES_CLAIM[result.status]) {
    await releaseVisitMessage(supabase, row)
    if (reviewClaimedAt !== null) {
      await releaseReviewAskClaim({
        venueId: venue.id,
        guestId: visit.guestId,
        claimedAt: reviewClaimedAt,
      })
    }
    console.warn('[post-visit] did not send; claim released', {
      agentRunId,
      guestId: visit.guestId,
      kind,
      status: result.status,
    })
    return 'send_failed'
  }

  const stored = judgedAngle === null ? null : encodeAngle(judgedAngle)
  if (result.status === 'sent') {
    // A fresh clock: `now` predates the message it would describe.
    const sentAt = new Date()
    await settleVisitMessage(supabase, {
      ...row,
      outcome: 'sent',
      messageId: result.outboundMessageId,
      sentAt,
      angle: stored,
    })
    // So the scan greeting and the check-back, which read the shared marker,
    // can see this one.
    await recordProactiveSend(supabase, visit.guestId, sentAt)
  } else {
    await settleVisitMessage(supabase, {
      ...row,
      outcome: 'queued',
      messageId: result.status === 'queued' ? result.outboundMessageId : null,
      angle: stored,
    })
  }
  console.log('[post-visit] message handled', {
    agentRunId,
    venueId: venue.id,
    guestId: visit.guestId,
    kind,
    slot: slot.slot,
    status: result.status,
    withReviewAsk: reviewAsk !== undefined,
    afterResolvedComplaint: standing === 'resolved',
  })
  return result.status === 'sent' ? 'sent' : 'queued'
}

/**
 * Is this drafted check-in fresh? The three steps, cheapest first, and any one
 * of them failing means it is not sent:
 *
 *   wording   no thanks-for-visiting, and no five-word run shared with an
 *             earlier check-in or with that visit's sign-off. No model.
 *   judge     specific to this guest, and not the same observation as an
 *             earlier one (lib/ai/verify-visit-checkin.ts). One retry on a
 *             fault that is not a truncation, then it counts as not fresh.
 *   floor     arithmetic over the angle the judge named.
 *
 * Exported for the measurement harness, which has to score drafts by the same
 * rule production sends by.
 */
export async function judgeCheckin(input: {
  draft: string
  order: string
  earlierOrders: readonly string[]
  earlier: readonly { body: string; angle: CheckinAngle | null }[]
  signOffBody: string | null
}): Promise<{
  rejection: CheckinRejection | 'judge_failed' | null
  angle: CheckinAngle | null
  /** Model calls this made: 0 when the wording check settled it, else 1 or 2. */
  judgeCalls: number
}> {
  const earlierBodies = input.earlier.map((c) => c.body)
  const wording = checkinWordingRejection(
    input.draft,
    input.signOffBody === null
      ? earlierBodies
      : [...earlierBodies, input.signOffBody],
  )
  if (wording !== null) {
    return { rejection: wording, angle: null, judgeCalls: 0 }
  }

  const ask = () =>
    verifyVisitCheckin({
      draft: input.draft,
      order: input.order,
      earlierOrders: input.earlierOrders,
      earlierCheckins: earlierBodies,
    })
  let judgeCalls = 1
  let verdict = await ask()
  if (!verdict.ok && !verdict.errorCode?.endsWith('_truncated')) {
    judgeCalls = 2
    verdict = await ask()
  }
  if (!verdict.ok) {
    console.warn('[post-visit] freshness judge failed; not sending', {
      error: verdict.error,
    })
    return { rejection: 'judge_failed', angle: null, judgeCalls }
  }
  // Assigning the judge's kind to CheckinAngle['kind'] is what keeps the two
  // lists of angles in step: a kind added to one and not the other fails tsc
  // on this line.
  const angle: CheckinAngle = {
    kind: verdict.data.angleKind,
    item: verdict.data.angleItem,
  }
  if (!verdict.data.specificToGuest) {
    return { rejection: 'not_specific', angle, judgeCalls }
  }
  if (verdict.data.repeatsEarlier) {
    return { rejection: 'judge_says_repeat', angle, judgeCalls }
  }
  return {
    rejection: checkinAngleRejection(
      angle,
      input.earlier.map((c) => c.angle),
    ),
    angle,
    judgeCalls,
  }
}
