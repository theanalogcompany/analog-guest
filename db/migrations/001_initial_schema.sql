-- analog-guest initial schema
-- creates all 12 core tables for the messaging engine
-- rls policies are added in a separate follow-up migration

-- ============================================================================
-- extensions
-- ============================================================================

create extension if not exists "pgcrypto";   -- gen_random_uuid()
create extension if not exists vector;        -- pgvector for embeddings

-- ============================================================================
-- shared trigger function: auto-update updated_at on row change
-- ============================================================================

create or replace function set_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

-- ============================================================================
-- table: venues
-- root of every block. everything venue-scoped FKs back to here.
-- ============================================================================

create table venues (
  id uuid primary key default gen_random_uuid(),

  -- identity
  name text not null,
  slug text unique not null,
  status text not null default 'pending'
    check (status in ('pending', 'active', 'paused', 'archived')),

  -- routing
  messaging_phone_number text unique
    check (messaging_phone_number is null or messaging_phone_number ~ '^\+[1-9]\d{1,14}$'),
  timezone text not null default 'America/Los_Angeles',

  -- test data toggle
  is_test boolean not null default false,

  -- audit
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index idx_venues_status on venues(status);
create index idx_venues_messaging_phone on venues(messaging_phone_number);
create index idx_venues_slug on venues(slug);
create index idx_venues_is_test on venues(is_test);

create trigger trg_venues_updated_at
  before update on venues
  for each row execute function set_updated_at();

-- ============================================================================
-- table: operators
-- humans on the venue side. linked to supabase auth via auth_user_id.
-- ============================================================================

create table operators (
  id uuid primary key default gen_random_uuid(),

  -- identity (from supabase auth)
  auth_user_id uuid unique not null,
  email text unique not null,
  phone_number text
    check (phone_number is null or phone_number ~ '^\+[1-9]\d{1,14}$'),

  -- profile
  full_name text,
  job_title text,
  avatar_url text,

  -- activity
  last_seen_at timestamptz,

  -- test data toggle
  is_test boolean not null default false,

  -- audit
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index idx_operators_auth_user_id on operators(auth_user_id);
create index idx_operators_email on operators(email);
create index idx_operators_is_test on operators(is_test);

create trigger trg_operators_updated_at
  before update on operators
  for each row execute function set_updated_at();

-- ============================================================================
-- table: operator_venues
-- many-to-many join: an operator can access multiple venues, with a role per venue
-- ============================================================================

create table operator_venues (
  id uuid primary key default gen_random_uuid(),

  operator_id uuid not null references operators(id) on delete cascade,
  venue_id uuid not null references venues(id) on delete cascade,
  permission_level text not null default 'editor'
    check (permission_level in ('viewer', 'editor', 'admin', 'owner')),

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  unique (operator_id, venue_id)
);

create index idx_operator_venues_operator on operator_venues(operator_id);
create index idx_operator_venues_venue on operator_venues(venue_id);

create trigger trg_operator_venues_updated_at
  before update on operator_venues
  for each row execute function set_updated_at();

-- ============================================================================
-- table: venue_configs
-- per-venue operational config. heavy jsonb. one row per venue.
-- ============================================================================

create table venue_configs (
  venue_id uuid primary key references venues(id) on delete cascade,

  -- voice and brand
  brand_persona jsonb not null default '{}',

  -- recognition mechanics
  relationship_strength_formula jsonb not null default '{}',
  state_thresholds jsonb not null default '{}',

  -- messaging behavior
  messaging_cadence jsonb not null default '{}',
  approval_policy jsonb not null default '{}',

  -- consolidated venue info (address, hours, menu, staff, amenities, etc.)
  venue_info jsonb not null default '{}',

  -- lifecycle
  onboarding_status text not null default 'pending'
    check (onboarding_status in (
      'pending',
      'in_progress',
      'voice_uploaded',
      'mechanics_configured',
      'live'
    )),

  -- versioning for jsonb shape evolution
  schema_version integer not null default 1,

  -- audit
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index idx_venue_configs_onboarding on venue_configs(onboarding_status);

create trigger trg_venue_configs_updated_at
  before update on venue_configs
  for each row execute function set_updated_at();

-- ============================================================================
-- table: guests
-- venue-scoped people. same phone = different rows per venue.
-- ============================================================================

create table guests (
  id uuid primary key default gen_random_uuid(),
  venue_id uuid not null references venues(id) on delete cascade,

  -- identity
  phone_number text not null
    check (phone_number ~ '^\+[1-9]\d{1,14}$'),
  first_name text,
  last_name text,
  email text,

  -- lifecycle
  status text not null default 'new'
    check (status in ('new', 'active', 'paused', 'opted_out')),
  created_via text not null
    check (created_via in ('nfc_tap', 'csv_import', 'manual', 'pos_match')),
  opted_out_at timestamptz,

  -- interaction timestamps
  first_contacted_at timestamptz,
  last_outbound_at timestamptz,
  last_inbound_at timestamptz,
  last_visit_at timestamptz,
  last_interaction_at timestamptz,

  -- audit
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  unique (venue_id, phone_number)
);

create index idx_guests_venue on guests(venue_id);
create index idx_guests_phone_venue on guests(venue_id, phone_number);
create index idx_guests_status on guests(venue_id, status);
create index idx_guests_last_visit on guests(venue_id, last_visit_at desc);
create index idx_guests_last_interaction on guests(venue_id, last_interaction_at desc);
-- supports cross-venue analytics via phone (internal-only per architecture decision)
create index idx_guests_phone on guests(phone_number);

create trigger trg_guests_updated_at
  before update on guests
  for each row execute function set_updated_at();

-- ============================================================================
-- table: mechanics
-- perks, referrals, content unlocks, event invites, merch.
-- operator describes the mechanic in their words; agent generates messages fresh.
-- no message templates - we don't do marketing automation.
-- ============================================================================

create table mechanics (
  id uuid primary key default gen_random_uuid(),
  venue_id uuid not null references venues(id) on delete cascade,

  type text not null
    check (type in ('perk', 'referral', 'content_unlock', 'event_invite', 'merch')),

  -- operator-described content (input to agent reasoning, not templates)
  name text not null,
  description text,
  qualification text,            -- what qualifies a guest (operator's words)
  reward_description text,       -- what the reward is (operator's words)
  expiration_rule text,          -- when/how it expires (operator's words)

  -- structured rules (system needs to act on these programmatically)
  trigger jsonb not null,        -- e.g. {type: 'state_reached', state: 'regular'}
  redemption jsonb,              -- e.g. {type: 'show_text_at_counter'}
  metadata jsonb not null default '{}',

  -- lifecycle
  is_active boolean not null default true,
  deactivated_at timestamptz,

  -- versioning for jsonb shape evolution
  schema_version integer not null default 1,

  -- audit
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index idx_mechanics_venue_active on mechanics(venue_id, is_active) where is_active = true;
create index idx_mechanics_venue_type on mechanics(venue_id, type);

create trigger trg_mechanics_updated_at
  before update on mechanics
  for each row execute function set_updated_at();

-- ============================================================================
-- table: transactions
-- visit data. mock-first, real pos source tbd.
-- guest_id nullable until matched.
-- ============================================================================

create table transactions (
  id uuid primary key default gen_random_uuid(),
  venue_id uuid not null references venues(id) on delete cascade,
  guest_id uuid references guests(id) on delete set null,

  -- transaction details
  amount_cents integer not null,
  item_count integer,
  occurred_at timestamptz not null,

  -- source + matching
  source text not null
    check (source in ('mock', 'csv_upload', 'square', 'toast', 'manual')),
  external_id text,
  raw_data jsonb,
  matched_at timestamptz,
  match_confidence numeric(4, 3)
    check (match_confidence is null or (match_confidence >= 0 and match_confidence <= 1)),
  match_method text
    check (match_method is null or match_method in ('phone', 'card_last_four', 'name', 'manual', 'unmatched')),

  -- audit
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  unique (venue_id, source, external_id)
);

create index idx_transactions_venue_guest on transactions(venue_id, guest_id);
create index idx_transactions_venue_occurred on transactions(venue_id, occurred_at desc);
create index idx_transactions_unmatched on transactions(venue_id) where guest_id is null;

create trigger trg_transactions_updated_at
  before update on transactions
  for each row execute function set_updated_at();

-- ============================================================================
-- table: messages
-- every message in or out. drafts, edits, sent, all of it.
-- ============================================================================

create table messages (
  id uuid primary key default gen_random_uuid(),
  venue_id uuid not null references venues(id) on delete cascade,
  guest_id uuid not null references guests(id) on delete cascade,

  -- direction + flow
  direction text not null check (direction in ('inbound', 'outbound')),
  status text not null default 'pending'
    check (status in (
      'received',
      'draft',
      'pending_review',
      'approved',
      'sending',
      'sent',
      'delivered',
      'failed',
      'rejected'
    )),
  category text
    check (category is null or category in (
      'welcome',
      'follow_up',
      'reply',
      'new_question',
      'opt_out',
      'media',
      'perk_unlock',
      'event_invite',
      'manual'
    )),

  -- content (must have body or media)
  body text not null default '',
  media_urls text[] not null default '{}',
  constraint messages_has_content
    check (body != '' or array_length(media_urls, 1) > 0),

  -- ai metadata (outbound drafts only)
  generated_by text
    check (generated_by is null or generated_by in ('llm', 'operator', 'system')),
  confidence_score numeric(4, 3)
    check (confidence_score is null or (confidence_score >= 0 and confidence_score <= 1)),
  prompt_version text,

  -- threading
  reply_to_message_id uuid references messages(id) on delete set null,
  parent_draft_id uuid references messages(id) on delete set null,

  -- review trail
  reviewed_by_operator_id uuid references operators(id) on delete set null,
  reviewed_at timestamptz,
  edits_made boolean not null default false,

  -- delivery
  provider_message_id text,
  sent_at timestamptz,
  delivered_at timestamptz,
  failure_reason text,

  -- audit
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index idx_messages_venue_guest on messages(venue_id, guest_id);
-- partial index: operator review queue
create index idx_messages_review_queue on messages(venue_id, status)
  where status in ('draft', 'pending_review');
create index idx_messages_provider_id on messages(provider_message_id);
create index idx_messages_created_at on messages(venue_id, created_at desc);
create index idx_messages_parent_draft on messages(parent_draft_id) where parent_draft_id is not null;
create index idx_messages_reply_to on messages(reply_to_message_id) where reply_to_message_id is not null;

create trigger trg_messages_updated_at
  before update on messages
  for each row execute function set_updated_at();

-- ============================================================================
-- table: engagement_events
-- audit trail of meaningful guest actions. powers analytics + state transitions.
-- append-only (no updated_at).
-- ============================================================================

create table engagement_events (
  id uuid primary key default gen_random_uuid(),
  venue_id uuid not null references venues(id) on delete cascade,
  guest_id uuid not null references guests(id) on delete cascade,

  event_type text not null
    check (event_type in (
      'first_visit',
      'return_visit',
      'state_transition',
      'milestone_reached',
      'perk_unlocked',
      'perk_redeemed',
      'referral_made',
      'merch_redeemed',
      'event_attended',
      'message_engagement',
      'community_join'
    )),

  -- event-specific payload
  data jsonb not null default '{}',

  -- causal links (nullable, depends on event type)
  triggered_by_transaction_id uuid references transactions(id) on delete set null,
  triggered_by_message_id uuid references messages(id) on delete set null,
  resulted_in_message_id uuid references messages(id) on delete set null,
  mechanic_id uuid references mechanics(id) on delete set null,

  -- versioning for data jsonb evolution
  schema_version integer not null default 1,

  -- audit (append-only, no updated_at)
  created_at timestamptz not null default now()
);

create index idx_engagement_events_venue_guest on engagement_events(venue_id, guest_id, created_at desc);
create index idx_engagement_events_type on engagement_events(venue_id, event_type);
create index idx_engagement_events_venue_created on engagement_events(venue_id, created_at desc);
create index idx_engagement_events_triggered_by_transaction on engagement_events(triggered_by_transaction_id)
  where triggered_by_transaction_id is not null;
create index idx_engagement_events_triggered_by_message on engagement_events(triggered_by_message_id)
  where triggered_by_message_id is not null;
create index idx_engagement_events_resulted_in_message on engagement_events(resulted_in_message_id)
  where resulted_in_message_id is not null;
create index idx_engagement_events_mechanic on engagement_events(mechanic_id) where mechanic_id is not null;

-- no updated_at trigger - append-only

-- ============================================================================
-- table: guest_states
-- discrete state per guest, with full history.
-- current state = row where exited_at is null.
-- ============================================================================

create table guest_states (
  id uuid primary key default gen_random_uuid(),
  guest_id uuid not null references guests(id) on delete cascade,
  venue_id uuid not null references venues(id) on delete cascade,

  state text not null
    check (state in ('new', 'returning', 'regular', 'raving_fan')),
  entered_at timestamptz not null default now(),
  exited_at timestamptz,
  triggered_by_event_id uuid references engagement_events(id) on delete set null,

  created_at timestamptz not null default now()
);

-- partial index: current state lookups (the hot path)
create index idx_guest_states_current on guest_states(guest_id, venue_id) where exited_at is null;
create index idx_guest_states_history on guest_states(guest_id, venue_id, entered_at);

-- no updated_at - append-only state history

-- ============================================================================
-- table: voice_corpus
-- raw text inputs for the rag system. preserved before chunking + embedding.
-- per-venue, never shared across venues (each venue's voice is theirs alone).
-- ============================================================================

create table voice_corpus (
  id uuid primary key default gen_random_uuid(),
  venue_id uuid not null references venues(id) on delete cascade,

  source_type text not null
    check (source_type in (
      'sample_text',
      'voicenote_transcript',
      'brand_doc',
      'email_archive',
      'text_archive',
      'chat_transcript',
      'social_post',
      'manual_entry',
      'training_response',
      'past_message'
    )),

  content text not null,
  metadata jsonb not null default '{}',

  -- new fields
  language text not null default 'en',
  confidence_score numeric(4, 3)
    check (confidence_score is null or (confidence_score >= 0 and confidence_score <= 1)),
  tags text[] not null default '{}',

  -- processing pipeline
  is_processed boolean not null default false,
  processed_at timestamptz,

  -- versioning for metadata jsonb evolution
  schema_version integer not null default 1,

  -- audit
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index idx_voice_corpus_venue on voice_corpus(venue_id);
create index idx_voice_corpus_unprocessed on voice_corpus(venue_id) where is_processed = false;
-- gin index for array tag filtering
create index idx_voice_corpus_tags on voice_corpus using gin (tags);

create trigger trg_voice_corpus_updated_at
  before update on voice_corpus
  for each row execute function set_updated_at();

-- ============================================================================
-- table: voice_embeddings
-- chunked vector embeddings for rag retrieval.
-- venue_id denormalized from corpus_id for fast filtering during retrieval.
-- ============================================================================

create table voice_embeddings (
  id uuid primary key default gen_random_uuid(),
  venue_id uuid not null references venues(id) on delete cascade,
  corpus_id uuid not null references voice_corpus(id) on delete cascade,

  chunk_text text not null,
  chunk_index integer not null,

  embedding vector(1024),
  embedding_model text not null,

  metadata jsonb not null default '{}',

  created_at timestamptz not null default now()
);

create index idx_voice_embeddings_venue on voice_embeddings(venue_id);
create index idx_voice_embeddings_corpus on voice_embeddings(corpus_id);
-- hnsw index for fast vector similarity search using cosine distance
create index idx_voice_embeddings_vector on voice_embeddings
  using hnsw (embedding vector_cosine_ops);

-- no updated_at - embeddings are immutable; reprocessing creates new rows

-- ============================================================================
-- table: audit_log
-- system-wide audit trail for sensitive actions. append-only.
-- different from engagement_events (which is guest-scoped).
-- ============================================================================

create table audit_log (
  id uuid primary key default gen_random_uuid(),

  -- who
  actor_type text not null
    check (actor_type in ('operator', 'system', 'service_role', 'analog_admin')),
  actor_id uuid,

  -- what
  action text not null,
  entity_type text not null,
  entity_id uuid,

  -- context
  venue_id uuid references venues(id) on delete set null,
  metadata jsonb not null default '{}',

  -- audit (append-only, no updated_at)
  created_at timestamptz not null default now()
);

create index idx_audit_log_actor on audit_log(actor_type, actor_id, created_at desc);
create index idx_audit_log_venue on audit_log(venue_id, created_at desc);
create index idx_audit_log_entity on audit_log(entity_type, entity_id, created_at desc);
create index idx_audit_log_action on audit_log(action, created_at desc);
create index idx_audit_log_venue_action on audit_log(venue_id, action, created_at desc);

-- no updated_at trigger - append-only

-- ============================================================================
-- end of migration
-- ============================================================================
