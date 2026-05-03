-- 012_add_personal_history_question_category.sql
-- THE-233: extends messages.category to include 'personal_history_question'
-- for the new classifier category that handles "what did I get last time"
-- style questions about the guest's own history with the venue. Existing
-- values are preserved. The classifier prompt + Zod schema in
-- lib/ai/classify-message.ts gain this value in the same PR; this migration
-- only widens the persistence-side gate so the orchestrator can write rows
-- with the new category string.

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
    'casual_chatter',
    'personal_history_question'
  ));

-- ============================================================================
-- end of migration
-- ============================================================================
