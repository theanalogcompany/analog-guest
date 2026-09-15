-- ============================================================================
-- migration 043: the operator conversations list counts only messages that
-- reached the guest (TAC-395)
-- ============================================================================
-- Recreates `list_operator_conversations` (migration 033) with `create or
-- replace`. The signature and the returned columns are unchanged, so there is
-- no DROP and no `db/types.ts` change.
--
-- Contract: TAC-395's description, `## Contract`, section
-- `GET /api/operator/conversations`.
--
-- ----------------------------------------------------------------------------
-- WHAT CHANGES
-- ----------------------------------------------------------------------------
-- A message reached the guest when
--
--   direction = 'inbound'
--   or (review_state is distinct from 'pending'
--       and status in ('sending', 'sent', 'delivered'))
--
-- which is the set `deriveDelivery` (lib/agent/group-responses.ts) calls
-- `delivered`. The same condition is written in lib/operator/thread.ts and in
-- migration 044. lib/operator/reached-guest-condition.test.ts reads all three
-- and fails if any status list drifts from DELIVERED_OUTBOUND_STATUSES.
--
--   1. A guest with at least one message that reached them: every field comes
--      from those messages only. A pending draft, a skipped draft or a reply
--      that never sent can no longer be the last-message preview, and no
--      longer counts toward conversation_count or first_conversation_at.
--
--   2. A guest with none (only pending drafts, only skipped drafts, or both)
--      stays in the list. Their fields are computed from all of their
--      non-empty messages, exactly as before, and last_message_body is ''
--      (TAC-395 rulings, 21:44 and 21:55). The preview is the only field that
--      makes a claim; the rest is ordering and counting metadata.
--
-- Membership (every guest with a non-empty message), ordering and the 200-row
-- cap are unchanged. `body <> ''` stays exactly where migration 033 had it.
--
-- ----------------------------------------------------------------------------
-- ORDERING
-- ----------------------------------------------------------------------------
-- Body-only change. The deployed code reads the same columns, so this can be
-- applied before or after the code merge (CLAUDE.md §Ordering). Apply it back
-- to back with migration 044. HIGH-STAKES: reads `messages`.
--
-- ----------------------------------------------------------------------------
-- BEFORE APPLYING: verify what is LIVE, not what is in this repo.
-- ----------------------------------------------------------------------------
--
--   -- 1. The live body should match migration 033. If it does NOT, stop:
--   --    someone edited this function in Studio and that edit is about to be
--   --    discarded.
--   select pg_get_functiondef('public.list_operator_conversations(uuid[])'::regprocedure);
--
--   -- 2. Exactly ONE overload.
--   select oid::regprocedure from pg_proc where proname = 'list_operator_conversations';
--
-- No GRANT/REVOKE to re-issue: migration 033 issues none, and `create or
-- replace` keeps the function's existing privileges.
--
-- To undo: re-run migration 033's `create or replace function` statement.

create or replace function public.list_operator_conversations(
  venue_ids uuid[]
)
returns table(
  guest_id uuid,
  venue_id uuid,
  venue_slug text,
  venue_timezone text,
  agent_name text,
  guest_first_name text,
  guest_last_name text,
  guest_phone text,
  recognition_state text,
  last_message_at timestamptz,
  last_message_direction text,
  last_message_body text,
  conversation_count bigint,
  first_conversation_at timestamptz
)
language sql
stable
as $function$
  with scoped_messages as (
    select
      m.venue_id,
      m.guest_id,
      m.direction,
      m.body,
      m.created_at,
      (
        m.direction = 'inbound'
        or (m.review_state is distinct from 'pending'
            and m.status in ('sending', 'sent', 'delivered'))
      ) as reached_guest
    from messages m
    where m.venue_id = any(venue_ids)
      and m.body <> ''
  ),
  guest_reach as (
    -- Whether each guest has ANY message that reached them. It decides which
    -- rows that guest's fields are computed from.
    select sm.guest_id, sm.venue_id, bool_or(sm.reached_guest) as any_reached
    from scoped_messages sm
    group by sm.guest_id, sm.venue_id
  ),
  counted_messages as (
    select sm.*
    from scoped_messages sm
    join guest_reach gr
      on gr.guest_id = sm.guest_id and gr.venue_id = sm.venue_id
    where sm.reached_guest or not gr.any_reached
  ),
  last_message as (
    select distinct on (guest_id, venue_id)
      guest_id, venue_id, direction, body, created_at, reached_guest
    from counted_messages
    order by guest_id, venue_id, created_at desc
  ),
  conversation_days as (
    select
      cm.guest_id,
      cm.venue_id,
      count(distinct date_trunc('day', cm.created_at at time zone coalesce(v.timezone, 'UTC'))) as day_count,
      min(cm.created_at) as first_at
    from counted_messages cm
    join venues v on v.id = cm.venue_id
    group by cm.guest_id, cm.venue_id
  )
  select
    lm.guest_id,
    lm.venue_id,
    v.slug as venue_slug,
    v.timezone as venue_timezone,
    coalesce(vc.brand_persona ->> 'voiceName', v.name) as agent_name,
    g.first_name as guest_first_name,
    g.last_name as guest_last_name,
    g.phone_number as guest_phone,
    gs.state as recognition_state,
    lm.created_at as last_message_at,
    lm.direction as last_message_direction,
    -- TAC-395: a guest no message has reached keeps their row, with no preview.
    case when lm.reached_guest then lm.body else '' end as last_message_body,
    cd.day_count as conversation_count,
    cd.first_at as first_conversation_at
  from last_message lm
  join venues v on v.id = lm.venue_id
  join guests g on g.id = lm.guest_id
  join conversation_days cd
    on cd.guest_id = lm.guest_id and cd.venue_id = lm.venue_id
  left join venue_configs vc on vc.venue_id = lm.venue_id
  left join lateral (
    -- guest_states is a transition log. Pick the open segment (exited_at
    -- IS NULL); order by entered_at desc as a defensive tiebreaker for
    -- the one-open-row-per-(guest,venue) invariant. If a guest has no open
    -- state, the LATERAL returns 0 rows → gs.state = NULL.
    select state
    from guest_states gs2
    where gs2.guest_id = lm.guest_id
      and gs2.venue_id = lm.venue_id
      and gs2.exited_at is null
    order by gs2.entered_at desc
    limit 1
  ) gs on true
  order by lm.created_at desc
  limit 200;
$function$;

-- ============================================================================
-- end of migration
-- ============================================================================
