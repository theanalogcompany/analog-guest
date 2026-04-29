-- ============================================================================
-- migration 010: command center foundational columns
-- ============================================================================
-- adds two unrelated columns bundled atomically:
--   1. messages.langfuse_trace_id (text, nullable) — links each agent-
--      generated outbound message to its Langfuse trace. Populated by the
--      THE-200 instrumentation pass; existing rows stay null. Inbound
--      messages stay null permanently (they aren't generated, so they don't
--      have a trace). Partial index covers the only query path: lookup a
--      message by its trace ID, which only makes sense for non-null rows.
--   2. operators.is_analog_admin (boolean, NOT NULL DEFAULT false) — gates
--      access to admin.theanalog.company (admin routes colocated in this
--      repo, served via a separate Vercel project). Default false so
--      existing operators are unaffected; admin grants are explicit
--      one-off SQL updates (template under "Common gotchas" in CLAUDE.md).
--      No separate index — the admin middleware reads this on the operator
--      row that's already loaded by auth_user_id (indexed).
-- ============================================================================

alter table messages
  add column langfuse_trace_id text;

create index idx_messages_langfuse_trace_id
  on messages(langfuse_trace_id)
  where langfuse_trace_id is not null;

-- ----------------------------------------------------------------------------
-- operators.is_analog_admin
-- ----------------------------------------------------------------------------

alter table operators
  add column is_analog_admin boolean not null default false;
