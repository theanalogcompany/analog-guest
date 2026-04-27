-- 006_idempotency_and_inbound_message_origin.sql
-- two additions to support the agent orchestration layer (THE-122):
--   1. unique constraint on messages.provider_message_id — backstop against
--      duplicate processing if a webhook fires twice or a send is retried.
--      orchestrator's first-line defense is a top-of-handler check that asks
--      "have i already replied to this inbound?"; this constraint is the
--      last-line defense at the database level if a race condition slips
--      past the application check.
--   2. extend guests.created_via to include 'inbound_message' — for guests
--      auto-created when an unrecognized phone number sends an inbound
--      message to a venue's sendblue number (no prior nfc tap, no prior
--      pos match, no manual creation).
--
-- not in this migration:
--   - inbound→outbound message linking: messages.reply_to_message_id already
--     exists from migration 001, no schema change needed.
--   - venue_configs.venue_info.currentContext: jsonb is already flexible,
--     this is a zod schema update on the app side, not a sql migration.
--   - visit dedupe timezone fix: code change in lib/recognition/load-signals.ts,
--     not a schema change.

-- ============================================================================
-- 1. unique constraint on messages.provider_message_id
-- ============================================================================
-- nullable column; postgres unique allows multiple nulls so this is safe
-- for drafts and pending messages that haven't been sent/received yet.
--
-- safety check before applying: verify there are no existing duplicate
-- non-null values. run this manually first; if it returns any rows,
-- investigate and dedupe before applying the constraint:
--
--   select provider_message_id, count(*) from messages
--   where provider_message_id is not null
--   group by provider_message_id
--   having count(*) > 1;

alter table messages
  add constraint messages_provider_message_id_unique
  unique (provider_message_id);

-- the unique constraint auto-creates a unique index, so the old regular
-- index on the same column is redundant. drop it.
drop index if exists idx_messages_provider_id;

-- ============================================================================
-- 2. extend guests.created_via to include 'inbound_message'
-- ============================================================================
-- the existing constraint name is auto-generated as guests_created_via_check
-- by postgres. drop and recreate with the extended set of allowed values.

alter table guests drop constraint guests_created_via_check;

alter table guests add constraint guests_created_via_check
  check (created_via in (
    'nfc_tap',
    'csv_import',
    'manual',
    'pos_match',
    'inbound_message'
  ));

-- ============================================================================
-- end of migration
-- ============================================================================
