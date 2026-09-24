-- 061_instagram_oauth_and_deletion.sql
-- TAC-516: the two tables the CONNECT FLOW and Meta's DELETION CALLBACK need.
--
-- Split from 060 so the token half stands alone. 060 is everything needed to
-- store and refresh a venue's token, and is useful before any button exists;
-- these two tables are only reachable once the OAuth flow and Meta's callbacks
-- are live. Two files, because they are two separable changes and the record
-- should say so. Applied together in one Studio session (ruled 2026-09-24):
-- two applies is two chances to run one and not the other.
--
-- ============================================================================
-- instagram_oauth_states: single-use state for the connect round trip
-- ============================================================================
--
-- The signed state alone CANNOT refuse a replay. A signature proves the value
-- came from us and has not been altered, and an embedded expiry proves it is
-- recent — but the same correctly-signed, unexpired value can be presented
-- any number of times, and nothing in the signature changes between them.
-- Single use has to be server-side state, which is this table.
--
-- `lib/pos/square/oauth-state.ts` is this repo's existing signed-state helper
-- and could not be reused: it signs a bare venue id with no expiry and no
-- nonce, so its values are valid forever and replayable. That is tolerable for
-- Square's flow and is not what this ticket's AC asks for.
--
-- The claim is a CAS UPDATE (`... WHERE consumed_at IS NULL AND expires_at >
-- now()`), so the ROW COUNT is the guarantee rather than an application-level
-- check-then-act. Same shape as transitionToPendingAck. Two callbacks racing
-- the same state value means exactly one wins.
--
-- NO CLEANUP JOB, deliberately. Rows accrue at connect-attempt scale, which is
-- a handful per venue ever, and nothing reads a stale one past its own expiry
-- check. A housekeeping ticket if that ever stops being true.
--
-- ============================================================================
-- instagram_deletion_requests: the audit trail for Meta's deletion callback
-- ============================================================================
--
-- Meta requires the callback to return a confirmation code and a status URL
-- the user can check, so the code has to be persisted and looked up later.
--
-- THIS TABLE IS THE RECEIPT, NOT THE DELETION (ruled 2026-09-23, question 2).
-- Recording the request was the option that ruling REJECTED as insufficient;
-- the callback actually redacts the guest data. This row exists alongside that
-- work so there is an auditable answer to "what did we do and when", which is
-- what a regulator or Meta's own tester would ask.
--
-- `venue_id` is NULLABLE and ON DELETE SET NULL: Meta can send a deletion
-- request for an account we have no venue for — a stale attempt, an account
-- that never finished connecting, or one already deauthorized and cleared. A
-- request we cannot match still gets recorded and still gets a well-formed
-- response, because refusing would fail Meta's test for a case that is not an
-- error.
--
-- PURELY ADDITIVE: two new tables, no drops, no column changes, no tightened
-- constraints. Applied in Studio by Jaipal; nothing in this repo runs it.

begin;

set local lock_timeout = '5s';

create table instagram_oauth_states (
  id uuid primary key default gen_random_uuid(),

  -- The random value carried in the signed state and echoed back by Meta.
  -- UNIQUE is what makes the claim single-use: two rows could never both be
  -- claimed for one presented value.
  state_nonce text not null unique,

  venue_id uuid not null references venues(id) on delete cascade,

  -- Which operator started the flow. NOT NULL: the connect endpoint is
  -- authenticated, so there is always one, and it is stamped onto the
  -- credential as connected_by_operator_id.
  operator_id uuid not null references operators(id) on delete cascade,

  -- Checked in SQL by the claim as well as in the signature. Belt and braces:
  -- the signature proves the expiry has not been altered, this proves the row
  -- was not issued longer ago than we think.
  expires_at timestamptz not null,

  -- Set by the CAS claim. Non-null means this state has been used, and the
  -- second presentation of the same value loses.
  consumed_at timestamptz,

  created_at timestamptz not null default now()
);

-- "is this nonce claimable" — the callback's only read. The unique constraint
-- on state_nonce already indexes the lookup, so this covers the sweep a
-- future cleanup job would want and nothing else.
create index idx_instagram_oauth_states_expiry
  on instagram_oauth_states (expires_at)
  where consumed_at is null;

comment on table instagram_oauth_states is
  'TAC-516: single-use state for the Instagram connect round trip. The signature proves the value is ours and unexpired; this table is what refuses a REPLAY, via a CAS claim on consumed_at.';

create table instagram_deletion_requests (
  id uuid primary key default gen_random_uuid(),

  -- Returned to Meta and echoed on the status page. UNIQUE because it is the
  -- lookup key for that page.
  confirmation_code text not null unique,

  -- The Instagram account Meta named in the signed request. Kept as text even
  -- when no venue matches, so an unmatched request is still traceable.
  instagram_account_id text not null,

  -- Null when no venue matched, or when the venue is later deleted.
  venue_id uuid references venues(id) on delete set null,

  -- How many guest rows were redacted. Zero is a legitimate answer: a repeat
  -- request finds nothing left to redact, which is what idempotent looks like.
  guests_affected integer not null default 0,

  requested_at timestamptz not null default now(),

  -- Set once the redaction finished. Null means it did not complete, which is
  -- what the status page reports as pending.
  completed_at timestamptz
);

create index idx_instagram_deletion_requests_account
  on instagram_deletion_requests (instagram_account_id, requested_at desc);

comment on table instagram_deletion_requests is
  'TAC-516: the receipt for a Meta data-deletion request. The deletion itself redacts guest rows; this records that it was asked for and what it touched. A row with venue_id null is a request for an account no venue owns, which is recorded rather than refused.';

commit;

-- rollback:
--   begin;
--   drop table if exists instagram_oauth_states;
--   drop table if exists instagram_deletion_requests;
--   commit;
--
-- Safe only while the connect flow and the callbacks are NOT deployed, or are
-- deployed and unused. Dropping instagram_oauth_states makes every in-flight
-- connect attempt fail at the callback (the operator retries, and gets a new
-- state), which is recoverable. Dropping instagram_deletion_requests destroys
-- the audit trail for deletion requests already honoured; the guest data
-- stays redacted either way, but the record that it was asked for is gone.
-- Check before dropping:
--   select count(*) from instagram_deletion_requests;
