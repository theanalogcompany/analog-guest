import { describe, expect, it } from 'vitest'
import { FOLLOWUP_RULES_DEFAULT, type FollowupRules } from '@/lib/schemas'
import {
  canSendFollowup,
  type FollowupGuestSnapshot,
  type FollowupLogSnapshot,
  isQuietHour,
} from './followup-rules'

const TZ = 'America/Los_Angeles'

// Helpers. Quick stand-up of a "no signals on file" guest + log so each test
// can vary the one field it's exercising.
function emptyGuest(overrides: Partial<FollowupGuestSnapshot> = {}): FollowupGuestSnapshot {
  return {
    optedOutAt: null,
    lastInboundAt: null,
    lastVisitAt: null,
    ...overrides,
  }
}
function emptyLog(overrides: Partial<FollowupLogSnapshot> = {}): FollowupLogSnapshot {
  return { weeklyCount: 0, lastByReason: {}, ...overrides }
}
function rulesWith(overrides: Partial<FollowupRules>): FollowupRules {
  return { ...FOLLOWUP_RULES_DEFAULT, ...overrides }
}
// 2026-06-03T17:30:00-07:00 = 2026-06-04T00:30:00Z. Pinned because the
// quiet-hours math is hour-local; we pick PT 17:30 as a "definitely
// outside default quiet window" anchor.
const NOW = new Date('2026-06-04T00:30:00Z')

describe('canSendFollowup', () => {
  it('proceeds when no signal blocks (returns allowedReasons = input reasons)', () => {
    expect(
      canSendFollowup({
        reasons: ['post_visit_day_7'],
        guest: emptyGuest(),
        log: emptyLog(),
        rules: FOLLOWUP_RULES_DEFAULT,
        venueTimezone: TZ,
        now: NOW,
      }),
    ).toEqual({ ok: true, allowedReasons: ['post_visit_day_7'] })
  })

  it('suppresses on opt-out', () => {
    expect(
      canSendFollowup({
        reasons: ['post_visit_day_7'],
        guest: emptyGuest({ optedOutAt: new Date('2026-01-01') }),
        log: emptyLog(),
        rules: FOLLOWUP_RULES_DEFAULT,
        venueTimezone: TZ,
        now: NOW,
      }),
    ).toEqual({ ok: false, reason: 'opted_out' })
  })

  it('suppresses on quiet hours', () => {
    // 22:00 PT (5am UTC) — inside default 21:00..08:00 quiet window.
    const insideQuiet = new Date('2026-06-04T05:00:00Z')
    expect(
      canSendFollowup({
        reasons: ['post_visit_day_7'],
        guest: emptyGuest(),
        log: emptyLog(),
        rules: FOLLOWUP_RULES_DEFAULT,
        venueTimezone: TZ,
        now: insideQuiet,
      }),
    ).toEqual({ ok: false, reason: 'quiet_hours' })
  })

  it('suppresses on recent conversation (within recent_conversation_hours)', () => {
    expect(
      canSendFollowup({
        reasons: ['post_visit_day_7'],
        guest: emptyGuest({
          // 2 hours ago — well inside the 48h default window.
          lastInboundAt: new Date(NOW.getTime() - 2 * 60 * 60 * 1000),
        }),
        log: emptyLog(),
        rules: FOLLOWUP_RULES_DEFAULT,
        venueTimezone: TZ,
        now: NOW,
      }),
    ).toEqual({ ok: false, reason: 'recent_conversation' })
  })

  it('proceeds when last_inbound_at is exactly at the window boundary', () => {
    // Strict-less-than comparison: elapsed == windowMs is NOT inside.
    const windowMs = FOLLOWUP_RULES_DEFAULT.recent_conversation_hours * 60 * 60 * 1000
    expect(
      canSendFollowup({
        reasons: ['post_visit_day_7'],
        guest: emptyGuest({
          lastInboundAt: new Date(NOW.getTime() - windowMs),
        }),
        log: emptyLog(),
        rules: FOLLOWUP_RULES_DEFAULT,
        venueTimezone: TZ,
        now: NOW,
      }),
    ).toEqual({ ok: true, allowedReasons: ['post_visit_day_7'] })
  })

  it('suppresses on weekly cap (>= cap)', () => {
    expect(
      canSendFollowup({
        reasons: ['post_visit_day_7'],
        guest: emptyGuest(),
        log: emptyLog({ weeklyCount: 1 }),
        rules: FOLLOWUP_RULES_DEFAULT, // weekly_cap = 1
        venueTimezone: TZ,
        now: NOW,
      }),
    ).toEqual({ ok: false, reason: 'weekly_cap' })
  })

  it('respects a higher weekly_cap from rules', () => {
    expect(
      canSendFollowup({
        reasons: ['post_visit_day_7'],
        guest: emptyGuest(),
        log: emptyLog({ weeklyCount: 1 }),
        rules: rulesWith({ weekly_cap: 2 }),
        venueTimezone: TZ,
        now: NOW,
      }),
    ).toEqual({ ok: true, allowedReasons: ['post_visit_day_7'] })
  })

  it('does NOT time-bound dedup post_visit at the gate (claim layer handles intent-bound)', () => {
    // Even with a same-day post_visit_day_7 row in the log, the gate
    // proceeds — intent-bound dedup (was-this-for-the-same-last_visit_at?)
    // is the engine's claim step, not the gate.
    expect(
      canSendFollowup({
        reasons: ['post_visit_day_7'],
        guest: emptyGuest(),
        log: emptyLog({
          lastByReason: {
            post_visit_day_7: new Date(NOW.getTime() - 1 * 24 * 60 * 60 * 1000),
          },
        }),
        rules: FOLLOWUP_RULES_DEFAULT,
        venueTimezone: TZ,
        now: NOW,
      }),
    ).toEqual({ ok: true, allowedReasons: ['post_visit_day_7'] })
  })

  it('does NOT time-bound dedup perk_unlock at the gate (mechanic dedup is claim-layer)', () => {
    expect(
      canSendFollowup({
        reasons: ['perk_unlock'],
        guest: emptyGuest(),
        log: emptyLog({
          lastByReason: {
            perk_unlock: new Date(NOW.getTime() - 1 * 24 * 60 * 60 * 1000),
          },
        }),
        rules: FOLLOWUP_RULES_DEFAULT,
        venueTimezone: TZ,
        now: NOW,
      }),
    ).toEqual({ ok: true, allowedReasons: ['perk_unlock'] })
  })

  it('drops cold_lapsed from allowedReasons when it\'s inside cold_dedup_days (mixed run)', () => {
    // The bug-was-here case: a regular finally visits after 30+ days,
    // post_visit_day_7 AND cold_lapsed both detect. The old code with
    // `every(onDedup)` would proceed with the cold reason intact and
    // re-fire cold within the window. The fixed code filters cold OUT
    // of allowedReasons; only post_visit_day_7 makes it to the claim.
    expect(
      canSendFollowup({
        reasons: ['cold_lapsed', 'post_visit_day_7'],
        guest: emptyGuest(),
        log: emptyLog({
          lastByReason: {
            cold_lapsed: new Date(NOW.getTime() - 1 * 24 * 60 * 60 * 1000),
          },
        }),
        rules: FOLLOWUP_RULES_DEFAULT,
        venueTimezone: TZ,
        now: NOW,
      }),
    ).toEqual({ ok: true, allowedReasons: ['post_visit_day_7'] })
  })

  it('proceeds when at least one reason is fresh (multi-reason aggregation)', () => {
    expect(
      canSendFollowup({
        reasons: ['cold_lapsed', 'perk_unlock'],
        guest: emptyGuest(),
        log: emptyLog({
          lastByReason: {
            // cold_lapsed is on time-bound dedup; perk_unlock isn't time-bound
            // at the gate → cold drops from allowedReasons, perk proceeds.
            cold_lapsed: new Date(NOW.getTime() - 1 * 24 * 60 * 60 * 1000),
          },
        }),
        rules: FOLLOWUP_RULES_DEFAULT,
        venueTimezone: TZ,
        now: NOW,
      }),
    ).toEqual({ ok: true, allowedReasons: ['perk_unlock'] })
  })

  it('cold_lapsed dedup re-opens after cold_dedup_days', () => {
    expect(
      canSendFollowup({
        reasons: ['cold_lapsed'],
        guest: emptyGuest(),
        log: emptyLog({
          lastByReason: {
            cold_lapsed: new Date(
              // Exactly cold_dedup_days ago — outside the strict-less-than window.
              NOW.getTime() - FOLLOWUP_RULES_DEFAULT.cold_dedup_days * 24 * 60 * 60 * 1000,
            ),
          },
        }),
        rules: FOLLOWUP_RULES_DEFAULT,
        venueTimezone: TZ,
        now: NOW,
      }),
    ).toEqual({ ok: true, allowedReasons: ['cold_lapsed'] })
  })

  it('cold_lapsed dedup suppresses inside cold_dedup_days', () => {
    expect(
      canSendFollowup({
        reasons: ['cold_lapsed'],
        guest: emptyGuest(),
        log: emptyLog({
          lastByReason: {
            // 1 day ago — well inside default 30d.
            cold_lapsed: new Date(NOW.getTime() - 1 * 24 * 60 * 60 * 1000),
          },
        }),
        rules: FOLLOWUP_RULES_DEFAULT,
        venueTimezone: TZ,
        now: NOW,
      }),
    ).toEqual({ ok: false, reason: 'per_reason_dedup' })
  })

  it('short-circuits on the first suppression hit (order: opt-out beats quiet)', () => {
    // Both signals are set; the returned reason should be 'opted_out'
    // (cheaper check, fires first).
    const insideQuiet = new Date('2026-06-04T05:00:00Z')
    expect(
      canSendFollowup({
        reasons: ['post_visit_day_7'],
        guest: emptyGuest({ optedOutAt: new Date('2026-01-01') }),
        log: emptyLog(),
        rules: FOLLOWUP_RULES_DEFAULT,
        venueTimezone: TZ,
        now: insideQuiet,
      }),
    ).toEqual({ ok: false, reason: 'opted_out' })
  })

  it('proceeds on an empty reasons array (defensive — engine never builds one)', () => {
    // No reasons → no per-reason dedup → falls through to ok with an
    // empty allowedReasons. The engine never invokes the gate with an
    // empty array (no reasons = no run), but the gate is defensive so the
    // failure mode is "passthrough" not "crash."
    expect(
      canSendFollowup({
        reasons: [],
        guest: emptyGuest(),
        log: emptyLog(),
        rules: FOLLOWUP_RULES_DEFAULT,
        venueTimezone: TZ,
        now: NOW,
      }),
    ).toEqual({ ok: true, allowedReasons: [] })
  })
})

describe('isQuietHour', () => {
  // Default 21:00..08:00 PT (midnight-crossing window).
  it('is true at 21:00 (start boundary, inclusive)', () => {
    expect(isQuietHour(new Date('2026-06-04T04:00:00Z'), TZ, '21:00', '08:00')).toBe(true)
  })

  it('is false at 20:59 (one minute before start)', () => {
    expect(isQuietHour(new Date('2026-06-04T03:59:00Z'), TZ, '21:00', '08:00')).toBe(false)
  })

  it('is true at 00:30 (midnight crossing case)', () => {
    expect(isQuietHour(new Date('2026-06-04T07:30:00Z'), TZ, '21:00', '08:00')).toBe(true)
  })

  it('is true at 07:59 (one minute before end)', () => {
    expect(isQuietHour(new Date('2026-06-04T14:59:00Z'), TZ, '21:00', '08:00')).toBe(true)
  })

  it('is false at 08:00 (end boundary, exclusive)', () => {
    expect(isQuietHour(new Date('2026-06-04T15:00:00Z'), TZ, '21:00', '08:00')).toBe(false)
  })

  it('is false at 10:00 (the default cron hour — main no-op case)', () => {
    expect(isQuietHour(new Date('2026-06-04T17:00:00Z'), TZ, '21:00', '08:00')).toBe(false)
  })

  it('handles a same-day window (02:00..04:00) correctly', () => {
    expect(isQuietHour(new Date('2026-06-04T09:30:00Z'), TZ, '02:00', '04:00')).toBe(true)
    expect(isQuietHour(new Date('2026-06-04T11:00:00Z'), TZ, '02:00', '04:00')).toBe(false)
  })

  it('returns false for an invalid timezone (fail-OPEN)', () => {
    expect(isQuietHour(NOW, 'Not/Real_Tz', '21:00', '08:00')).toBe(false)
  })

  it('treats a zero-width window as disabled', () => {
    expect(isQuietHour(NOW, TZ, '21:00', '21:00')).toBe(false)
  })
})
