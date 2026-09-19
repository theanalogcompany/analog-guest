-- TAC-469 PR B: an Instagram follow-up is RECORDED, never sent.
--
-- Instagram's 24-hour reply window means a follow-up fires when the venue
-- usually cannot message the guest at all, and nothing reopens the window but
-- the guest acting. So the engine runs its detectors, its Gate 1 checks and its
-- claim exactly as it does for SMS, and then, instead of dispatching, marks the
-- claim as a task for a human to complete. TAC-486 is the surface that shows
-- them; until it ships these rows are the only durable record that the venue
-- owed this guest a touch, which is the whole point: nothing may silently
-- vanish.
--
-- WHY A TIMESTAMP AND NOT AN ID. The plan called this `manual_task_id`, and
-- there is no task table for it to reference: `followup_log.id` is already the
-- stable handle TAC-486 joins on, and a uuid column named `_id` pointing at
-- nothing is a name that promises a foreign key it does not have. The column's
-- one real job is telling a RECORDED TASK apart from an ORPHANED CLAIM, since
-- both leave `message_id` null, and a timestamp does that job while also
-- recording when. Ruled 2026-09-19.
--
-- The CHECK is the invariant: a claim is a send or a task, never both. A row
-- with neither is still the orphan-claim audit signal migration 029 describes,
-- so that query becomes
--
--   select * from followup_log
--   where message_id is null and manual_task_recorded_at is null
--     and created_at < now() - interval '1 day';
--
-- NO BACKFILL. Every existing row predates Instagram follow-ups entirely, and
-- null correctly means "not a task". Nullable rather than defaulted for the
-- same reason: a default would claim every historical SMS send was a task.
--
-- Additive, but the deployed engine WRITES this column on its next hourly tick
-- after the code lands, so apply in Studio BEFORE merging the PR — the same
-- call migration 029 made on this table, and for the same reason: the engine
-- never throws into the cron, so a missing column would surface as a claim that
-- can never be finalised, burning the dedup with nothing recorded.
--
-- `followup_log` is not on the high-stakes table list. Standard care.

begin;

alter table followup_log
  add column manual_task_recorded_at timestamptz;

comment on column followup_log.manual_task_recorded_at is
  'When this claim was recorded as a task for a human to complete rather than sent (TAC-469). Instagram only today: the 24-hour reply window is usually shut when a follow-up fires. Mutually exclusive with message_id; both null is an orphaned claim.';

alter table followup_log
  add constraint followup_log_task_xor_message
  check (not (message_id is not null and manual_task_recorded_at is not null));

-- The read TAC-486 makes: tasks awaiting a human, newest first. Partial so it
-- stays small — the overwhelming majority of rows are sends.
create index idx_followup_log_manual_tasks
  on followup_log (venue_id, manual_task_recorded_at desc)
  where manual_task_recorded_at is not null;

commit;

-- Verification (read-only, after applying):
--
--   select count(*) as rows_total,
--          count(manual_task_recorded_at) as tasks,
--          count(message_id) as sends
--   from followup_log;
--
-- `tasks` must be 0 immediately after applying: nothing writes the column until
-- the PR deploys. Both counts non-zero on the same row is impossible under the
-- CHECK; if that ever appears, the constraint was dropped.
--
-- Rollback (safe at any time — no reader outside the engine, and a dropped
-- column simply returns the engine to refusing Instagram follow-ups):
--
--   begin;
--   drop index if exists idx_followup_log_manual_tasks;
--   alter table followup_log drop constraint if exists followup_log_task_xor_message;
--   alter table followup_log drop column if exists manual_task_recorded_at;
--   commit;
