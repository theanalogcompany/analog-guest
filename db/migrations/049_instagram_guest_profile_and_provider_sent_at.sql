-- 049_instagram_guest_profile_and_provider_sent_at.sql
-- TAC-479: store an Instagram guest's handle and display name, and store
-- Instagram's own time on each Instagram message.
--
-- Two unrelated changes in one migration, so they share one human review.
--
-- WHAT CHANGES
--
-- 1. messages.provider_sent_at: when the provider says the message was sent,
--    by the provider's clock. For Instagram, the `timestamp` of the
--    `messaging[]` item: when the guest sent a message or tapped an
--    icebreaker, or when the venue account sent an echo. NOT `entry.time`,
--    which is when Meta sent the delivery; in all four recorded payloads
--    (lib/messaging/instagram/fixtures/) it is 0.4 to 1.1 seconds later.
--    - Why it exists: Instagram measures its 24-hour reply window from the
--      guest's action on Instagram's clock. created_at is when our webhook
--      received it, which runs later, and by far more than seconds when Meta
--      redelivers. TAC-469's window gate and TAC-486's countdown read this.
--    - Written only by the Instagram handler, on message, postback and echo
--      rows. Sendblue rows leave it NULL: no default, so a writer that
--      doesn't name it gets NULL. Nothing may assume it is present on a
--      'text' row.
--    - No CHECK: it is written on the live webhook path, where a rejected
--      insert loses the guest's message (migration 048's reasoning). The
--      parser turns anything that isn't a millisecond epoch into NULL.
--    - Named for the provider, not the vendor ("meta_sent_at"), because
--      providers are swappable (CLAUDE.md "Tech stack"); `_at` like every
--      other timestamp column; pairs with provider_message_id.
--    - Nothing that reads created_at switches to it. History is ordered on
--      one clock across both channels, and Sendblue rows only have ours.
--
-- 2. guests.instagram_username and guests.instagram_name: the guest's
--    Instagram handle and display name, from Instagram's User Profile API,
--    fetched after the webhook has answered (never on its critical path).
--    - instagram_name is NEVER copied into first_name/last_name (ruled
--      2026-09-18). It is free text the guest never gave the venue; in
--      first_name the agent would greet them by it, and the learn_name
--      intention closes on any string there.
--    - profile_pic is deliberately not stored: Meta's docs say its URL
--      expires in a few days. Follower count and verified status are not
--      requested at all.
--    - No uniqueness: handles change, and two rows can briefly hold the same
--      one (A renames, B takes A's old handle, A's row not yet refreshed).
--      Nothing routes on the handle; routing is by instagram_scoped_id.
--    - Non-blank CHECKs, so an absent value is always NULL, never ''. A
--      reader can then use `??` safely (TAC-473's '' trap). These columns
--      are written off the webhook path, so a violation would lose only the
--      profile write; the code writes NULL for an empty value anyway.
--
-- 3. guests.instagram_profile_fetched_at: when the last fetch SUCCEEDED. The
--    two values above are as of this time. A failed fetch never clears them.
--
-- 4. guests.instagram_profile_attempted_at: when a fetch was last tried,
--    whatever the outcome. The refresh claims on it, and it throttles retries
--    of a fetch that keeps failing.
--
-- NO BACKFILL. Existing Instagram guests get a profile on their next
-- message. Existing messages keep NULL.
-- NO INDEX. The profile is read and written by guest id; TAC-469 decides any
-- index its window query needs.
--
-- ORDERING: APPLY IN STUDIO BEFORE THE PR MERGES. Additive, but once merged
-- every Instagram message insert names provider_sent_at, and Vercel deploys on
-- merge. Against a missing column that insert fails, the route still answers
-- 200 (TAC-468's ruling), and the guest's message is lost with no retry.
-- `npm run db:types` is safe to run on any branch afterwards: new nullable
-- columns add optional fields, and no code builds a full guests or messages
-- row literal.
--
-- LOCKS: every lock is taken up front, messages first, for the deadlock
-- reason in migration 048 (a Sendblue inbound holds messages, then needs
-- guests for its foreign-key check). Adding a nullable column with no default
-- is catalogue-only; the two CHECKs scan guests under the lock, milliseconds
-- at today's size. The 5-second lock_timeout makes a busy table fail the
-- whole migration cleanly (nothing applied, run it again). Apply outside Le
-- Mil's hours (7am to 3pm America/Los_Angeles) anyway.
--
-- HIGH-STAKES: touches `messages` and `guests`.

begin;

set local lock_timeout = '5s';
lock table messages, guests in access exclusive mode;

-- 1
alter table messages add column provider_sent_at timestamptz;

-- 2
alter table guests add column instagram_username text;
alter table guests add column instagram_name text;

alter table guests add constraint guests_instagram_username_not_blank
  check (instagram_username is null or btrim(instagram_username) <> '');

alter table guests add constraint guests_instagram_name_not_blank
  check (instagram_name is null or btrim(instagram_name) <> '');

-- 3
alter table guests add column instagram_profile_fetched_at timestamptz;

-- 4
alter table guests add column instagram_profile_attempted_at timestamptz;

commit;

-- VERIFY (read-only, after applying):
--
--   -- expect five rows, all is_nullable = 'YES', column_default null
--   select table_name, column_name, data_type, is_nullable, column_default
--   from information_schema.columns
--   where table_schema = 'public'
--     and (table_name, column_name) in (
--       ('messages', 'provider_sent_at'),
--       ('guests', 'instagram_username'), ('guests', 'instagram_name'),
--       ('guests', 'instagram_profile_fetched_at'),
--       ('guests', 'instagram_profile_attempted_at'));
--
--   select conname, pg_get_constraintdef(oid) from pg_constraint
--   where conname in ('guests_instagram_username_not_blank',
--     'guests_instagram_name_not_blank');
--
-- After the PR is deployed and an Instagram guest has written in:
--
--   -- expect a non-null provider_sent_at on the new Instagram rows, a few
--   -- hundred ms to a few seconds before created_at, and null on text rows
--   select channel, direction, created_at, provider_sent_at
--   from messages order by created_at desc limit 10;
--
-- ROLLBACK (roll the code back first: it writes these columns):
--
--   begin;
--   set local lock_timeout = '5s';
--   lock table messages, guests in access exclusive mode;
--   alter table guests drop column instagram_profile_attempted_at;
--   alter table guests drop column instagram_profile_fetched_at;
--   alter table guests drop column instagram_name;
--   alter table guests drop column instagram_username;
--   alter table messages drop column provider_sent_at;
--   commit;
--
-- Dropping a column drops its CHECK with it. The rollback loses the stored
-- profiles and Instagram's times; both can be refetched or are recorded
-- again on the next message, and nothing else depends on them yet.
