-- 005_post_recognition_refinements.sql
-- batches schema changes accumulated since 003 across multiple modules:
--   1. voice_embeddings.retrieval_count + last_retrieved_at — for THE-119
--      (voice corpus management UI / corpus pruning)
--   2. voice_corpus.added_by_operator_id — audit trail of who added each entry
--      (THE-120 analog admin voice editing)
--   3. operator_venues.permission_level extended to include 'analog_admin' —
--      so Analog team members can be added to venues with super-admin role
--   4. guests.home_postal_code + distance_to_venue_miles — feeds the
--      distance multiplier in the recognition module (THE-102)
--   5. engagement_events.event_type extended to include 'referral_converted' —
--      so we can fire this event when a referred friend completes a transaction
--      (recognition module already has weights for it)

-- ============================================================================
-- 1. voice_embeddings retrieval analytics
-- ============================================================================

alter table voice_embeddings
  add column retrieval_count integer not null default 0,
  add column last_retrieved_at timestamptz;

-- index for queries that surface low-utilization chunks for pruning
create index idx_voice_embeddings_retrieval
  on voice_embeddings(venue_id, retrieval_count, last_retrieved_at nulls first);

-- ============================================================================
-- 2. voice_corpus authorship
-- ============================================================================

alter table voice_corpus
  add column added_by_operator_id uuid references operators(id) on delete set null;

-- partial index for queries that filter by adder
create index idx_voice_corpus_added_by
  on voice_corpus(added_by_operator_id)
  where added_by_operator_id is not null;

-- ============================================================================
-- 3. operator_venues.permission_level extended to include 'analog_admin'
-- ============================================================================
-- analog team members get this role on pilot venues so they can edit voice
-- corpus, brand persona, etc. on behalf of the venue during pilot.

alter table operator_venues
  drop constraint operator_venues_permission_level_check;

alter table operator_venues
  add constraint operator_venues_permission_level_check
  check (permission_level in (
    'viewer',
    'editor',
    'admin',
    'owner',
    'analog_admin'
  ));

-- ============================================================================
-- 4. guests location for distance multiplier
-- ============================================================================
-- captured during onboarding (NFC tap form, first conversation) or via
-- operator dashboard. distance_to_venue_miles is computed from postal_code
-- + venue address and cached on the row. nullable: most guests won't have
-- this for a while during early pilot.

alter table guests
  add column home_postal_code text,
  add column distance_to_venue_miles numeric(6, 2);

-- format check on postal code: allow most reasonable formats
-- (US 5 or 9 digit, or international up to 10 chars). loose check.
alter table guests
  add constraint guests_home_postal_code_format
  check (
    home_postal_code is null
    or (length(home_postal_code) between 3 and 12)
  );

-- distance must be non-negative
alter table guests
  add constraint guests_distance_non_negative
  check (
    distance_to_venue_miles is null
    or distance_to_venue_miles >= 0
  );

-- ============================================================================
-- 5. engagement_events.event_type extended for referral_converted
-- ============================================================================
-- the recognition module already has weights configured for referral_converted;
-- this constraint extension allows the event type to be persisted.

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
    'event_attended',
    'message_engagement',
    'community_join'
  ));

-- ============================================================================
-- end of migration
-- ============================================================================
