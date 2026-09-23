-- 056_operator_instagram_fields.sql
-- TAC-473: the operator app can tell an Instagram guest from a text guest,
-- see how long is left to reply, and record a card answered from outside.
--
-- WHY THIS EXISTS. `analog-operator` receives a guest row and no way to know
-- which channel it is on. An Instagram guest has no phone number, so the app's
-- `name ?? phoneFallback` renders a blank; and a held Instagram draft has a
-- 24-hour deadline the app cannot see, so an operator can approve a card Meta
-- will refuse. The Contract locked on TAC-473 adds three fields to each queue
-- draft and each conversation summary, and this migration is what lets the two
-- RPCs return them.
--
-- FIVE CHANGES, ONE TRANSACTION:
--   1. messages.resolved_by_message_id  — which echo answered this card
--   2. messages.window_warning_pushed_at — the one-hour push's idempotency marker
--   3. messages_review_state_check       — gains 'resolved_externally'
--   4. list_operator_queue               — DROP + CREATE, three new columns
--   5. list_operator_conversations       — DROP + CREATE, four new columns
--
-- ============================================================================
-- ORDERING: APPLY IN STUDIO **BEFORE** MERGING THE PR
-- ============================================================================
-- Deployed code SELECTs the new RPC columns, so merging first breaks
-- `GET /api/operator/queue` and `GET /api/operator/conversations` outright —
-- every operator loses the queue until this is applied.
--
-- Applying FIRST is safe in the other direction: the currently-deployed TS
-- projects RPC rows by column name and ignores columns it does not know, and
-- the two new `messages` columns have no reader until the PR lands. The CHECK
-- widening is additive and nothing writes the new value yet.
--
-- The same call migrations 025, 026, 027, 034, 035, 036, 038, 039, 045 and 052
-- all made on this table.
--
-- ============================================================================
-- PRECONDITIONS: run these three READ-ONLY checks in Studio first
-- ============================================================================
-- (a) The live list_operator_queue is migration 054's body, not something
--     applied by hand. Migration 021's orphaned link_operator_auth is the
--     precedent for not trusting the repo about what is live.
--
--     select pg_get_functiondef('public.list_operator_queue(uuid[])'::regprocedure);
--
-- (b) The live list_operator_conversations is migration 043's body.
--
--     select pg_get_functiondef('public.list_operator_conversations(uuid[])'::regprocedure);
--
-- (c) Exactly ONE overload of each, so `drop function` has one target.
--
--     select oid::regprocedure from pg_proc
--     where proname in ('list_operator_queue', 'list_operator_conversations');
--
-- No GRANT/REVOKE to re-issue on either: migrations 033 and 018 issue none, and
-- both functions are called with the service-role client.
--
-- ============================================================================
-- ROLLBACK
-- ============================================================================
-- Safe at any time BEFORE the PR merges. Afterwards the deployed code SELECTs
-- the new RPC columns, so rolling back breaks the operator queue and the fix is
-- forward.
--
-- ORDER MATTERS, and the first step is the one that is easy to skip. A
-- SQL-language function's body is a STRING and carries no column dependencies,
-- so `drop column resolved_by_message_id` succeeds while this migration's
-- functions still select it — committing that leaves every operator read
-- failing at call time, which is worse than the thing being rolled back. So
-- both functions are restored FIRST, by pasting the previous migrations' bodies
-- in rather than by hand-editing these down. Migration 054's own rollback
-- header sets this precedent.
--
--   begin;
--
--   -- STEP 1, FIRST AND NOT OPTIONAL: restore the previous function bodies.
--   -- Copy the whole `drop function ... create function ... $function$;` block
--   -- verbatim out of db/migrations/054_conversation_cards_per_reply.sql, and
--   -- the whole `create or replace function ... $function$;` block out of
--   -- db/migrations/043_operator_conversations_reached_guest.sql. 054's is a
--   -- DROP + CREATE for the same return-type reason as the forward migration
--   -- below; 043's is a create-or-replace, which must be preceded by
--   -- `drop function if exists public.list_operator_conversations(uuid[]);`
--   -- here, because this migration widened its return type.
--
--   -- STEP 2: restore the CHECK. This ABORTS if any row already carries
--   -- 'resolved_externally' — which is the correct outcome, because those rows
--   -- are cards a human was told were handled and there is no honest value to
--   -- rewrite them to. If it aborts, fix forward instead.
--   alter table messages drop constraint messages_review_state_check;
--   alter table messages
--     add constraint messages_review_state_check
--     check (review_state is null or review_state in (
--       'pending', 'approved', 'edited', 'skipped', 'auto_sent'
--     ));
--
--   -- STEP 3: only now are the columns unreferenced.
--   alter table messages
--     drop column resolved_by_message_id,
--     drop column window_warning_pushed_at;
--
--   commit;
--
-- ============================================================================
-- AFTER APPLYING: what should be true
-- ============================================================================
-- Both functions return their new columns, and nothing has been written yet:
--
--     select guest_channel, instagram_username, last_guest_action_at
--     from list_operator_queue(array(select id from venues)) limit 5;
--
--     select count(*) from messages where review_state = 'resolved_externally';
--     -- expect 0 until the PR is deployed
--
-- ============================================================================

begin;

-- Take the lock on `messages` up front, under a short timeout, so a busy table
-- fails this migration cleanly rather than queueing behind live traffic.
-- Migrations 048, 049 and 054 set the same precedent on this table.
set local lock_timeout = '5s';

-- ---------------------------------------------------------------------------
-- 1. which echo answered this card
-- ---------------------------------------------------------------------------
-- Set when an echo (a reply staff typed in the Instagram app) resolves a
-- pending card whose reply window had already closed. NULL on every other row,
-- and deliberately NULL on a card an operator resolved by hand through
-- POST /api/operator/messages/:id/resolve-external: an operator asserting a
-- message was sent is a weaker record than an echo proving it, and the two must
-- stay tellable apart.
--
-- `on delete set null` because the echo row can legitimately be deleted:
-- stampInstagramOperatorSend folds an early-arriving echo into its card and
-- deletes it. That path only ever touches OUR OWN sends, which can never be the
-- echo that resolved a card (see the handler's own comment), so in practice
-- this cascade should never fire. It is here so that if it ever does, the
-- resolution survives with a weaker record rather than the delete failing.
alter table messages
  add column resolved_by_message_id uuid references messages(id) on delete set null;

comment on column messages.resolved_by_message_id is
  'TAC-473: the Instagram echo that answered this pending card from outside the operator app. NULL when the card was resolved by an operator asserting it by hand, and on every card never resolved externally.';

-- ---------------------------------------------------------------------------
-- 2. the one-hour push's idempotency marker
-- ---------------------------------------------------------------------------
-- DURABLE STATE, not a log. The processor runs every minute, so without a
-- marker a card under an hour would push on every tick: sixty pushes per card
-- per hour. That is migration 038's escalation lesson exactly — an alert that
-- fires every tick is not noisy, it is worthless, and the fix is a column, not
-- a shorter interval.
--
-- It answers exactly one question (has this card's operator been warned) and
-- carries no reason, no count and no recipient; those ride on the PostHog event.
alter table messages
  add column window_warning_pushed_at timestamptz;

comment on column messages.window_warning_pushed_at is
  'TAC-473: when the one-hour Instagram reply-window warning push was claimed for this pending draft. Idempotency marker only. NULL means never warned.';

-- ---------------------------------------------------------------------------
-- 3. review_state gains 'resolved_externally'
-- ---------------------------------------------------------------------------
-- A card answered from the Instagram app was not approved, edited, skipped or
-- auto-sent. Reusing 'skipped' would record an operator verdict nobody gave and
-- would pollute the skip rate with cards that were in fact answered.
--
-- The CHECK is DROPPED and recreated rather than widened in place, because
-- Postgres has no `alter constraint` for a check expression. Additive: every
-- existing value stays permitted, so no row can fail it.
--
-- `messages_previous_review_state_check` is deliberately NOT widened. Nothing
-- writes the new value there: external resolution is not an operator action
-- with an undo window, and /undo gates on last_operator_action_at plus an
-- operator match, so it cannot reach one of these rows. A value permitted in a
-- column nothing writes is a claim the schema cannot back.
alter table messages drop constraint messages_review_state_check;

alter table messages
  add constraint messages_review_state_check
  check (review_state is null or review_state in (
    'pending',
    'approved',
    'edited',
    'skipped',
    'auto_sent',
    'resolved_externally'
  ));

-- ---------------------------------------------------------------------------
-- 4. list_operator_queue returns the channel, the handle and the window anchor
-- ---------------------------------------------------------------------------
-- DROP + CREATE, not `create or replace`: adding a return column is a
-- return-type change, which Postgres refuses to replace. Both statements are in
-- this transaction so no reader observes a window where the function is
-- missing. Migration 039's header documents this rule; 042 and 054 followed it.
--
-- The body below restates migration 054's verbatim, with only the three new
-- columns added to the return table and the select list, plus one new lateral.
-- Diff it against db/migrations/054_conversation_cards_per_reply.sql rather
-- than reading it as new code.
--
-- `guest_channel` IS THE DRAFT ROW'S OWN CHANNEL, not a property re-derived
-- from the guest, and that is the only correct answer here:
-- dispatchOperatorOutbound routes on the card's channel, so this column is
-- exactly "what approving this card will do". A re-derivation could disagree
-- with the routing and tell the operator the wrong thing about their own tap.
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
  last_guest_action_at timestamptz
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
    window_anchor.last_guest_action_at
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
  where m.review_state = 'pending'
    and m.venue_id = any(venue_ids)
  order by m.created_at asc
  limit 200;
$function$;

-- ---------------------------------------------------------------------------
-- 5. list_operator_conversations returns the same three, resolved per guest
-- ---------------------------------------------------------------------------
-- DROP + CREATE for the same return-type reason. Migration 043 was a
-- `create or replace` because it changed only the body; adding return columns
-- makes this one a drop-and-recreate.
--
-- The body restates migration 043's verbatim, with only the four new columns
-- added to the return table and the select list, plus one new lateral. Diff it
-- against db/migrations/043_operator_conversations_reached_guest.sql.
--
-- THE CHANNEL IS NOT RESOLVED HERE. There is no draft to read it from, so the
-- rule is resolveConversationChannel's (lib/agent/conversation-channel.ts,
-- TAC-495) and this function returns only its INPUTS. Writing that rule a
-- second time in SQL is exactly the drift CLAUDE.md keeps warning about: the
-- guest-with-both-identifiers case is subtle, and two copies of it would agree
-- until the day one changed.
--
-- `guest_has_instagram_id` is a BOOLEAN, not the scoped ID. The resolver needs
-- only presence, and an IGSID carried into a projection is one typo away from
-- the wire, where the Contract does not put it.
drop function if exists public.list_operator_conversations(uuid[]);

create function public.list_operator_conversations(
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
  first_conversation_at timestamptz,
  guest_has_instagram_id boolean,
  instagram_username text,
  last_inbound_channel text,
  last_guest_action_at timestamptz
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
    cd.first_at as first_conversation_at,
    -- TAC-473: the three inputs resolveConversationChannel needs, plus the
    -- handle and the window anchor. `guest_phone` above is the fourth input.
    (g.instagram_scoped_id is not null) as guest_has_instagram_id,
    g.instagram_username,
    inbound_channel.last_inbound_channel,
    window_anchor.last_guest_action_at
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
  left join lateral (
    -- TAC-473: the channel of this guest's newest inbound, whatever it is.
    --
    -- MIRRORS loadLastInboundChannel (lib/agent/last-inbound-channel.ts):
    -- direction='inbound', newest by created_at, no channel filter. It is read
    -- only for a guest who has BOTH identifiers, which is how
    -- resolveConversationChannel decides which conversation they are actually
    -- in. NULL when the guest has never sent anything, which falls back to the
    -- phone number exactly as it did before TAC-469.
    --
    -- created_at, not provider_sent_at: this asks WHICH channel was most
    -- recent, across both, and a Sendblue row has no provider_sent_at at all,
    -- so ordering on it would make every text inbound invisible here.
    select ic.channel as last_inbound_channel
    from messages ic
    where ic.venue_id = lm.venue_id
      and ic.guest_id = lm.guest_id
      and ic.direction = 'inbound'
    order by ic.created_at desc
    limit 1
  ) inbound_channel on true
  left join lateral (
    -- TAC-473: the newest Instagram inbound carrying Meta's own timestamp.
    -- Identical to list_operator_queue's lateral above and to
    -- loadLastGuestActionAt, for the same reason: one deadline, computed the
    -- same way wherever it is shown.
    select max(w.provider_sent_at) as last_guest_action_at
    from messages w
    where w.venue_id = lm.venue_id
      and w.guest_id = lm.guest_id
      and w.direction = 'inbound'
      and w.channel = 'instagram'
      and w.provider_sent_at is not null
  ) window_anchor on true
  order by lm.created_at desc
  limit 200;
$function$;

commit;

-- ============================================================================
-- end of migration
-- ============================================================================
