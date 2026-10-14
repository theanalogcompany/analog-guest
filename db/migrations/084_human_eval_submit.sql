-- 084: submitting a blind human-evaluation pass.
--
-- A pass had no finish line. Every row was editable forever, the CSV link was
-- always live, and "is this pass done?" had no answer anywhere - so a file
-- downloaded halfway through a pass and a file downloaded at the end were the
-- same artifact with the same name, and nothing distinguished them.
--
-- SUBMITTING IS THAT LINE, and it is one-way. The route refuses a pass that is
-- not complete (every judgeable question generated, both verdicts on every
-- judgeable row, a comment wherever something failed), stamps these two
-- columns, and from then on every write route on the pass answers 409 and the
-- export will serve the CSV. The order matters: the file can only be generated
-- for a pass that can no longer change, so "this CSV is what was judged" is a
-- property of the schema rather than a claim in a README.
--
-- `submitted_by` IS NOT `rated_by`. The admin who signs a pass off need not be
-- the one who ran it, and one column meaning both would answer neither.
--
-- NO UNSUBMIT, deliberately - not a route, not a button. Reopening a pass
-- makes an already-downloaded file a lie about rows that moved after it was
-- written. A pass that genuinely has to reopen is an operator UPDATE in
-- Studio, which is a deliberate act by a person who knows the file is now
-- stale.
--
-- Additive: two nullable columns, no default, no backfill. Every existing pass
-- reads as unsubmitted, which is exactly what it is.
--
-- `npm run db:apply -- 084_human_eval_submit.sql`, and applied BEFORE merging:
-- the /admin/tests/human-eval loader selects both columns on first render
-- (root CLAUDE.md, "additive but the deployed code reads it").

begin;

alter table human_eval_sessions
  add column submitted_at timestamptz,
  add column submitted_by uuid;

comment on column human_eval_sessions.submitted_at is
  'When the pass was submitted. Null means in progress - the pass is editable and its CSV cannot be generated. Set once by the submit route, which refuses an incomplete pass; every write route on the pass refuses once it is set.';

comment on column human_eval_sessions.submitted_by is
  'The analog admin who submitted the pass, which is not necessarily rated_by - the admin who ran it. No FK, same reason as rated_by (083''s header).';

commit;
