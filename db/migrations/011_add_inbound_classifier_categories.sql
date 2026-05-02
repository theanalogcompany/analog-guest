-- 011_add_inbound_classifier_categories.sql
-- THE-228: extends messages.category to include four new categories returned
-- by the inbound classifier:
--   - comp_complaint:         guest reports a quality issue / bad experience
--   - mechanic_request:       guest invokes or asks about a venue mechanic
--   - recommendation_request: guest asks the venue for a recommendation
--   - casual_chatter:         guest makes unprompted small talk
--
-- Existing values are preserved. 'media' and 'reaction' are DB-only
-- categories with no classifier counterpart; left in place. The classifier
-- prompt + Zod schema in lib/ai/classify-message.ts gain these four values
-- in the same PR; this migration only widens the persistence-side gate so
-- the orchestrator can write rows with the new category strings.

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
    'acknowledgment',
    'comp_complaint',
    'mechanic_request',
    'recommendation_request',
    'casual_chatter'
  ));

-- ============================================================================
-- end of migration
-- ============================================================================
