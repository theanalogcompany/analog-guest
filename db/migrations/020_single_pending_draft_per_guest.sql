-- ============================================================================
-- migration 020: one pending draft per (venue, guest) invariant
-- ============================================================================
-- Adds a partial unique index on messages enforcing "at most one pending draft
-- per guest within a venue" at the storage layer. The runtime path in
-- lib/agent/schedule-and-send.ts (persistOrRegenQueuedDraft) is the primary
-- enforcement — branching on existence and routing to UPDATE-in-place rather
-- than INSERT — and this index is the race-condition backstop: concurrent
-- inbounds for the same guest that both miss the existence check still get
-- caught here, with the losing INSERT receiving 23505 (unique_violation) and
-- falling through to the UPDATE branch.
--
-- Composite on (venue_id, guest_id) honors the cross-venue isolation invariant
-- (each venue is its own block per CLAUDE.md product principles) — a guest
-- could in principle have a pending draft at venue A and another at venue B.
--
-- Filtered on review_state='pending' so the index is sparse and doesn't
-- block any of the other review_state values (approved/edited/skipped/
-- auto_sent), each of which can legitimately appear many times per guest.
--
-- No backfill required — verified pre-migration that no (venue_id, guest_id)
-- pair has more than one pending row in production.
--
-- Coordinates with:
--   - migration 018 (TAC-258): introduced review_state column + the partial
--     index idx_messages_review_state_pending used by the operator queue RPC.
--     This migration is additive and doesn't change 018's index.
--   - migration 019 (TAC-212): per-mechanic operator-approval gate. Unrelated;
--     no coordination needed.
--
-- TAC-264.
-- ============================================================================

create unique index idx_messages_one_pending_per_guest
  on messages (venue_id, guest_id)
  where review_state = 'pending';

-- ============================================================================
-- end of migration
-- ============================================================================
