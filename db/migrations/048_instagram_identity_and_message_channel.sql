-- 048_instagram_identity_and_message_channel.sql
-- TAC-467: let a guest be an Instagram sender with no phone number, record
-- which channel each message went through, and keep the referral an ig.me
-- link carries.
--
-- Schema only. Nothing in this migration is written or read by deployed code
-- yet: the Instagram webhook still persists nothing (TAC-468 does that), and
-- the Sendblue path always has a phone number.
--
-- WHAT CHANGES
--
-- 1. guests.phone_number becomes nullable. An Instagram guest has no phone.
--    guests_phone_number_check is left exactly as it is: a CHECK passes when
--    its expression is NULL, so a null phone already satisfies it. The
--    UNIQUE (venue_id, phone_number) constraint treats NULLs as distinct, so
--    a venue can hold any number of guests without a phone.
--
-- 2. guests.instagram_scoped_id: the Instagram-scoped ID (IGSID) of a guest
--    who messaged the venue's Instagram account.
--    - It is scoped to one app-and-account pair, so it identifies a person
--      only as one venue's account sees them. Two venues seeing the same
--      person get different IGSIDs. It is NOT a person identifier, which is
--      why "scoped" is in the name.
--    - UNIQUE PER VENUE, not globally. While venues.instagram_account_id is
--      globally unique (6 below), an IGSID can only ever reach the one venue
--      that owns its account, so per-venue and global behave the same today.
--      Per venue is chosen because it mirrors UNIQUE (venue_id, phone_number),
--      keeps each venue its own block, and stays correct if an account is
--      ever allowed to map to more than one venue row, where a global unique
--      would refuse the second venue's guest and lose that message.
--    - A table constraint rather than a partial unique index, so a handler
--      can upsert with onConflict 'venue_id,instagram_scoped_id' the way the
--      phone path upserts on 'venue_id,phone_number'. PostgREST cannot target
--      a partial index. The constraint's index serves the lookup that runs on
--      every inbound event.
--    - No format check beyond non-blank. Samples so far are 16-digit strings,
--      but Meta documents neither a length nor a character set, and this is
--      written on the live webhook path, where a rejected insert loses the
--      guest's message along with the row.
--
-- 3. guests_must_have_identity: every guest can be reached through at least
--    one channel. At least one, not exactly one: merging a person's rows
--    across channels is out of scope, but nothing here forbids it later.
--
-- 4. messages.channel: which channel a message went through.
--    'text'      = iMessage or SMS, through the phone-number provider.
--    'instagram' = an Instagram DM.
--    Not 'sms' (most of these are iMessage) and not a vendor name (providers
--    are swappable; see CLAUDE.md "Tech stack").
--    THE DEFAULT IS A KNOWN HAZARD, KEPT DELIBERATELY. No deployed insert
--    site names a channel, so without a default every message insert would
--    fail. The cost: an Instagram message inserted without an explicit
--    channel is recorded as 'text', silently, and stays invisible until
--    someone queries by channel. Every Instagram insert must set channel
--    explicitly, and the default is removed as a tracked dependency of the
--    Instagram outbound ticket once every insert site names its channel.
--    Adding the column with a constant default is a catalogue-only change
--    (Postgres 11+), but the CHECK added after it scans every existing row
--    under the lock: milliseconds at today's size (766 rows on 2026-09-18).
--
-- 5. messages.referral_ref and messages.referral_source: the `ref` and
--    `source` of the referral an ig.me link carries (verified 2026-09-17 on a
--    postback: ref "TESTVENUE", source "SHORTLINK", type "OPEN_THREAD"; see
--    lib/messaging/instagram/fixtures/postback-referral.json). Instagram
--    delivers them once, with the guest's first action, and they cannot be
--    queried back, so they are stored on the message they arrived with. First-
--    touch attribution per guest can be derived from these later. `type` is
--    not stored: OPEN_THREAD is the only value seen, and it follows from a ref
--    being present. No CHECK on either column, for the same live-path reason
--    as 2: Instagram caps ref at 2,083 base64url characters, but a CHECK that
--    enforced it would drop the whole message if the promise ever changed.
--
-- 6. venues.instagram_account_id: the venue's Instagram professional account
--    ID, the `entry.id` / `recipient.id` of an inbound event. Without it an
--    inbound event cannot be mapped to a venue. Globally unique: one account
--    routes to one venue row.
--
-- NO BACKFILL. Existing guests all have phones; existing messages are all
-- 'text' and get it from the default.
-- NO NEW INDEX beyond the two unique constraints' own.
--
-- ORDERING: relaxes one constraint and adds everything else, and no deployed
-- code writes a null phone or reads a new column, so it can be applied in
-- Studio before or after the PR merges. Do NOT run `npm run db:types` on a
-- main (or any branch) that lacks the PR: regenerated types make
-- phone_number nullable and `tsc` fails at the sites this PR fixes. The PR
-- carries the hand-patched db/types.ts.
--
-- LOCKS: every lock is taken up front, messages first. Altering guests
-- before messages could deadlock with a Sendblue inbound, which holds its
-- lock on messages and then needs guests for the foreign-key check; Postgres
-- would abort one side, and the webhook answers 200 on a failed insert, so a
-- lost race would lose the guest's text with no retry. Queries touching both
-- tables start from messages, so taking messages first leaves no cycle. The
-- 5-second lock_timeout means a busy table makes the whole migration fail
-- cleanly (nothing applied, run it again) rather than hold every message
-- read and write queued behind it indefinitely; for up to those 5 seconds
-- they do wait. Apply outside Le Mil's hours (7am to 3pm
-- America/Los_Angeles) anyway.
--
-- HIGH-STAKES: touches `guests` and `messages`.

begin;

set local lock_timeout = '5s';
lock table messages, guests, venues in access exclusive mode;

-- 1
alter table guests alter column phone_number drop not null;

-- 2
alter table guests add column instagram_scoped_id text;

alter table guests add constraint guests_instagram_scoped_id_not_blank
  check (instagram_scoped_id is null or instagram_scoped_id <> '');

alter table guests add constraint guests_venue_id_instagram_scoped_id_key
  unique (venue_id, instagram_scoped_id);

-- 3
alter table guests add constraint guests_must_have_identity
  check (phone_number is not null or instagram_scoped_id is not null);

-- 4
alter table messages add column channel text not null default 'text';

alter table messages add constraint messages_channel_check
  check (channel in ('text', 'instagram'));

-- 5
alter table messages add column referral_ref text;
alter table messages add column referral_source text;

-- 6
alter table venues add column instagram_account_id text;

alter table venues add constraint venues_instagram_account_id_key
  unique (instagram_account_id);

commit;

-- VERIFY (read-only, after applying):
--
--   select table_name, column_name, is_nullable, column_default
--   from information_schema.columns
--   where table_schema = 'public'
--     and (table_name, column_name) in (
--       ('guests', 'phone_number'), ('guests', 'instagram_scoped_id'),
--       ('messages', 'channel'), ('messages', 'referral_ref'),
--       ('messages', 'referral_source'), ('venues', 'instagram_account_id'));
--
--   -- expect exactly one row, channel = 'text'
--   select channel, count(*) from messages group by 1;
--
--   select conname, pg_get_constraintdef(oid) from pg_constraint
--   where conname in ('guests_instagram_scoped_id_not_blank',
--     'guests_venue_id_instagram_scoped_id_key', 'guests_must_have_identity',
--     'messages_channel_check', 'venues_instagram_account_id_key');
--
-- ROLLBACK:
--
--   begin;
--   set local lock_timeout = '5s';
--   lock table messages, guests, venues in access exclusive mode;
--   alter table venues drop column instagram_account_id;
--   alter table messages drop column referral_source;
--   alter table messages drop column referral_ref;
--   alter table messages drop column channel;
--   alter table guests drop constraint guests_must_have_identity;
--   alter table guests drop column instagram_scoped_id;
--   alter table guests alter column phone_number set not null;
--   commit;
--
-- Dropping a column also drops the constraints on it. The last statement
-- fails once any guest without a phone exists, and that is the intended
-- outcome: after the Instagram handler has written guests, rolling back means
-- deciding what happens to them and their conversations, which no script
-- should decide. Before that handler deploys, the rollback is clean. After it
-- deploys, roll the code back first: it reads these columns.
