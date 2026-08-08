-- ============================================================================
-- 032_message_splitting_generation_id.sql
-- TAC-313 — message splitting: let replies arrive as multiple messages
-- ============================================================================
--
-- A single agent generation may now be dispatched as up to three separate
-- Sendblue messages ("bubbles"). Each bubble gets its own `messages` row —
-- forced by evidence, not preference: the Sendblue status webhook looks up
-- rows by `provider_message_id` and each send returns its own handle, so one
-- row for two bubbles would leave the second bubble's delivery status with
-- nowhere to land.
--
-- This migration adds the grouping key those rows share, drops a dead column
-- that would otherwise sit beside it as a second plausible source of truth,
-- and moves the two SQL surfaces that count message ROWS onto counting
-- RESPONSES.
--
-- ── HIGH-STAKES: touches `messages`. ───────────────────────────────────────
--
-- ── ORDERING: apply in Studio BEFORE merging the PR. ───────────────────────
--
-- This file contains a DROP COLUMN, which the *Database migrations* §"Ordering
-- for backwards-incompatible migrations" heuristic says to apply AFTER merge.
-- That rule does not bind here, and the reason is worth stating so the next
-- reader doesn't re-derive it: the rule exists because deployed code queries a
-- schema that no longer exists. `messages.parent_draft_id` has ZERO readers and
-- ZERO writers in app code (verified by grep across the repo — the only
-- reference is the generated `db/types.ts`, which is compile-time). Nothing can
-- 500 on its absence, so the drop is backwards-incompatible on paper and inert
-- in practice. The ADD half is what sets the real ordering: the deployed code
-- SELECTs `generation_id`, so Studio must run first. Same posture as migrations
-- 025 / 027 / 028.
--
-- ── NO BACKFILL, deliberately. ─────────────────────────────────────────────
--
-- Legacy rows keep `generation_id = null`. Every consumer — the two functions
-- below and the TS projection in `lib/agent/build-runtime-context.ts` — uses
-- the same grouping identity:
--
--     coalesce(generation_id, id)
--
-- Split bubbles share a generation_id and group together; every other row
-- (legacy outbound, inbound, single-bubble replies, queue drafts) is its own
-- group via its own primary key. That expression is exact for historical data
-- with no data migration, and it is why the three call sites agree by
-- construction rather than by discipline.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- 1. generation_id — the response grouping key
-- ----------------------------------------------------------------------------
--
-- Plain indexed uuid, NOT a self-referencing FK. A self-FK would make the
-- first bubble's value null (it points at nothing) and every later bubble
-- point at it, so grouping would need a null special case at each read site.
-- A plain uuid stamped identically on every bubble is symmetric: all rows in
-- a response carry the same value, including the first.
--
-- Minted fresh per dispatch in `scheduleAndSend`. Deliberately NOT reusing
-- `agentRunId`: the Langfuse link already lives on `messages.langfuse_trace_id`,
-- so this column does not need to carry it, and coupling the two would mean
-- any future case where one agent run dispatches twice silently merges two
-- responses into one group.

alter table messages add column generation_id uuid;

-- Partial: the column is null for every pre-TAC-313 row and for inbound rows,
-- so a full index would be mostly dead weight. Matches the partial-index
-- convention from migrations 022 / 024.
create index idx_messages_generation_id
  on messages (generation_id)
  where generation_id is not null;


-- ----------------------------------------------------------------------------
-- 2. drop the dead parent_draft_id
-- ----------------------------------------------------------------------------
--
-- Added in migration 001, indexed, self-referencing FK — and never read or
-- written by any code in the four years since. It is exactly the shape a
-- grouping key wants, which is precisely the problem: leaving it beside
-- `generation_id` creates two plausible sources of truth for the same
-- behavior. That is the `venue_configs.approval_policy` trap CLAUDE.md already
-- documents (a column that looked like where a setting belonged, sat unread
-- fleet-wide for 102 days, and misled anyone who reasoned from its name).
--
-- Not reused for the grouping key either: a column named `parent_draft_id`
-- holding generation grouping is a naming lie that costs the next reader an
-- hour.
--
-- The explicit index drop is redundant (DROP COLUMN cascades to indexes and
-- to the self-FK constraint) and kept for legibility.

drop index if exists idx_messages_parent_draft;

alter table messages drop column parent_draft_id;


-- ----------------------------------------------------------------------------
-- 3. count_outbound_responses — response-grained count for recognition
-- ----------------------------------------------------------------------------
--
-- `lib/recognition/load-signals.ts` counted outbound ROWS into
-- `normalizeResponseRate(replied, sent) = replied / sent`, weighted 0.10 in
-- `computeRelationshipStrength`. Splitting inflates that denominator ONLY —
-- the guest's replies don't multiply — so without this a venue whose agent
-- splits would watch its guests drift downward out of `regular` with no change
-- in guest behavior. That is not a display bug; it changes who the product
-- treats as a regular, silently.
--
-- COUNT(DISTINCT ...) has no PostgREST expression, hence an RPC. Called with
-- the service-role admin client from the agent runtime, so no GRANT is needed
-- — same posture as `list_operator_queue` (migration 018).
--
-- The status filter is carried over verbatim from the query this replaces.

create or replace function public.count_outbound_responses(
  p_venue_id uuid,
  p_guest_id uuid
)
returns bigint
language sql
stable
as $function$
  select count(distinct coalesce(generation_id, id))
  from messages
  where venue_id = p_venue_id
    and guest_id = p_guest_id
    and direction = 'outbound'
    and status in ('sent', 'delivered');
$function$;


-- ----------------------------------------------------------------------------
-- 4. list_operator_queue — recent_context returns three RESPONSES, not rows
-- ----------------------------------------------------------------------------
--
-- Replaces the migration-018 definition. ONLY the `ctx` lateral changes;
-- everything else is byte-identical, reproduced in full because
-- CREATE OR REPLACE FUNCTION requires the whole body.
--
-- Previously the inner `limit 3` bounded on rows, so one three-bubble reply
-- would consume all three context slots and the operator card would show the
-- venue talking to itself with none of the guest's own message.
--
-- The fix MERGES each response into a single entry rather than returning all
-- the bubbles of three responses. That keeps the array at <= 3 entries, which
-- matters because `QueueRecentContextEntry` is a cross-repo shape consumed by
-- analog-operator: widening the cardinality to <= 9 while multi-bubble card
-- rendering is explicitly out of scope would be a silent Contract change of
-- exactly the kind §"Cross-repo contracts" exists to prevent. Same shape, same
-- cardinality, now response-grained.
--
-- Merged entry semantics:
--   id         — the FIRST bubble's real message id, so it stays a valid handle
--   direction  — the first bubble's (all bubbles in a group share it)
--   body       — bubbles joined with a single space, reconstructing the turn
--                as one thing said; btrim guards the blank-body case
--                (TAC-309 knowledge-gap cards persist with body = '')
--   createdAt  — min(created_at), i.e. when the venue started replying
--
-- Ordering note, considered and accepted: group selection orders by
-- min(created_at), so a response is placed by when the venue STARTED replying.
-- If a guest texts BETWEEN two bubbles of a split reply, their message sorts
-- after the venue's response even though the second bubble landed later. That
-- requires replying inside the ~1-2s inter-bubble gap, so it is near
-- unreachable, and min() is the right value for the displayed createdAt
-- regardless. Recorded so the next reader knows it was weighed, not missed.

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
    -- TAC-313: the inner query groups by response and takes the 3 most recent
    -- RESPONSES; the outer jsonb_agg flattens them most-recent-first. The
    -- draft row itself is excluded (id <> m.id) — safe against splitting a
    -- group, because queue drafts are always single-row (migration 020's
    -- partial unique index permits at most one pending draft per guest).
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
      group by coalesce(generation_id, id)
      order by min(created_at) desc
      limit 3
    ) r
  ) ctx on true
  where m.review_state = 'pending'
    and m.venue_id = any(venue_ids)
  order by m.created_at asc
  limit 200;
$function$;


-- ============================================================================
-- end of migration
-- ============================================================================
