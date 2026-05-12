-- ============================================================================
-- migration 018: operator review state machine on messages
-- ============================================================================
-- Adds the operator-review state machine consumed by the mobile approval queue
-- (TAC-258) and written by the autonomous agent runtime (TAC-258 stamps every
-- new outbound row 'auto_sent'; TAC-212 will later override to 'pending' at
-- draft creation when the flag policy decides the agent's output needs human
-- review).
--
-- review_state is a separate axis from messages.status (which is the lifecycle:
-- received / draft / sending / sent / delivered / ...). status carries delivery
-- lifecycle; review_state carries the human-review verdict applied to outbound
-- drafts surfaced in the mobile approval queue. Five values:
--   pending   — draft awaiting operator review (set by TAC-212 runtime).
--   approved  — operator approved as-is; Sendblue dispatched.
--   edited    — operator edited body; Sendblue dispatched with the edit.
--   skipped   — operator chose not to send anything for this draft.
--   auto_sent — never queued for review (status quo for current drafts).
--
-- previous_review_state, last_operator_action_at, last_operator_id support the
-- 3-second undo window enforced server-side via
--   now() - last_operator_action_at < interval '3 seconds'.
-- For v1, only the skip→pending revert mutates state; approve/edit undo fires
-- a PostHog event only (analytics signal, no state change). Storing the prior
-- state on the row keeps the contract explicit and gives future operator-undo
-- richer than v1's single-action revert a place to land without a migration.
--
-- All four columns are nullable. Inbound messages and pre-TAC-258 outbound rows
-- stay NULL for review_state where appropriate; new outbound writes set the
-- column explicitly. We backfill every existing direction='outbound' row to
-- 'auto_sent' so the partial queue index isn't polluted by the legacy
-- population (no behaviour change — pre-existing outbounds were never queued
-- for review and shouldn't be treated as pending).
--
-- Partial indexes:
--   idx_messages_review_state_pending — covers GET /api/operator/queue's hot
--     path (filter review_state='pending', ordered by created_at ASC FIFO,
--     scoped to the operator's allowlist via venue_id).
--   idx_messages_operator_action_recent — covers the 3-second undo window
--     lookup; sparse, since last_operator_action_at is only set on the few
--     rows that have been acted on in the last few seconds.
--
-- TAC-258.
-- ============================================================================

-- ── columns ─────────────────────────────────────────────────────────────────

alter table messages
  add column review_state text,
  add column previous_review_state text,
  add column last_operator_action_at timestamptz,
  add column last_operator_id uuid references operators(id);

-- ── CHECK constraints ──────────────────────────────────────────────────────

alter table messages
  add constraint messages_review_state_check
  check (review_state is null or review_state in (
    'pending',
    'approved',
    'edited',
    'skipped',
    'auto_sent'
  ));

alter table messages
  add constraint messages_previous_review_state_check
  check (previous_review_state is null or previous_review_state in (
    'pending',
    'approved',
    'edited',
    'skipped',
    'auto_sent'
  ));

-- ── backfill ────────────────────────────────────────────────────────────────
-- Every existing outbound row → 'auto_sent'. These pre-date the operator
-- queue so by definition they were never reviewed. Keeps the partial queue
-- index clean (only newly-flagged drafts qualify). Inbound rows stay NULL.

update messages
set review_state = 'auto_sent'
where direction = 'outbound' and review_state is null;

-- ── indexes ────────────────────────────────────────────────────────────────

-- Queue lookup: filter review_state='pending', scope by venue_id, order by
-- created_at ASC. Composite (venue_id, created_at) covers both the equality
-- filter and the sort.
create index idx_messages_review_state_pending
  on messages (venue_id, created_at)
  where review_state = 'pending';

-- Undo window lookup: bounded by last_operator_action_at within the last few
-- seconds. Sparse — most rows never have this set. desc ordering matches the
-- "most recent action" semantics.
create index idx_messages_operator_action_recent
  on messages (last_operator_action_at desc)
  where last_operator_action_at is not null;

-- ── rpc: list_operator_queue ───────────────────────────────────────────────
-- Powers GET /api/operator/queue. Returns pending drafts scoped to the
-- operator's allowed venue list, FIFO ordered, with the latest guest_state
-- and the last 3 messages (excluding the draft itself) pre-joined into a
-- jsonb array. The lateral aggregate keeps the round-trip count to one even
-- when the queue contains many drafts — the alternative (one round trip per
-- draft for recent_context) would be N+1.
--
-- recent_context: the inner `select ... limit 3` bounds the agg to 3 rows
-- per draft; the outer jsonb_agg(... order by ...) flattens them
-- most-recent-first. Returns null for guests with no prior messages; app
-- code normalizes to [] before returning.
--
-- venue_id IN allowedVenueIds enforcement happens at the SQL layer via the
-- function's input param. The route handler passes the operator's
-- allowedVenueIds (already resolved by withOperatorAuth) — no separate
-- existence-leak code path needed (drafts the operator can't see don't
-- come back).
--
-- limit 200 matches the soft cap documented in the plan; if a single
-- operator has more than 200 pending drafts, the swipe UX has bigger
-- problems than pagination. v2 if needed.

-- Column-citation note (per the post-mortem on the first apply attempt):
--   guests       — first_name, last_name (no full_name column; display name
--                  is composed here). phone_number, opted_out_at. See
--                  db/types.ts:201-260.
--   guest_states — entered_at + exited_at + state. Transition log, not a
--                  snapshot — currently-active state is the row where
--                  exited_at IS NULL. Matches the existing in-repo callers
--                  (app/admin/(authed)/conversations/page.tsx,
--                   app/admin/(authed)/voices/[slug]/_lib/load-voice-page.ts).
--                  See db/types.ts:146-200.
--   venues       — slug. See db/types.ts:829-870.

create or replace function public.list_operator_queue(
  venue_ids uuid[]
)
returns table(
  draft_id uuid,
  venue_id uuid,
  venue_slug text,
  guest_id uuid,
  guest_display_name text,
  guest_phone text,
  guest_opted_out_at timestamptz,
  draft_body text,
  category text,
  voice_fidelity numeric,
  review_reason text,
  recognition_state text,
  created_at timestamptz,
  langfuse_trace_id text,
  recent_context jsonb
)
language sql
stable
as $function$
  select
    m.id            as draft_id,
    m.venue_id,
    v.slug          as venue_slug,
    m.guest_id,
    -- guests has no full_name; compose from first/last + null-out the empty
    -- case so the TS layer's `guestDisplayName: string | null` is honored.
    nullif(
      trim(both ' ' from
        coalesce(g.first_name, '') || ' ' || coalesce(g.last_name, '')
      ),
      ''
    )               as guest_display_name,
    g.phone_number  as guest_phone,
    g.opted_out_at  as guest_opted_out_at,
    m.body          as draft_body,
    m.category,
    m.voice_fidelity,
    m.review_reason,
    gs.state        as recognition_state,
    m.created_at,
    m.langfuse_trace_id,
    ctx.recent_context
  from messages m
  join venues v on v.id = m.venue_id
  join guests g on g.id = m.guest_id
  left join lateral (
    -- guest_states is a transition log. Pick the open segment (exited_at
    -- IS NULL); order by entered_at desc as a defensive tiebreaker for
    -- the one-open-row-per-(guest,venue) invariant. If a guest has no open
    -- state, the LATERAL returns 0 rows → gs.state = NULL.
    select state
    from guest_states gs2
    where gs2.guest_id = m.guest_id
      and gs2.venue_id = m.venue_id
      and gs2.exited_at is null
    order by gs2.entered_at desc
    limit 1
  ) gs on true
  left join lateral (
    select jsonb_agg(
      jsonb_build_object(
        'id', ctx_msg.id,
        'direction', ctx_msg.direction,
        'body', ctx_msg.body,
        'createdAt', ctx_msg.created_at
      )
      order by ctx_msg.created_at desc
    ) as recent_context
    from (
      select id, direction, body, created_at
      from messages
      where guest_id = m.guest_id
        and venue_id = m.venue_id
        and id <> m.id
      order by created_at desc
      limit 3
    ) ctx_msg
  ) ctx on true
  where m.review_state = 'pending'
    and m.venue_id = any(venue_ids)
  order by m.created_at asc
  limit 200;
$function$;

-- ============================================================================
-- end of migration
-- ============================================================================
