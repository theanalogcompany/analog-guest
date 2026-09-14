-- TAC-364: tell the operator card why a message is held.
--
-- TWO nullable text[] columns on `messages`, plus a recreate of
-- `list_operator_queue` to return them.
--
-- WHY TWO COLUMNS AND NOT ONE:
--   review_triggers    — the FULL trigger set from applyApprovalPolicyStage.
--                        `review_reason` keeps holding the priority-selected
--                        primary; this holds everything that fired, primary
--                        included. Before this, a comp commitment that was
--                        ALSO below the auto-send fidelity floor reached the
--                        operator labelled only "Commitment requires approval"
--                        and the second condition was unrecoverable — triggers[]
--                        lived in memory and in a PostHog payload, nowhere else.
--   ungrounded_claims  — the verbatim claims verifyGroundingStage's verifier
--                        flagged. Same story: computed, sent to PostHog and
--                        Langfuse, then discarded at exactly the point it would
--                        be useful. TAC-301 part 1.5 stopped blanking the body
--                        on a backstop catch (blanking destroyed two CORRECT
--                        replies in production within two minutes of deploy),
--                        which made a one-swipe bad approval possible for the
--                        first time. The operator now sees a fluent draft and a
--                        generic label with no way to know which sentence is
--                        the suspect one. This column is that way.
--
--                        THREE-STATE, deliberately: non-empty = flagged these,
--                        empty = the check ran and found nothing, NULL = the
--                        check did not run. See the column comment below. The
--                        empty-vs-NULL split is not incidental — TAC-367 was
--                        filed because a silently-skipped grounding check was
--                        invisible everywhere, and conflating the two would
--                        have rebuilt that blind spot in a new column on its
--                        first day. `review_triggers` has no equivalent split
--                        because the gate returns `send` when nothing fires,
--                        so a queued draft's trigger set is never empty.
--
-- `messages.response_review` was the no-migration alternative and was REJECTED
-- (TAC-364 §"The flagged claim: RPC, not response_review"): that column means
-- "a human reviewed this", and `getReviewedVia` plus the cc-review and
-- mobile-operator consumers all read it on that basis. Writing agent output
-- into it produces a field nobody can interpret later.
--
-- NO BACKFILL, deliberately. A null `review_triggers` beside a non-null
-- `review_reason` means "recorded before this shipped" and the client renders
-- it exactly as it does today (the projection maps null → []). Inventing a
-- single-element array from `review_reason` would be a lie of a different kind:
-- it would claim the primary was the ONLY trigger, which is precisely the
-- thing this column exists to stop assuming.
--
-- ----------------------------------------------------------------------------
-- WHY THE RPC IS DROPPED AND RECREATED RATHER THAN `create or replace`
-- ----------------------------------------------------------------------------
-- Adding a column to a `returns table(...)` IS a return-type change, and
-- Postgres refuses it outright:
--
--   ERROR:  cannot change return type of existing function
--   HINT:   Use DROP FUNCTION list_operator_queue(uuid[]) first.
--
-- Migration 032 got away with `create or replace` because it changed only the
-- BODY (the `ctx` lateral), not the signature. This one changes the signature,
-- so the drop is mandatory rather than stylistic.
--
-- The whole file runs in ONE transaction so no reader ever observes a window
-- where the function does not exist. Postgres DDL is transactional; a
-- concurrent `list_operator_queue` call blocks on the lock and then sees the
-- new definition. Without the explicit transaction the drop and the create are
-- two statements and a queue read landing between them fails with
-- "function does not exist" — a 500 on the operator's queue, which is the
-- exact downtime window §"Ordering for backwards-incompatible migrations"
-- exists to prevent.
--
-- ----------------------------------------------------------------------------
-- ORDERING: apply in Studio BEFORE merging the PR.
-- ----------------------------------------------------------------------------
-- Additive in shape (two nullable columns, no constraint change, no enum
-- change), but the deployed code SELECTs both columns through the RPC, so the
-- schema has to land first. Same call migrations 025 / 026 / 034 / 035 / 036 /
-- 038 made. HIGH-STAKES: touches `messages`.
--
-- db/types.ts is hand-patched in the same commit (the two columns on
-- messages Row/Insert/Update, and the two fields on the RPC's Returns) until
-- `npm run db:types` runs post-apply.

-- ----------------------------------------------------------------------------
-- BEFORE APPLYING: verify what is LIVE, not what is in this repo.
-- ----------------------------------------------------------------------------
-- The DROP below replaces whatever definition Postgres currently holds, which
-- is not necessarily the one in migration 032. This repo has been bitten by
-- Studio-only SQL objects before — migration 021 dropped an orphan
-- `link_operator_auth` that existed in Studio with zero call sites in app
-- code, and CLAUDE.md draws the explicit lesson that "the same risk applies to
-- SQL functions". Migration 034 set the precedent of re-verifying against live
-- catalog state immediately before applying. Two queries, both read-only:
--
--   -- 1. Confirm the live body matches migration 032 (only the `ctx` lateral
--   --    should differ from 018). If it does NOT, stop: someone edited this
--   --    function in Studio and that edit is about to be discarded.
--   select pg_get_functiondef('public.list_operator_queue(uuid[])'::regprocedure);
--
--   -- 2. Confirm there is exactly ONE overload. `drop ... if exists (uuid[])`
--   --    silently no-ops against a different signature, which would leave the
--   --    old function live and the new one never created.
--   select oid::regprocedure from pg_proc where proname = 'list_operator_queue';
--
-- No GRANT/REVOKE to re-issue on this one: `list_operator_queue` is called
-- only through the service-role admin client, and the sole grant statements
-- anywhere in db/migrations are migration 023's on `link_operator_auth`.
-- Verify rather than assume if that ever changes — DROP FUNCTION discards
-- grants along with the function.

begin;

-- ----------------------------------------------------------------------------
-- 1. The two columns
-- ----------------------------------------------------------------------------

alter table messages add column review_triggers text[];
alter table messages add column ungrounded_claims text[];

comment on column messages.review_triggers is
  'TAC-364: full approval-trigger set for this draft, primary included. '
  'messages.review_reason holds the priority-selected primary only. '
  'NULL means the row predates TAC-364, not that no triggers fired.';

comment on column messages.ungrounded_claims is
  'TAC-364: verbatim claims flagged by the grounding verifier '
  '(lib/ai/verify-grounding.ts). THREE-STATE: a non-empty array is what it '
  'flagged; empty means the check RAN and found nothing; NULL means the check '
  'DID NOT RUN (followup, demo guest, model self-reported a gap, an unreadable '
  'truncated verdict) or the row predates TAC-364. The empty-vs-NULL '
  'distinction is deliberate — TAC-367 was filed because a silently-skipped '
  'grounding check was invisible everywhere, and this column is where that is '
  'now answerable. Caveat inherited from TAC-367: a TRANSIENT verifier fault '
  'fails open and records as empty, not NULL.';

-- No index on either. Both are read only via `list_operator_queue`, which is
-- already bounded by the migration-018 partial index on
-- (venue_id, created_at) WHERE review_state='pending' and capped at 200 rows;
-- neither column is ever a filter or a join key.

-- ----------------------------------------------------------------------------
-- 2. list_operator_queue — two new return columns
-- ----------------------------------------------------------------------------
--
-- Replaces the migration-032 definition. ONLY the two added columns differ:
-- `review_triggers` and `ungrounded_claims` join `returns table(...)` and the
-- select list, positioned next to `review_reason` since they describe the same
-- thing. Everything else — the guest_states lateral, the TAC-313
-- response-grained `ctx` lateral, the where clause, the 200-row cap — is
-- reproduced verbatim from 032, because a full recreate has to restate the
-- whole body and there is nothing else to change in it.

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
    m.review_triggers,
    m.ungrounded_claims,
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

commit;


-- ============================================================================
-- end of migration
-- ============================================================================
