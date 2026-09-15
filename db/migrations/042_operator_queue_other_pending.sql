-- TAC-394, option F: tell the operator card that its guest has another card.
--
-- Recreates `list_operator_queue` with two changes and nothing else:
--
--   1. A new return column, `other_pending_for_guest integer`: how many OTHER
--      pending drafts the same guest has at the same venue. With migration 041
--      a guest can hold one obligation card and one conversation card, so this
--      is 0 or 1 today. The projection in lib/operator/queue.ts surfaces it as
--      QueueDraft.otherPendingDraftsForGuest, always present, 0 when none.
--
--   2. `recent_context` excludes every pending row, not just the card's own.
--      Before 041 the card's own row was the only pending row a guest could
--      have, so `id <> m.id` was enough. With two cards, the comp card's context
--      would otherwise show the conversation card's unsent draft as if it were
--      part of the conversation. `id <> m.id` is kept: it is now redundant (the
--      card itself is pending), and stating it keeps the intent readable.
--
-- Contract: TAC-394's description, `## Contract`. Client half: TAC-402.
--
-- ----------------------------------------------------------------------------
-- WHY DROP AND RECREATE
-- ----------------------------------------------------------------------------
-- Adding a column to `returns table(...)` is a return-type change, and
-- Postgres refuses it under `create or replace` (see migration 039's header).
-- The whole file runs in ONE transaction so no queue read observes a window
-- where the function does not exist.
--
-- ----------------------------------------------------------------------------
-- ORDERING: apply in Studio BEFORE merging, immediately after migration 041.
-- ----------------------------------------------------------------------------
-- The deployed code reads the new column through the RPC, so the schema lands
-- first. Old code ignores an extra column, and the recent_context change is
-- harmless to it, so this migration can stay in place even if 041 is rolled
-- back (see 041's header for the rollback rule). HIGH-STAKES: reads `messages`.
--
-- db/types.ts is hand-patched in the same commit (the RPC's Returns gains
-- other_pending_for_guest) until `npm run db:types` runs post-apply.
--
-- ----------------------------------------------------------------------------
-- BEFORE APPLYING: verify what is LIVE, not what is in this repo.
-- ----------------------------------------------------------------------------
--
--   -- 1. The live body should match migration 039. If it does NOT, stop:
--   --    someone edited this function in Studio and that edit is about to be
--   --    discarded.
--   select pg_get_functiondef('public.list_operator_queue(uuid[])'::regprocedure);
--
--   -- 2. Exactly ONE overload. `drop ... if exists (uuid[])` silently no-ops
--   --    against a different signature.
--   select oid::regprocedure from pg_proc where proname = 'list_operator_queue';
--
-- No GRANT/REVOKE to re-issue: the function is called only through the
-- service-role admin client, and the only grant statements in db/migrations
-- are migration 023's on link_operator_auth. DROP FUNCTION discards grants, so
-- re-verify that if it ever changes.
--
-- To undo this migration by itself, recreate migration 039's function body in
-- one transaction.

begin;

drop function if exists public.list_operator_queue(uuid[]);

create function public.list_operator_queue(
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
  review_triggers text[],
  ungrounded_claims text[],
  recognition_state text,
  created_at timestamptz,
  langfuse_trace_id text,
  recent_context jsonb,
  other_pending_for_guest integer
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
    m.review_triggers,
    m.ungrounded_claims,
    gs.state        as recognition_state,
    m.created_at,
    m.langfuse_trace_id,
    ctx.recent_context,
    other.other_pending_for_guest
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
    -- TAC-313: the inner query groups by response and takes the 3 most recent
    -- RESPONSES; the outer jsonb_agg flattens them most-recent-first.
    --
    -- TAC-394: every PENDING row is excluded, not only the draft itself. A
    -- guest can hold two cards (migration 041), and neither card's context
    -- may show the other card's unsent draft. Pending drafts are always
    -- single-row (the queue path persists one row per draft), so excluding
    -- them cannot split a sent response's group. `is distinct from` so rows
    -- with a NULL review_state (every inbound row) stay in.
    select jsonb_agg(
      jsonb_build_object(
        'id', r.id,
        'direction', r.direction,
        'body', r.body,
        'createdAt', r.created_at
      )
      order by r.created_at desc
    ) as recent_context
    from (
      select
        (array_agg(id        order by created_at))[1] as id,
        (array_agg(direction order by created_at))[1] as direction,
        btrim(string_agg(body, ' ' order by created_at)) as body,
        min(created_at)                               as created_at
      from messages
      where guest_id = m.guest_id
        and venue_id = m.venue_id
        and id <> m.id
        and review_state is distinct from 'pending'
      group by coalesce(generation_id, id)
      order by min(created_at) desc
      limit 3
    ) r
  ) ctx on true
  left join lateral (
    -- TAC-394: the other cards this guest has waiting. Never NULL: count(*)
    -- over zero rows is 0.
    select count(*)::integer as other_pending_for_guest
    from messages o
    where o.venue_id = m.venue_id
      and o.guest_id = m.guest_id
      and o.review_state = 'pending'
      and o.id <> m.id
  ) other on true
  where m.review_state = 'pending'
    and m.venue_id = any(venue_ids)
  order by m.created_at asc
  limit 200;
$function$;

commit;


-- ============================================================================
-- end of migration
-- ============================================================================
