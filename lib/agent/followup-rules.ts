// TAC-123 Gate 1 — pre-generation suppression for the follow-up engine.
//
// Pure function. The caller (lib/followups/engine.ts) pre-loads everything
// this gate inspects in a single batched read per venue (guest row,
// last-7-day engine-initiated send count, per-reason last-dispatch row),
// then runs canSendFollowup once per guest. Keeping the gate pure makes
// every suppression branch trivially unit-testable without a DB harness
// and lets the engine fan out cleanly.
//
// Gate 2 (lib/agent/stages.ts → applyApprovalPolicyStage) is the second
// guard — runs post-generation, decides queue-vs-send. This gate is the
// FIRST guard, before any AI call burns tokens.
//
// Suppression order matches cost: cheap-and-categorical first (opt-out,
// quiet hours, recent conversation, weekly cap), then per-reason dedup.
// The first hit short-circuits; the returned `reason` tells the engine
// which counter to bump on the `followup_scan_complete` event AND which
// event to fire on the `followup_suppressed` per-guest event.

import type { EngineFollowupReason, FollowupRules } from '@/lib/schemas'

const MS_PER_HOUR = 60 * 60 * 1000
const MS_PER_DAY = 24 * MS_PER_HOUR

/**
 * Snapshot of a guest's followup_log rows the gate needs. Engine pre-loads
 * one row per reason (the most recent `created_at` per `(venue, guest,
 * reason)`) plus the rolling 7-day count.
 */
export interface FollowupLogSnapshot {
  /** Total engine-initiated rows for this (venue, guest) within the last 7 days. */
  weeklyCount: number
  /** Most-recent created_at per reason, if any, for cold + post_visit dedup. */
  lastByReason: Partial<Record<EngineFollowupReason, Date>>
}

/**
 * Guest signals the gate inspects. The engine batches these per venue;
 * the gate doesn't fetch anything itself.
 */
export interface FollowupGuestSnapshot {
  /** guests.opted_out_at — non-null = total suppression. */
  optedOutAt: Date | null
  /** guests.last_inbound_at — recent-conversation suppression. */
  lastInboundAt: Date | null
  /** guests.last_visit_at — used by cold_lapsed dedup keying. */
  lastVisitAt: Date | null
}

/** Inputs to `canSendFollowup`. */
export interface CanSendFollowupInput {
  reasons: readonly EngineFollowupReason[]
  guest: FollowupGuestSnapshot
  log: FollowupLogSnapshot
  rules: FollowupRules
  /** Venue's IANA timezone (venues.timezone). */
  venueTimezone: string
  now: Date
}

/** Suppression-reason union, also the event-payload code. */
export type FollowupSuppressionReason =
  | 'opted_out'
  | 'quiet_hours'
  | 'recent_conversation'
  | 'weekly_cap'
  | 'per_reason_dedup'

export type CanSendFollowupResult =
  | {
      ok: true
      /**
       * Subset of `input.reasons` that passed all gates. Time-bound dedup
       * (cold_lapsed within cold_dedup_days) drops affected reasons here;
       * the engine uses this filtered list to construct the claim. When
       * non-empty, the run proceeds with only these reasons; intent-bound
       * dedup (post_visit / perk dedup_key matches) is enforced at the
       * claim layer, not here.
       */
      allowedReasons: EngineFollowupReason[]
    }
  | { ok: false; reason: FollowupSuppressionReason; detail?: string }

/**
 * Decide whether to dispatch a follow-up to this guest. Pure — every input
 * is supplied by the caller.
 *
 * Returns `{ ok: true, allowedReasons }` to proceed (with the filtered
 * reasons subset), `{ ok: false, reason }` to suppress. The engine fires
 * a `followup_suppressed` event with the returned reason when suppressed.
 *
 * Why allowedReasons is the return shape: cold_lapsed has a time-bound
 * dedup orthogonal to the dedup_key intent (cold_dedup_days), and that
 * dedup is reason-specific. When cold_lapsed runs alongside another
 * reason (the common case: a regular finally visits after 30d, fires
 * cold_lapsed AND post_visit_day_7), we want to suppress ONLY cold and
 * still dispatch post_visit. Returning a single boolean ok would force
 * us to either over-suppress (drop the whole run) or under-suppress
 * (let cold_lapsed re-fire inside its window). The filtered subset is
 * the right semantic.
 */
export function canSendFollowup(input: CanSendFollowupInput): CanSendFollowupResult {
  const { reasons, guest, log, rules, venueTimezone, now } = input

  // 1. Opt-out — total suppression, irrespective of any reason.
  if (guest.optedOutAt !== null) {
    return { ok: false, reason: 'opted_out' }
  }

  // 2. Quiet hours — venue-local clock check. Even though the cron fires
  // at `cron_hour_local` (default 10am) and the default quiet window is
  // 21:00..08:00 (so the gate never trips in practice today), the run hour
  // is a tunable; this gate has to be correct.
  if (isQuietHour(now, venueTimezone, rules.quiet_hours_start_local, rules.quiet_hours_end_local)) {
    return { ok: false, reason: 'quiet_hours' }
  }

  // 3. Recent conversation — if the guest just texted in, don't interrupt.
  if (guest.lastInboundAt !== null) {
    const elapsedMs = now.getTime() - guest.lastInboundAt.getTime()
    const windowMs = rules.recent_conversation_hours * MS_PER_HOUR
    if (elapsedMs < windowMs) {
      return { ok: false, reason: 'recent_conversation' }
    }
  }

  // 4. Weekly cap — rolling 7-day count of engine-initiated rows. The cap
  // is inclusive of this prospective dispatch: weekly_cap=1 means "if any
  // engine row exists in the last 7d, suppress." Operator-initiated
  // (TAC-249 manual) sends do not write followup_log rows, so they don't
  // count toward this — per the operator's plan-review clarification.
  if (log.weeklyCount >= rules.weekly_cap) {
    return { ok: false, reason: 'weekly_cap' }
  }

  // 5. Per-reason TIME-BOUND dedup. Filter the reasons array — keep only
  // the ones that are NOT currently inside their time-bound window. Today
  // this only filters cold_lapsed (the post_visit / perk_unlock branches
  // of isReasonTimeBoundOnDedup return false unconditionally because their
  // dedup is intent-bound at the claim layer, not time-bound here). When
  // the filter empties the array entirely, the only reasons we were going
  // to dispatch are all in dedup → suppress with per_reason_dedup.
  const allowedReasons = reasons.filter(
    (reason) => !isReasonTimeBoundOnDedup(reason, log.lastByReason[reason], rules, now),
  )
  if (reasons.length > 0 && allowedReasons.length === 0) {
    return { ok: false, reason: 'per_reason_dedup' }
  }

  return { ok: true, allowedReasons: [...allowedReasons] }
}

/**
 * Pure quiet-hours check. Compares the venue-local hour of `now` against
 * `[start, end)`. Handles the midnight-crossing case (end < start) via the
 * two-interval form: hour >= start OR hour < end.
 *
 * Exported for unit testing the boundaries (20:59 / 21:00 / 07:59 / 08:00).
 *
 * Invalid timezone returns `false` (fail-OPEN — better to risk a quiet-
 * hours send than block the whole engine on bad venue config).
 */
export function isQuietHour(
  now: Date,
  venueTimezone: string,
  startLocal: string,
  endLocal: string,
): boolean {
  const nowMinutes = venueLocalMinutes(now, venueTimezone)
  if (nowMinutes === null) return false
  const startMinutes = parseHhmm(startLocal)
  const endMinutes = parseHhmm(endLocal)
  if (startMinutes === null || endMinutes === null) return false
  if (startMinutes === endMinutes) return false // zero-width window = disabled
  if (startMinutes < endMinutes) {
    // Same-day window (e.g., 02:00..04:00).
    return nowMinutes >= startMinutes && nowMinutes < endMinutes
  }
  // Midnight-crossing window (e.g., 21:00..08:00).
  return nowMinutes >= startMinutes || nowMinutes < endMinutes
}

/**
 * Venue-local hour-and-minute as minutes-since-midnight, or null on
 * invalid timezone.
 */
function venueLocalMinutes(instant: Date, venueTimezone: string): number | null {
  try {
    const formatted = new Intl.DateTimeFormat('en-GB', {
      timeZone: venueTimezone,
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(instant)
    // en-GB renders as "HH:MM" — but the day-rollover special case
    // "24:00" can appear with hourCycle=h23 on some platforms; reject it
    // alongside any other surprise.
    const parsed = parseHhmm(formatted)
    return parsed
  } catch {
    return null
  }
}

/** Parse "HH:MM" (24-hour, leading zero required) → minutes since midnight, or null. */
function parseHhmm(text: string): number | null {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(text)
  if (!match) return null
  return Number(match[1]) * 60 + Number(match[2])
}

/**
 * True when this reason is currently inside its TIME-BOUND dedup window
 * for this guest. `last` is the most-recent followup_log row created_at
 * for this (venue, guest, reason), or undefined if never dispatched.
 *
 * Only `cold_lapsed` has a time-bound dedup at the gate layer; the rest
 * are intent-bound via dedup_key at the followup_log claim step (which is
 * the precise enforcement, this gate is unconcerned).
 */
function isReasonTimeBoundOnDedup(
  reason: EngineFollowupReason,
  last: Date | undefined,
  rules: FollowupRules,
  now: Date,
): boolean {
  if (last === undefined) return false
  switch (reason) {
    case 'cold_lapsed': {
      const elapsedMs = now.getTime() - last.getTime()
      return elapsedMs < rules.cold_dedup_days * MS_PER_DAY
    }
    case 'post_visit_day_1':
    case 'post_visit_day_3':
    case 'post_visit_day_7':
    case 'post_visit_day_14':
    case 'perk_unlock':
      // Intent-bound dedup only (claim layer). Returning false here means
      // "the gate doesn't suppress on this reason being recently sent" —
      // the engine's claim step is the precise gate. The dedup_key
      // construction is what re-arms after a fresh visit (post_visit) or
      // a new mechanic (perk_unlock).
      return false
  }
}
