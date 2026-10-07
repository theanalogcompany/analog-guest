-- TAC-575: one row per guest per visit for the "how is it so far?" check-in.
--
-- ============================================================================
-- WHAT THIS IS FOR
-- ============================================================================
--
-- Ruled 2026-10-06. A guest who scans at the counter and tells us what they
-- got is asked how it is, right then. What they say decides everything that
-- follows in the visit:
--
--   good      the review ask is saved for the sign-off
--   not yet   one check-back about ten minutes after the order
--   bad       the existing complaint path, and a follow-up on their next visit
--
-- None of that is recorded anywhere today. An intention row
-- (guest_intention_prompts) says we ASKED and nothing about the answer, there
-- is no complaint state on a guest at all, and a captured order is a
-- `transactions` row with no link to the scan or the message it came from.
-- Every later step needs "did we ask, when, and what did they say", so that is
-- what a row here is.
--
-- A ROW IS WRITTEN WHEN THE QUESTION REACHES THE GUEST, or when the message
-- that named the order already said how it is ("iced sofi, so good"), in which
-- case the answer is recorded and no question is asked. So "a row exists"
-- means "this visit has a check-in", and `asked_at` is NOT NULL: it is when
-- the question reached them, or, in that second case, when their own message
-- arrived. A visit where the order was named but the question was held,
-- dropped or never generated has no row and nothing here acts on it.
--
-- ============================================================================
-- ONE ROW PER GUEST PER VENUE-LOCAL DAY
-- ============================================================================
--
-- `venue_local_date` is the visit's identity, the same key
-- instagram_scan_arrivals uses for "one greeting a day" (migration 064). The
-- unique index is the storage-layer backstop behind the application's own
-- check: two orders named in one sitting ("the SoFi", then "and a croissant")
-- must not ask how it is twice, and a racing coalesced turn must not either.
-- The losing insert takes 23505 and reads as "already asked".
--
-- KNOWN LIMIT: THE DAY ROLLS OVER AT VENUE-LOCAL MIDNIGHT. A guest asked at
-- 23:55 who answers at 00:02 is read against a new day, finds no row, and the
-- answer is not recorded. Irrelevant for a cafe and live for a late venue;
-- loading by "asked within the answer window" is the fix when one arrives.
--
-- ============================================================================
-- THE COLUMNS, AND WHICH PART OF TAC-575 READS EACH
-- ============================================================================
--
-- TAC-575 ships as five PRs. This migration carries the whole table so the
-- operator applies one file rather than three. Stated per column, because a
-- well-named column with no reader is how this schema has been misread before:
--
--   PR 2 (this one) writes and reads:
--     order_message_id  the inbound that named the order. ON DELETE SET NULL,
--                       like instagram_scan_arrivals.scan_message_id: the row
--                       outlives the message.
--     ordered_at        when that inbound arrived. "Ten minutes after the
--                       order" is measured from here.
--     asked_at          when our question reached the guest.
--     answer            'good' | 'bad' | 'not_yet', null until they reply.
--     answered_at       when the answer was last written.
--
--   PR 3 (the timed check-back) will write:
--     checkback_claimed_at  the claim, taken before the send. Claim before the
--                           side effect, the house rule (064's claimed_at).
--     checkback_sent_at     set only once the check-back reached the guest.
--
--   PR 5 (the follow-up on the next visit after a complaint) will write:
--     followup_claimed_at   the claim for that follow-up, once per row.
--
-- UNTIL THOSE PRs MERGE THE LAST THREE ARE NULL ON EVERY ROW AND NOTHING READS
-- THEM. If either PR is abandoned, drop its columns rather than leave them.
--
-- `answer` and `answered_at` move together, which the CHECK below enforces so
-- that neither can be read as meaning something the other contradicts.
--
-- NO FREE TEXT AND NOTHING THAT IDENTIFIES ANYBODY: ids, timestamps, a date
-- and a three-value enum. `delete-venue-data.ts` deletes the rows anyway, for
-- the reason it deletes scan arrivals: a row awaiting its check-back is a
-- pending unprompted message.
--
-- ============================================================================
-- LOCKS AND ORDERING
-- ============================================================================
--
-- A new table, so nothing is rewritten. Each foreign key takes a brief lock on
-- the table it references while the constraint is created. They are taken UP
-- FRONT AND `messages` FIRST, the rule in db/migrations/CLAUDE.md and what 066
-- does: an inbound webhook holds `messages` and then needs `guests`, so taking
-- them in the other order can deadlock with it. `lock_timeout` makes a busy
-- table fail the migration cleanly rather than queue. APPLY OUTSIDE THE PILOT
-- VENUE'S OPENING HOURS regardless.
--
-- IS THIS A MIGRATION AGAINST `messages`? The author's reading is no, and it
-- is a reading for the operator to confirm before applying, not a ruling. No
-- column, index or constraint OWNED by `messages` changes. But the foreign key
-- does touch it: it locks the table as above, installs referential triggers on
-- it, and makes every DELETE from `messages` look up
-- `visit_checkins.order_message_id` (indexed below for exactly that). 064 and
-- 066 reference `messages` the same way.
--
-- ORDERING: additive, but the deployed code reads this table on every inbound
-- turn's context build and inserts into it when the question is sent. APPLY IN
-- STUDIO BEFORE MERGING, the call 064 and 066 made. The context-build read
-- fails open (an unreadable table reads as "do not ask"), so a merge ahead of
-- the migration silences the new question rather than breaking a turn. That is
-- a safety margin, not a licence to merge first.
--
-- THE NUMBER: 072 is on two files already (072_regression_recommendation_scenario
-- and 072_transactions_retracted_at). This is 073. Re-check
-- `git ls-tree origin/main db/migrations/` before applying.

begin;

set local lock_timeout = '5s';

lock table messages, guests, venues in share row exclusive mode;

create table visit_checkins (
  id uuid primary key default gen_random_uuid(),
  venue_id uuid not null references venues(id) on delete cascade,
  guest_id uuid not null references guests(id) on delete cascade,
  venue_local_date text not null,
  order_message_id uuid references messages(id) on delete set null,
  ordered_at timestamptz not null,
  asked_at timestamptz not null,
  answer text check (answer in ('good', 'bad', 'not_yet')),
  answered_at timestamptz,
  checkback_claimed_at timestamptz,
  checkback_sent_at timestamptz,
  followup_claimed_at timestamptz,
  created_at timestamptz not null default now(),
  constraint visit_checkins_answer_has_time
    check ((answer is null) = (answered_at is null))
);

comment on table visit_checkins is
  'TAC-575: one row per guest per venue-local day on which the venue asked how their order is. Written when the question reaches the guest.';

-- The backstop for "ask once per visit". See the header.
create unique index visit_checkins_one_per_venue_day
  on visit_checkins (venue_id, guest_id, venue_local_date);

-- PR 3's due scan: rows still owed a check-back, oldest order first.
create index idx_visit_checkins_checkback_pending
  on visit_checkins (ordered_at)
  where checkback_claimed_at is null
    and (answer is null or answer = 'not_yet');

-- For the ON DELETE SET NULL lookup a `messages` delete now performs.
create index idx_visit_checkins_order_message
  on visit_checkins (order_message_id)
  where order_message_id is not null;

commit;

-- rollback:
--   begin;
--   drop table visit_checkins;
--   commit;
--
-- `drop table` loses the record of who was asked and what they said. Roll the
-- CODE back first: with the table gone the context-build read fails open and
-- the question simply stops being asked, but the insert after a sent question
-- would log an error on every such turn until the code is reverted.
