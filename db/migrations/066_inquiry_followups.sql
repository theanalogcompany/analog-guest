-- TAC-386: the follow-up that checks our answer worked out.
--
-- A guest asks something our answer helps them DO afterwards (where to park,
-- which beans, how to brew it, whether the dog can come, what to try). We
-- answer normally. A few hours later, inside Instagram's 24-hour window, we
-- check that it worked out. It never asks or asserts whether they came in.
--
-- WHY A TABLE, where TAC-560 needed only a column. The warm close derives its
-- due set from `messages`, because the event it waits on IS our own last
-- outbound row. Here the event is a CLASSIFIER VERDICT on one inbound
-- (`followUpWorthy`), which no row records, and the due moment is computed from
-- the venue's hours at ask time. That is TAC-536's situation, so it gets
-- TAC-536's answer: one small table keyed on the triggering message.
--
-- THREE OBJECTS, so locks are taken up front with `messages` FIRST under
-- lock_timeout (db/migrations/CLAUDE.md). Creating this table takes a lock on
-- every table it references, and altering `guests` before `messages` can
-- deadlock with an inbound webhook, which holds `messages` and then needs
-- `guests` for its FK check. That route answers 200 on failure, so the guest's
-- message would be lost silently. A busy table makes this fail cleanly instead.
--
-- APPLY IN STUDIO BEFORE MERGING, then run `npm run db:types`. Additive, but
-- the deployed code inserts into this table on the next qualifying inbound and
-- the cron route reads it a minute later, and both answer 200 whatever happens
-- inside them. A missing table surfaces as a mechanism that silently arms
-- nothing, not as an error anyone sees. Apply outside the pilot venue's
-- opening hours.
--
-- `guests` and `followup_log` are NOT on the high-stakes list (messages,
-- engagement_events, voice_corpus); `messages` is referenced by two FKs and is
-- not altered. So this is standard care rather than a hard stop.

begin;

set local lock_timeout = '5s';

-- `messages` first, then the rest, for the deadlock reason in the header. Taken
-- at ACCESS EXCLUSIVE rather than the weaker mode each statement below actually
-- needs, because one predictable order is worth more than the few milliseconds
-- a narrower mode would save at pilot size.
lock table messages, guests, venues, followup_log in access exclusive mode;

-- ----------------------------------------------------------------------------
-- 1. the armed-question table
-- ----------------------------------------------------------------------------

create table inquiry_followups (
  id uuid primary key default gen_random_uuid(),
  venue_id uuid not null references venues(id) on delete cascade,
  guest_id uuid not null references guests(id) on delete cascade,

  -- the inbound that armed this. ON DELETE CASCADE rather than SET NULL: with
  -- the question row gone there is nothing to follow up ON, and the unique
  -- index below is what makes the follow-up once-per-question, so a NULL here
  -- would also silently un-guard that.
  source_message_id uuid not null references messages(id) on delete cascade,

  -- the guest's own words, stored at arm time. Kept verbatim because the
  -- follow-up has to reference the specific thing they asked and no paraphrase
  -- survives the round trip. NOT the answer: see comment on the table below.
  question text not null,

  -- Meta's clock for the guest's action (`messages.provider_sent_at`), not our
  -- webhook's receive time. `window_closes_at` is that plus 24 hours, stored so
  -- the dispatch-time skip does not have to re-derive it from a row that may
  -- since have been superseded.
  asked_at timestamptz not null,
  window_closes_at timestamptz not null,

  -- when to send, computed from the venue's hours at arm time and re-checked at
  -- dispatch. A few hours after the question; if that lands while closed, a few
  -- hours into the next open period (ruled 2026-09-30, option A).
  due_at timestamptz not null,

  -- 'pending'   armed, not yet attempted
  -- 'dispatched' generated and either sent or carded. Terminal: the trigger has
  --              fired once, whatever an operator later does with the card.
  -- 'skipped'   a gate said never (opted out, they wrote again, no answer ever
  --             reached them, the weekly cap, a category we do not follow up on)
  -- 'expired'   the 24-hour window shut, or it sat past its own horizon
  --
  -- `'pending'` IS in this CHECK and is also the column default. Postgres does
  -- NOT validate a default against the column's own CHECK (migration 046's
  -- trap: `messages.status` carried `default 'pending'` against a CHECK that
  -- never permitted it, on adjacent lines, for months), so this pairing is not
  -- safe to assume from the fact that it is written here.
  status text not null default 'pending'
    check (status in ('pending', 'dispatched', 'skipped', 'expired')),

  -- which gate said no, for the QA join. Free text rather than a CHECK: the
  -- reason set lives in the processor's own union and a CHECK here would be a
  -- second copy of it that drifts.
  skip_reason text,

  -- the outbound row the follow-up became. ALSO READ BY THE WARM CLOSE: TAC-560
  -- excludes a message listed here from its candidate scan, so a follow-up
  -- three hours out cannot open a fresh two-hour warm-close window. See
  -- lib/agent/warm-close-store.ts.
  dispatched_message_id uuid references messages(id) on delete set null,
  dispatched_at timestamptz,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table inquiry_followups is
  'TAC-386: one row per inbound the classifier marked followUpWorthy, carrying the guest''s question and the venue-hours-derived moment to check that our answer worked out. The answer itself is NOT stored: it is read at dispatch from the outbound that replied to source_message_id, so an operator-edited card is reflected rather than a stale copy.';

-- Once per question, structurally. The processor also checks, but this is what
-- makes it true under two ticks landing together.
create unique index idx_inquiry_followups_source
  on inquiry_followups (source_message_id);

-- ONE PENDING PER GUEST AT A TIME (ruled 2026-09-30): a regular who asks
-- something every visit does not get a check-in every visit. A partial unique
-- index rather than a check-then-act in the scheduler, because the scheduler
-- runs inside a fire-and-forget waitUntil where two inbounds seconds apart can
-- both pass a read before either writes.
--
-- `guest_id` is NOT NULL, so this needs no coalesce() sentinel; the NULLs-are-
-- distinct trap that migrations 041 and 054 work around does not apply.
create unique index idx_inquiry_followups_one_pending_per_guest
  on inquiry_followups (guest_id) where status = 'pending';

-- the every-minute due scan
create index idx_inquiry_followups_due
  on inquiry_followups (due_at) where status = 'pending';

-- the closure scan, and the warm close's anchor-exclusion lookup
create index idx_inquiry_followups_dispatched
  on inquiry_followups (guest_id) where status = 'dispatched';
create index idx_inquiry_followups_dispatched_message
  on inquiry_followups (dispatched_message_id)
  where dispatched_message_id is not null;

-- reuses the shared set_updated_at() from migration 001.
create trigger trg_inquiry_followups_updated_at
  before update on inquiry_followups
  for each row execute function set_updated_at();

-- ----------------------------------------------------------------------------
-- 2. the proactive-send spacing marker
-- ----------------------------------------------------------------------------

-- Ruled 2026-09-30: a guest never gets two proactive messages close together.
-- Three mechanisms can now reach a guest with no inbound behind them (TAC-536's
-- scan greeting, TAC-560's warm close, this), and each writes this column on a
-- confirmed send and reads it before its own claim.
--
-- ONE COLUMN RATHER THAN A DERIVATION, because there is nothing to derive from.
-- `guests.last_outbound_at` has never been written by anything since migration
-- 001 and is commented DO NOT READ (migration 051), and `messages.category`
-- cannot recover the proactive set: a warm close stores 'acknowledgment', which
-- it shares with genuine sign-offs, and a day-based follow-up stores
-- 'follow_up'.
--
-- Written on a confirmed send only, never on a queued card: a card is an
-- operator's decision and an operator can see the whole thread. So this is
-- advisory, NOT a claim, and nothing releases it.
--
-- NULL is the honest value for every existing guest, so no backfill and no
-- NOT NULL: a default of now() would suppress every proactive send fleet-wide
-- for an hour on the day it shipped.
alter table guests add column last_proactive_send_at timestamptz;

comment on column guests.last_proactive_send_at is
  'TAC-386: when a proactive message (TAC-536 scan greeting, TAC-560 warm close, TAC-386 inquiry follow-up) last reached this guest. NULL means never. Read before each proactive claim to keep PROACTIVE_SPACING_MINUTES between them. Advisory, not a claim: written only on a confirmed send, never released.';

-- ----------------------------------------------------------------------------
-- 3. followup_log accepts the new reason
-- ----------------------------------------------------------------------------

-- This is what makes the follow-up count toward the venue's rolling 7-day
-- weekly cap for free: loadFollowupSnapshotsForVenue's weekly query
-- (lib/followups/log.ts) filters on venue, guest and created_at with NO reason
-- filter, so any row counts. Ruled 2026-09-30, the cap also BLOCKS this trigger
-- (superseding ruling 6(b) of 2026-09-17 for this reason only), which the
-- processor enforces by reading that count before its claim.
--
-- THE CONSTRAINT NAME IS SERVER-GENERATED. Migration 029 declared the CHECK
-- inline and it has never been widened, so the live name is whatever Postgres
-- chose. Rather than hard-code a guess, this looks it up and raises if it
-- cannot find exactly one match, so a wrong assumption fails the migration
-- instead of silently dropping the wrong constraint. The replacement is named
-- explicitly, so the next widening needs none of this.
do $$
declare
  cname text;
  matches int;
begin
  select count(*), min(con.conname) into matches, cname
  from pg_constraint con
  join pg_class rel on rel.oid = con.conrelid
  join pg_namespace nsp on nsp.oid = rel.relnamespace
  where nsp.nspname = 'public'
    and rel.relname = 'followup_log'
    and con.contype = 'c'
    and pg_get_constraintdef(con.oid) like '%post_visit_day_1%';

  if matches <> 1 then
    raise exception
      'expected exactly 1 followup_log reason CHECK, found %', matches;
  end if;

  execute format('alter table followup_log drop constraint %I', cname);
end $$;

alter table followup_log
  add constraint followup_log_reason_check
  check (reason in (
    'post_visit_day_1',
    'post_visit_day_3',
    'post_visit_day_7',
    'post_visit_day_14',
    'cold_lapsed',
    'perk_unlock',
    -- TAC-386. Deliberately NOT added to FOLLOWUP_REASONS in
    -- lib/schemas/followup-rules.ts: that constant means "reasons the engine
    -- can DETECT and dispatch", and nothing in the daily engine detects this
    -- one, the same way nothing detects instagram_scan_arrival, warm_close,
    -- event or manual. The runtime narrows on read instead.
    'inquiry_followup'
  ));

commit;

-- ----------------------------------------------------------------------------
-- After applying: this should return one row per object, and nothing else.
-- ----------------------------------------------------------------------------
--
--   select 'table' as kind, 1 as n from information_schema.tables
--    where table_name = 'inquiry_followups'
--   union all
--   select 'guests.col', count(*) from information_schema.columns
--    where table_name = 'guests' and column_name = 'last_proactive_send_at'
--   union all
--   select 'reason', count(*) from pg_constraint
--    where conname = 'followup_log_reason_check'
--      and pg_get_constraintdef(oid) like '%inquiry_followup%';
--
-- Migration 046's trap, checked directly because this migration adds a
-- defaulted column with a CHECK and Postgres validates neither against the
-- other. This inserts a row relying on the default and rolls it back, which is
-- the only check that can actually fail if the two ever disagree. It should
-- print 'pending' and leave nothing behind:
--
--   begin;
--   insert into inquiry_followups
--     (venue_id, guest_id, source_message_id, question, asked_at,
--      window_closes_at, due_at)
--   select m.venue_id, m.guest_id, m.id, 'default probe',
--          now(), now() + interval '24 hours', now()
--     from messages m where m.guest_id is not null limit 1
--   returning status;
--   rollback;
--
-- ----------------------------------------------------------------------------
-- Rollback
-- ----------------------------------------------------------------------------
--
-- Run the code revert WITH this, not after it: the processor and the scheduler
-- both read objects this drops, and the cron route answers 200 regardless, so
-- leaving the code running against a missing table is invisible.
--
--   begin;
--   set local lock_timeout = '5s';
--   lock table messages, guests, venues, followup_log in access exclusive mode;
--   drop table if exists inquiry_followups;
--   alter table guests drop column if exists last_proactive_send_at;
--   commit;
--
-- The reason CHECK is deliberately NOT narrowed back. Narrowing it ABORTS once
-- any followup_log row carries 'inquiry_followup', and that is the right
-- outcome: those rows are real dispatches. A value nothing writes costs
-- nothing (db/migrations/CLAUDE.md). If it genuinely must go back:
--
--   delete from followup_log where reason = 'inquiry_followup';
--   alter table followup_log drop constraint followup_log_reason_check;
--   alter table followup_log add constraint followup_log_reason_check
--     check (reason in ('post_visit_day_1','post_visit_day_3','post_visit_day_7',
--                       'post_visit_day_14','cold_lapsed','perk_unlock'));
