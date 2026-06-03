// TAC-123 follow-up reason detectors. Pure per-guest predicates.
//
// One function per reason: each takes the guest's signals + the venue's
// rules and returns either `null` (this reason doesn't apply) or the
// FollowupReason (and, for perk_unlock, the chosen mechanic). The engine
// collects all hits into a `FollowupReason[]` and aggregates the
// perkMechanic separately.
//
// Detectors are PURE — they consult only the data the caller hands in.
// The engine pre-loads everything in a batched per-venue query. This
// keeps each detector trivially unit-testable per branch.
//
// Detectors do NOT consult followup_log. Intent-bound dedup (have we
// already fired this dedup_key?) lives at the engine's claim step where
// the dedup_key UNIQUE constraint is the precise enforcement. The
// detectors only answer "does the calendar/state condition trip?"
//
// Time-bound dedup (cold_lapsed within cold_dedup_days) lives in
// canSendFollowup (the rules gate). Detectors stay calendar-only.

import { isStateAtLeast, type EligibleMechanic, type GuestState } from '@/lib/recognition'
import type { EngineFollowupReason, FollowupRules } from '@/lib/schemas'

const MS_PER_DAY = 24 * 60 * 60 * 1000

/**
 * Per-venue messaging_cadence (jsonb on venue_configs). Source-of-truth
 * stays the seed default `{day_1, day_3, day_7, day_14}` — the engine
 * reads this and the detector returns reasons only for enabled days. Pure
 * shape declaration; the runtime parse is permissive (missing keys =
 * disabled, extra keys ignored).
 */
export type MessagingCadence = {
  day_1?: boolean
  day_3?: boolean
  day_7?: boolean
  day_14?: boolean
}

const POST_VISIT_TIERS: ReadonlyArray<{ days: number; reason: EngineFollowupReason; cadenceKey: keyof MessagingCadence }> = [
  { days: 14, reason: 'post_visit_day_14', cadenceKey: 'day_14' },
  { days: 7, reason: 'post_visit_day_7', cadenceKey: 'day_7' },
  { days: 3, reason: 'post_visit_day_3', cadenceKey: 'day_3' },
  { days: 1, reason: 'post_visit_day_1', cadenceKey: 'day_1' },
]

/**
 * Highest enabled day_N tier this guest has crossed since their last visit.
 * Returns null when:
 *   - lastVisitAt is null (never visited);
 *   - no enabled tier has elapsed;
 *
 * "Highest only" is the engine's behavior — if a guest skipped day_1 and
 * day_3 (e.g., enrolled mid-tier-jump or cron gaps), only the highest
 * crossed tier fires on this tick. Sending day_1 + day_3 + day_7 all at
 * once would read as a backfill spam, not a thoughtful touch.
 *
 * "Due-and-not-yet-sent" semantics in the ticket are split between this
 * detector (DUE) and the engine's claim step (NOT-YET-SENT): the
 * dedup_key `day_N:<last_visit_at_iso>` makes the per-visit-episode
 * uniqueness automatic.
 */
export function detectPostVisitReason(
  lastVisitAt: Date | null,
  cadence: MessagingCadence,
  now: Date,
): EngineFollowupReason | null {
  if (lastVisitAt === null) return null
  const elapsedDays = Math.floor((now.getTime() - lastVisitAt.getTime()) / MS_PER_DAY)
  if (elapsedDays < 1) return null
  for (const tier of POST_VISIT_TIERS) {
    if (elapsedDays >= tier.days && cadence[tier.cadenceKey] === true) {
      return tier.reason
    }
  }
  return null
}

/**
 * Cold-lapsed re-engagement: the guest hasn't visited in absence_window_days
 * AND they're in one of the lapsed_eligible_states (typically regular /
 * raving_fan — we don't try to re-engage a brand-new guest who never
 * engaged in the first place).
 *
 * Time-bound dedup (cold_dedup_days) lives in canSendFollowup. Intent-bound
 * dedup (don't re-fire for the same last_visit_at) lives at the engine's
 * claim step via dedup_key='cold:<last_visit_at_iso>'. A new visit moves
 * last_visit_at forward → fresh dedup_key → re-arm automatic (per the
 * operator's "no event source needed" clarification).
 */
export function detectColdLapsedReason(
  lastVisitAt: Date | null,
  currentState: GuestState,
  rules: FollowupRules,
  now: Date,
): EngineFollowupReason | null {
  if (lastVisitAt === null) return null
  const elapsedDays = Math.floor((now.getTime() - lastVisitAt.getTime()) / MS_PER_DAY)
  if (elapsedDays < rules.absence_window_days) return null
  if (!rules.lapsed_eligible_states.includes(currentState)) return null
  return 'cold_lapsed'
}

/**
 * Perk newly eligible: the guest's current state has crossed a mechanic's
 * `min_state` gate AND we haven't announced THAT specific mechanic to
 * them yet.
 *
 * "Newly eligible" is computed inline against `eligibleMechanics`: those
 * are the mechanics filterEligibleMechanics has already cleared for this
 * guest's current state (min_state met, no active redemption). The
 * detector picks the FIRST eligible mechanic NOT in
 * `announcedMechanicIds`. Returns null when no fresh perk is available.
 *
 * Pick-the-first ordering: relies on the upstream load order of
 * `mechanics` (which today is creation order — no explicit `order by`
 * in build-runtime-context.ts's mechanics query). Acceptable for v1.
 * Operators expecting deterministic order across multiple newly-eligible
 * perks should rank explicitly in a future iteration.
 *
 * Why pick ONE perk per run rather than all newly-eligible: same logic as
 * post_visit's highest-only — announcing three perks at once reads as a
 * marketing push, not a thoughtful touch. The remaining perks stay
 * eligible and will surface on the next morning tick (or, if multiple
 * eligible perks accumulated without being announced, they each get
 * their own day across subsequent ticks).
 */
export interface DetectPerkUnlockInput {
  currentState: GuestState
  eligibleMechanics: readonly EligibleMechanic[]
  /**
   * Set of mechanic ids that already have a followup_log row with
   * dedup_key='perk:<mechanic_id>' for this guest. The engine pre-loads
   * this via a batched followup_log query per venue.
   */
  announcedMechanicIds: ReadonlySet<string>
  rules: FollowupRules
}

export function detectPerkUnlockReason(
  input: DetectPerkUnlockInput,
): { reason: 'perk_unlock'; mechanic: EligibleMechanic } | null {
  if (!input.rules.perk_unlock_enabled) return null
  for (const mechanic of input.eligibleMechanics) {
    if (input.announcedMechanicIds.has(mechanic.id)) continue
    // The `mechanic.minState` already cleared at filter-time via
    // filterEligibleMechanics + isStateAtLeast. Defensive recheck —
    // mostly a paranoid no-op, but if the upstream mechanic list ever
    // includes a mechanic with a state we don't meet, this catches it.
    if (mechanic.minState !== null && !isStateAtLeast(input.currentState, mechanic.minState)) {
      continue
    }
    return { reason: 'perk_unlock', mechanic }
  }
  return null
}

/**
 * Compose `dedup_key` for a followup_log row. Reason-appropriate:
 *   - post_visit_day_N: 'day_N:<last_visit_at_iso>' — new visit re-arms.
 *   - cold_lapsed:      'cold:<last_visit_at_iso>' — same.
 *   - perk_unlock:      'perk:<mechanic_id>'      — keyed to the specific
 *                       mechanic so different perks dedup independently.
 *
 * The engine consumes this when claiming a row + when reading the
 * "already-announced mechanics" set for the perk detector. Centralized
 * here so the construction is single-source.
 *
 * For perk_unlock the caller must pass `mechanicId`. For post_visit /
 * cold_lapsed the caller must pass `lastVisitAt`. Caller mismatch throws
 * (engine wiring bug — fail fast, never silently mis-key dedup).
 */
export function dedupKeyForReason(
  reason: EngineFollowupReason,
  details: { lastVisitAt?: Date | null; mechanicId?: string },
): string {
  switch (reason) {
    case 'post_visit_day_1':
    case 'post_visit_day_3':
    case 'post_visit_day_7':
    case 'post_visit_day_14': {
      if (!details.lastVisitAt) {
        throw new Error(
          `dedupKeyForReason: ${reason} requires lastVisitAt`,
        )
      }
      // Match the FollowupReason tag suffix (day_1 / day_3 / ...).
      const dayTag = reason.replace('post_visit_', '')
      return `${dayTag}:${details.lastVisitAt.toISOString()}`
    }
    case 'cold_lapsed': {
      if (!details.lastVisitAt) {
        throw new Error('dedupKeyForReason: cold_lapsed requires lastVisitAt')
      }
      return `cold:${details.lastVisitAt.toISOString()}`
    }
    case 'perk_unlock': {
      if (!details.mechanicId) {
        throw new Error('dedupKeyForReason: perk_unlock requires mechanicId')
      }
      return `perk:${details.mechanicId}`
    }
  }
}
