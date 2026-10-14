-- 085: passport stamps (TAC-586)
--
-- A scan that binds a Square payment to a guest gets that guest one passport
-- stamp. The guest is sent two images: the stamp on its own, then the open
-- passport spread with the stamp in place. This table is the record of every
-- stamp, and everything needed to draw it again identically.
--
-- THE INSERT IS THE CLAIM. `transaction_id` is unique, so two runners that
-- both see the same bound payment cannot both stamp it: the loser takes 23505
-- and stops before rendering or sending anything. Claim before the side
-- effect, as lib/agent/scan-arrival-store.ts does.
--
-- WHY `seq`. The page a stamp lands on is derived from how many stamps the
-- guest already has, six to a page. Without a per-guest sequence, two
-- purchases scanned at the same moment both read "five prior stamps", both
-- land on page 01 in different free slots, and page 01 holds seven. The
-- (venue, guest, page, slot) key cannot see that; (venue, guest, seq) can, so
-- the second insert fails, re-reads, and lands correctly.
-- `passport_stamps_page_from_seq` makes "six to a page" a constraint rather
-- than a comment.
--
-- EVERYTHING RANDOM IS STORED. slot, dx, dy, rotation and texture_seed are
-- chosen once at insert (lib/passport/layout.ts) and read back on every later
-- render, so the spread a guest receives at stamp 9 draws stamp 1 exactly as
-- it was drawn at stamp 1. `label` is the item a DISCOVERED stamp names, or
-- the perk line an INVITED stamp carries; ARRIVED and VISIT carry none.
--
-- THE IMAGES LIVE IN `guest-media`, under passport/{venue}/{guest}/{stamp}/.
-- That private bucket is the only one the operator thread signs links from
-- and the only one venue data deletion clears, so no new bucket is created.
-- The paths are recorded once the upload lands; NULL means it never did.
--
-- `sent_at` IS SET ONLY WHEN BOTH IMAGES REACHED THE GUEST. NULL after the
-- run means a render, upload or send failed and the event says which. Nothing
-- retries it later (ruled 2026-10-14: retries happen inside the run only).
--
-- NO LINK TO THE OUTBOUND MESSAGE ROWS. A foreign key to that table is a
-- high-stakes reference db:apply refuses by design, and an unenforced uuid is
-- a claim nothing checks. The two outbound rows are found through their
-- attachment rows, whose `storage_path` equals this row's image paths.
--
-- NO RLS, matching transactions, pos_tap_events and instagram_scan_arrivals:
-- every reader is the server's admin client.
--
-- PURELY ADDITIVE, AND THE DEPLOYED CODE READS IT. Applied by
-- `npm run db:apply -- 085_passport_stamps.sql`, BEFORE merging: the
-- Instagram webhook inserts into it on the first bound scan after deploy, and
-- that path answers 200 whatever happens, so a missing table would fail
-- silently.

begin;

set local lock_timeout = '5s';

create table passport_stamps (
  id uuid primary key default gen_random_uuid(),
  venue_id uuid not null references venues(id) on delete cascade,
  guest_id uuid not null references guests(id) on delete cascade,
  transaction_id uuid not null references transactions(id) on delete cascade,
  seq integer not null check (seq >= 1),
  kind text not null
    check (kind in ('arrived', 'visit', 'discovered', 'invited')),
  label text,
  stamped_on date not null,
  page integer not null,
  slot smallint not null check (slot between 0 and 5),
  dx smallint not null,
  dy smallint not null,
  rotation numeric(4, 2) not null,
  texture_seed integer not null,
  stamp_image_path text,
  spread_image_path text,
  sent_at timestamptz,
  created_at timestamptz not null default now(),
  constraint passport_stamps_transaction_key unique (transaction_id),
  constraint passport_stamps_seq_key unique (venue_id, guest_id, seq),
  constraint passport_stamps_slot_key unique (venue_id, guest_id, page, slot),
  constraint passport_stamps_page_from_seq check (page = (seq - 1) / 6 + 1),
  constraint passport_stamps_label_by_kind
    check ((kind in ('discovered', 'invited')) = (label is not null))
);

comment on table passport_stamps is
  'One row per passport stamp (TAC-586). The insert is the claim: unique transaction_id. See migration 085.';

commit;
