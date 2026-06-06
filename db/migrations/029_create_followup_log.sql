-- 029_create_followup_log.sql
-- adds the follow-up engine's per-reason dispatch audit table (tac-123).
-- powers per-reason dedup AND claim-before-side-effect idempotency.
--
-- shape:
--   - one row per (venue, guest, dedup_key) — the unique constraint enforces
--     this. multi-reason runs write multiple rows in the same engine pass,
--     all sharing one message_id (the run correlator).
--   - dedup_key is reason-appropriate text constructed at engine time:
--       post_visit:  'day_7:<last_visit_at_iso>'
--       cold_lapsed: 'cold:<last_visit_at_iso>'
--       perk_unlock: 'perk:<mechanic_id>'
--     keyed this way so dedup is intent-bound. cold_lapsed re-arms naturally
--     when a new visit moves last_visit_at forward (the new dedup_key is
--     different → no row exists yet → not suppressed). per the operator
--     clarification on this ticket.
--   - reason is the closed FollowupReason union (lib/ai/types.ts) but stored
--     as text + CHECK rather than enum so adding reasons (a future engine
--     ticket adds 'birthday' for instance) is a single migration to widen
--     the CHECK rather than an enum-rebuild dance.
--
-- idempotency anchor: tac-297 design call #4 sized this for the commitments
-- processor (CAS-gated UPDATE rowcount=1 → anchor for the push). the
-- follow-up engine is concurrent in the same way (GH Actions can overlap
-- or fire late) AND wider in the failure surface (a dispatch can fail
-- after the side-effect, leaving us holding a dedup we shouldn't have).
-- the operator's plan-review call: CLAIM before the side-effect.
--
-- flow (engine, per guest, per run):
--   1. compute reasons[] + dedup_keys[].
--   2. INSERT all rows with message_id=NULL in ONE multi-row statement.
--      NO `ON CONFLICT` clause — Postgres treats a multi-row INSERT as a
--      single statement, so any UNIQUE violation aborts the WHOLE
--      statement atomically and Supabase surfaces it as error code
--      '23505'. The helper (claimFollowupLogRows in lib/followups/log.ts)
--      catches '23505' specifically and returns {conflict: true}; the
--      engine skips the guest entirely. No partial-claim cleanup needed
--      because no partial state was ever committed.
--   3. call handleFollowup with the claimed reasons.
--   4. on AgentResult.sent / .queued → UPDATE rows set message_id =
--      <outbound id>. claim becomes a permanent log row.
--   5. on .refused → DELETE the claim rows. dedup not burned;
--      the guest will be re-evaluated on the next tick.
--   6. on .failed with stage in {context_build, classification, corpus,
--      generation} → DELETE the claim rows (pre-persist failure, no
--      side-effect occurred, safe to retry).
--   7. on .failed with stage in {persist, send} → LEAVE the claim row
--      in place with message_id=NULL. A `persist` or `send` failure may
--      have written a `messages` row but failed mid-dispatch; releasing
--      the claim would let the next tick re-claim and re-dispatch,
--      producing a duplicate. Orphan claim rows (message_id IS NULL,
--      created_at > 1 day ago) are the audit signal for manual operator
--      investigation. Documented in CLAUDE.md "Common gotchas".
--
-- this gives us "claim before side-effect" with a clean failure mode:
-- exactly one engine run can dispatch for a given (venue, guest, reason),
-- and a failed dispatch doesn't lose the guest. the trade-off is one
-- extra DB round trip per guest per tick (INSERT before, UPDATE/DELETE
-- after) — acceptable at pilot scale.
--
-- per-venue isolation: rows carry venue_id NOT NULL + FK. consistent with
-- the repo's app-layer isolation pattern (withOperatorAuth +
-- allowedVenueIds); no RLS policy added, matches the rest of the repo.
--
-- additive only — new table, no schema changes elsewhere. per CLAUDE.md
-- "Ordering for backwards-incompatible migrations" this is
-- backwards-compatible, but the deployed code INSERTs into it on the
-- engine's claim step, so apply in Studio BEFORE merging the PR. then
-- run `npm run db:types`. db/types.ts is hand-patched in the same commit.

create table followup_log (
  id uuid primary key default gen_random_uuid(),
  venue_id uuid not null references venues(id) on delete cascade,
  guest_id uuid not null references guests(id) on delete cascade,
  -- closed FollowupReason union (lib/ai/types.ts). widen via a follow-up
  -- migration if the engine adds reasons; the runtime narrows further via
  -- the Zod schema on read.
  reason text not null check (reason in (
    'post_visit_day_1',
    'post_visit_day_3',
    'post_visit_day_7',
    'post_visit_day_14',
    'cold_lapsed',
    'perk_unlock'
  )),
  -- reason-appropriate intent key (see header). enforces dedup per
  -- (venue, guest, reason+intent) without baking the reason structure into
  -- additional columns. the FollowupLogClaim type in lib/followups/log.ts
  -- documents the construction rules.
  dedup_key text not null,
  -- nullable on initial CLAIM insert (step 2 above). UPDATEd to the
  -- outbound messages.id on dispatch success (step 4). multi-reason runs
  -- share one message_id — that's the run correlator.
  message_id uuid references messages(id) on delete set null,
  created_at timestamptz not null default now()
);

-- dedup uniqueness + idempotency claim guard. (venue_id, guest_id,
-- dedup_key) is the unique grain — duplicate INSERT attempts return 23505
-- (unique_violation) which the engine catches as "already claimed."
create unique index idx_followup_log_dedup
  on followup_log (venue_id, guest_id, dedup_key);

-- weekly cap query: count engine-initiated rows per guest in the last 7d.
-- partial+sorted index by (venue_id, guest_id, created_at desc) makes the
-- bounded `SELECT count(*) WHERE created_at >= now() - interval '7 days'`
-- a sparse range scan. matches the canSendFollowup gate's read shape.
create index idx_followup_log_weekly
  on followup_log (venue_id, guest_id, created_at desc);

-- per-reason last-dispatch lookup: dedup gate reads "is there a row for
-- this (venue, guest, reason) within the dedup window?" — query goes via
-- the unique-index column set, but the reason filter benefits from a
-- compact (venue_id, guest_id, reason) covering pattern. duplicates the
-- unique index's column set in different order; pgsql planner can use it
-- when the WHERE shape favors equality on reason ahead of dedup_key
-- (canSendFollowup's case).
create index idx_followup_log_reason
  on followup_log (venue_id, guest_id, reason, created_at desc);

-- no updated_at — append-only by design. the claim/finalize/release flow
-- mutates message_id once on the happy path; never bumps created_at; never
-- touches rows once message_id is set.
