-- 081: what a guest's photo, video or story shows, and the visit it is
-- evidence of (TAC-584).
--
-- WHAT WAS WRONG. TAC-582 stored guest media and showed it to operators, and
-- the agent still could not see any of it: a photo with no text became a
-- blank card, and a story tagging the venue with its drinks in frame, the
-- strongest sign of a visit there is, recorded nothing.
--
-- WHAT THIS ADDS.
--   A. Three columns on `message_attachments` for the describe step.
--   B. One more value on `transactions_source_check`: 'guest_media'.
--   C. A partial unique index: one such visit per guest per venue-local day.
--   D. `venues.record_media_visits`, default false: whether B is written at
--      all. See "SHADOW MODE" below.
--
-- A. THE COLUMNS, AND WHO READS EACH.
--   description       one sentence about the drinks, food or space. Written
--                     by lib/messaging/attachments/describe.ts. Read by the
--                     agent's history (lib/agent/media-history.ts) and by the
--                     turn that answers the message.
--   description_meta  everything else the vision call returned, plus why a
--                     describe was skipped when it was. Shape and parser:
--                     lib/schemas/attachment-description.ts. Read by the
--                     naming rule and the visit rule, which are one function
--                     each in that file.
--   described_at      when the describe step settled this row, whether or
--                     not it produced a description. Non-null with a null
--                     `description` means "tried, nothing usable"; the reason
--                     is in description_meta. Null means never tried.
--   All three are nullable with no default: every row older than this file
--   was never described, and null says so.
--
-- A STORY'S ROW GAINS A DESCRIPTION AND STILL NO FILE. Meta forbids keeping a
-- story (owner ruling 2026-10-11, restated on TAC-584): the bytes are
-- downloaded for the one call and dropped. `storage_path` stays null on a
-- story row and `status` stays 'link_only'.
--
-- B. WHY A NEW SOURCE AND NOT 'guest_reported_ongoing'. The guest did not
-- report anything: a model looked at a picture. Recognition reads every
-- un-retracted row whatever its source, so the row counts the same; what the
-- value buys is that a wrong one can be found and removed as a class, and
-- that the Command Center can say where a visit came from.
--
-- `transactions_retracted_at_source_check` (migration 072) is NOT widened. A
-- guest cannot retract a photo visit by text; the Command Center's delete is
-- the correction path. Widening a CHECK for a writer that does not exist is
-- the well-named-thing-with-no-reader this schema has paid for before.
--
-- C. THE INDEX IS THE BACKSTOP behind lib/agent/record-media-visit.ts's own
-- same-day check, the way visit_checkins_one_per_venue_day is (073). The
-- venue's timezone is not on this table, so the writer stamps the venue-local
-- date into raw_data and the index reads it from there. `coalesce(..., '')`
-- because NULLs are distinct in a unique index: a row missing the date would
-- otherwise escape it. With the sentinel, two such rows collide, which is the
-- loud direction. A row whose guest was deleted (guest_id set null) is
-- outside the index, as NULL guest_ids are everywhere else here.
--
-- D. SHADOW MODE (owner ruling 2026-10-11, on TAC-584). Whether a picture is
-- evidence of a visit is a model's call, and a visit moves recognition. So
-- the decision is computed and recorded for every described attachment
-- (`description_meta.visit`, and one structured log line), and NO transactions
-- row is written unless this venue's `record_media_visits` is true. It ships
-- false everywhere. The owner turns it on per venue after reading a week of
-- decisions:
--   update venues set record_media_visits = true where slug = '<venue>';
-- B and C ship now so that turning it on needs no second migration, and a
-- 'guest_media' value nothing writes costs nothing (db/migrations/CLAUDE.md).
--
-- THE FLAG'S ONE READER is lib/agent/record-media-visit.ts, with its own
-- query. It is deliberately NOT added to the venue select in
-- build-runtime-context.ts: that select runs on every turn, and a column it
-- names that does not exist yet fails every turn. A failed read of the flag
-- is read as false.
--
-- NOT NULL DEFAULT false, like `hold_all_outbound` (migration 031): a
-- constant default is a metadata-only change, and no CHECK sits on it.
--
-- APPLY IN STUDIO, BEFORE THE CODE MERGES. `db:apply` refuses this file: a
-- constraint drop and an index on a live table. Every statement is additive
-- or a loosening and the deployed code is indifferent to all of it, so it can
-- be applied at any point before merge. Apply outside the pilot venue's
-- opening hours: it briefly locks `message_attachments`, which the Instagram
-- webhook inserts into before its 200, and `venues`, which every inbound
-- reads; the lock timeout turns a busy table into a clean failure rather than
-- a stalled delivery.
--
-- LIVE CHECK, 2026-10-11, read-only, relayed by the owner before this was
-- written:
--   pg_get_constraintdef(transactions_source_check) lists exactly
--     mock, csv_upload, square, toast, manual, guest_reported,
--     guest_reported_ongoing
-- Re-run it before applying if any time has passed:
--   select conname, pg_get_constraintdef(oid) from pg_constraint
--   where conrelid = 'public.transactions'::regclass
--     and conname = 'transactions_source_check';
--
-- NO db/types.ts CHANGE FOR B OR C. `transactions.source` is typed `string`
-- and an index is not in the generated types. A and D are hand-patched; the
-- next `npm run db:types` overwrites the patch with the same columns.
--
-- ROLLBACK. Runnable as-is once uncommented, and only before the code that
-- writes these is deployed. The CHECK step ABORTS if any 'guest_media' row
-- exists, which is correct: those rows are real, so roll the code back and
-- leave the CHECK wide.
--
--   begin;
--
--   set local lock_timeout = '5s';
--
--   lock table message_attachments in access exclusive mode;
--   lock table transactions in access exclusive mode;
--   lock table venues in access exclusive mode;
--
--   alter table venues drop column record_media_visits;
--
--   drop index if exists idx_transactions_one_guest_media_per_guest_day;
--
--   alter table transactions drop constraint transactions_source_check;
--   alter table transactions add constraint transactions_source_check
--     check (source in (
--       'mock',
--       'csv_upload',
--       'square',
--       'toast',
--       'manual',
--       'guest_reported',
--       'guest_reported_ongoing'
--     ));
--
--   alter table message_attachments drop column described_at;
--   alter table message_attachments drop column description_meta;
--   alter table message_attachments drop column description;
--
--   notify pgrst, 'reload schema';
--
--   commit;

begin;

set local lock_timeout = '5s';

lock table message_attachments in access exclusive mode;
lock table transactions in access exclusive mode;
lock table venues in access exclusive mode;

-- A. What the describe step writes. Nullable, no defaults.
alter table message_attachments add column description text;
alter table message_attachments add column description_meta jsonb;
alter table message_attachments add column described_at timestamptz;

-- B. A visit seen in a guest's photo, video or story.
alter table transactions drop constraint transactions_source_check;
alter table transactions add constraint transactions_source_check
  check (source in (
    'mock',
    'csv_upload',
    'square',
    'toast',
    'manual',
    'guest_reported',
    'guest_reported_ongoing',
    'guest_media'
  ));

-- C. One photo visit per guest per venue-local day.
create unique index idx_transactions_one_guest_media_per_guest_day
  on transactions (
    venue_id,
    guest_id,
    (coalesce(raw_data ->> 'venue_local_date', ''))
  )
  where source = 'guest_media';

-- D. Whether B is written for this venue. Off everywhere until turned on.
alter table venues
  add column record_media_visits boolean not null default false;

notify pgrst, 'reload schema';

commit;
