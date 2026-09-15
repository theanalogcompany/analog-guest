-- TAC-395: a card's recent context holds only messages that reached the guest.
--
-- Recreates `list_operator_queue` (migration 042) with `create or replace`,
-- restating 042's body with ONE change, inside the `recent_context` lateral:
-- each row must meet
--
--   direction = 'inbound'
--   or (review_state is distinct from 'pending'
--       and status in ('sending', 'sent', 'delivered'))
--
-- which is the set `deriveDelivery` (lib/agent/group-responses.ts) calls
-- `delivered`. It replaces 042's `review_state is distinct from 'pending'`,
-- which it covers, so pending drafts stay out and skipped drafts and replies
-- that never sent now leave the card's context too. The same condition is
-- written in lib/operator/thread.ts and in migration 043;
-- lib/operator/reached-guest-condition.test.ts reads all three and fails if any
-- status list drifts from DELIVERED_OUTBOUND_STATUSES.
--
-- The condition applies per row, BEFORE rows are grouped into responses and
-- before the 3-response limit, so a split reply keeps the bubbles that went out.
--
-- NO `body <> ''` HERE, deliberately (TAC-395, 22:08 ruling). Unlike the thread
-- endpoints and the conversations list, `recent_context` has always returned
-- empty-body entries, such as a reaction or a photo-only text, and a photo the
-- guest sent is context the operator needs while deciding. The binding test
-- fails if a body filter is added to this file.
--
-- Contract: TAC-395's description, `## Contract`, section
-- `GET /api/operator/queue`. It narrows what TAC-394's Contract says
-- `recentContext` excludes; the entry shape is unchanged.
--
-- ----------------------------------------------------------------------------
-- WHY CREATE OR REPLACE (042 had to drop)
-- ----------------------------------------------------------------------------
-- `recent_context` is already a `jsonb` column and no column is added, so the
-- return type is identical and `create or replace` is accepted. No DROP, no
-- window where the function does not exist, and no `db/types.ts` change.
--
-- ----------------------------------------------------------------------------
-- ORDERING
-- ----------------------------------------------------------------------------
-- Body-only change. The deployed code reads the same columns and the same entry
-- shape, so this can be applied before or after the code merge (CLAUDE.md
-- §Ordering). Apply it back to back with migration 043. HIGH-STAKES: reads
-- `messages`.
--
-- ----------------------------------------------------------------------------
-- BEFORE APPLYING: verify what is LIVE, not what is in this repo.
-- ----------------------------------------------------------------------------
--
--   -- 1. The live body should match migration 042. If it does NOT, stop:
--   --    someone edited this function in Studio and that edit is about to be
--   --    discarded.
--   select pg_get_functiondef('public.list_operator_queue(uuid[])'::regprocedure);
--
--   -- 2. Exactly ONE overload.
--   select oid::regprocedure from pg_proc where proname = 'list_operator_queue';
--
-- No GRANT/REVOKE to re-issue: the function is called only through the
-- service-role admin client, migration 042 issues none, and `create or replace`
-- keeps the function's existing privileges.
--
-- To undo: re-run migration 042's function definition as `create or replace
-- function` (its `drop` is not needed, since the return type is the same).

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
    -- may show the other card's unsent draft.
    --
    -- TAC-395: more generally, only messages that reached the guest, decided
    -- per row BEFORE grouping. Pending drafts are always single-row (the queue
    -- path persists one row per draft), so excluding them cannot split a sent
    -- response's group. A split reply whose bubble a late Sendblue ERROR moved
    -- to 'failed' does lose that bubble, on purpose: the entry keeps the
    -- bubbles that went out and takes the earliest remaining bubble's id. That
    -- is per row, as the Contract says, and stricter than group-responses.ts's
    -- "delivered if any bubble was". `is distinct from` so rows with a NULL
    -- review_state stay in; every inbound row is kept by
    -- `direction = 'inbound'` regardless.
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
        and (
          direction = 'inbound'
          or (review_state is distinct from 'pending'
              and status in ('sending', 'sent', 'delivered'))
        )
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


-- ============================================================================
-- end of migration
-- ============================================================================
