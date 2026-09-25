-- 063_messages_guest_arrived_category.sql
-- TAC-536: the category a scan greeting is written under.
--
-- WHY A NEW CATEGORY. A guest who follows the venue's ig.me link into an
-- existing thread sends no message, and after five minutes of silence the
-- agent greets them (ruled 2026-09-25). That outbound is not a follow-up: the
-- follow_up instructions are written for a message days after a visit and tell
-- the model to check in rather than greet someone standing at the counter.
-- `welcome` is the other near miss and is worse -- its own text is "the first
-- message the venue is sending to a NEW guest", which is false for the case
-- this exists for, someone who has been messaging the shop for weeks and has
-- now walked in.
--
-- MESSAGE_CATEGORIES in lib/ai/types.ts gains the same value in the same PR.
-- That constant drives the type and the Command Center approval-policy UI; it
-- does NOT widen this CHECK, and the two are separate gates. Without this
-- migration the very first guest_arrived insert fails the constraint, behind a
-- webhook that answers 200, so the greeting would vanish with no error anyone
-- sees.
--
-- Drop-and-recreate is the only way to widen a CHECK: Postgres has no ALTER
-- CONSTRAINT for the expression. Same pattern migrations 002 / 003 / 011 /
-- 012 / 016 use on this exact constraint.
--
-- THE VALUE LIST BELOW IS MIGRATION 016'S, RESTATED, PLUS ONE. 016 is the
-- migration that owns this constraint today. VERIFY THE LIVE DEFINITION
-- BEFORE APPLYING -- CLAUDE.md's standing caution, because a list assumed
-- rather than read is how a widening silently DROPS a value some other
-- migration added:
--
--   select conname, pg_get_constraintdef(oid)
--   from pg_constraint
--   where conrelid = 'messages'::regclass and contype = 'c';
--
-- ORDERING: additive, but the deployed code writes the new category the first
-- time a guest scans, and a rejected insert loses that greeting. Apply in
-- Studio BEFORE merging.
--
-- HIGH-STAKES: this is a migration against `messages`. Confirmed for this
-- session by the ruling of 2026-09-25.

begin;

set local lock_timeout = '5s';

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
    'perk_inquiry',
    'event_invite',
    'event_question',
    'manual',
    'reaction',
    'acknowledgment',
    'comp_complaint',
    'mechanic_request',
    'recommendation_request',
    'casual_chatter',
    'personal_history_question',
    'unknown',
    -- TAC-536: the greeting sent after a guest scans the counter code and
    -- says nothing for five minutes. Outbound only, set by triggerToCategory,
    -- never by the classifier.
    'guest_arrived'
  ));

commit;

-- rollback:
--   begin;
--   alter table messages drop constraint messages_category_check;
--   alter table messages add constraint messages_category_check
--     check (category is null or category in (
--       'welcome', 'follow_up', 'reply', 'new_question', 'opt_out', 'media',
--       'perk_unlock', 'perk_inquiry', 'event_invite', 'event_question',
--       'manual', 'reaction', 'acknowledgment', 'comp_complaint',
--       'mechanic_request', 'recommendation_request', 'casual_chatter',
--       'personal_history_question', 'unknown'
--     ));
--   commit;
--
-- NARROWING IS NOT SAFE ONCE A ROW CARRIES THE NEW VALUE. Postgres validates
-- an added CHECK against existing rows, so the rollback ABORTS if any message
-- is already `guest_arrived`. That is correct behaviour rather than a problem
-- -- it refuses instead of lying about the data -- but it means the rollback
-- has to run before, or together with, deciding what those rows become:
--
--   select id, venue_id, guest_id, created_at, status, review_state
--   from messages where category = 'guest_arrived';
--
-- Those are real messages, sent or queued. Prefer rolling the CODE back and
-- leaving the CHECK wide: a value the application no longer writes costs
-- nothing, and rewriting a sent message's category loses what it was.
