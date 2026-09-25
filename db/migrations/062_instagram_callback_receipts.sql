-- 062_instagram_callback_receipts.sql
-- TAC-516 follow-up: one row per VERIFIED Meta callback delivery, carrying
-- enough of the payload to recognise a repeat.
--
-- WHY THIS EXISTS. `signed_request` carries no nonce, so a captured genuine
-- callback stays valid until INSTAGRAM_APP_SECRET rotates. That replay window
-- is deliberately left OPEN (ruled 2026-09-24): the only check Meta's scheme
-- allows is an age window, and on these two callbacks refusing a genuine
-- request is worse than accepting a replayed one in both directions —
-- refusing a deauthorize keeps a token the venue revoked, refusing a deletion
-- is a compliance failure with a deadline, and both are reachable by ordinary
-- clock skew. Accepting the replay is the lesser harm.
--
-- What that ruling does NOT accept is the replay being INVISIBLE. The one real
-- exposure is narrow and specific: a guest messages the venue AFTER a deletion
-- has been honoured, and a replayed request then redacts those new rows too.
-- Before this table that left no trace anywhere. Now it leaves a row, and the
-- repeat is linked to the delivery it repeats.
--
-- WHY NOT `inbound_turn_outcomes` (migration 055). That table is one row per
-- INBOUND GUEST TURN — a guest action that could have warranted a reply — and
-- three things make it the wrong shape here rather than merely a loose fit:
--   - its `reason` and `outcome` CHECK vocabularies are agent-layer and
--     Sendblue-bail specific, and a callback is neither;
--   - these deliveries are Meta APP-level events with no guest at all, and
--     often no venue, where that table's whole purpose is a per-turn ledger;
--   - CLAUDE.md documents `where outcome <> 'skipped_duplicate'` as the strict
--     turn count, so adding callback rows would silently corrupt the one query
--     that table exists to answer.
-- So: its own table, beside the callbacks' own existing writes.
--
-- WHY NOT COLUMNS ON `instagram_deletion_requests` (migration 061). That table
-- is Meta-facing — it is what the confirmation code and the public status page
-- read. This one is audit-facing and covers BOTH callbacks, where deauthorize
-- has no receipt at all today (it only sets flags on instagram_credentials, so
-- a replay overwrites the same values and is invisible by construction). Two
-- tables, two jobs; the deletion row and its receipt are linked by
-- `confirmation_code`.
--
-- THE FINGERPRINT IS OVER THE PAYLOAD HALF ONLY, NEVER THE SIGNATURE, and that
-- is a rule rather than a detail. CLAUDE.md's standing instruction is that our
-- HMAC digest is never stored or logged, because our digest of a payload is a
-- valid signature for that payload until the secret rotates. A sha256 of the
-- payload half cannot be turned back into a signature, identifies an exact
-- repeat just as well (same payload means the same user_id and issued_at), and
-- keeps the signature out of the database entirely.
--
-- PURELY ADDITIVE: one new table, no drops, no column changes, no tightened
-- constraints. But the deployed code INSERTs into it on the very next verified
-- callback, so apply in Studio BEFORE merging — the call migrations 026, 029,
-- 035 and 055 all made on their own new tables.

begin;

set local lock_timeout = '5s';

create table instagram_callback_receipts (
  id uuid primary key default gen_random_uuid(),

  -- Which callback. CHECK rather than free text so a third one has to be
  -- added deliberately; the TS vocabulary is bound to this list by a test.
  callback text not null check (callback in ('deauthorize', 'data_deletion')),

  -- The account Meta named. Text, and kept even when no venue matches, so an
  -- unmatched delivery is still traceable.
  instagram_account_id text not null,

  -- sha256, hex, of the signed request's PAYLOAD half. See the header: never
  -- the signature, never our digest.
  signed_request_fingerprint text not null,

  -- Meta's own `issued_at`, when the payload carries one. Nullable because
  -- some callbacks omit it — which is exactly why an age check could not be
  -- made to fail closed safely, and why this is a trail rather than a gate.
  payload_issued_at timestamptz,

  received_at timestamptz not null default now(),

  -- Null when no venue matched, or when the venue is later deleted.
  venue_id uuid references venues(id) on delete set null,

  -- What we did with it. Closed vocabulary, bound to TS by a test.
  outcome text not null check (
    outcome in ('applied', 'no_match', 'failed')
  ),

  -- Whether the repeat lookup actually ran. FALSE means the read failed and
  -- this row's repeat status is UNKNOWN, not "first delivery".
  --
  -- Without this column the two are identical in the row — repeat_of_receipt_id
  -- is null either way — so a replay arriving during a database blip would
  -- read forever after as a first delivery, which is precisely the
  -- invisibility this table exists to remove. Found by a surviving mutant: the
  -- code had a variable for this and never stored it.
  repeat_checked boolean not null default true,

  -- The EARLIER receipt carrying this same fingerprint, when there was one.
  -- Self-referencing and ON DELETE SET NULL: losing the original must not
  -- take the repeat's row with it, because the repeat is the interesting one.
  repeat_of_receipt_id uuid references instagram_callback_receipts(id) on delete set null,

  -- How many guest rows THIS delivery redacted. Null for deauthorize, which
  -- touches no guest data at all. On a repeat, a non-zero value here is the
  -- exposure the header names: rows that existed only because they were
  -- created after the original request.
  rows_affected integer,

  -- Links a data_deletion receipt to its Meta-facing row. Null for
  -- deauthorize, and null when the receipt could be written but that row
  -- could not.
  confirmation_code text
);

-- The repeat lookup, which runs once per verified delivery: "have I seen this
-- exact payload before". Newest first so the read takes the most recent.
create index idx_instagram_callback_receipts_fingerprint
  on instagram_callback_receipts (signed_request_fingerprint, received_at desc);

-- "what has this account sent us, in order" — the audit read.
create index idx_instagram_callback_receipts_account
  on instagram_callback_receipts (instagram_account_id, received_at desc);

comment on table instagram_callback_receipts is
  'TAC-516: one row per verified Meta callback delivery (deauthorize, data deletion). Replay is accepted rather than refused (signed_request carries no nonce, and refusing a genuine request is worse on both callbacks), so this is what makes a replay visible: repeat_of_receipt_id links a delivery to the earlier one carrying the same payload.';

comment on column instagram_callback_receipts.signed_request_fingerprint is
  'sha256 hex of the signed request''s PAYLOAD half only. Never the signature and never our HMAC digest, which would be a valid forgery for that payload until the secret rotates.';

comment on column instagram_callback_receipts.repeat_checked is
  'False when the repeat lookup itself failed: the row''s repeat status is UNKNOWN, not "first delivery". Any query counting first deliveries must exclude these.';

comment on column instagram_callback_receipts.rows_affected is
  'Guest rows redacted by THIS delivery; null for deauthorize. Non-zero on a row with repeat_of_receipt_id set is the replay exposure: rows created after the original request was honoured.';

commit;

-- rollback:
--   begin;
--   drop table if exists instagram_callback_receipts;
--   commit;
--
-- Safe at any time as far as the callbacks are concerned: both write this row
-- on a best-effort basis and neither fails the delivery when it cannot be
-- written (a non-2xx eventually costs us the callback itself, which is worse
-- than a missing audit row). Dropping it therefore returns both callbacks to
-- their pre-062 behaviour rather than breaking them.
--
-- It DOES destroy the replay trail, which is the only record that a repeated
-- delivery was repeated. Check before dropping:
--   select callback, count(*) filter (where repeat_of_receipt_id is not null) as repeats,
--          count(*) as total
--   from instagram_callback_receipts group by callback;
