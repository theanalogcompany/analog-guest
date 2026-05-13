-- ============================================================================
-- migration 019: mechanics.requires_operator_approval
-- ============================================================================
-- Adds a per-mechanic flag indicating that committing a guest to this mechanic
-- requires operator approval before the agent's drafted reply is dispatched.
-- Consumed by TAC-212's approval-policy gate (lib/agent/stages.ts:
-- applyApprovalPolicyStage). When the mechanic serializer renders an eligible
-- mechanic with this flag set, the prompt instructs the model to also set
-- requiresOperatorApproval=true in its structured output if the draft commits
-- the guest to that mechanic. The gate then queues the draft instead of
-- auto-sending.
--
-- NOT NULL DEFAULT false so existing mechanics across all venues backfill to
-- the conservative "no operator approval required" behavior. Per-venue toggling
-- is by hand in Supabase Studio (template under CLAUDE.md Common gotchas).
-- The Phase 5 onboarding pipeline parses this from the venue spec when present
-- and passes it through during seed-supabase.
--
-- No index added — the agent loads all active mechanics per venue
-- (build-runtime-context.ts) and filters in app code. No filtered query that
-- would benefit from an index.
--
-- TAC-212.
-- ============================================================================

alter table mechanics
  add column requires_operator_approval boolean not null default false;

-- ============================================================================
-- end of migration
-- ============================================================================
