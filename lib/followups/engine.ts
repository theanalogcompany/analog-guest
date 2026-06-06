// TAC-123 follow-up engine processor — concrete sibling to TAC-297's
// processDueCommitments. Daily per-venue scan at venue-local 10am
// (followup_rules.cron_hour_local) that detects which guests are due for
// a touch, runs Gate 1 (canSendFollowup) + the claim-before-dispatch
// idempotency machinery (lib/followups/log.ts), and hands off to
// handleFollowup → applyApprovalPolicyStage → dispatch (no fork).
//
// Architectural call (operator's TAC-123 plan-review): build the literal
// sibling now, defer the shared "find-eligible → CAS-transition →
// side-effect" extraction with TAC-297 until both engines exist and the
// seam falls out cleanly. This file is intentionally concrete — no
// plugin framework, no abstract job runner.
//
// Idempotency model — claim-before-side-effect (operator's plan-review
// guidance, beyond the four open questions):
//   1. Build claim rows per detected reason + their dedup_keys.
//   2. claimFollowupLogRows (atomic INSERT). Conflict = another run is
//      handling at least one of our reasons → skip this guest entirely
//      this tick. The next tick re-evaluates; reasons still due get a
//      fresh attempt.
//   3. handleFollowup. Success (sent/queued) →
//      finalizeFollowupLogClaim stamps message_id. Refusal / failure →
//      releaseFollowupLogClaim deletes the claim so dedup isn't burned.
//
// Cron trigger: re-uses the GH Actions surface introduced by TAC-297
// (Vercel Hobby caps cron at daily; sub-daily lives on GH Actions). The
// new endpoint is /api/cron/followups-due. Per-venue local-hour
// filtering happens here in JS, mirroring MORNING_HOUR_LOCAL=7 in
// commitments-due.ts.
//
// Manual followups (TAC-249 Command Center button) bypass this engine
// entirely — they go through handleFollowup with trigger.reason='manual',
// don't write followup_log rows, and don't count toward weekly_cap.
// Inbound replies don't count either.

import { createAdminClient } from '@/lib/db/admin'
import { computeGuestState } from '@/lib/recognition/compute-state'
import {
  filterEligibleMechanics,
  type EligibilityCandidate,
  type EligibleMechanic,
  type MechanicType,
  type RedemptionPolicy,
  type RedemptionRecord,
} from '@/lib/recognition'
import type { GuestState } from '@/lib/recognition'
import {
  parseFollowupRules,
  type EngineFollowupReason,
  type FollowupRules,
} from '@/lib/schemas'
import {
  captureFollowupScanComplete,
  captureFollowupSuppressed,
  type FollowupVenueBreakdown,
} from '@/lib/analytics/posthog'
import {
  canSendFollowup,
  type FollowupSuppressionReason,
} from '@/lib/agent/followup-rules'
import { handleFollowup } from '@/lib/agent/handle-followup'
import type { FollowupTrigger } from '@/lib/agent/types'
import {
  dedupKeyForReason,
  detectColdLapsedReason,
  detectPerkUnlockReason,
  detectPostVisitReason,
  type MessagingCadence,
} from './detectors'
import {
  claimFollowupLogRows,
  emptyFollowupGuestSignals,
  finalizeFollowupLogClaim,
  loadFollowupSnapshotsForVenue,
  releaseFollowupLogClaim,
  type FollowupClaimRow,
  type FollowupGuestSignals,
} from './log'

export interface ProcessDueFollowupsResult {
  /** Total venues scanned (rows in `venues`). */
  venuesScanned: number
  /** Venues whose local hour matched their cron_hour_local this tick. */
  venuesDispatching: number
  /** Total enrolled guests evaluated across dispatching venues. */
  guestsEvaluated: number
  /** Guests with at least one detected reason. */
  guestsDue: number
  /** Guests whose dispatch fired (sent or queued) at least one followup. */
  guestsDispatched: number
  /** Guests suppressed by canSendFollowup (Gate 1). */
  guestsSuppressed: number
  /** Per-suppression-reason counts (Gate 1). */
  suppressedBy: Record<FollowupSuppressionReason, number>
  /** Guests skipped because another concurrent run already claimed at least one reason. */
  guestsConflicted: number
  /** Guests where handleFollowup returned refused / failed (claim released). */
  guestsDispatchFailed: number
  /** Per-venue breakdown for the captureFollowupScanComplete event. */
  perVenue: FollowupVenueBreakdown[]
}

const PRIMARY_REASON_PRIORITY: readonly EngineFollowupReason[] = [
  'perk_unlock',
  'cold_lapsed',
  'post_visit_day_14',
  'post_visit_day_7',
  'post_visit_day_3',
  'post_visit_day_1',
]

function pickPrimaryReason(reasons: readonly EngineFollowupReason[]): EngineFollowupReason {
  for (const r of PRIMARY_REASON_PRIORITY) {
    if (reasons.includes(r)) return r
  }
  // Unreachable in practice: pickPrimaryReason is only called when
  // reasons.length >= 1 AND every EngineFollowupReason value is enumerated
  // in PRIMARY_REASON_PRIORITY (locked by exhaustiveness — a new reason
  // landing in the union without being added here will fail the priority-
  // coverage assertion in detectors.test.ts). Throw rather than return
  // `reasons[0] | undefined` so the type signature stays honest.
  throw new Error(
    `pickPrimaryReason: no priority match for reasons=${JSON.stringify(reasons)} — extend PRIMARY_REASON_PRIORITY?`,
  )
}

/**
 * Map a FollowupReason (render-side enum, post_visit_day_*) to the
 * agent-side FollowupTrigger.reason union (day_*). The agent-side union
 * also carries 'perk_unlock' and 'cold_lapsed' directly (added in this
 * ticket); those pass through.
 */
function primaryReasonToTriggerReason(
  reason: EngineFollowupReason,
): FollowupTrigger['reason'] {
  switch (reason) {
    case 'post_visit_day_1':
      return 'day_1'
    case 'post_visit_day_3':
      return 'day_3'
    case 'post_visit_day_7':
      return 'day_7'
    case 'post_visit_day_14':
      return 'day_14'
    case 'cold_lapsed':
      return 'cold_lapsed'
    case 'perk_unlock':
      return 'perk_unlock'
  }
}

interface VenueScanContext {
  id: string
  timezone: string
  rules: FollowupRules
  cadence: MessagingCadence
  mechanicCandidates: EligibilityCandidate[]
}

interface EnrolledGuestRow {
  id: string
  optedOutAt: Date | null
  lastInboundAt: Date | null
  lastVisitAt: Date | null
}

interface RedemptionRow {
  guest_id: string
  mechanic_id: string
  created_at: string
}

/**
 * Top-level entry. Iterates every venue in `venues`, dispatches due
 * follow-ups for the venues whose local hour matches their
 * cron_hour_local. Failures per-venue / per-guest are caught + logged;
 * the function itself never throws into the cron route.
 */
export async function processDueFollowups(
  now: Date,
): Promise<ProcessDueFollowupsResult> {
  const summary: ProcessDueFollowupsResult = {
    venuesScanned: 0,
    venuesDispatching: 0,
    guestsEvaluated: 0,
    guestsDue: 0,
    guestsDispatched: 0,
    guestsSuppressed: 0,
    suppressedBy: {
      opted_out: 0,
      quiet_hours: 0,
      recent_conversation: 0,
      weekly_cap: 0,
      per_reason_dedup: 0,
    },
    guestsConflicted: 0,
    guestsDispatchFailed: 0,
    perVenue: [],
  }

  const supabase = createAdminClient()
  const venuesResult = await supabase
    .from('venues')
    .select('id, timezone, venue_configs(followup_rules, messaging_cadence)')
  if (venuesResult.error || !venuesResult.data) {
    console.error('[followup-engine] venues load failed', {
      error: venuesResult.error?.message,
    })
    return summary
  }
  summary.venuesScanned = venuesResult.data.length

  for (const venueRow of venuesResult.data) {
    const ctx = projectVenueScanContext(venueRow)
    if (!ctx) continue
    if (!isVenueDispatchingNow(ctx, now)) continue
    summary.venuesDispatching += 1
    const breakdown = await scanVenue(ctx, now, summary)
    summary.perVenue.push(breakdown)
  }

  await captureFollowupScanComplete({
    now: now.toISOString(),
    summary: {
      venuesScanned: summary.venuesScanned,
      venuesDispatching: summary.venuesDispatching,
      guestsEvaluated: summary.guestsEvaluated,
      guestsDue: summary.guestsDue,
      guestsDispatched: summary.guestsDispatched,
      guestsSuppressed: summary.guestsSuppressed,
      suppressedBy: summary.suppressedBy,
      guestsConflicted: summary.guestsConflicted,
      guestsDispatchFailed: summary.guestsDispatchFailed,
    },
    perVenue: summary.perVenue,
  })

  return summary
}

function projectVenueScanContext(venueRow: {
  id: string
  timezone: string
  venue_configs:
    | { followup_rules: unknown; messaging_cadence: unknown }
    | Array<{ followup_rules: unknown; messaging_cadence: unknown }>
    | null
}): VenueScanContext | null {
  const configRaw = venueRow.venue_configs
  const config = Array.isArray(configRaw) ? configRaw[0] ?? null : configRaw
  if (!config) {
    console.warn(
      `[followup-engine] venue ${venueRow.id} has no venue_configs row, skipping`,
    )
    return null
  }
  const rules = parseFollowupRules(config.followup_rules)
  const cadenceParsed = parseMessagingCadence(config.messaging_cadence)
  return {
    id: venueRow.id,
    timezone: venueRow.timezone,
    rules,
    cadence: cadenceParsed,
    // Filled in scanVenue (per-venue mechanic load) — typed here so the
    // wider signature stays useful even though it's empty at this layer.
    mechanicCandidates: [],
  }
}

function parseMessagingCadence(value: unknown): MessagingCadence {
  if (!value || typeof value !== 'object') return {}
  const out: MessagingCadence = {}
  const obj = value as Record<string, unknown>
  if (obj.day_1 === true || obj.day_1 === false) out.day_1 = obj.day_1
  if (obj.day_3 === true || obj.day_3 === false) out.day_3 = obj.day_3
  if (obj.day_7 === true || obj.day_7 === false) out.day_7 = obj.day_7
  if (obj.day_14 === true || obj.day_14 === false) out.day_14 = obj.day_14
  return out
}

function isVenueDispatchingNow(ctx: VenueScanContext, now: Date): boolean {
  try {
    const formatted = new Intl.DateTimeFormat('en-GB', {
      timeZone: ctx.timezone,
      hour: '2-digit',
      hour12: false,
    }).format(now)
    const hour = Number(formatted)
    if (Number.isNaN(hour)) return false
    return hour === ctx.rules.cron_hour_local
  } catch {
    console.warn(
      `[followup-engine] invalid timezone "${ctx.timezone}" for venue ${ctx.id}, skipping`,
    )
    return false
  }
}

async function scanVenue(
  ctx: VenueScanContext,
  now: Date,
  summary: ProcessDueFollowupsResult,
): Promise<FollowupVenueBreakdown> {
  const breakdown: FollowupVenueBreakdown = {
    venueId: ctx.id,
    guestsEvaluated: 0,
    guestsDue: 0,
    guestsDispatched: 0,
    guestsSuppressed: 0,
    guestsConflicted: 0,
    guestsDispatchFailed: 0,
  }

  const supabase = createAdminClient()

  const [guestsResult, mechanicsResult, redemptionsResult] = await Promise.all([
    supabase
      .from('guests')
      .select('id, opted_out_at, last_inbound_at, last_visit_at')
      .eq('venue_id', ctx.id)
      .not('phone_number', 'is', null)
      .is('opted_out_at', null)
      .in('status', ['new', 'active']),
    supabase
      .from('mechanics')
      .select(
        'id, type, name, description, qualification, reward_description, min_state, redemption_policy, redemption_window_days, requires_operator_approval',
      )
      .eq('venue_id', ctx.id)
      .eq('is_active', true),
    supabase
      .from('engagement_events')
      .select('guest_id, mechanic_id, created_at')
      .eq('venue_id', ctx.id)
      .eq('event_type', 'mechanic_redeemed')
      .not('mechanic_id', 'is', null),
  ])

  if (guestsResult.error || !guestsResult.data) {
    console.error('[followup-engine] guests load failed', {
      venueId: ctx.id,
      error: guestsResult.error?.message,
    })
    return breakdown
  }
  if (mechanicsResult.error) {
    console.error('[followup-engine] mechanics load failed', {
      venueId: ctx.id,
      error: mechanicsResult.error.message,
    })
    return breakdown
  }
  if (redemptionsResult.error) {
    console.error('[followup-engine] redemptions load failed', {
      venueId: ctx.id,
      error: redemptionsResult.error.message,
    })
    return breakdown
  }

  const enrolledGuests: EnrolledGuestRow[] = guestsResult.data.map((g) => ({
    id: g.id,
    optedOutAt: g.opted_out_at ? new Date(g.opted_out_at) : null,
    lastInboundAt: g.last_inbound_at ? new Date(g.last_inbound_at) : null,
    lastVisitAt: g.last_visit_at ? new Date(g.last_visit_at) : null,
  }))

  const mechanicCandidates: EligibilityCandidate[] = (mechanicsResult.data ?? []).map((m) => ({
    id: m.id,
    type: m.type as MechanicType,
    name: m.name,
    description: m.description,
    qualification: m.qualification,
    rewardDescription: m.reward_description,
    minState: m.min_state,
    redemptionPolicy: m.redemption_policy as RedemptionPolicy,
    redemptionWindowDays: m.redemption_window_days,
    requiresOperatorApproval: m.requires_operator_approval,
  }))

  const redemptionsByGuest = new Map<string, RedemptionRecord[]>()
  for (const row of (redemptionsResult.data ?? []) as RedemptionRow[]) {
    if (!row.mechanic_id) continue
    let list = redemptionsByGuest.get(row.guest_id)
    if (!list) {
      list = []
      redemptionsByGuest.set(row.guest_id, list)
    }
    list.push({ mechanicId: row.mechanic_id, createdAt: new Date(row.created_at) })
  }

  const guestIds = enrolledGuests.map((g) => g.id)
  const snapshotsResult = await loadFollowupSnapshotsForVenue(ctx.id, guestIds, now)
  if (!snapshotsResult.ok) {
    console.error('[followup-engine] followup_log snapshots load failed', {
      venueId: ctx.id,
      error: snapshotsResult.error,
    })
    return breakdown
  }
  const snapshots = snapshotsResult.data

  for (const guest of enrolledGuests) {
    breakdown.guestsEvaluated += 1
    summary.guestsEvaluated += 1
    const snap = snapshots.get(guest.id) ?? emptyFollowupGuestSignals()

    let currentState: GuestState
    try {
      const stateResult = await computeGuestState({
        guestId: guest.id,
        venueId: ctx.id,
      })
      if (!stateResult.ok) {
        console.warn(
          `[followup-engine] computeGuestState failed for guest=${guest.id}: ${stateResult.error}`,
        )
        continue
      }
      currentState = stateResult.data.state
    } catch (e) {
      console.warn(
        `[followup-engine] computeGuestState threw for guest=${guest.id}: ${
          e instanceof Error ? e.message : String(e)
        }`,
      )
      continue
    }

    const eligibleMechanics: EligibleMechanic[] = filterEligibleMechanics(
      mechanicCandidates,
      redemptionsByGuest.get(guest.id) ?? [],
      currentState,
      now,
    )

    const detected = runDetectors({
      guest,
      currentState,
      eligibleMechanics,
      snapshot: snap,
      ctx,
      now,
    })

    if (detected.reasons.length === 0) continue
    breakdown.guestsDue += 1
    summary.guestsDue += 1

    const gateResult = canSendFollowup({
      reasons: detected.reasons,
      guest: {
        optedOutAt: guest.optedOutAt,
        lastInboundAt: guest.lastInboundAt,
        lastVisitAt: guest.lastVisitAt,
      },
      log: {
        weeklyCount: snap.weeklyCount,
        lastByReason: snap.lastByReason,
      },
      rules: ctx.rules,
      venueTimezone: ctx.timezone,
      now,
    })
    if (!gateResult.ok) {
      breakdown.guestsSuppressed += 1
      summary.guestsSuppressed += 1
      summary.suppressedBy[gateResult.reason] += 1
      await captureFollowupSuppressed({
        venueId: ctx.id,
        guestId: guest.id,
        wouldHaveDispatchedReasons: detected.reasons,
        suppressionReason: gateResult.reason,
      })
      continue
    }

    // Honor the gate's reason-level filter: time-bound dedup may have
    // dropped one or more reasons (e.g., cold_lapsed within
    // cold_dedup_days) even though the run as a whole proceeds. If the
    // primary reason was filtered out, we re-pick from what remains. The
    // perkMechanic only stays if perk_unlock survives.
    const allowedReasons = gateResult.allowedReasons
    if (allowedReasons.length === 0) {
      // Defensive — the gate guarantees non-empty when ok=true, but type
      // doesn't enforce. Skip rather than crash.
      console.warn(
        `[followup-engine] gate ok with empty allowedReasons for guest=${guest.id}, skipping`,
      )
      continue
    }
    const perkMechanicAfterFilter =
      allowedReasons.includes('perk_unlock') ? detected.perkMechanic : undefined

    const claimRows: FollowupClaimRow[] = allowedReasons.map((reason) => ({
      venueId: ctx.id,
      guestId: guest.id,
      reason,
      dedupKey: dedupKeyForReason(reason, {
        lastVisitAt: guest.lastVisitAt,
        mechanicId: perkMechanicAfterFilter?.id,
      }),
    }))

    const claimResult = await claimFollowupLogRows(claimRows)
    if (!claimResult.ok) {
      console.warn(
        `[followup-engine] claim failed for guest=${guest.id}: ${claimResult.error}`,
      )
      breakdown.guestsDispatchFailed += 1
      summary.guestsDispatchFailed += 1
      continue
    }
    if ('conflict' in claimResult) {
      breakdown.guestsConflicted += 1
      summary.guestsConflicted += 1
      continue
    }
    const claims = claimResult.claimed
    const claimIds = claims.map((c) => c.id)

    const dispatchResult = await dispatchOnce({
      ctx,
      guestId: guest.id,
      reasons: allowedReasons,
      perkMechanic: perkMechanicAfterFilter,
      now,
    })

    if (dispatchResult.kind === 'sent' || dispatchResult.kind === 'queued') {
      const finalize = await finalizeFollowupLogClaim(claimIds, dispatchResult.messageId)
      if (!finalize.ok) {
        console.warn(
          `[followup-engine] finalize failed for guest=${guest.id} message=${dispatchResult.messageId}: ${finalize.error}`,
        )
      }
      breakdown.guestsDispatched += 1
      summary.guestsDispatched += 1
    } else if (dispatchResult.kind === 'release_claim') {
      // Pre-persist failure or refusal — safe to release the claim so
      // the next morning tick can re-attempt. Dedup is NOT burned.
      const release = await releaseFollowupLogClaim(claimIds)
      if (!release.ok) {
        console.warn(
          `[followup-engine] release failed for guest=${guest.id}: ${release.error}`,
        )
      }
      breakdown.guestsDispatchFailed += 1
      summary.guestsDispatchFailed += 1
    } else {
      // Post-persist failure (handleFollowup wrote a messages row but
      // Sendblue dispatch crashed). DO NOT release — the claim row
      // (message_id=NULL) is the audit signal for manual operator
      // investigation. Releasing would let the next tick re-claim and
      // re-dispatch, producing a duplicate. See migration 029 header +
      // CLAUDE.md "Common gotchas".
      console.warn(
        `[followup-engine] post-persist dispatch failure for guest=${guest.id}; claim left in place (message_id=NULL audit row)`,
      )
      breakdown.guestsDispatchFailed += 1
      summary.guestsDispatchFailed += 1
    }
  }

  return breakdown
}

function runDetectors(input: {
  guest: EnrolledGuestRow
  currentState: GuestState
  eligibleMechanics: readonly EligibleMechanic[]
  snapshot: FollowupGuestSignals
  ctx: VenueScanContext
  now: Date
}): {
  reasons: EngineFollowupReason[]
  perkMechanic?: EligibleMechanic
} {
  const reasons: EngineFollowupReason[] = []
  let perkMechanic: EligibleMechanic | undefined

  if (input.ctx.rules.post_visit_enabled) {
    const postVisit = detectPostVisitReason(input.guest.lastVisitAt, input.ctx.cadence, input.now)
    if (postVisit) reasons.push(postVisit)
  }
  if (input.ctx.rules.cold_lapsed_enabled) {
    const cold = detectColdLapsedReason(
      input.guest.lastVisitAt,
      input.currentState,
      input.ctx.rules,
      input.now,
    )
    if (cold) reasons.push(cold)
  }
  if (input.ctx.rules.perk_unlock_enabled) {
    const perk = detectPerkUnlockReason({
      currentState: input.currentState,
      eligibleMechanics: input.eligibleMechanics,
      announcedMechanicIds: input.snapshot.announcedMechanicIds,
      rules: input.ctx.rules,
    })
    if (perk) {
      reasons.push(perk.reason)
      perkMechanic = perk.mechanic
    }
  }

  return { reasons, perkMechanic }
}

interface DispatchOutcomeSent {
  kind: 'sent' | 'queued'
  messageId: string
}
// Pre-persist failure (refusal, or stage in {context_build, classification,
// corpus, generation}) → engine RELEASES the claim. No side-effect
// occurred; safe to retry next tick.
interface DispatchOutcomeReleaseClaim {
  kind: 'release_claim'
}
// Post-persist failure (stage in {persist, send}) → engine KEEPS the
// claim (message_id stays NULL) as the audit signal. Releasing risks
// duplicate dispatch on the next tick.
interface DispatchOutcomeKeepClaim {
  kind: 'keep_claim'
}
type DispatchOutcome =
  | DispatchOutcomeSent
  | DispatchOutcomeReleaseClaim
  | DispatchOutcomeKeepClaim

/**
 * Build a FollowupTrigger from the detected reasons + perkMechanic and
 * dispatch via handleFollowup. Returns a normalized outcome shape so the
 * engine can route to finalize / release without inspecting the full
 * AgentResult discriminated union.
 *
 * Catches handleFollowup throws — the orchestrator is supposed to be
 * fail-closed (returns AgentResult.failed on every internal error path),
 * but defensively we catch here so a thrown handleFollowup can't crash
 * the per-guest loop.
 */
async function dispatchOnce(input: {
  ctx: VenueScanContext
  guestId: string
  reasons: readonly EngineFollowupReason[]
  perkMechanic?: EligibleMechanic
  now: Date
}): Promise<DispatchOutcome> {
  const primaryReason = pickPrimaryReason(input.reasons)
  const triggerReason = primaryReasonToTriggerReason(primaryReason)
  // additionalReasons = everything OTHER than the primary, in detector
  // enumeration order (post_visit → cold → perk per runDetectors). Not
  // sorted by PRIMARY_REASON_PRIORITY because the relative ordering of
  // non-primary reasons doesn't affect downstream rendering (the
  // serializer's weaving rider treats reasons[] as an unordered set).
  const additionalReasons = input.reasons.filter((r) => r !== primaryReason)
  const trigger: FollowupTrigger = {
    reason: triggerReason,
    triggeredAt: input.now,
    ...(additionalReasons.length > 0 ? { additionalReasons } : {}),
    ...(input.perkMechanic ? { perkMechanic: input.perkMechanic } : {}),
  }

  try {
    const result = await handleFollowup({
      venueId: input.ctx.id,
      guestId: input.guestId,
      trigger,
    })
    if (result.status === 'sent') {
      return { kind: 'sent', messageId: result.outboundMessageId }
    }
    if (result.status === 'queued') {
      return { kind: 'queued', messageId: result.outboundMessageId }
    }
    if (result.status === 'refused') {
      // Pre-persist by construction — generateStage returned refused
      // before any DB write. Safe to release.
      return { kind: 'release_claim' }
    }
    if (result.status === 'failed') {
      // Stage tells us whether a side-effect happened. Pre-persist
      // stages → release. Post-persist (persist / send) → keep claim
      // as audit row to prevent next-tick duplicate dispatch.
      switch (result.stage) {
        case 'persist':
        case 'send':
          return { kind: 'keep_claim' }
        default:
          return { kind: 'release_claim' }
      }
    }
    // skipped_duplicate is an inbound-flow shape that shouldn't appear
    // on the followup path; defensively release the claim if it does.
    return { kind: 'release_claim' }
  } catch (e) {
    // handleFollowup is supposed to be fail-closed (catches its own
    // errors), so a throw here is unexpected. We don't know whether a
    // side-effect occurred — keep the claim as audit row.
    console.error(`[followup-engine] handleFollowup threw for guest=${input.guestId}`, {
      error: e instanceof Error ? e.message : String(e),
    })
    return { kind: 'keep_claim' }
  }
}
