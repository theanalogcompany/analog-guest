-- TAC-476: derive each guest's last activity from `messages`, and say so on
-- the three columns that only ever recorded first contact.
--
-- ----------------------------------------------------------------------------
-- WHY DERIVE RATHER THAN KEEP THE COLUMNS CURRENT
-- ----------------------------------------------------------------------------
-- `guests.last_inbound_at` and `last_interaction_at` are written at guest
-- creation and never again; `last_outbound_at` has never been written by
-- anything. So all three record first contact, and on 35 of the 36 rows on
-- file they hold the same value as `first_contacted_at`, to the millisecond,
-- because one insert sets all of them from the same `nowIso`.
--
-- Their two readers are the follow-up engine's recent-conversation gate
-- (lib/agent/followup-rules.ts, fed from lib/followups/engine.ts) and the
-- Command Center conversations dropdown. The gate has failed OPEN three times
-- in production, dispatching 1.7, 4.5 and 6.4 hours after the guest's real
-- previous inbound. Twenty of the thirty-five scannable guests carry NULL,
-- where the gate short-circuits and rule 3 never runs at all — one of them has
-- 122 inbound messages.
--
-- The obvious repair is to write the columns on every send and receive. That
-- was rejected (ruled 2026-09-20): it needs six write sites, every one of them
-- on a live path, on handlers that log-and-return-200 on failure. A silently
-- failed UPDATE there reintroduces this exact defect invisibly, which is the
-- failure this ticket exists to remove — a fix that can fail the same way the
-- original did is not a fix. It would also need a backfill, and per-column
-- forward-only guards, because a delayed inbound webhook that correctly
-- advances `last_inbound_at` would drag `last_interaction_at` BACKWARDS past a
-- newer outbound under a single shared guard.
--
-- Deriving touches no send or receive path, is correct for every existing row
-- including the NULLs on the day it ships, needs no backfill, and cannot
-- drift. Precedent in this repo: TAC-469 computes Instagram's 24-hour reply
-- window from message rows; app/api/cron/webhook-silence derives its own last
-- inbound the same way; `count_outbound_responses` (migration 032) derives a
-- count rather than storing one.
--
-- ----------------------------------------------------------------------------
-- ONE FUNCTION, TWO READERS
-- ----------------------------------------------------------------------------
-- Both readers take from this function, so "when was this guest last active"
-- is defined once and the two cannot disagree. The engine reads
-- `last_inbound_at`; the conversations dropdown orders on
-- `last_interaction_at`.
--
-- `last_interaction_at` is `max(created_at)` over BOTH directions, which is
-- what the name has always claimed and has never been true: its reader asks it
-- for recent activity and has been given enrollment date.
--
-- `created_at` is our receipt time, deliberately, NOT `provider_sent_at`.
-- Instagram rows carry Meta's own clock (TAC-479) and Sendblue rows never do,
-- so ordering on it would sort the two channels on different clocks. TAC-469's
-- window gate reads `provider_sent_at` because Meta enforces the window on
-- Meta's clock; nothing here is enforced by a provider.
--
-- EVERY row counts: no `body <> ''`, no status filter, no review_state filter.
-- A photo-only text with an empty body is still the guest making contact; an
-- outbound row that failed to send is still the venue having tried; a pending
-- draft is a card an operator is holding on this conversation. The deliberate
-- choice is not to import the reached-guest condition (migrations 043/044)
-- here: that list exists so operator-facing reads show only what the guest
-- actually received, and tying a follow-up suppression rule and a dropdown
-- sort order to it would couple them to a delivery-status list maintained for
-- a different purpose.
--
-- What that means per reader, stated rather than left to be inferred:
--   - the gate reads `last_inbound_at` only, so none of the above can reach
--     it; inbound rows have no review_state and no failed sends.
--   - the conversations dropdown orders on `last_interaction_at`, and that
--     viewer's contract is show-everything (TAC-316) — a guest with a pending
--     card is exactly who an operator wants near the top of the list.
--
-- ----------------------------------------------------------------------------
-- ORDERING
-- ----------------------------------------------------------------------------
-- HIGH-STAKES by the 043/044 precedent: it reads `messages`. Additive — a new
-- function, nothing altered and nothing dropped — but deployed code calls it,
-- so APPLY IN STUDIO BEFORE MERGING. Applying it early is harmless: nothing
-- calls it until the deploy lands.
--
-- `create or replace` is correct for a first version. A later change to the
-- RETURN TYPE (adding a column) must DROP and CREATE inside one transaction,
-- per migration 039's gotcha; a body-only change may use `create or replace`.
--
-- `db/types.ts` is hand-patched in the same commit (RPCs surface under
-- `Functions`) until `npm run db:types` runs post-apply.
--
-- ----------------------------------------------------------------------------
-- COLUMN COMMENTS
-- ----------------------------------------------------------------------------
-- The three columns stay for now — removing them means editing the Sendblue
-- webhook handler, which is the hard-stop tier this ticket otherwise avoids.
-- TAC-503 removes them. Until then a comment on each is the mitigation, so the
-- next person to read the schema is not misled the way this ticket's readers
-- were. A column that looks live and is not is a trap this repo has paid for
-- three times (`guests.is_test_synthetic`, `venue_configs.approval_policy`'s
-- 102 unread days, and the `future-add safety` test that asserted its own
-- opposite).

begin;

-- ----------------------------------------------------------------------------
-- 1. the function
-- ----------------------------------------------------------------------------

create or replace function public.venue_guest_activity(p_venue_id uuid)
returns table (
  guest_id uuid,
  last_inbound_at timestamptz,
  last_outbound_at timestamptz,
  last_interaction_at timestamptz
)
language sql
stable
as $$
  select
    m.guest_id,
    max(m.created_at) filter (where m.direction = 'inbound') as last_inbound_at,
    max(m.created_at) filter (where m.direction = 'outbound') as last_outbound_at,
    max(m.created_at) as last_interaction_at
  from messages m
  where m.venue_id = p_venue_id
  group by m.guest_id;
$$;

comment on function public.venue_guest_activity(uuid) is
  'TAC-476: each guest''s last inbound, last outbound and last activity at this '
  'venue, derived from messages.created_at. Replaces guests.last_inbound_at / '
  'last_outbound_at / last_interaction_at, which only ever recorded first '
  'contact. Counts every message row, pending drafts and failed sends '
  'included. Read by lib/followups/engine.ts (the recent-conversation gate) '
  'and the Command Center conversations dropdown.';

-- ----------------------------------------------------------------------------
-- 2. mark the three columns (TAC-503 removes them)
-- ----------------------------------------------------------------------------

comment on column guests.last_inbound_at is
  'DO NOT READ. Written once at guest creation and never updated, so it holds '
  'first contact, not last inbound. Read by nothing as of TAC-476; use '
  'venue_guest_activity(p_venue_id). Removal: TAC-503.';

comment on column guests.last_outbound_at is
  'DO NOT READ. Never written by anything, since migration 001. Read by '
  'nothing; use venue_guest_activity(p_venue_id). Removal: TAC-503.';

comment on column guests.last_interaction_at is
  'DO NOT READ. Written once at guest creation and never updated, so it holds '
  'first contact, not last interaction — it equals first_contacted_at on every '
  'row but one. Read by nothing as of TAC-476; use '
  'venue_guest_activity(p_venue_id). Removal: TAC-503.';

commit;

-- ----------------------------------------------------------------------------
-- VERIFICATION (run after applying, before merging)
-- ----------------------------------------------------------------------------
--
-- 1. The function exists with the expected signature and returns rows:
--
--      select * from venue_guest_activity(
--        (select id from venues where slug = 'le-mils-coffee')
--      ) order by last_interaction_at desc;
--
-- 2. It disagrees with the stored columns, which is the whole point. Every
--    row this returns should be >= the stored value, and the NULL-column
--    guests should now have one:
--
--      select g.id, g.last_inbound_at as stored, a.last_inbound_at as derived
--      from guests g
--      join venue_guest_activity(g.venue_id) a on a.guest_id = g.id
--      where g.venue_id = (select id from venues where slug = 'le-mils-coffee')
--      order by a.last_inbound_at desc nulls last;
--
-- 3. The comments are visible:
--
--      select column_name, col_description('guests'::regclass, ordinal_position)
--      from information_schema.columns
--      where table_name = 'guests'
--        and column_name in
--          ('last_inbound_at', 'last_outbound_at', 'last_interaction_at');
--
-- 4. POSTGREST CAN SEE IT. The three checks above are SQL-level and all pass
--    against a stale PostgREST schema cache, which answers the APP with
--    PGRST202 ("could not find the function"). The two callers fail
--    differently on that, so it is worth one explicit check: the engine gets
--    `activityResult.error` and refuses to scan the venue (loud, no sends),
--    while the conversations dropdown silently falls back to an arbitrary
--    order that looks like a working list. Either reload the cache
--    (`notify pgrst, 'reload schema';`) or hit it once:
--
--      curl -s -X POST "$SUPABASE_URL/rest/v1/rpc/venue_guest_activity" \
--        -H "apikey: $KEY" -H "Authorization: Bearer $KEY" \
--        -H 'Content-Type: application/json' \
--        -d '{"p_venue_id":"<venue-uuid>"}'
--
-- ----------------------------------------------------------------------------
-- ROLLBACK
-- ----------------------------------------------------------------------------
-- Only for undoing this migration cleanly before the code that calls it is
-- live. Afterwards the engine's venue scan fails for every venue, which means
-- no follow-ups are sent — the safe direction, but not a state to sit in.
--
--   drop function if exists public.venue_guest_activity(uuid);
--   comment on column guests.last_inbound_at is null;
--   comment on column guests.last_outbound_at is null;
--   comment on column guests.last_interaction_at is null;
