-- 016_add_inbound_outbound_split_categories.sql
-- Adds perk_inquiry, event_question, and unknown to messages.category check
-- constraint. perk_inquiry / event_question are the inbound counterparts to
-- the outbound perk_unlock / event_invite categories. unknown is the inbound
-- catch-all when the classifier can't categorize confidently — replaces the
-- old practice of routing ambiguous inbounds to manual.
--
-- Existing values are preserved. The classifier prompt + Zod schema in
-- lib/ai/classify-message.ts gain these three values in the same PR; this
-- migration only widens the persistence-side gate so the orchestrator can
-- write rows with the new category strings.

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
    'unknown'
  ));

-- ============================================================================
-- end of migration
-- ============================================================================
