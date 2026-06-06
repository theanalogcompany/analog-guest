-- 028_venue_configs_followup_rules.sql
-- adds the follow-up engine's per-venue rules to venue_configs (tac-123).
-- complements the pre-existing messaging_cadence column (kept as the pure
-- day-schedule: {day_1, day_3, day_7, day_14}). followup_rules carries the
-- gate + scheduling settings the engine reads at scan time.
--
-- shape (validated by FollowupRulesSchema, lib/schemas/followup-rules.ts):
--   {
--     post_visit_enabled: true,
--     cold_lapsed_enabled: true,
--     perk_unlock_enabled: true,
--     absence_window_days: 21,                  // cold_lapsed: last visit older than this
--     lapsed_eligible_states: ['regular','raving_fan'],
--     cold_dedup_days: 30,                      // not re-armed across this window
--     weekly_cap: 1,                            // engine-initiated follow_up sends per 7d
--     recent_conversation_hours: 48,            // suppress if last_inbound_at within this window
--     quiet_hours_start_local: '21:00',
--     quiet_hours_end_local: '08:00',
--     cron_hour_local: 10                       // venue-local hour the processor fires
--   }
-- all fields required; defaults applied via the backfill below. the column
-- is nullable at the storage layer for migration ordering safety (the deploy
-- can SELECT this column before any row exists), but the runtime parser
-- (FollowupRulesSchema) substitutes defaults on null/missing values so the
-- engine always sees a complete config.
--
-- schema_version bump: 1 → 2. the column already exists per migration 001
-- (currently 1 on every row). bumping to 2 marks the followup_rules
-- addition; future readers can distinguish v1 rows (followup_rules absent
-- → uses defaults) from v2 rows (followup_rules present → uses stored
-- values). per the operator clarification on this ticket: not a new
-- precedent, just incrementing.
--
-- HIGH-STAKES per CLAUDE.md "Audit-first" — not because the column is on
-- the high-stakes table list (it isn't), but because the deployed code
-- SELECTs the new column on read (lib/followups/engine.ts +
-- lib/schemas/followup-rules.ts). per "Ordering for backwards-incompatible
-- migrations": apply in Studio BEFORE merging the PR. then run
-- `npm run db:types`. db/types.ts is hand-patched in the same commit as a
-- stopgap until db:types runs.
--
-- backfill default: written below as a json literal. keep in sync with
-- FOLLOWUP_RULES_DEFAULT in lib/schemas/followup-rules.ts — that constant
-- is the source of truth for the Zod parser; this SQL value is the source
-- of truth for the existing-row backfill at deploy time. they MUST match
-- on v1 ship (the test in followup-rules.test.ts asserts this by
-- round-tripping through JSON.parse).

alter table venue_configs
  add column followup_rules jsonb;

update venue_configs
set
  followup_rules = jsonb_build_object(
    'post_visit_enabled', true,
    'cold_lapsed_enabled', true,
    'perk_unlock_enabled', true,
    'absence_window_days', 21,
    'lapsed_eligible_states', jsonb_build_array('regular', 'raving_fan'),
    'cold_dedup_days', 30,
    'weekly_cap', 1,
    'recent_conversation_hours', 48,
    'quiet_hours_start_local', '21:00',
    'quiet_hours_end_local', '08:00',
    'cron_hour_local', 10
  ),
  schema_version = 2;

-- no index. the column is read once per scan per venue (a handful of
-- venues, infrequent reads). adding an index for jsonb path queries we
-- don't make would be premature.
