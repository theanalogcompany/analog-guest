-- ============================================================================
-- 058: the operator queue carries the guest message each draft is answering
-- ============================================================================
-- TAC-534, the server half of TAC-533.
--
-- WHY. Since TAC-397 a guest can hold several pending cards, one per
-- unanswered inbound (migration 054's index is what makes that true). The
-- operator app shows each card's thread ending on the guest's NEWEST messages,
-- so every card but the newest reads as answering the wrong question. Observed
-- on device 2026-09-23: a card drafting "yeah, any drink" for an oat milk
-- question sat directly under "do you have a loyalty program?".
--
-- The link this needs already exists and is populated. `reply_to_message_id`
-- has been on `messages` since migration 001 (line 357), indexed by
-- `idx_messages_reply_to`, and `buildOutboundInsert` sets it from
-- `ctx.currentMessage` on every draft. What was missing is only the
-- projection: `list_operator_queue` never returned it.
--
-- THE BODY COMES OVER THE WIRE, NOT JUST THE ID. This is the point of the
-- ticket and the easy thing to get wrong. `recent_context` is capped at three
-- responses and the replied-to message is routinely older than that, so a
-- client given only an id holds something it cannot resolve against anything
-- it has, and the card still quotes nothing. Hence the lateral.
--
-- ---------------------------------------------------------------------------
-- WHY DROP + CREATE RATHER THAN CREATE OR REPLACE
-- ---------------------------------------------------------------------------
-- Adding a column to `returns table(...)` is a return-type change, which
-- Postgres refuses to replace in place ("cannot change return type of existing
-- function"). Migration 039 is where that rule is written down; 042, 054 and
-- 056 all followed it. The drop and the create are in ONE transaction, so no
-- concurrent caller ever observes a window where the function is missing: a
-- reader blocks on the lock and then sees the new definition. Without the
-- transaction, `GET /api/operator/queue` 500s for every operator in the gap.
--
-- `DROP FUNCTION` also discards any grant on the function. Inert here — this
-- one is called only with the service-role client, and the sole `grant`
-- statements in db/migrations are migration 023's, on a different function.
--
-- ---------------------------------------------------------------------------
-- BEFORE APPLYING: verify what is actually live
-- ---------------------------------------------------------------------------
-- The body below restates migration 056's verbatim, with only the three new
-- return columns, their three select entries, and one new lateral added. Diff
-- it against db/migrations/056_operator_instagram_fields.sql lines 232-406.
--
-- 232-406 and not further: 056 line 406 is this function's closing
-- `$function$;`, 407-428 are the NEXT function's header comment, and line 429
-- is `drop function if exists public.list_operator_conversations(uuid[]);`.
--
-- This repo has been bitten by a Studio-only SQL object before (migration
-- 021's orphan `link_operator_auth`), so confirm the live body is 056's and
-- that there is exactly one overload, rather than assuming:
--
--     select pg_get_functiondef('public.list_operator_queue(uuid[])'::regprocedure);
--
--     select proname, pronargs, prorettype::regtype
--     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
--     where n.nspname = 'public' and proname = 'list_operator_queue';
--
-- ---------------------------------------------------------------------------
-- ORDERING: apply in Studio BEFORE merging the PR
-- ---------------------------------------------------------------------------
-- Additive in shape — no column, no constraint, no index, and no existing
-- return column changes type — but the deployed code SELECTs the three new
-- columns through the RPC the moment the PR merges and Vercel deploys. Merging
-- first breaks `GET /api/operator/queue` outright for every operator. This is
-- the call migrations 042, 054 and 056 all made on this same function.
--
-- Rolling back the code without rolling back this migration is safe: the old
-- TypeScript simply ignores the extra columns.
--
-- ---------------------------------------------------------------------------
-- AFTERWARDS: what should be true
-- ---------------------------------------------------------------------------
-- The one that can actually fail. A card whose id resolved to nothing is the
-- failure that matters, because it reaches the client as `replyingTo: null` on
-- a card that was generated from a guest message — indistinguishable from a
-- proactive card. Expect 0:
--
--     select count(*) as broken
--     from list_operator_queue(array(select id from venues))
--     where reply_to_message_id is not null
--       and replying_to_created_at is null;
--
-- And one that shows the body is really travelling, rather than a count that
-- is equally true of three NULLs:
--
--     select draft_id, reply_to_message_id, replying_to_body, replying_to_created_at
--     from list_operator_queue(array(select id from venues))
--     where reply_to_message_id is not null
--     limit 5;
--
-- A proactive card (manual followup, operator decline, crash card, engine
-- followup) has NULL in all three. `replying_to_body` may legitimately be ''
-- for a media-only inbound, which is NOT the same as NULL.
--
-- ---------------------------------------------------------------------------
-- ROLLBACK
-- ---------------------------------------------------------------------------
-- Restore migration 056's definition of this function, which is
-- db/migrations/056_operator_instagram_fields.sql lines 232-406, wrapped the
-- same way:
--
-- READ THE END OF THAT RANGE CAREFULLY. It stops at line 406, this function's
-- closing `$function$;`. Line 429 of 056 is
-- `drop function if exists public.list_operator_conversations(uuid[]);` — a
-- paste that runs one statement wider drops the conversations RPC inside this
-- transaction with no matching create, commits, and breaks
-- `GET /api/operator/conversations` for every operator.
--
--     begin;
--     set local lock_timeout = '5s';
--     drop function if exists public.list_operator_queue(uuid[]);
--     -- ... paste 056 lines 234-406 here, and no further ...
--     commit;
--
-- Safe at any time on its own: nothing but `lib/operator/queue.ts` reads the
-- three new columns, and code deployed before this migration never asked for
-- them. Roll the code back first if it is already live, or the queue 500s.
--
-- HIGH-STAKES: this function READS `messages`. It performs no DDL on that
-- table.
-- ============================================================================

begin;

-- 5s rather than waiting behind a long transaction. A busy `messages` makes
-- this fail cleanly instead of queueing behind writes; the webhook paths
-- answer 200 on a failed insert, so a lock held here is guest messages lost.
set local lock_timeout = '5s';

-- ---------------------------------------------------------------------------
-- list_operator_queue: + reply_to_message_id, replying_to_body,
--                        replying_to_created_at
-- ---------------------------------------------------------------------------

drop function if exists public.list_operator_queue(uuid[]);

create function public.list_operator_queue(venue_ids uuid[])
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
  other_pending_for_guest integer,
  replaced_draft_body text,
  replaced_draft_at timestamptz,
  guest_channel text,
  instagram_username text,
  last_guest_action_at timestamptz,
  reply_to_message_id uuid,
  replying_to_body text,
  replying_to_created_at timestamptz
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
    other.other_pending_for_guest,
    -- TAC-397: non-null only on a card a correction regenerated in place.
    m.replaced_draft_body,
    m.replaced_draft_at,
    -- TAC-473: the card's own channel. `not null default 'text'` since
    -- migration 048, so this is never NULL.
    m.channel       as guest_channel,
    g.instagram_username,
    -- TAC-473: Meta's own time for this guest's newest Instagram inbound. The
    -- TS layer adds INSTAGRAM_WINDOW_MS to get the deadline the Contract
    -- promises; the 24 hours is NOT written here, so it has one definition.
    window_anchor.last_guest_action_at,
    -- TAC-534: the guest message this draft answers. The id is the column
    -- itself; the body and the timestamp come from the lateral below.
    replying_to.id         as reply_to_message_id,
    replying_to.body       as replying_to_body,
    replying_to.created_at as replying_to_created_at
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
    -- TAC-397: a guest can now hold MORE than two, one per unanswered inbound.
    -- The exclusion is unchanged and still correct — it keys on
    -- review_state = 'pending', not on a count.
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
    --
    -- TAC-473: a card resolved externally is NOT pending, so its unsent draft
    -- body would now qualify as context. It is excluded by the same
    -- `status in (...)` clause — an externally-resolved card was never sent by
    -- us, so its status is still 'pending_review'.
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
    --
    -- TAC-397: this may now exceed 1, per the Contract. The query is
    -- unchanged — it never had a bound.
    select count(*)::integer as other_pending_for_guest
    from messages o
    where o.venue_id = m.venue_id
      and o.guest_id = m.guest_id
      and o.review_state = 'pending'
      and o.id <> m.id
  ) other on true
  left join lateral (
    -- TAC-473: the newest Instagram inbound carrying Meta's own timestamp.
    --
    -- MIRRORS loadLastGuestActionAt (lib/messaging/instagram/window.ts) filter
    -- for filter, and it has to: that function is what the send gate consults,
    -- so a different answer here would show the operator a deadline the server
    -- would not itself honour. A row without provider_sent_at is skipped rather
    -- than falling back to created_at — the safe direction, since the true
    -- close is at least as late as one computed from an older action.
    select max(w.provider_sent_at) as last_guest_action_at
    from messages w
    where w.venue_id = m.venue_id
      and w.guest_id = m.guest_id
      and w.direction = 'inbound'
      and w.channel = 'instagram'
      and w.provider_sent_at is not null
  ) window_anchor on true
  left join lateral (
    -- TAC-534: the guest message this card's draft is replying to.
    --
    -- THE BODY COMES OVER THE WIRE, NOT JUST THE ID, and that is the whole
    -- point of the ticket. recent_context above is capped at 3 responses and
    -- the replied-to message is routinely older than that, so a client holding
    -- only an id has nothing to resolve it against and the card quotes nothing.
    --
    -- NO body <> '' CONDITION HERE, deliberately. A media-only inbound is
    -- stored with body = '' and is still the message this draft answers; the
    -- Contract says the endpoint sends it as-is and the client decides whether
    -- to show it. The queue's recent_context carries empty bodies for the same
    -- reason (TAC-395's 22:08 ruling), and reached-guest-condition.test.ts
    -- asserts no body filter is ever added to this function.
    --
    -- Scoped to the same venue AND guest on top of the id. Every writer sets
    -- reply_to_message_id from this guest's own inbound
    -- (schedule-and-send.ts, dispatch-instagram-reply.ts, expressions.ts), so
    -- the scope excludes nothing real; without it, one mis-set id would put
    -- another guest's message body on this card.
    --
    -- The seek is on rt.id, the PRIMARY KEY, so this rides messages_pkey.
    -- NOT idx_messages_reply_to, which indexes the pointing column and is what
    -- you would use to find the drafts answering a given message — the
    -- opposite direction to this join.
    --
    -- The ID COMES OUT OF THIS LATERAL, not from m.reply_to_message_id, so all
    -- three columns are null together. Taken from m., a row whose id failed the
    -- venue/guest scope would return (id, null, null), and the Contract's "null
    -- exactly when reply_to_message_id is NULL" would be false on the wire.
    select rt.id, rt.body, rt.created_at
    from messages rt
    where rt.id = m.reply_to_message_id
      and rt.venue_id = m.venue_id
      and rt.guest_id = m.guest_id
  ) replying_to on true
  where m.review_state = 'pending'
    and m.venue_id = any(venue_ids)
  order by m.created_at asc
  limit 200;
$function$;

commit;

-- ============================================================================
-- end of migration
-- ============================================================================
