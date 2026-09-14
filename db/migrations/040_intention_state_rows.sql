-- 040_intention_state_rows.sql
-- TAC-380: seven intentions, gated on a conversational signal, with expiry
-- anchored to when each intention became ELIGIBLE rather than to guest creation.
--
-- guest_intention_prompts stops being a prompted-only table and becomes one
-- STATE row per (guest, intention):
--   - eligibility row: prompted_at IS NULL. The intention became askable at
--     eligible_at and has not been raised yet.
--   - prompted row: prompted_at IS NOT NULL. Raised, and closed for this guest.
--     An event-armed intention that a newer recommendation or order re-arms
--     keeps its last prompt and moves eligible_at past it, which reads as open
--     again; that is app logic, not schema. Migration 035's unique
--     (guest_id, intention_key) still caps it at one row per intention per guest.
--
-- That change silently inverts code written against the old meaning. Each trap
-- below has a test written BEFORE this file (TAC-380 ruling 2):
--   1. A reader that keys on row EXISTENCE now reads every eligible intention as
--      already asked: nothing renders, nothing records, the suite stays green.
--      Readers filter prompted_at IS NOT NULL in SQL
--      (lib/agent/intentions/load.ts; the Command Center's
--      load-intention-prompts.ts is trap 5).
--   2. The old recording write was an upsert with ignoreDuplicates, i.e.
--      ON CONFLICT DO NOTHING. Against an existing eligibility row it no-ops and
--      prompted_at is never stamped. The stamp is now an UPDATE guarded on
--      prompted_at IS NULL (lib/agent/intentions/record.ts).
--   3. prompted_at KEEPS its DEFAULT now() (see below), so an eligibility insert
--      that merely omits prompted_at is born already prompted. New code writes
--      prompted_at: null explicitly.
--
-- WHY THE now() DEFAULT STAYS IN THIS MIGRATION. The deployed, pre-TAC-380
-- recordIntentionPrompts omits prompted_at and relies on the default. Drop it
-- before deploy and every real prompt written in the apply-to-deploy window is
-- stored as NULL, which the new code reads as unasked and re-asks. Drop it in a
-- follow-up migration AFTER deploy (TAC-392): a now() default on a column where NULL means
-- "not yet raised" is a trap for any future writer.
--
-- ORDERING: additive only — a dropped NOT NULL, two nullable columns, one
-- nullable jsonb column, and data backfills. Deployed code SELECTs the new
-- columns, so apply in Studio BEFORE merging the PR. Then RE-RUN the backfill
-- block (between the markers) AFTER deploy. Every statement in it is idempotent,
-- and it catches the rows the old code writes between apply and deploy: those
-- carry a learn_first_order key, no eligible_at and no prompt_source.
--
-- Not on the high-stakes table list (messages / engagement_events /
-- voice_corpus). db/types.ts is hand-patched in the same commit until
-- `npm run db:types` runs post-apply.

begin;

-- NULL now means "eligible, not yet raised".
alter table guest_intention_prompts
  alter column prompted_at drop not null;

-- When the intention became askable. Expiry is measured from here (ruling 5).
-- Nullable because rows written by pre-TAC-380 code carry none until backfilled.
alter table guest_intention_prompts
  add column eligible_at timestamptz;

-- How a prompted row was closed:
--   'classified'  — the post-send classifier saw the sent message raise it.
--   'pessimistic' — the classifier failed twice, so every rendered intention was
--                   closed rather than risk re-asking (ruling 4).
-- Without it a pessimistic closure is indistinguishable from a real prompt, and
-- the unanswered-prompt brake would count a question that may never have been
-- asked. NULL on eligibility rows.
alter table guest_intention_prompts
  add column prompt_source text
  check (prompt_source in ('classified', 'pessimistic'));

-- Per-venue gating thresholds, parsed by lib/schemas/intention-rules.ts. NULL
-- means the code defaults, via parseIntentionRules, which fails open. No
-- backfill: every venue starts on the defaults.
alter table venue_configs
  add column intention_rules jsonb;

-- ===== BACKFILL — re-run this block after deploy =====

-- Every row written before this migration is a prompted row. It became eligible
-- no later than it was raised, and a closed row only uses eligible_at for display.
update guest_intention_prompts
set eligible_at = prompted_at
where eligible_at is null
  and prompted_at is not null;

-- Every prompted row written before this migration came from the classifier.
update guest_intention_prompts
set prompt_source = 'classified'
where prompt_source is null
  and prompted_at is not null;

-- learn_first_order is the same intention as understand_order, renamed.
-- invite_contact_save is retired and deliberately NOT migrated: the Command
-- Center renders its row as unrecognized, the honest rendering of a retired
-- intention (ruling 5). As of 2026-09-14 the only row fleet-wide is that
-- invite_contact_save orphan, so the rename below matches nothing today. It is
-- here for rows the old code writes before deploy.
--
-- The post-deploy re-run is the only time the unique constraint can bite: new
-- code may already have written an understand_order ELIGIBILITY row for a guest
-- whose learn_first_order PROMPT came from the old code in the window. A bare
-- rename would then fail the whole statement on the constraint. So first carry
-- the old prompt onto the new row — the guest WAS asked, and must not be asked
-- again — then drop the old row, then rename whatever is left.
update guest_intention_prompts as u
set prompted_at   = l.prompted_at,
    message_id    = l.message_id,
    prompt_source = coalesce(l.prompt_source, 'classified')
from guest_intention_prompts as l
where u.guest_id = l.guest_id
  and u.intention_key = 'understand_order'
  and u.prompted_at is null
  and l.intention_key = 'learn_first_order'
  and l.prompted_at is not null;

delete from guest_intention_prompts as l
where l.intention_key = 'learn_first_order'
  and exists (
    select 1
    from guest_intention_prompts as u
    where u.guest_id = l.guest_id
      and u.intention_key = 'understand_order'
  );

update guest_intention_prompts
set intention_key = 'understand_order'
where intention_key = 'learn_first_order';

-- ===== END BACKFILL =====

commit;
