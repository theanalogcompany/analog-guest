-- 087: a submitted pass carries its own CSV.
--
-- Submitting a pass froze it and let its CSV exist (084), but the file was
-- never stored: the export route rebuilt every row from `human_eval_units` on
-- each download, including the two reply columns. So the replies were the
-- file, and "the pass is finished with it" could not be acted on - clearing
-- them would have served an empty spreadsheet forever after.
--
-- This column is the file, written once by the submit route from the same rows
-- the completeness check just read, before anything is cleared. Migration 088
-- is what then lets the replies go.
--
-- WHY THE WHOLE FILE RATHER THAN A POINTER. A pass is 58 rows and well under a
-- megabyte of text, this table is internal, and an object in Storage adds a
-- failure mode this does not have: a row saying the pass was submitted beside
-- an object that is missing. It also makes 084's "the file is the pass"
-- literal rather than derived - the artifact is the thing stored, not a
-- rendering of rows that are allowed to change underneath it. Nothing can
-- change them (every write route refuses a submitted pass), but that is a
-- property of three routes agreeing, and this is one column.
--
-- NULL IS EXPECTED AND IS NOT A DEGRADED STATE. Two cases: a pass still in
-- progress, which has no file by design, and a pass submitted before this
-- migration, whose replies are still in place. The export route reads this
-- column when it is set and falls back to building the file from the rows when
-- it is not, so both keep working - and that fallback is also what covers a
-- submit that stamped the pass and then failed to store the file.
--
-- NOT the filename, which stays derived (the git sha plus the pass's start,
-- `lib/eval/csv.ts`). Storing it would be a second copy of a naming rule the
-- golden set's export shares.
--
-- PURELY ADDITIVE, AND THE DEPLOYED CODE READS IT - one nullable column, no
-- default, no backfill, nothing altered. `npm run db:apply -- 087_human_eval_csv.sql`,
-- applied BEFORE merging: the export route selects it on the first download
-- after deploy (root CLAUDE.md, "additive but the deployed code reads it").
--
-- ALREADY APPLIED, AND RE-RUNNING THIS FILE NOW FAILS - deliberately noted
-- rather than left for someone to rediscover. The column went in while this
-- work was still numbered 085, before #387 and #388 took 085 and 086 for the
-- passport stamps and this file was renumbered. `db:apply` answers
-- `42701: column "csv" of relation "human_eval_sessions" already exists`,
-- which is the correct refusal and not a problem to fix: the live column is
-- nullable `text` and is the one this file describes. What did NOT move with
-- the renumber is the stored column comment, which still cross-references
-- migration 085 - restated in 088, because `add column` cannot be re-run and
-- `comment on` can.

begin;

alter table human_eval_sessions
  add column csv text;

comment on column human_eval_sessions.csv is
  'The pass as a CSV, written once by the submit route before the replies are cleared, and what the export route serves. Null on a pass still in progress, and on one submitted before migration 087 - the export route then builds the file from the rows instead. The filename is not stored; it stays derived from git_sha and started_at.';

commit;
