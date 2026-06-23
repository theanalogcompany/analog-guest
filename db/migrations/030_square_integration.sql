-- 030_square_integration.sql
-- square pos integration: identity (card fingerprint), per-venue credentials,
-- menu/inventory cache, webhook idempotency, and nfc tap reconciliation.
--
-- builds on the existing `transactions` table (migration 001), which was
-- designed mock-first with `guest_id` nullable-until-matched and a `source`
-- check already containing 'square'/'toast'. this migration adds the columns
-- + tables that real square ingestion needs; it does NOT redesign the
-- transactions model.
--
-- additive only → backwards-compatible per CLAUDE.md §"Database migrations".
-- but the deployed code SELECTs the new columns/tables, so apply in Studio
-- BEFORE merging the PR, then run `npm run db:types`.
--
-- not on the high-stakes table list (messages / engagement_events /
-- voice_corpus) — standard-care migration. the companion square WEBHOOK
-- HANDLER is the payment-adjacent high-stakes surface; flagged in its own PR.
--
-- identity scope decision (square integration plan §A): the fingerprint→guest
-- map below is keyed PER-VENUE, matching the existing guests isolation
-- (`guests UNIQUE(venue_id, phone_number)`) and the product principle "every
-- venue is its own isolated block". if the cross-venue identity graph from the
-- discovery call is chosen instead, drop `venue_id` from
-- `guest_card_fingerprints` and re-point `guest_id` resolution — a contained
-- change isolated to this table + lib/pos/reconcile.ts.

-- ============================================================================
-- 030.1 — identity primitive on transactions
-- square exposes a stable, non-PCI card fingerprint
-- (payment.card_details.card.fingerprint) that is the same for a given card
-- across every square merchant. store it; never store PAN/CVV.
-- ============================================================================

alter table transactions add column card_fingerprint text;

create index idx_transactions_fingerprint
  on transactions(venue_id, card_fingerprint)
  where card_fingerprint is not null;

-- widen match_method to recognize the two new automated resolution paths:
--   'card_fingerprint' — returning guest auto-matched via the fingerprint map
--   'tap_time_window'  — first-time opt-in matched via an nfc tap event
-- preserves the existing values from migration 001.
alter table transactions drop constraint transactions_match_method_check;
alter table transactions add constraint transactions_match_method_check
  check (
    match_method is null or match_method in (
      'phone', 'card_last_four', 'name', 'manual', 'unmatched',
      'card_fingerprint', 'tap_token', 'tap_time_window'
    )
  );

-- ============================================================================
-- 030.2 — fingerprint → guest map (returning-guest auto-resolution)
-- per-venue (see header decision). first tap writes the mapping; every
-- subsequent transaction with the same fingerprint resolves the guest with
-- no tap required.
-- ============================================================================

create table guest_card_fingerprints (
  id uuid primary key default gen_random_uuid(),
  venue_id uuid not null references venues(id) on delete cascade,
  guest_id uuid not null references guests(id) on delete cascade,
  card_fingerprint text not null,

  first_seen_at timestamptz not null default now(),
  created_at timestamptz not null default now(),

  unique (venue_id, card_fingerprint)
);

create index idx_gcf_lookup
  on guest_card_fingerprints(venue_id, card_fingerprint);
create index idx_gcf_guest
  on guest_card_fingerprints(guest_id);

-- ============================================================================
-- 030.3 — pos credentials (oauth-ready, per venue per provider)
-- mvp can seed a single square access token row per venue; the oauth refresh
-- columns are present from day one so multi-merchant oauth slots in without a
-- migration. tokens stored app-layer encrypted (lib/pos/crypto.ts) — never
-- plaintext.
-- ============================================================================

create table pos_credentials (
  id uuid primary key default gen_random_uuid(),
  venue_id uuid not null references venues(id) on delete cascade,
  provider text not null
    check (provider in ('square', 'toast', 'clover')),

  merchant_external_id text,            -- square merchant id
  location_external_id text,            -- square location id (one per venue for mvp)

  access_token_enc text,                -- app-layer encrypted
  refresh_token_enc text,
  token_expires_at timestamptz,
  scopes text[],

  is_active boolean not null default true,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  unique (venue_id, provider)
);

create index idx_pos_credentials_active
  on pos_credentials(venue_id, provider) where is_active = true;

create trigger trg_pos_credentials_updated_at
  before update on pos_credentials
  for each row execute function set_updated_at();

-- ============================================================================
-- 030.4 — menu cache
-- mirror of the venue's square catalog (items + variations), refreshed on
-- backfill and on catalog.version.updated webhooks. `is_available` and the
-- inventory table together answer "do you have croissants left?".
-- ============================================================================

create table pos_catalog_items (
  id uuid primary key default gen_random_uuid(),
  venue_id uuid not null references venues(id) on delete cascade,
  provider text not null,

  external_id text not null,            -- square catalog object id (variation)
  parent_external_id text,              -- item id for a variation
  name text not null,
  category text,
  price_cents integer,
  is_available boolean not null default true,
  version bigint,                       -- square catalog version (staleness guard)
  raw_data jsonb,

  updated_at timestamptz not null default now(),

  unique (venue_id, provider, external_id)
);

create index idx_pos_catalog_venue
  on pos_catalog_items(venue_id, is_available);

create trigger trg_pos_catalog_items_updated_at
  before update on pos_catalog_items
  for each row execute function set_updated_at();

-- ============================================================================
-- 030.5 — inventory cache (best-effort availability)
-- counts are per variation per location. only as good as the venue's habits;
-- the agent treats this as best-effort and hedges.
-- ============================================================================

create table pos_inventory_counts (
  id uuid primary key default gen_random_uuid(),
  venue_id uuid not null references venues(id) on delete cascade,
  provider text not null,

  catalog_external_id text not null,    -- variation id
  location_external_id text not null,
  quantity numeric,
  state text,                           -- IN_STOCK / SOLD / etc.

  updated_at timestamptz not null default now(),

  unique (venue_id, provider, catalog_external_id, location_external_id)
);

create index idx_pos_inventory_venue
  on pos_inventory_counts(venue_id, catalog_external_id);

create trigger trg_pos_inventory_counts_updated_at
  before update on pos_inventory_counts
  for each row execute function set_updated_at();

-- ============================================================================
-- 030.6 — webhook idempotency / audit
-- dedup square webhook deliveries (which can repeat and arrive out of order)
-- on the provider's event_id. transaction-level idempotency is additionally
-- guaranteed by transactions UNIQUE(venue_id, source, external_id); this table
-- covers non-transaction events (catalog/inventory) too.
-- ============================================================================

create table pos_webhook_events (
  id uuid primary key default gen_random_uuid(),
  provider text not null,
  event_id text not null,               -- square event id
  event_type text not null,
  signature_verified boolean not null default false,
  payload jsonb,

  received_at timestamptz not null default now(),
  processed_at timestamptz,

  unique (provider, event_id)
);

create index idx_pos_webhook_events_received
  on pos_webhook_events(received_at desc);

-- ============================================================================
-- 030.7 — nfc tap opt-in events (reconciliation stream A) — P1
-- a tap opens iMessage with a server-issued tap_token; the sendblue inbound
-- carries the token + guest phone back. the reconciler matches a pending tap
-- to a square transaction by location + nearest timestamp within a window,
-- then writes the fingerprint→guest mapping so future visits need no tap.
-- ============================================================================

create table pos_tap_events (
  id uuid primary key default gen_random_uuid(),
  tap_token text not null unique,
  venue_id uuid not null references venues(id) on delete cascade,
  device_id text,
  location_external_id text,

  tapped_at timestamptz,                -- device client time (ranking signal, not key)
  received_at timestamptz not null default now(),
  phone_number text,                    -- from sendblue inbound

  reconciled_transaction_id uuid references transactions(id) on delete set null,
  status text not null default 'pending'
    check (status in ('pending', 'matched', 'expired')),

  created_at timestamptz not null default now()
);

create index idx_tap_events_pending
  on pos_tap_events(venue_id, location_external_id, received_at)
  where status = 'pending';

-- ============================================================================
-- 030.8 — eink devices (reconciliation stream A, device side) — P1
-- the wifi-connected eink/Arduino display polls its event feed and writes the
-- issued tap_token into the NFC payload. authenticated by a bearer token; we
-- store only its sha256 hash. device_id maps the physical device to a venue +
-- POS location.
-- ============================================================================

create table pos_devices (
  id uuid primary key default gen_random_uuid(),
  venue_id uuid not null references venues(id) on delete cascade,
  device_id text not null unique,
  location_external_id text,
  device_token_hash text not null,       -- sha256 hex of the bearer token
  last_seen_at timestamptz,
  created_at timestamptz not null default now()
);

create index idx_pos_devices_device on pos_devices(device_id);
