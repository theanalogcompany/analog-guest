-- 002_add_message_reactions.sql
-- adds support for storing iMessage tapback reactions in the messages table.
-- a reaction message has category='reaction', a reaction_type, and points to
-- the inbound message being reacted to via reply_to_message_id.

-- ============================================================================
-- 1. add reaction_type column with allowed values
-- ============================================================================

alter table messages
  add column reaction_type text
  check (reaction_type is null or reaction_type in (
    'love',
    'like',
    'dislike',
    'laugh',
    'emphasize',
    'question'
  ));

-- ============================================================================
-- 2. extend the category check to include 'reaction'
-- ============================================================================

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
    'reaction'
  ));

-- ============================================================================
-- 3. update the content constraint
-- a reaction message has no body or media; the reaction_type is its content
-- ============================================================================

alter table messages drop constraint messages_has_content;

alter table messages add constraint messages_has_content check (
  body != ''
  or array_length(media_urls, 1) > 0
  or reaction_type is not null
);

-- ============================================================================
-- 4. add a constraint linking reaction_type and category
-- if reaction_type is set, category must be 'reaction' (and vice versa)
-- ============================================================================

alter table messages add constraint messages_reaction_consistency check (
  (reaction_type is null and category is distinct from 'reaction')
  or (reaction_type is not null and category = 'reaction')
);

-- ============================================================================
-- end of migration
-- ============================================================================
