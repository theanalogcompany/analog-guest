-- ============================================================================
-- migration 009: min_state + redemption tracking on mechanics
-- ============================================================================
-- adds:
--   1. mechanics.min_state — gates mechanic eligibility by guest's current
--      relationship band. NOT NULL DEFAULT 'new' so existing rows backfill to
--      ungated behavior (every state >= 'new').
--   2. mechanics.redemption_policy — declares whether a redemption is permanent
--      ('one_time') or refreshes after a window ('renewable'). NOT NULL DEFAULT
--      'one_time' so existing rows backfill to the conservative behavior (any
--      redemption blocks future re-offers). Named "policy" rather than "type"
--      to avoid collision with the existing mechanics.redemption.type jsonb
--      field (which describes the redemption mechanism, e.g.
--      'show_text_at_counter').
--   3. mechanics.redemption_window_days — only meaningful when redemption_policy
--      = 'renewable'. Composite check enforces (one_time + null) or
--      (renewable + non-null + > 0).
--   4. index on (venue_id, min_state) for the runtime mechanics-load query.
--   5. engagement_events.event_type extended to include 'mechanic_redeemed'.
--      The legacy 'perk_redeemed' / 'merch_redeemed' values stay in the
--      constraint for back-compat but new code emits 'mechanic_redeemed' only.
-- ============================================================================

alter table mechanics
  add column min_state text not null default 'new'
    check (min_state in ('new', 'returning', 'regular', 'raving_fan'));

alter table mechanics
  add column redemption_policy text not null default 'one_time'
    check (redemption_policy in ('one_time', 'renewable'));

alter table mechanics
  add column redemption_window_days integer
    check (redemption_window_days is null or redemption_window_days > 0);

alter table mechanics
  add constraint mechanics_redemption_window_consistency
  check (
    (redemption_policy = 'one_time' and redemption_window_days is null)
    or
    (redemption_policy = 'renewable' and redemption_window_days is not null)
  );

create index idx_mechanics_min_state on mechanics(venue_id, min_state);

-- ----------------------------------------------------------------------------
-- engagement_events: add 'mechanic_redeemed' to allowed event_types
-- ----------------------------------------------------------------------------

alter table engagement_events
  drop constraint engagement_events_event_type_check;

alter table engagement_events
  add constraint engagement_events_event_type_check
  check (event_type in (
    'first_visit',
    'return_visit',
    'state_transition',
    'milestone_reached',
    'perk_unlocked',
    'perk_redeemed',
    'referral_made',
    'referral_converted',
    'merch_redeemed',
    'mechanic_redeemed',
    'event_attended',
    'message_engagement',
    'community_join'
  ));