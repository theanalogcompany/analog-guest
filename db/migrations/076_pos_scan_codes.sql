-- 076_pos_scan_codes.sql
-- A printed/displayed QR code issued per Square payment, and the column that
-- lets a guest's Instagram scan bind that payment to them.
--
-- ============================================================================
-- WHY THIS IS NOT JUST THE NFC TAP FLOW
-- ============================================================================
--
-- Migration 030 built an NFC path: the eink device polls its feed, gets a
-- `tap_token` derived from OUR `transactions.id`, writes it into an NFC
-- payload, and `reconcileTapFromInbound` matches the SendBlue inbound that
-- carries the token back. That path is intact and untouched here.
--
-- The QR path differs in two ways that each need a column:
--
--   1. THE CODE IS ISSUED BEFORE OUR TRANSACTIONS ROW EXISTS. The code is
--      issued against the SQUARE PAYMENT, which we learn about from a live
--      `ListPayments` read (or, later, from the webhook). At issue time there
--      may be no `transactions` row at all, so `reconciled_transaction_id` --
--      which FKs `transactions(id)` -- cannot be filled. Hence
--      `provider_payment_id`.
--
--   2. IT COMES BACK ON INSTAGRAM, NOT SMS. The guest scans an ig.me link
--      carrying the code in `?ref=`, which Meta delivers as `referral.ref` and
--      `handle-events.ts` already persists to `messages.referral_ref`. The two
--      reconcilers now coexist on one table, so a row has to say which one
--      owns it. Hence `channel`.
--
-- Reusing `pos_tap_events` rather than adding a parallel table: the lifecycle
-- is identical (a token issued at the counter, pending until a guest's inbound
-- carries it back, then matched to a transaction, or expired by the cron). A
-- second table would mean a second reconciler and a second expiry job. The
-- table's NAME is now narrower than its contents; renaming it would be a
-- backwards-incompatible migration for no behavioural gain, so it stays.
--
-- ============================================================================
-- ONE CODE PER PAYMENT IS A STORAGE GUARANTEE, NOT A CONVENTION
-- ============================================================================
--
-- Ruled 2026-10-07: one code per payment. The partial unique index below is
-- what makes that true rather than hoped for. The issuer is a check-then-act
-- (look for an existing code, else insert), and at a counter two devices or
-- two polls can run it concurrently; the index is the backstop that turns the
-- loser into a 23505 the issuer handles as an outcome, per
-- .claude/rules/errors-as-values.md. `where provider_payment_id is not null`
-- so the pre-existing NFC rows, which have none, are simply not in it --
-- NULLs are distinct in a unique index anyway, so a bare column would give
-- those rows no uniqueness at all (the trap migrations 041 and 054 both turn
-- on).
--
-- ============================================================================
-- WIDENING match_method
-- ============================================================================
--
-- `scan_code` is added so a QR bind is distinguishable from an NFC tap bind by
-- reading `transactions` ALONE. It could have reused `tap_token` and been told
-- apart by joining to `pos_tap_events.channel`, but scan-to-purchase
-- attribution is one of the two things this work exists to measure, and
-- collapsing two causes into one value is how a distinction becomes
-- unanswerable in SQL.
--
-- Drop-and-recreate is the only way to widen a CHECK. The constraint name is
-- the one migration 030 created, and 034 and 047 both record that the naming
-- convention holds. VERIFY IT AGAINST pg_constraint BEFORE APPLYING:
--
--   select conname, pg_get_constraintdef(oid)
--   from pg_constraint
--   where conrelid = 'transactions'::regclass and contype = 'c';
--
-- Widening, never tightening, so this is NOT backwards-incompatible: old code
-- writing the old values stays legal.
--
-- ============================================================================
-- venues.instagram_username
-- ============================================================================
--
-- The ig.me link is `https://ig.me/m/<username>?ref=<code>`, and nothing in
-- this schema holds a venue's Instagram USERNAME. `instagram_account_id` is
-- the numeric `user_id` the webhook routes on (see
-- lib/messaging/instagram/CLAUDE.md) and cannot be substituted into a link.
-- Named to match the existing `guests.instagram_username` rather than
-- inventing a second spelling for the same kind of value.
--
-- Nullable with no default and no backfill: a venue without one simply has no
-- scan link, which `buildScanLink` returns as a typed error rather than
-- guessing a handle.
--
-- ============================================================================
-- ORDERING
-- ============================================================================
--
-- Additive throughout, but the deployed code SELECTs and INSERTs every column
-- below on the next scan. Apply in Studio BEFORE merging, then run
-- `npm run db:types` -- the call 026 / 029 / 035 / 055 / 057 / 059 / 064 all
-- made. `db/types.ts` is hand-patched in the same commit so the code
-- typechecks before that run happens; the next `db:types` overwrites the patch
-- with canonical output.
--
-- Not on the high-stakes list (messages / engagement_events / voice_corpus).
-- `transactions` is payment data, so the CHECK widening is the one statement
-- here worth a second pair of eyes.

begin;

set local lock_timeout = '5s';

-- ----------------------------------------------------------------------------
-- 076.1 - the Square payment a code was issued against
-- ----------------------------------------------------------------------------

alter table pos_tap_events add column provider_payment_id text;

comment on column pos_tap_events.provider_payment_id is
  'Square payment id the code was issued for. Known before our transactions row exists, which is why reconciled_transaction_id cannot carry it.';

-- ONE CODE PER PAYMENT. See the header.
create unique index idx_pos_tap_events_payment
  on pos_tap_events(venue_id, provider_payment_id)
  where provider_payment_id is not null;

-- ----------------------------------------------------------------------------
-- 076.2 - which reconciler owns the row
-- ----------------------------------------------------------------------------

-- No default: existing NFC rows keep NULL, which reads honestly as "issued
-- before this column existed" rather than asserting a channel nobody recorded.
-- Postgres does not validate a default against a column's own CHECK (migration
-- 046's trap), so omitting the default also removes that question.
alter table pos_tap_events add column channel text
  check (channel is null or channel in ('imessage', 'instagram'));

comment on column pos_tap_events.channel is
  'imessage = the migration 030 NFC tap_token path; instagram = the QR code returned via an ig.me referral. NULL on rows predating this column.';

-- ----------------------------------------------------------------------------
-- 076.3 - widen transactions.match_method for a QR bind
-- ----------------------------------------------------------------------------

alter table transactions drop constraint transactions_match_method_check;
alter table transactions add constraint transactions_match_method_check
  check (
    match_method is null or match_method in (
      'phone', 'card_last_four', 'name', 'manual', 'unmatched',
      'card_fingerprint', 'tap_token', 'tap_time_window',
      'scan_code'
    )
  );

-- ----------------------------------------------------------------------------
-- 076.4 - the venue's Instagram username, for its ig.me link
-- ----------------------------------------------------------------------------

alter table venues add column instagram_username text;

comment on column venues.instagram_username is
  'The venue''s Instagram handle, for building https://ig.me/m/<username>?ref=<code>. Distinct from instagram_account_id, which is the numeric user_id the webhook routes on and is not substitutable into a link.';

commit;

-- ============================================================================
-- ROLLBACK
-- ============================================================================
--
-- Narrowing the CHECK back ABORTS once any row carries 'scan_code', and that
-- is the correct outcome: those rows are real bindings. Roll the code back and
-- leave the CHECK wide; a value nothing writes costs nothing.
--
--   begin;
--   drop index if exists idx_pos_tap_events_payment;
--   alter table pos_tap_events drop column if exists channel;
--   alter table pos_tap_events drop column if exists provider_payment_id;
--   alter table venues drop column if exists instagram_username;
--   commit;
