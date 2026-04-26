-- 003_ai_module_refinements.sql
-- batches schema changes accumulated during AI module design:
--   1. rename messages.confidence_score → messages.voice_fidelity (terminology
--      consistency with the AI module — distinct from operator review decision)
--   2. add messages.review_reason column for recording why a message was flagged
--   3. extend messages.category check to include 'acknowledgment' for fallback messages
--   4. add messages.pending_until for the future hold-and-fallback workflow

-- ============================================================================
-- 1. rename confidence_score → voice_fidelity
-- ============================================================================

-- the column rename automatically updates any constraint that references it,
-- but the constraint NAME stays as whatever postgres auto-generated (likely
-- "messages_confidence_score_check"). we drop and recreate it with a clearer
-- name to keep things tidy.

alter table messages rename column confidence_score to voice_fidelity;

-- find and drop the auto-named check constraint, then add it back with the
-- new column name. doing this in a do-block so we look up the actual constraint
-- name at runtime (postgres auto-names are predictable but not guaranteed).
do $$
declare
  constraint_name text;
begin
  select conname into constraint_name
  from pg_constraint
  where conrelid = 'messages'::regclass
    and contype = 'c'
    and pg_get_constraintdef(oid) like '%voice_fidelity%';

  if constraint_name is not null then
    execute format('alter table messages drop constraint %I', constraint_name);
  end if;
end $$;

alter table messages add constraint messages_voice_fidelity_check
  check (voice_fidelity is null or (voice_fidelity >= 0 and voice_fidelity <= 1));

-- ============================================================================
-- 2. add review_reason column
-- ============================================================================
-- nullable text. populated by the orchestration layer when a message is
-- flagged for operator review. examples: 'low_voice_fidelity',
-- 'category_always_review', 'first_message_to_new_guest'.
-- not constrained to an enum yet — values are evolving and we want to learn
-- from real flags before locking shape.

alter table messages add column review_reason text;

-- ============================================================================
-- 3. extend category check to include 'acknowledgment'
-- ============================================================================
-- 'acknowledgment' is the fallback category for "let me find out and get
-- back to you" messages. AI module already supports the category; this
-- extends the DB constraint so we can persist these messages.

alter table messages drop constraint messages_category_check;

alter table messages add constraint messages_category_check
  check (category is null or category in (
    'welcome',
    'follow_up',
    'reply',
    'new_question',
    'opt_out',
    'media',
    'perk_unlock',
    'event_invite',
    'manual',
    'reaction',
    'acknowledgment'
  ));

-- ============================================================================
-- 4. add pending_until column
-- ============================================================================
-- timestamptz. set when a message enters status='pending_review' to mark
-- when the timeout fires. cron jobs scan for messages where pending_until
-- has passed and take action (THE-114 — hold-and-fallback workflow).
-- nullable: most messages never have a pending state.

alter table messages add column pending_until timestamptz;

-- ============================================================================
-- end of migration
-- ============================================================================
