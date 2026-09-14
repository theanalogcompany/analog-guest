-- TAC-341: commitment lifecycle — expiry and escalation for obligations.
--
-- ONE nullable column. The status enum needs NO change: migration 026 already
-- permits all six of open / pending_ack / acknowledged / redeemed / expired /
-- cancelled. 'expired' has simply never been written by anything. Verified
-- against 026 lines 58-59 before writing this file rather than assumed.
--
-- WHY A COLUMN IS REQUIRED, since the ticket originally said no migration.
-- Escalation needs durable state or it is not idempotent. The lifecycle cron
-- runs hourly and re-reads every open obligation; with nothing on the row to
-- say "a human has already been told about this one", a comp that escalates
-- at 7 days against a 2-year horizon would re-fire its Slack alert on every
-- tick for the rest of the horizon — roughly 17,000 alerts for one commitment.
-- That does not make the alert noisy, it makes it worthless, which is the
-- same way the comp_regex_backstop illusion was paid for. The AC's "no
-- migration" was scoped to the STATUS ENUM; this is orthogonal to it.
--
-- escalated_at is an IDEMPOTENCY MARKER, not an audit trail. It answers
-- exactly one question — has this row already surfaced to a human — and the
-- reason it surfaced rides on the PostHog/Slack event instead. Resisting the
-- urge to also add escalated_reason / escalation_count keeps the column
-- honest about the one job it has, and the event carries what an analyst
-- would actually query.
--
-- NOT a status value. 'escalated' as a seventh status would have meant
-- widening guest_commitments_status_check and, worse, would have taken the
-- row OUT of 'open' — which is the filter that every other consumer keys on
-- (findActiveCommitmentsForGuest, the ## Active commitments prompt block,
-- migration 037's open-dedup index). An escalated commitment is still open.
-- It is still owed. The venue still has to honour it. Escalation is a
-- notification fact about the row, not a lifecycle state of the promise, and
-- putting it on an axis of its own is what keeps those two things separable.
--
-- ORDERING: additive (one nullable column, no default, no backfill, no
-- constraint change), but the deployed code SELECTs escalated_at on the
-- lifecycle scan, so apply in Studio BEFORE merging the PR, per CLAUDE.md
-- §"Ordering for backwards-incompatible migrations" — the SELECT side is the
-- backwards-incompatible half even when the schema change is not. Same call
-- migrations 025/026/034/035/036 made for the same reason.
--
-- Standard care. guest_commitments is not on the high-stakes table list
-- (messages / engagement_events / voice_corpus).

alter table guest_commitments
  add column escalated_at timestamptz;

comment on column guest_commitments.escalated_at is
  'TAC-341. Set once, by the commitment-lifecycle cron (or at creation when a '
  'hold falls back to the 23:59 horizon), the first time this obligation is '
  'surfaced to a human. NULL means never surfaced. Idempotency marker only — '
  'the reason rides on the commitment_escalated PostHog event. The row stays '
  'status=''open'' while escalated: the promise is still owed.';

-- Sibling of idx_guest_commitments_due (026), same partial shape, different
-- column: that one serves the arrival cron's expected_arrival scan, this one
-- serves the lifecycle cron's expires_at scan. Kept separate rather than
-- widened because the two crons ask genuinely different questions and a
-- composite would serve neither well.
--
-- Deliberately NOT filtered on type. The scan restricts to obligation types
-- in app code (OBLIGATION_TYPES), but baking 'recommendation' exclusion into
-- the index would silently need a migration the day TAC-380 changes what a
-- recommendation is. Partial on status alone keeps it sparse enough — most
-- rows leave 'open' over time — without encoding a product decision.
create index idx_guest_commitments_expiry
  on guest_commitments (expires_at)
  where status = 'open' and expires_at is not null;
