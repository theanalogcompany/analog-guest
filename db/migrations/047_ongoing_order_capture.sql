-- 047_ongoing_order_capture.sql
-- TAC-325: ongoing order capture after enrollment.
--
-- TAC-323 built ONE self-reported order per guest, ever — the enrollment
-- order. Once a `guest_reported` row exists (or 7 days pass), the extractor
-- permanently stopped writing anything for that guest. A regular who tells
-- Sana what they ordered every week accumulated nothing beyond their first
-- visit. This migration adds the one piece of storage TAC-325 needs to
-- capture the ongoing case: a second `source` value.
--
-- `transactions.source` gains 'guest_reported_ongoing' — a guest's own
-- account of a LATER order, once enrollment either already happened or its
-- 7-day window has closed. Same shape as 'guest_reported' (self-reported,
-- menu-estimated, no POS record behind it); a DIFFERENT source value so
-- enrollment's own storage-layer invariant is untouched: enrollment's gate
-- (lib/agent/extract-reported-order.ts) and its partial unique index
-- (idx_transactions_one_guest_reported_per_guest, migration 034) both key
-- specifically on `source = 'guest_reported'`, so a guest can still only
-- ever enroll once — ongoing capture rows are a disjoint population that
-- index never sees.
--
-- No new index. TAC-325's same-local-day merge/dedupe (one ongoing row per
-- guest per venue-local calendar day, later items in the same day joining
-- the most recent row) is app-level, not a DB constraint: "same venue-local
-- calendar day" isn't expressible as a Postgres index predicate without the
-- venue's timezone, which isn't a column on `transactions`. A rare
-- concurrent-message race could in principle produce two same-day ongoing
-- rows instead of one merged row; the accepted cost is that item/spend
-- attribution splits across two rows, never a lost visit or a duplicated
-- visit count (visits collapse by venue-local calendar day regardless of
-- how many transaction rows exist on it).
--
-- Constraint name verified against this migration's own history:
-- `transactions_source_check` was defined inline in migration 001 and has
-- only ever been dropped and recreated under that SAME auto-generated name
-- (migration 034, for the 'guest_reported' addition; migration 030's
-- sibling `transactions_match_method_check` confirms the naming convention
-- holds on this exact table). No Studio-only constraint edits are on
-- record. Per the standing caution on this table (migration 034's own
-- header), RE-VERIFY against live `pg_constraint` immediately before
-- applying in Studio — the DROP below fails loudly, not silently, if the
-- name has drifted.
--
-- HIGH-STAKES (touches `transactions`). ORDERING: additive per CLAUDE.md
-- "Database migrations" §Ordering (a new enum value, no other schema
-- change) — "order doesn't matter" is the stated rule for this shape.
-- APPLY IN STUDIO BEFORE MERGING THIS PR ANYWAY, mirroring migration 034's
-- own deviation from that default rule and for the identical reason: an
-- existing guest within 7 days of guests.created_at (or any guest at all,
-- once ongoing capture's fallthrough ships) who mentions a menu item in an
-- ordinary text trips lib/agent/extract-reported-order.ts's new
-- 'guest_reported_ongoing' write path regardless of migration timing.
-- extractReportedOrder never throws — a rejected INSERT against the
-- pre-migration CHECK constraint is caught, logged, and returns
-- `{kind:'failed'}` — but the guest's report is silently and permanently
-- lost, with no retry. Applying BEFORE merge closes that window entirely.
--
-- No db/types.ts patch needed: `transactions.source` is typed as a plain
-- `string` in the generated types (CHECK constraint values don't surface in
-- Supabase's generated types), so this migration changes nothing there.

alter table transactions drop constraint transactions_source_check;

alter table transactions add constraint transactions_source_check
  check (source in (
    'mock',
    'csv_upload',
    'square',
    'toast',
    'manual',
    'guest_reported',
    'guest_reported_ongoing'
  ));

-- ============================================================================
-- end of migration
-- ============================================================================
