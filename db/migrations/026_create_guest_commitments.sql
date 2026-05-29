-- 026_create_guest_commitments.sql
-- adds the per-guest commitments table for tac-297 — every promise the agent
-- makes in conversation (a comped drink, a held croissant, an off-menu rec).
-- the table records promises and, when a guest signals arrival, converts them
-- into a timed heads-up the venue can act on.
--
-- lifecycle: status moves
--   open                                    (just promised; agent waiting for arrival signal)
--     → pending_ack                         (guest signaled arrival; operator has been pushed)
--       → acknowledged                      (operator swiped right on the heads-up card)
--       → cancelled                         (operator cancelled before ack)
--     → expired                             (expires_at elapsed without a signal)
--     → cancelled                           (operator cancelled before signal)
--     → redeemed                            (operator marked actually-fulfilled; future ticket)
--
-- transitions are app-side via CAS UPDATEs in lib/guests/commitments.ts.
-- the conditional WHERE clause anchors push idempotency: a transition that
-- returns rowcount=0 means another caller (concurrent imminent inbound +
-- cron firing on the same row) won the race and the push must not fire
-- twice (tac-297 design call #4).
--
-- per-venue isolation: row carries venue_id NOT NULL. consistent with the
-- repo's app-layer isolation pattern (withOperatorAuth + allowedVenueIds);
-- no RLS policy added — no RLS policies exist in the repo today, and the
-- agent + cron paths use the service role and would bypass RLS regardless.
-- (tac-297 design call #3 confirmed this supersession.)
--
-- intent carrier interaction: the gated path (comp/hold/discount) does NOT
-- write rows directly. instead the agent's commitment intent rides through
-- the approval queue in messages.pending_commitment (migration 027). on
-- successful dispatch, dispatch-operator-outbound.ts reads that jsonb and
-- calls createCommitmentFromPending here. rejected/skipped draft → never
-- dispatched → no row created. (tac-297 design call #1.)
--
-- ungated path (recommendation type): scheduleAndSend writes the row inline
-- on dispatch success — recs don't queue, so no jsonb carrier is needed for
-- that path.
--
-- code column: cosmetic verification chip for comp/hold/discount only —
-- the operator reads the code aloud or types it to confirm the right guest
-- before handing over the item. populated by lib/guests/commitments.ts
-- (createCommitmentFromPending) using pendingFromEmission, which generates
-- a 4-char alphanumeric code if the agent didn't emit one. null for
-- recommendation type.
--
-- additive only: new table, no schema changes to existing tables. per
-- CLAUDE.md "Ordering for backwards-incompatible migrations" this is
-- backwards-compatible — order doesn't matter, but apply BEFORE the code
-- deploys SELECTs against it on the read path (build-runtime-context).

create table guest_commitments (
  id uuid primary key default gen_random_uuid(),
  guest_id uuid not null references guests(id) on delete cascade,
  venue_id uuid not null references venues(id) on delete cascade,
  type text not null check (type in ('recommendation', 'hold', 'comp', 'discount')),
  description text not null,
  code text,
  status text not null default 'open' check (
    status in ('open', 'pending_ack', 'acknowledged', 'redeemed', 'expired', 'cancelled')
  ),
  expected_arrival timestamptz,
  arrival_signal text check (arrival_signal in ('imminent', 'scheduled')),
  created_by text not null default 'agent' check (created_by in ('agent', 'operator')),
  expires_at timestamptz,
  acknowledged_at timestamptz,
  acknowledged_by uuid references operators(id) on delete set null,
  redeemed_at timestamptz,
  source_message_id uuid references messages(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger trg_guest_commitments_updated_at
  before update on guest_commitments
  for each row execute function set_updated_at();

-- cron query: find open commitments due for transition. partial index keeps
-- it sparse (most rows have status != 'open' over time).
create index idx_guest_commitments_due
  on guest_commitments (expected_arrival)
  where status = 'open' and expected_arrival is not null;

-- runtime lookup: load active commitments for a guest into the agent's
-- ## Active commitments prompt block. partial filter avoids dragging in
-- acknowledged/expired/cancelled history.
create index idx_guest_commitments_active_for_guest
  on guest_commitments (venue_id, guest_id, status)
  where status in ('open', 'pending_ack');

-- operator queue read: list pending_ack heads-ups for the operator's
-- allowed venues, ordered oldest-first to match list_operator_queue
-- convention. partial index keeps the index sparse.
create index idx_guest_commitments_pending_ack_venue
  on guest_commitments (venue_id, created_at)
  where status = 'pending_ack';

-- realtime publication: tac-298 (operator card) subscribes to this table so
-- a newly pending_ack row surfaces live without polling. mirrors the
-- messages-table subscription used by the conversations viewer
-- (lib/db/browser.ts pattern).
alter publication supabase_realtime add table guest_commitments;
