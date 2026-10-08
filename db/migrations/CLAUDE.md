# db/migrations - hand-written SQL, additive applied by the tool, the rest by a human

Loads only when you work in this directory.

**There is no index in this file, deliberately.** The filenames are the index
(`ls db/migrations/`) and each migration carries its own header explaining what it does and
why - typically 60 to 90 lines. That header is the authority. A restatement here would be a
second copy to go stale.

## Workflow

1. Write the file. Number it `NNN_snake_case_description.sql`, and **wrap it in
   `begin;` / `commit;`** - the applier requires that pair, so a half-applied file is not a
   state it can produce.
2. `npm run db:apply -- NNN_name.sql --dry-run` prints the classification of every
   statement. Drop the flag to apply; it then verifies the objects in `information_schema`
   and runs `db:types` itself.
3. **A refusal is a handoff, not an obstacle.** The operator applies that file in Supabase
   Studio and runs `npm run db:types`. Do not split a refused file into additive-looking
   pieces to get it past the tool - if a statement is backwards-incompatible, so is the
   change, and the apply-order rule below is what matters.
4. If the code needs the new column to typecheck before the types land, hand-patch
   `db/types.ts` in the same commit and say so in the commit message. The next `db:types`
   run overwrites the patch with canonical output.

## What `db:apply` will and will not run

The classifier is `scripts/apply-migration-pure.ts` - no `@/*` imports and no network, so it
can be run over real migration files with no credential in the process. That is how the two
bugs below were found; neither was visible by reading it.

| applied | refused |
| --- | --- |
| `CREATE TABLE` | every `DROP`, `TRUNCATE`, `DELETE`, `UPDATE`, `ON CONFLICT DO UPDATE` |
| `ALTER TABLE … ADD COLUMN` | `ALTER COLUMN`, `SET NOT NULL`, `RENAME`, `ALTER CONSTRAINT` |
| `CREATE INDEX` on a table this file creates | `CREATE INDEX` on a live table |
| `ADD CONSTRAINT` on a table this file creates | `ADD CONSTRAINT` on a live table |
| `INSERT`, `COMMENT ON`, `GRANT`, `CREATE FUNCTION` | `CREATE OR REPLACE`, `REVOKE` |
| `set local lock_timeout` / `statement_timeout` | any RLS or policy statement |
| | anything it cannot classify |
| | anything naming `messages`, `engagement_events`, `voice_corpus`, `operators` |

Four of those look additive and are not, and the reasons are this schema's own:

- **`CREATE INDEX` on a live table** takes `ACCESS EXCLUSIVE`. See the lock-ordering entry
  below for what stalling `messages` costs.
- **`ADD CONSTRAINT` on a live column** is a tightened `CHECK`, which is deploy-code-first.
  Deciding whether a constraint touches only new columns needs a real parser, so the tool
  refuses rather than guesses.
- **`CREATE OR REPLACE`** is a replacement of behaviour wearing the word "create".
- **RLS and policies** are the auth boundary, a hard stop whatever the verb.

Two deliberate asymmetries worth knowing before you fight the tool:

- **A plain `references operators(id)` is allowed; `references messages(id)` is not.** An FK
  takes a lock on the referenced table, and `messages` is the one table where that lock lands
  on the inbound webhook - which answers 200 on failure, so the loss is silent. `operators`,
  `voice_corpus` and `engagement_events` carry no such path (migration 074 is the precedent).
- **A denied keyword inside a string literal refuses the file.** A `comment on … is '… do not
  drop this'` will not apply. That is the cheap direction and not worth engineering around.

**`set local lock_timeout = '5s'` is on the allowlist, and the first version of the
classifier refused it** - which meant it refused precisely the most careful migrations in
this directory. Found by running it over all 77 files, not by reading it. Same class of
finding as the `references operators` false positive. If you extend the allowlist, re-run it
over the whole directory and read the refusal reasons, because the reason is where a
misclassification shows up: migration 077's `alter column lesson drop not null` was first
refused as "a DROP is never additive", a true verdict with a misleading explanation that
would send the next reader looking for a dropped object.

**Nothing about `db:apply` changes apply ORDER.** The rules below are about a deployed reader
meeting a schema; who typed the statement is a different question.

## Apply order against the deploy

This is the rule that causes outages when it is got wrong.

**Backwards-incompatible - deploy the code FIRST, then apply.** A `DROP COLUMN`,
`DROP FUNCTION`, `RENAME COLUMN`, `ALTER ... SET NOT NULL`, or a tightened `CHECK`. Applying
first opens a window where deployed code queries a schema that no longer exists and every
affected request 500s. Migration 021 did this and `admin.theanalog.company` was down for
roughly three minutes.

**Additive but the deployed code reads it - apply in Studio BEFORE merging.** This is the
common case and the one people get backwards. Vercel deploys on merge, so if the new code
selects or inserts a column that does not exist yet, the first request after merge fails.
On a webhook path that failure is invisible: the route answers 200 and the guest's message
is lost with no retry.

**Purely additive with no new reader - order does not matter.**

**Exception: an inert drop can ride along with an add.** The rule binds on *live readers*,
not on the keyword. Prove inertness first - `grep -rn '<column>' --include='*.ts' .` must
return only `db/types.ts`. One live reader means the whole file waits for merge, and the
two halves should be split rather than argued about.

## High-stakes tables

`messages`, `engagement_events`, `voice_corpus`. A migration against any of them is a
**hard stop**: write the plan, post it, and stop on approval - a human drives the build.

**Additivity does not lift this.** `db:apply` refuses any statement naming one of them, plus
`operators`, whatever the verb in front of it - the stop is about what the table is. A
`create table` that merely FKs to `operators`, `voice_corpus` or `engagement_events` is fine;
one that FKs to `messages` is not.

Reading `messages` through an RPC counts. Payment-adjacent and auth surfaces are hard stops
for the same reason.

## Patterns this schema uses

**Widening a `CHECK` has no `ALTER CONSTRAINT`** - drop and recreate it, in one transaction.
Precedent: 002, 003, 011, 012, 016, 034, 047, 057, 059, 063.

**Verify a constraint name against `pg_constraint` before dropping it.** The names are
Postgres's own for inline CHECKs, and a name assumed rather than checked is how a drop
removes the wrong constraint.

**Adding a column to an RPC's `returns table(...)` requires DROP + CREATE**, not
`create or replace` - Postgres refuses a return-type change outright. Wrap both in one
transaction or you leave a window where the function does not exist and every operator
queue read 500s. Restate the previous body verbatim; diff it against the previous migration
rather than retyping. `DROP FUNCTION` also discards every `grant`/`revoke` on the function -
re-issue them (migration 023 is the one with grants).

**Check what is LIVE before dropping, not what is in the repo.** This schema has carried a
Studio-only function before (migration 021's orphan). Use `pg_get_functiondef` and a
`pg_proc` overload check, and put the output in the migration header.

**Take locks up front, `messages` first, under `lock_timeout = '5s'`** when touching more
than one table. Altering `guests` before `messages` can deadlock with an inbound webhook,
which holds `messages` and then needs `guests` for its FK check - and that route answers 200
on failure, so the guest's message is silently lost. A busy table makes the migration fail
cleanly instead. Apply outside the pilot venue's opening hours regardless.

**A partial unique index is the storage-layer backstop** for a check-then-act in app code.
Create the new one before dropping the old one, in one transaction, so the table is never
unguarded. `CONCURRENTLY` cannot run in a transaction, and at pilot size the one-transaction
swap matters more than a lock held for milliseconds.

**`coalesce(col, '<sentinel>')` in a partial unique index predicate.** NULLs are distinct in
a unique index, so a bare nullable column gives rows with a NULL no uniqueness at all.
Migrations 041 and 054 both depend on this.

## Traps paid for here

**Postgres does not validate a column default against that column's own CHECK.**
`messages.status` carried `default 'pending'` against a CHECK that never permitted
`'pending'` from migration 001, on adjacent lines, unnoticed for months - because any insert
relying on the default already fails. The damage was not runtime: the schema asserted
something false and was believed, and that reasoning reached a code comment and a CLAUDE.md
entry before review caught it. Migration 046 has the sweep query to re-run after adding a
defaulted column with a CHECK.

**Check the number before you pick it.** Two migrations were numbered 058 simultaneously:
they touched different objects, so git merged them with no conflict and left a duplicate
number in a directory where the number is the apply-order key. Run
`git ls-tree origin/main db/migrations/` before choosing, on any branch that has been open
more than a few hours. `062` is currently reserved.

**A rollback that ABORTS is usually correct.** Narrowing a CHECK back fails once any row
carries the new value, and that is the right outcome - those rows are real. Prefer rolling
the code back and leaving the CHECK wide; a value nothing writes costs nothing.

**No RLS anywhere yet.** Agent and cron use the service role and would bypass it. THE-110
tracks adding policies before any external user gets DB access.

---

Root `CLAUDE.md` is the index for the whole repo, `docs/decisions/README.md` holds the
cross-cutting decisions, and `README.md` is the navigable map of both.
