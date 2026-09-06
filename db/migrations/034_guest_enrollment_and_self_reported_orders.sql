-- 034_guest_enrollment_and_self_reported_orders.sql
-- TAC-323: guest enrollment via static QR + self-reported orders.
--
-- Two changes to `transactions`:
--   1. `source` check gains 'guest_reported' — a guest's own account of what
--      they ordered, with no POS transaction behind it. Provenance is the
--      guest, not Square.
--   2. `amount_cents` becomes nullable. Guest-reported orders are normally
--      priced off the venue menu, but a resolved item with no price in
--      venue_info leaves the WHOLE order's amount null rather than a partial
--      sum — a partial sum looks complete and isn't. Every amount_cents
--      consumer (lib/recognition/load-signals.ts, the admin conversations
--      page, transaction-row.tsx) was audited for this null path in the same
--      PR; see CLAUDE.md's "amount_cents null audit" gotcha.
--
-- One change to `guests`: `created_via` gains 'qr_scan' for a guest whose
-- first-ever contact was scanning the venue's static QR sign (prefilled
-- message matched exactly against venue_info.qrEnrollmentMessage — a JSONB
-- field addition on the existing venue_info column, no schema change needed
-- there). Same drop-and-recreate pattern as migration 006, which added
-- 'inbound_message' for the same webhook branch.
--
-- One new index: a partial unique index closing a TOCTOU race between two
-- near-simultaneous inbounds from the same guest, each independently naming
-- a menu item before either write lands. Same rationale and shape as
-- migration 020's `idx_messages_one_pending_per_guest` (TAC-264).
--
-- Constraint names verified against this migration's own history:
-- `transactions_source_check` and `guests_created_via_check` were both
-- defined inline in migration 001 and have only ever been dropped and
-- recreated under those SAME auto-generated names (migration 006 for
-- guests_created_via_check; migration 030 for the sibling
-- transactions_match_method_check, confirming the naming convention holds on
-- this exact table). No Studio-only constraint edits are on record for
-- either. Per the ticket's own instruction, re-verify against live
-- `pg_constraint` immediately before applying in Studio — the DROP below
-- fails loudly, not silently, if the name has drifted.
--
-- HIGH-STAKES (touches `transactions` and `guests`). ORDERING, revised from
-- the plan's original "apply after merge" call — see PR description for the
-- explicit ask to confirm this before applying:
--
-- This migration is purely additive per CLAUDE.md "Database migrations"
-- §Ordering (new enum values, a relaxed NOT NULL, a new index) — "order
-- doesn't matter" is the stated rule for this exact shape, and old code
-- never writes the new enum values or a null amount_cents, so applying
-- early changes nothing for it. The ticket's own instruction to deploy code
-- first only reasoned about the qr_scan half ("The QR is not printed yet,
-- so no guest can enroll in the gap") — true, but the self-reported-order
-- half has NO equivalent gate: any existing guest within 7 days of
-- guests.created_at who mentions a menu item in an ordinary text trips
-- lib/agent/extract-reported-order.ts regardless of whether a QR sign
-- exists anywhere. Applying this migration AFTER merge would open a real
-- (if narrow, pilot-scale) window where that guest's self-report hits the
-- pre-migration CHECK/NOT NULL constraints, fails the INSERT, and is
-- logged-and-permanently-lost with no retry — extractReportedOrder never
-- throws, so nothing crashes, but the data is gone. Recommend applying in
-- Studio BEFORE merging this PR to close that window entirely, at no cost
-- to the qr_scan path (which still can't fire until the sign is printed
-- regardless of migration timing).
--
-- db/types.ts hand-patched in the same commit (transactions.amount_cents ->
-- number | null) until `npm run db:types` runs post-apply.

-- ============================================================================
-- 1. transactions.source: add 'guest_reported'
-- ============================================================================

alter table transactions drop constraint transactions_source_check;

alter table transactions add constraint transactions_source_check
  check (source in ('mock', 'csv_upload', 'square', 'toast', 'manual', 'guest_reported'));

-- ============================================================================
-- 2. transactions.amount_cents: allow null
-- ============================================================================
-- Reserved for one situation: a resolved item that has no price in
-- venue_info. See lib/agent/extract-reported-order.ts.

alter table transactions alter column amount_cents drop not null;

-- ============================================================================
-- 3. guests.created_via: add 'qr_scan'
-- ============================================================================

alter table guests drop constraint guests_created_via_check;

alter table guests add constraint guests_created_via_check
  check (created_via in (
    'nfc_tap',
    'csv_import',
    'manual',
    'pos_match',
    'inbound_message',
    'qr_scan'
  ));

-- ============================================================================
-- 4. one guest-reported transaction per guest, storage-layer backstop
-- ============================================================================
-- Mirrors migration 020's idx_messages_one_pending_per_guest: closes the
-- TOCTOU race where two near-simultaneous inbounds from the same guest each
-- pass the "zero existing guest_reported rows" application-layer check
-- before either INSERT lands. The losing INSERT receives 23505; the
-- extractor treats that the same as the ordinary already_reported outcome
-- (log, no throw, no red alert) — see lib/agent/extract-reported-order.ts.

create unique index idx_transactions_one_guest_reported_per_guest
  on transactions (venue_id, guest_id)
  where source = 'guest_reported';

-- ============================================================================
-- end of migration
-- ============================================================================
