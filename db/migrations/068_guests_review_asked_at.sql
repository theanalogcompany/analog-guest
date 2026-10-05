-- The once-per-guest-ever marker behind the Google review ask.
--
-- One nullable timestamptz on `guests`. NULL means this guest has never been
-- asked for a review. Two paths write it, both strictly post-dispatch and both
-- only when the body that actually reached the guest contains the venue's
-- review link character for character (lib/agent/review-ask.ts owns the one
-- definition of "received the ask"):
--
--   the auto-send path         (handle-inbound.ts, against deliveredBody, so a
--                               partially delivered Instagram split whose tail
--                               bubble died does not stamp)
--   the operator-approved path (lib/operator/dispatch-operator-outbound.ts,
--                               against the dispatched body, so an operator who
--                               edits the link out before approving does not
--                               stamp, and one who types it into any draft does)
--
-- Never written at queue time: a skipped or declined pending card leaves this
-- NULL and the guest re-eligible on their next praise.
--
-- THE COLUMN IS ALSO THE CLAIM, same design as warm_close_sent_at (065):
--
--   update guests set review_asked_at = now()
--    where id = $1 and venue_id = $2 and review_asked_at is null
--
-- rowcount 1 owns the ask; rowcount 0 means another run took it. `is null`
-- rather than a date comparison is what makes this once per guest EVER.
-- Guests are per-venue rows, so one column is already per guest per venue.
--
-- NO INDEX. Every read rides buildRuntimeContext's existing primary-key select,
-- and the write is the CAS above.
--
-- NO BACKFILL, and NOT NULL is wrong here. NULL is the honest value for every
-- existing guest: the mechanism did not exist, so no ask was sent. A default of
-- now() would switch the feature off for the entire fleet on day one.
--
-- `guests` is NOT on the high-stakes list (messages, engagement_events,
-- voice_corpus), so this is standard care rather than a hard stop.
--
-- APPLY IN STUDIO BEFORE MERGING. Additive, but the deployed code SELECTs the
-- column on every inbound turn the moment the merge deploys, and the webhook
-- route answers 200 whatever happens inside it, so a missing column surfaces as
-- silently lost guest messages rather than as an error anyone sees. Then run
-- `npm run db:types`.
--
-- Single table, so no lock ordering is needed (the messages-first rule in
-- db/migrations/CLAUDE.md binds when a migration touches more than one).

alter table guests add column review_asked_at timestamptz;

comment on column guests.review_asked_at is
  'When the Google review ask reached this guest (body containing the venue''s review link actually dispatched, auto-send or operator-approved). NULL means never asked. This column is both the once-per-guest-ever marker and the CAS claim (update ... where review_asked_at is null).';

-- Rollback. Safe at any time: nothing else reads this column, so dropping it
-- loses only the record of who has already been asked. Rolling back and
-- forward again could ask those guests a second time, which is why the code
-- should be reverted with it rather than left running against a missing column.
--
--   alter table guests drop column review_asked_at;
