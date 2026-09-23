-- ============================================================================
-- migration 054: one conversation card per inbound, and the replaced draft
-- ============================================================================
-- TAC-397.
--
-- Three changes, one transaction, deployed together. They must land together
-- because old code must never see the new index without the new columns and
-- the new RPC, and new code must never run against migration 041's index.
--
--   1. messages.replaced_draft_body / replaced_draft_at
--   2. the conversation-slot index is keyed per inbound, not per guest
--   3. list_operator_queue returns the two new columns
--
-- WHY. When a guest sent a second message while their first reply waited for
-- approval, the agent regenerated the waiting draft IN PLACE: migration 041
-- allowed one conversation card per guest, and persistOrRegenQueuedDraft
-- (TAC-264) overwrites that row. Roughly 4 in 10 of those regens answered only
-- the newest message and lost the earlier question (TAC-394 PR 1). Seen live at
-- Le Mil's on 2026-09-18: a guest asked about events at 16:07, complained about
-- a SoFi at 16:10, and the events question was never answered.
--
-- After this migration a guest holds at most one conversation card PER INBOUND
-- MESSAGE, so an unrelated second question gets its own card and the first is
-- untouched. A correction still regenerates in place, and the text it replaced
-- is kept so the operator can compare.
--
-- HIGH-STAKES: touches `messages`.
--
-- ----------------------------------------------------------------------------
-- 1. WHY reply_to_message_id, AND WHY THE coalesce IS LOAD-BEARING
-- ----------------------------------------------------------------------------
-- Postgres partial unique indexes cannot express "at most N rows" — that needs
-- a trigger, heavier than this codebase's established unique-index-plus-catch-
-- 23505 pattern (migrations 020, 034, 041). `reply_to_message_id` is the right
-- key instead: buildOutboundInsert and tryRegenUpdate both set it to the
-- current inbound's id (lib/agent/schedule-and-send.ts), so each of a guest's
-- DISTINCT inbound messages owns at most one conversation card, while a
-- correction's regen moves the column onto the correcting message and keeps
-- the index satisfied by construction.
--
-- The coalesce is NOT cosmetic. NULLs are distinct in a unique index, so a
-- bare `reply_to_message_id` column would give NO uniqueness at all to
-- conversation cards with no inbound — the proactive ones (manual followups,
-- the operator decline, the crash card, engine followups), which is protection
-- migration 041 provides today. Two concurrent manual followups would both
-- INSERT. Folding NULL onto a fixed sentinel restores "at most one
-- proactive conversation card per guest", which is exactly what 041 gave
-- those rows.
--
-- This is the same trick 041's own predicate already uses on
-- `pending_commitment->>'type'`, and for the same reason: without a coalesce a
-- NULL silently opts the row out of the constraint.
--
-- The sentinel is the nil UUID. It can never collide with a real message id:
-- every id is gen_random_uuid() (migration 001), which is v4 and never all
-- zeroes.
--
-- ----------------------------------------------------------------------------
-- 2. THE NEW INDEX CANNOT FAIL TO BUILD
-- ----------------------------------------------------------------------------
-- Migration 041 guarantees at most ONE conversation-slot pending row per
-- (venue_id, guest_id). The new index groups by (venue_id, guest_id,
-- reply-or-sentinel), which is strictly finer, so every group has at most one
-- row before this runs. No backfill, no collision risk, no pre-clean.
--
-- That is why this file creates the new index BEFORE dropping 041's, in one
-- transaction: the table is never without a uniqueness constraint on pending
-- conversation rows, and 041's is strictly stronger while both exist.
--
-- Not CONCURRENTLY, which cannot run inside a transaction. The one-transaction
-- swap matters more than a write lock lasting milliseconds at pilot size.
--
-- The obligation index (idx_messages_one_pending_obligation_per_guest) is
-- UNTOUCHED. TAC-394's protection for comps, holds and discounts is unchanged.
--
-- ----------------------------------------------------------------------------
-- 3. THE TWO NEW COLUMNS
-- ----------------------------------------------------------------------------
-- replaced_draft_body  the text a card held before a CORRECTION regen
-- replaced_draft_at    when that regen happened
--
-- Both nullable, no default, no backfill. NULL on every card that has never
-- been corrected, which is almost all of them, and on every row that predates
-- this migration.
--
-- They are written TOGETHER or not at all: the persist layer sets both or sets
-- both to NULL, overwrite-wholesale on every regen (like pending_commitment
-- and ungrounded_claims, unlike pending_until). A later decline or crash-card
-- regen of the same row therefore clears them rather than leaving a stale
-- correction's text on a card since overwritten for an unrelated reason. No
-- CHECK enforcing the pairing: the write path is the single writer, and a
-- CHECK on the live webhook path buys a failed insert instead of a NULL.
--
-- Ruled 2026-09-22 (question 1): a dedicated column here rather than reusing
-- per-message metadata. TAC-424 established there is no clean existing field
-- (it used review_triggers), so "the same place TAC-424 uses" did not apply.
--
-- ----------------------------------------------------------------------------
-- DEPLOY: apply in Studio BEFORE merging the PR, outside venue hours
-- ----------------------------------------------------------------------------
-- New code must never run against migration 041's index. If it did, every
-- SECOND conversation card would hit 041's per-guest index, race recovery
-- would find the target slot empty and retry, and the turn would end in a red
-- alert with no reply to the guest. It would never overwrite a card, but it
-- would fail exactly the case this ticket exists to fix.
--
-- Schedule OUTSIDE Le Mil's hours, 7am to 3pm America/Los_Angeles (after close
-- or before open). Almost no inbound traffic means almost nothing for old code
-- to race during the window.
--
-- Preconditions:
--   - the PR is approved and CI is green
--   - nobody else merges to main during the window
--   - someone is watching Slack red alerts
--
-- Order:
--   1. Run the three read-only checks below.
--   2. Apply this file.
--   3. Merge within ~2 minutes.
--   4. When both production deploys are ready (analog-guest, and analog-admin,
--      which serves the Command Center Follow Up button), run the detection
--      query below.
--   5. Run `npm run db:types`.
--
-- What OLD code does in the window, once this is applied. Old code knows
-- nothing about per-inbound cards, so it still regenerates the single
-- conversation card in place — the pre-TAC-397 behaviour, no worse than today.
-- The new index is strictly LOOSER than 041's for old code (it permits rows
-- 041 forbade; it forbids nothing 041 allowed), so no old-code write that
-- succeeded before can start failing. This window is materially safer than
-- 041's own was, where the new index pair was looser in a way old code could
-- trip over.
--
-- ----------------------------------------------------------------------------
-- BEFORE APPLYING: three read-only checks
-- ----------------------------------------------------------------------------
--
-- (a) Neither column already exists. Expect 0 rows.
--
--     select column_name
--     from information_schema.columns
--     where table_schema = 'public'
--       and table_name = 'messages'
--       and column_name in ('replaced_draft_body', 'replaced_draft_at');
--
-- (b) 041's conversation index is live and the obligation index is too.
--     Expect exactly these two names.
--
--     select indexname
--     from pg_indexes
--     where schemaname = 'public'
--       and tablename = 'messages'
--       and indexname like 'idx_messages_one_pending_%';
--
-- (c) The live RPC is 044's body, not something applied by hand in Studio.
--     Read it and confirm it matches db/migrations/044 before dropping it.
--     Migration 021's orphaned link_operator_auth is the precedent for not
--     trusting the repo about what is live.
--
--     select pg_get_functiondef('public.list_operator_queue(uuid[])'::regprocedure);
--
--     And confirm there is exactly one overload to drop:
--
--     select oid::regprocedure from pg_proc where proname = 'list_operator_queue';
--
-- ----------------------------------------------------------------------------
-- AFTER BOTH DEPLOYS ARE READY: detection query
-- ----------------------------------------------------------------------------
-- Guests holding more than one pending conversation card. Expect this to be
-- EMPTY before the new code deploys and NON-EMPTY afterwards once a guest
-- sends two questions in a row. It is the signal the feature is live, not an
-- alarm.
--
--     select venue_id, guest_id, count(*) as conversation_cards
--     from messages
--     where review_state = 'pending'
--       and coalesce(pending_commitment->>'type', '') not in ('comp', 'hold', 'discount')
--     group by venue_id, guest_id
--     having count(*) > 1
--     order by count(*) desc;
--
-- A row where two cards share a reply_to_message_id is impossible while the
-- index is live; if one appears, the index is gone.
--
-- ----------------------------------------------------------------------------
-- ROLLBACK
-- ----------------------------------------------------------------------------
-- Roll back only when BOTH hold: the new code is NOT live 30 minutes after
-- applying, AND the detection query above returns no rows.
--
-- If it returns rows, FIX FORWARD. Recreating 041's index needs every guest
-- collapsed to one conversation card by hand, and the transaction below aborts
-- harmlessly on the duplicate anyway.
--
-- The rollback drops two columns that new code SELECTs, so it is only for
-- undoing this migration cleanly before that code is live.
--
-- ORDER MATTERS, and the first step is the one that is easy to skip.
--
-- A SQL-language function's body is a STRING and carries no column
-- dependencies, so `drop column replaced_draft_body` succeeds while 054's
-- function is still selecting it. Commit that and every operator queue read
-- fails at call time — the rollback would leave the queue more broken than
-- the thing being rolled back. So the function is restored FIRST, and it is
-- restored by pasting migration 044's body in, not by remembering to.
--
--   begin;
--
--   -- STEP 1, FIRST AND NOT OPTIONAL: restore migration 044's function.
--   -- Copy the whole `drop function ... create function ... $function$;`
--   -- block verbatim out of
--   -- db/migrations/044_operator_queue_context_reached_guest.sql and paste it
--   -- here. It is a DROP + CREATE for the same return-type reason as the
--   -- forward migration below. Do not hand-edit 054's body down; take 044's.
--
--   -- STEP 2: restore migration 041's conversation index, before dropping
--   -- this migration's, so the table is never unguarded.
--   create unique index idx_messages_one_pending_conversation_per_guest
--     on messages (venue_id, guest_id)
--     where review_state = 'pending'
--       and coalesce(pending_commitment->>'type', '') not in ('comp', 'hold', 'discount');
--
--   drop index idx_messages_one_pending_conversation_per_guest_reply;
--
--   -- STEP 3: only now are the columns unreferenced.
--   alter table messages
--     drop column replaced_draft_body,
--     drop column replaced_draft_at;
--
--   commit;
--
-- Step 2 ABORTS if any guest already holds two pending conversation cards,
-- which is the detection query's own signal and the reason the precondition
-- above says to check it first. That abort is harmless: the transaction rolls
-- back whole and nothing is half-restored.
--
-- ============================================================================

begin;

-- Take the lock on `messages` up front, under a short timeout, so a busy table
-- fails this migration cleanly rather than queueing behind live traffic.
-- Migrations 048 and 049 set the same precedent on this table.
set local lock_timeout = '5s';

-- ---------------------------------------------------------------------------
-- 1. the replaced draft
-- ---------------------------------------------------------------------------
alter table messages
  add column replaced_draft_body text,
  add column replaced_draft_at timestamptz;

comment on column messages.replaced_draft_body is
  'TAC-397: the body this pending draft held before a CORRECTION regen overwrote it, so the operator can compare. Written with replaced_draft_at or not at all; cleared on any regen that is not a correction. NULL on every card that has never been corrected.';

comment on column messages.replaced_draft_at is
  'TAC-397: when replaced_draft_body was captured. Paired with it by the write path, not by a CHECK.';

-- ---------------------------------------------------------------------------
-- 2. one conversation card per inbound
-- ---------------------------------------------------------------------------
-- Created BEFORE the drop so the table is never without a uniqueness
-- constraint on pending conversation rows. 041's is strictly stronger while
-- both exist, so this build cannot fail (see the header).
--
-- The type list here and OBLIGATION_TYPES (lib/guests/commitment-expiry.ts)
-- MOVE TOGETHER: pending-slots.test.ts reads this file and fails if they
-- differ. The SQL cannot import the constant, so that test is the only thing
-- keeping the two in step.
create unique index idx_messages_one_pending_conversation_per_guest_reply
  on messages (
    venue_id,
    guest_id,
    coalesce(reply_to_message_id, '00000000-0000-0000-0000-000000000000'::uuid)
  )
  where review_state = 'pending'
    and coalesce(pending_commitment->>'type', '') not in ('comp', 'hold', 'discount');

drop index idx_messages_one_pending_conversation_per_guest;

-- ---------------------------------------------------------------------------
-- 3. list_operator_queue returns the replaced draft
-- ---------------------------------------------------------------------------
-- DROP + CREATE, not `create or replace`: adding a return column is a
-- return-type change, which Postgres refuses to replace. Both statements are
-- in this transaction so no reader observes a window where the function is
-- missing. Migration 039's header documents this rule and migration 042
-- followed it.
--
-- The body below restates migration 044's verbatim, with only the two new
-- columns added to the return table and the select list. Diff it against
-- db/migrations/044_operator_queue_context_reached_guest.sql rather than
-- reading it as new code.
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
  replaced_draft_at timestamptz
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
    m.replaced_draft_at
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
  where m.review_state = 'pending'
    and m.venue_id = any(venue_ids)
  order by m.created_at asc
  limit 200;
$function$;

commit;

-- ============================================================================
-- end of migration
-- ============================================================================
