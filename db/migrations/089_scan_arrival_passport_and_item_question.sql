-- 089: instagram_scan_arrivals learns about the passport and the item question
-- (TAC-588).
--
-- A scan that carries a receipt code now binds the order, sends the passport
-- images, and only THEN says hello, with a compliment on what they ordered.
-- About twenty minutes after the order it asks how they liked it. Both of
-- those are timed off this row, so both need columns on it.
--
-- THE PASSPORT HALF. The hello waits for the two images (stamp, then spread)
-- and goes a few seconds after them. Two runners decide when the hello is due,
-- the webhook's fast path and the every-minute cron behind it, and they must
-- agree, so the facts live here rather than in one runner's memory:
--
--   awaits_passport      the scan carried a receipt code, so a stamp run was
--                        started for it. False for the counter sign, which
--                        keeps today's twenty-second hello.
--   passport_settled_at  when that run ended, either way. Null while it is
--                        still running; a run that died leaves it null and the
--                        hello falls back after a cap (PASSPORT_WAIT_CAP_MS).
--   passport_sent_at     when both images reached the guest. Null when the
--                        run ended without sending (no passport configured,
--                        opted out, a failed send, an expired code), which
--                        sends the hello on the twenty-second fallback.
--
-- THE ITEM QUESTION HALF. "How'd you like the cortado?" goes at the order plus
-- twenty minutes, never sooner than five minutes after the hello. It replaces
-- the ten-to-thirty-minute check-back for a scan visit, and is the visit's one
-- check-back once it goes:
--
--   item_question_due_at      written when the hello goes out for a scan with
--                             a bound order. Null on every other row: no
--                             question is owed.
--   item_question_claimed_at  the claim, taken before the send (the house
--                             rule, as claimed_at above). Also taken, with no
--                             send, when the guest wrote back first: that
--                             cancels the timer for good.
--   item_question_sent_at     set only once the question reached the guest.
--   item_question_outcome     what the claim became: 'sent', 'queued' (held
--                             for an operator), 'cancelled' (the guest wrote
--                             back first), 'too_late', 'no_item', 'no_hello',
--                             'refused', or another status the send kept its
--                             claim on ('superseded'). Null while
--                             unclaimed or while a claimed send is in flight.
--                             The claim alone cannot tell a cancelled timer
--                             from one that is sending, and the reply path
--                             may only ask after a cancel. Free text, no
--                             CHECK, for the reason below; the writer is
--                             lib/agent/scan-item-question.ts.
--
-- WHAT IS NOT HERE, ON PURPOSE. The bound order's id: it is derived from the
-- scan's own referral code through pos_tap_events.reconciled_transaction_id,
-- so there is one record of which order a scan bound and no copy to drift.
-- No CHECK, no index and no foreign key: each would be a constraint or index on
-- a live table. The due read filters on two of these columns over a table that
-- holds one row per scan.
--
-- APPLY BEFORE MERGING. The new code reads and writes every column, and the
-- deployed code reads none of them, so applying it early is safe.

begin;

set local lock_timeout = '5s';

alter table instagram_scan_arrivals
  add column awaits_passport boolean not null default false,
  add column passport_settled_at timestamptz,
  add column passport_sent_at timestamptz,
  add column item_question_due_at timestamptz,
  add column item_question_claimed_at timestamptz,
  add column item_question_sent_at timestamptz,
  add column item_question_outcome text;

comment on column instagram_scan_arrivals.awaits_passport is
  'TAC-588: the scan carried a receipt code, so a passport stamp run was started and the hello waits for it.';
comment on column instagram_scan_arrivals.passport_settled_at is
  'TAC-588: when the stamp run for this scan ended, sent or not. Null while it runs.';
comment on column instagram_scan_arrivals.passport_sent_at is
  'TAC-588: when both passport images reached the guest. The hello is due a few seconds after it.';
comment on column instagram_scan_arrivals.item_question_due_at is
  'TAC-588: when the item question is due (order + 20 min, at least hello + 5 min). Null when none is owed.';
comment on column instagram_scan_arrivals.item_question_claimed_at is
  'TAC-588: the item question claim, taken before the send, or with no send when the guest wrote back first.';
comment on column instagram_scan_arrivals.item_question_sent_at is
  'TAC-588: when the item question reached the guest.';
comment on column instagram_scan_arrivals.item_question_outcome is
  'TAC-588: what the item question claim became: sent, queued, cancelled, too_late, no_item, no_hello, refused or another kept status. Null while unclaimed or in flight.';

commit;
