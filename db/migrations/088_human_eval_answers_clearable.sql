-- 088: a submitted pass stops holding the replies.
--
-- OPERATOR-APPLIED. `alter column` is refused by `db:apply` by name, the same
-- refusal migration 077 took, so this file is pasted into Supabase Studio and
-- followed by `npm run db:types`. The refusal is a handoff, not an obstacle -
-- do not split it into additive-looking pieces.
--
-- WHY. A pass exists to produce one spreadsheet. Once it has (087 stores it),
-- the two reply columns are a copy of a file somebody already has, sitting in
-- the venue's database for as long as the pass does. Submitting now clears
-- them, and a required column cannot be cleared - so there has to be room for
-- nothing here before anything can write nothing.
--
-- THE VERDICTS STAY. a_verdict, b_verdict, preference, note, the A/B scramble
-- and every timestamp are untouched: they are the judgment, they are small,
-- and they are what anyone asks the table about later. What goes is the text
-- both engines wrote.
--
-- NULL NOW MEANS TWO THINGS AND THE DIFFERENCE IS READABLE. On a submitted
-- pass it means cleared; on one still in progress it means a row written by
-- something other than this code, because the submit route is the only writer
-- of null anywhere. That is why there is no `answers_cleared_at` column: the
-- stamp that says "cleared" already exists on the session, and a second
-- marker could disagree with it. The page words the two cases apart, and
-- distinguishes both from a column that would not parse - a blank reply read
-- as "the engine said nothing" is a false claim about a reply a human judged.
--
-- APPLY BEFORE THE CODE RUNS, which here means before merging. Relaxing a
-- constraint cannot break an existing reader - no null exists until the new
-- submit route writes one - but the new submit route writing one against the
-- old schema is a constraint violation on the last step of a pass, after the
-- file was already stored. Reverse of the SET NOT NULL rule, same reasoning.
--
-- `db/types.ts` is hand-patched in the same commit so the code typechecks
-- before this lands (db/migrations/CLAUDE.md, step 4). The next `db:types`
-- run overwrites the patch with canonical output.

begin;

alter table human_eval_units
  alter column v1 drop not null,
  alter column v2 drop not null;

comment on column human_eval_units.v1 is
  'v1''s answer, shape GoldenV1Schema in lib/schemas/golden.ts. Null on a submitted pass means the replies were cleared once the CSV was stored (087) - the file is the record. Null on a pass still in progress means a row written outside this code: the submit route is the only writer of null.';

comment on column human_eval_units.v2 is
  'v2''s answer, shape GoldenV2Schema in lib/schemas/golden.ts. Null means the same two things as v1 - see that column.';

commit;
