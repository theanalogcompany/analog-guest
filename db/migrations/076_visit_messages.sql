-- TAC-578: one row per unprompted message tied to a guest's visit.
--
-- ============================================================================
-- WHAT THIS IS FOR
-- ============================================================================
--
-- Ruled 2026-10-07. A visit now ends in up to two messages of ours, and each
-- needs a claim and a record:
--
--   sign_off            the light line when the guest goes quiet in the shop.
--                       It used to be claimed by `guests.review_asked_at`,
--                       because it carried the review link. It no longer does,
--                       so it needs a claim of its own or it repeats every ten
--                       quiet minutes.
--   first_visit_thanks  once per guest EVER, the next morning or the same
--                       evening. Carries the review ask.
--   visit_checkin       after a later visit: a compliment on the order, sent
--                       only when it is fresh. The earlier ones have to be
--                       readable, with the angle each took, to check that.
--
-- None of that fits an existing table. `visit_checkins` (073) has a row only
-- when the guest named their order, and `instagram_scan_arrivals` (064) can
-- hold several rows for one day.
--
-- ============================================================================
-- THE INSERT IS THE CLAIM
-- ============================================================================
--
-- A plain INSERT with no ON CONFLICT, taken immediately before generating.
-- 23505 means another tick owns it. Two unique indexes, two guarantees:
--
--   one row per guest, venue-local day and kind
--   one `first_visit_thanks` per guest, ever
--
-- A message that never reached the guest DELETES its row, so a later tick
-- inside the slot can try again. A deliberate skip (the check-in was not
-- fresh) keeps the row with `outcome = 'skipped'`, so that day is settled.
--
-- ============================================================================
-- THE COLUMNS, AND WHAT READS EACH
-- ============================================================================
--
--   venue_local_date  the visit's day, the key 064 and 073 use.
--   kind              which of the three.
--   slot              first_visit_thanks and visit_checkin only: which slot it
--                     went out in. Decides "earlier today" against "yesterday".
--   outcome           claimed -> sent | queued | skipped. `queued` is a card an
--                     operator can still approve, and keeps the claim.
--   skip_reason       why a kept row was skipped. Free text from a closed set
--                     in lib/agent/post-visit-timeout.ts; read by people.
--   angle             visit_checkin only: `<kind>:<item>` as the freshness
--                     judge read it. The safety floor compares these.
--   message_id        the outbound row. The freshness check reads the earlier
--                     check-ins' bodies through it. ON DELETE SET NULL, like
--                     064 and 073: the row outlives the message.
--   sent_at           set once it reached the guest. The one-message rule
--                     reads it.
--
-- NO FREE TEXT FROM A GUEST. `delete-venue-data.ts` deletes the rows anyway,
-- for the reason it deletes scan arrivals: a claimed row is a pending
-- unprompted message.
--
-- ============================================================================
-- LOCKS AND ORDERING
-- ============================================================================
--
-- A new table. Each foreign key takes a brief lock on the table it references;
-- they are taken UP FRONT AND `messages` FIRST (db/migrations/CLAUDE.md).
-- `lock_timeout` makes a busy table fail the migration cleanly rather than
-- queue. APPLY OUTSIDE THE PILOT VENUE'S OPENING HOURS.
--
-- The foreign key to `messages` was ruled fine on 2026-10-07 (TAC-578).
--
-- ORDERING: additive, and the deployed code reads and inserts into this table
-- on the every-minute ticks. APPLY IN STUDIO BEFORE MERGING, then run
-- `npm run db:types`. Every read fails toward sending nothing, so a merge
-- ahead of the migration silences the new messages and the in-shop sign-off
-- rather than breaking a turn. That is a margin, not a licence to merge first.
--
-- THE NUMBER: re-check `git ls-tree origin/main db/migrations/` before
-- applying. 072 is on two files already.

-- AS APPLIED (2026-10-07): production ran the statements below without the
-- `begin`/`commit` pair, which the migration runner wraps itself, and with RLS
-- off, matching visit_checkins. The table comment was added in a second
-- statement the same day. This file is otherwise what ran.

begin;

set local lock_timeout = '5s';

lock table messages, guests, venues in share row exclusive mode;

create table visit_messages (
  id uuid primary key default gen_random_uuid(),
  venue_id uuid not null references venues(id) on delete cascade,
  guest_id uuid not null references guests(id) on delete cascade,
  venue_local_date text not null,
  kind text not null
    check (kind in ('sign_off', 'first_visit_thanks', 'visit_checkin')),
  slot text check (slot in ('next_morning', 'same_evening')),
  outcome text not null default 'claimed'
    check (outcome in ('claimed', 'sent', 'queued', 'skipped')),
  skip_reason text,
  angle text,
  message_id uuid references messages(id) on delete set null,
  claimed_at timestamptz not null default now(),
  sent_at timestamptz
);

comment on table visit_messages is
  'TAC-578: one row per unprompted message tied to a guest''s visit (in-shop sign-off, first-visit thank-you, later-visit check-in). The insert is the claim.';

-- One of each kind per visit.
create unique index visit_messages_one_per_visit_kind
  on visit_messages (venue_id, guest_id, venue_local_date, kind);

-- The first-visit thank-you is once per guest, ever.
create unique index visit_messages_one_first_visit_thanks
  on visit_messages (venue_id, guest_id)
  where kind = 'first_visit_thanks';

-- The freshness check's read: this guest's earlier check-ins, newest first.
-- Also the one-message rule's.
create index idx_visit_messages_guest_recent
  on visit_messages (venue_id, guest_id, claimed_at desc);

-- For the ON DELETE SET NULL lookup a `messages` delete now performs.
create index idx_visit_messages_message
  on visit_messages (message_id)
  where message_id is not null;

commit;

-- rollback:
--   begin;
--   drop table visit_messages;
--   commit;
--
-- `drop table` loses the record of who has had their first-visit thank-you and
-- what every check-in said. Roll the CODE back first: with the table gone the
-- reads fail toward sending nothing, but each tick logs an error until the
-- code is reverted.
