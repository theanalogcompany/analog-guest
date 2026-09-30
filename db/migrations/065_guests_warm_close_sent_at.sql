-- TAC-560: the once-per-guest-ever marker behind the warm "line is open" close.
--
-- One nullable timestamptz on `guests`. NULL means the close has never been
-- sent to this guest. Two paths write it:
--
--   the in-conversation close  (the guest says thanks, the model reports it
--                               via GeneratedMessageResult.closedTheConversation,
--                               and handle-inbound.ts marks post-dispatch)
--   the pause timer            (lib/agent/warm-close-timeout.ts)
--
-- THE COLUMN IS ALSO THE CLAIM, and that is why it is one column rather than a
-- table. The timer's claim-before-send is this single statement:
--
--   update guests set warm_close_sent_at = now()
--    where id = $1 and warm_close_sent_at is null
--
-- rowcount 1 owns the close; rowcount 0 means another tick took it. Because the
-- predicate is `is null` rather than a date comparison, the same statement
-- enforces once per guest EVER, not once per day. TAC-536 needed a whole table
-- (instagram_scan_arrivals, migration 064) because a scan is an event nothing
-- else records; here the event is our own last outbound, already in `messages`,
-- so the due set is derived and only the marker needs storage.
--
-- NO INDEX. Every read is by primary key: the processor already has the guest
-- id from its own candidate scan, and the write is the CAS above.
--
-- NO BACKFILL, and NOT NULL is wrong here. NULL is the honest value for every
-- existing guest: the mechanism did not exist, so no close was sent. A default
-- of now() would claim every guest on file had already been closed, which would
-- switch the feature off for the entire fleet on the day it shipped.
--
-- `guests` is NOT on the high-stakes list (messages, engagement_events,
-- voice_corpus), so this is standard care rather than a hard stop.
--
-- APPLY IN STUDIO BEFORE MERGING. Additive, but the deployed code both SELECTs
-- and UPDATEs the column on the next tick after merge, and the cron route
-- answers 200 whatever happens inside it, so a missing column would surface as
-- a processor that silently claims nothing rather than as an error anyone sees.
-- Then run `npm run db:types`.
--
-- Single table, so no lock ordering is needed (the messages-first rule in
-- db/migrations/CLAUDE.md binds when a migration touches more than one).

alter table guests add column warm_close_sent_at timestamptz;

comment on column guests.warm_close_sent_at is
  'TAC-560: when the warm "line is open" close was sent to this guest, from either the in-conversation path or the pause timer. NULL means never. This column is both the once-per-guest-ever marker and the timer''s CAS claim (update ... where warm_close_sent_at is null).';

-- Rollback. Safe at any time: nothing else reads this column, so dropping it
-- loses only the record of which guests have already been closed. The cost of
-- rolling back and forward again is that those guests could receive a second
-- close, which is why the code should be reverted with it rather than left
-- running against a missing column.
--
--   alter table guests drop column warm_close_sent_at;
