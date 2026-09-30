import { z } from 'zod'
import { GUEST_STATES } from '@/lib/recognition'

// Closed enum of follow-up reasons the engine can detect + dispatch (TAC-123).
// Mirrors the AI-side FollowupReason union in lib/ai/types.ts. Stored as text
// in the DB CHECK constraint (followup_log.reason); narrowed here for the
// engine + canSendFollowup gate. The two enums MUST stay in sync — the engine
// builds reasons from this set and threads them into the AI runtime, where the
// AI-side enum picks them up for rendering.
export const FOLLOWUP_REASONS = [
  'post_visit_day_1',
  'post_visit_day_3',
  'post_visit_day_7',
  'post_visit_day_14',
  'cold_lapsed',
  'perk_unlock',
] as const

export type EngineFollowupReason = (typeof FOLLOWUP_REASONS)[number]

/**
 * TAC-386: every value the `followup_log.reason` CHECK accepts.
 *
 * A SUPERSET of FOLLOWUP_REASONS, and the distinction is the point. That
 * constant means "reasons the daily engine can DETECT and dispatch", and the
 * engine's gate, its detectors and its dedup switches are all exhaustive over
 * it. This one means "reasons that can appear in the audit table", which also
 * covers rows written by processors the daily engine knows nothing about.
 *
 * Keeping them separate is what lets an inquiry follow-up write its audit row,
 * and so count toward `weekly_cap`, without being added to four exhaustive
 * switches that have no branch to give it.
 *
 * MUST match migration 066's CHECK list exactly. That is asserted against the
 * migration file itself in followup-rules.test.ts, not left to a comment.
 */
export const FOLLOWUP_LOG_REASONS = [
  ...FOLLOWUP_REASONS,
  'inquiry_followup',
] as const

export type FollowupLogReason = (typeof FOLLOWUP_LOG_REASONS)[number]

// Time-of-day rendered as "HH:MM" (24-hour). Used by the quiet-hours window.
// Validated as a literal string here so the JSONB column accepts the exact
// shape the engine reads; conversion to a number-of-minutes-since-midnight
// happens at runtime in canSendFollowup.
const HH_MM_REGEX = /^([01]\d|2[0-3]):[0-5]\d$/
const HhmmSchema = z
  .string()
  .regex(HH_MM_REGEX, 'time must be HH:MM (24-hour, leading zero required)')

/**
 * Per-venue follow-up engine rules. Lives on `venue_configs.followup_rules`
 * (jsonb, nullable at the storage layer; this schema fills in defaults on
 * null/missing). The migration writes a versioned default for every existing
 * row at apply time (db/migrations/028_venue_configs_followup_rules.sql) so
 * post-deploy reads see the populated shape; the runtime fallback below
 * exists so a fresh venue inserted between deploy and migration-apply doesn't
 * crash the engine.
 *
 * Source-of-truth invariant: FOLLOWUP_RULES_DEFAULT below must match the
 * literal default written by migration 028's UPDATE. asserted in
 * followup-rules.test.ts.
 */
export const FollowupRulesSchema = z.object({
  // Per-reason kill switches. Operator can disable post-visit / cold-lapsed /
  // perk-unlock independently per venue without changing the cron cadence.
  post_visit_enabled: z.boolean().default(true),
  cold_lapsed_enabled: z.boolean().default(true),
  perk_unlock_enabled: z.boolean().default(true),
  // cold_lapsed: a guest's last visit must be older than this many days for
  // the reason to fire. Combined with lapsed_eligible_states to narrow.
  absence_window_days: z.number().int().positive().default(21),
  // cold_lapsed: only fires when the guest is currently in one of these
  // recognition states. Drops new/returning out of scope — we don't try to
  // re-engage guests who never engaged in the first place.
  lapsed_eligible_states: z
    .array(z.enum(GUEST_STATES))
    .default(['regular', 'raving_fan']),
  // cold_lapsed: secondary dedup — even if absence_window_days passes, don't
  // fire again within this many days of the last cold_lapsed dispatch. Keyed
  // off followup_log.created_at for reason='cold_lapsed'.
  cold_dedup_days: z.number().int().positive().default(30),
  // Hard cap: total engine-initiated follow_up sends per (venue, guest) in any
  // rolling 7-day window. Operator-initiated (TAC-249 manual) sends do NOT
  // count toward this cap.
  weekly_cap: z.number().int().positive().default(1),
  // If the guest has texted in within this many hours, suppress the engine
  // entirely for this guest this tick — they're in active conversation, the
  // engine shouldn't interrupt.
  recent_conversation_hours: z.number().int().positive().default(48),
  // Quiet hours window in venue-local time. The window spans
  // [quiet_hours_start_local, quiet_hours_end_local). Implementations MUST
  // handle the midnight-crossing case (end < start, e.g. 21:00..08:00) via
  // the two-interval form: hour >= start OR hour < end.
  quiet_hours_start_local: HhmmSchema.default('21:00'),
  quiet_hours_end_local: HhmmSchema.default('08:00'),
  // The venue-local HOUR (0-23) at which processDueFollowups dispatches for
  // this venue. The cron itself fires hourly UTC; the processor filters
  // per-venue against this value (mirrors MORNING_HOUR_LOCAL=7 in
  // commitments-due.ts).
  cron_hour_local: z.number().int().min(0).max(23).default(10),

  // TAC-560: minutes of guest silence, after our last message reached them,
  // before the warm "line is open" close fires. The venue setting behind
  // WARM_CLOSE_PAUSE_MINUTES_DEFAULT in lib/agent/warm-close.ts.
  //
  // IT LIVES HERE DESPITE NOT BEING A FOLLOW-UP, and the tension is worth
  // stating rather than leaving to be discovered: `weekly_cap` does NOT count
  // the warm close, and the per-reason toggles do not gate it. What this column
  // has become is the per-venue timing-and-outreach bag, and the precedent is
  // `recent_conversation_hours`, which TAC-380's intention brake and TAC-547's
  // contextual retrieval both read for reasons unconnected to the engine.
  //
  // `quiet_hours_*` above, by contrast, DO gate it (ruled 2026-09-29), so the
  // close never lands in the middle of the night.
  //
  // NOT IN MIGRATION 028's BACKFILL LITERAL, because it postdates it. Stored
  // rows written before this key existed simply do not carry it and take the
  // default below; followup-rules.test.ts pins that 028's own eleven values are
  // unchanged and asserts this key separately.
  warm_close_pause_minutes: z.number().int().positive().default(10),

  // TAC-386: the per-venue kill switch for the inquiry follow-up, matching the
  // three per-reason toggles above. Approved 2026-09-30 without a ruling asking
  // for one: this is the most forward message the agent sends, and an operator
  // should be able to switch it off for one venue without touching the others.
  //
  // It lives here for the reason warm_close_pause_minutes does, and inherits the
  // same tension: this column has become the per-venue timing-and-outreach bag.
  // Read by lib/followups/inquiry-followup-engine.ts, NOT by canSendFollowup,
  // which this trigger never goes through.
  //
  // NOT IN MIGRATION 028's BACKFILL LITERAL, because it postdates it. Rows
  // written before this key existed do not carry it and take the default;
  // followup-rules.test.ts pins 028's own eleven values separately.
  inquiry_followup_enabled: z.boolean().default(true),

  // TAC-568: the fixed "by the way, you can always message us here" text the
  // warm close sends, WORD FOR WORD, on both paths. Approved verbatim by Jaipal
  // and never generated: ruling 1 is that this message is the same every time.
  //
  // PER VENUE because the topics it names are a product decision. Le Mil's
  // names coffee and beans, what to get next time, and what is coming up at the
  // shop; another venue's three will differ. This is the same argument
  // categories/warm-close.ts makes for why the PROMPT names no topics, applied
  // one layer out: the venue supplies the content, the mechanism supplies the
  // moment.
  //
  // THE DEFAULT IS EMPTY, AND THAT IS THE FEATURE. A default carrying Le Mil's
  // wording would ship one venue's copy to every venue on the day it shipped,
  // which is the failure `docs/decisions` keeps calling out under "every venue
  // is its own isolated block". Empty means this venue has not been given a
  // close, so neither path sends one; the timer counts it as
  // `no_warm_close_text` and handle-inbound logs it, so an unconfigured venue
  // is visible rather than silently inert.
  //
  // IT IS COPY IN A RULES BLOB, which is a stretch this column has now made
  // three times (warm_close_pause_minutes, inquiry_followup_enabled, this). The
  // alternative is a venue_configs column of its own; that tension is recorded
  // on TAC-568 as a follow-up rather than resolved here.
  //
  // NOT IN MIGRATION 028's BACKFILL LITERAL, because it postdates it. Le Mil's
  // live value was written directly into `followup_rules` (TAC-568 ruling), so
  // no migration ships with this key; followup-rules.test.ts pins that 028's own
  // eleven values are unchanged and asserts the post-028 keys separately.
  warm_close_text: z.string().default(''),
})

export type FollowupRules = z.infer<typeof FollowupRulesSchema>

/**
 * Canonical default. Source of truth for the SQL backfill in migration 028
 * (the migration's `update venue_configs set followup_rules = jsonb_build_object(...)`
 * literal must match this object key-by-key). Round-tripped in
 * followup-rules.test.ts via FollowupRulesSchema to guarantee defaults parse
 * to the same shape.
 */
export const FOLLOWUP_RULES_DEFAULT: FollowupRules = {
  post_visit_enabled: true,
  cold_lapsed_enabled: true,
  perk_unlock_enabled: true,
  absence_window_days: 21,
  lapsed_eligible_states: ['regular', 'raving_fan'],
  cold_dedup_days: 30,
  weekly_cap: 1,
  recent_conversation_hours: 48,
  quiet_hours_start_local: '21:00',
  quiet_hours_end_local: '08:00',
  cron_hour_local: 10,
  warm_close_pause_minutes: 10,
  inquiry_followup_enabled: true,
  warm_close_text: '',
}

/**
 * Parse a jsonb-shaped value (or null/undefined) into a FollowupRules with
 * defaults filled in. Used by the engine to read `venue_configs.followup_rules`
 * at scan time without crashing on a fresh venue whose row predates the
 * migration backfill.
 */
export function parseFollowupRules(value: unknown): FollowupRules {
  if (value === null || value === undefined) return FOLLOWUP_RULES_DEFAULT
  const parsed = FollowupRulesSchema.safeParse(value)
  if (!parsed.success) {
    console.warn(
      `[followup-rules] malformed followup_rules JSONB, falling back to defaults: ${parsed.error.message}`,
    )
    return FOLLOWUP_RULES_DEFAULT
  }
  return parsed.data
}
