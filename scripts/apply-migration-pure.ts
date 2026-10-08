// Is a migration file purely additive? The one definition.
//
// The `-pure` half of apply-migration.ts, per scripts/CLAUDE.md's module
// split: no `@/*` imports, no SDK init, no network. That is not a style
// choice here - it means the classifier can be exercised against real
// migration files with no credential anywhere in the process, which is how
// its refusals were checked before it was ever pointed at production.
//
// WHY THIS FILE IS THE ENTIRE GUARD. The apply path authenticates to the
// Supabase Management API with SUPABASE_ACCESS_TOKEN, which connects as the
// `postgres` role - it would accept `drop table messages` just as happily as
// a `create table`. There is no least-privilege credential behind this and
// Supabase offers none, so nothing except the classifier below stands between
// a generated statement and the production schema. Two properties follow, and
// both are deliberate:
//
//   1. IT FAILS CLOSED ON ANYTHING IT CANNOT CLASSIFY. An unrecognized
//      statement is a refusal, never a pass. The allowlist is small on
//      purpose: a statement kind nobody has thought about is one a human
//      applies in Studio, which costs a message and no risk.
//   2. IT OVER-REFUSES BY DESIGN. A denied keyword inside a string literal
//      (a `comment on ... is '... do not drop this'`) refuses the file. That
//      is the cheap direction: a false refusal costs one hand-apply, a false
//      acceptance costs the database.
//
// The classifier is NOT a Postgres parser and does not try to be. It strips
// comments, respects string and dollar-quote boundaries so a function body
// cannot be read as statements, splits on top-level semicolons, and then
// matches leading keywords. Where a precise answer would need real parsing -
// which columns a CHECK constraint touches - it refuses instead of guessing.

/**
 * Tables a migration may not touch, whatever the statement says.
 *
 * Root CLAUDE.md's high-stakes list plus the auth surface: a migration
 * against any of these is a hard stop where a human drives the build.
 * Additivity does not lift that - the stop is about what the table IS, not
 * about the keyword in front of it.
 */
export const HARD_STOP_TABLES: readonly string[] = [
  'messages',
  'engagement_events',
  'voice_corpus',
  // lib/auth and operators.is_analog_admin are hard stops for the same
  // reason, and `is_analog_admin` is granted by a hand-written UPDATE on
  // purpose.
  'operators',
]

/**
 * `messages` is refused even as the TARGET OF A FOREIGN KEY, and the other
 * three are not.
 *
 * A new table declaring `references messages(id)` is not a migration against
 * `messages` in any ordinary sense - but it takes a lock on it, and
 * db/migrations/CLAUDE.md records the specific cost: the inbound webhook
 * holds `messages` and then needs `guests` for its FK check, the route
 * answers 200 on failure, and the guest's message is lost with no retry and
 * no error anywhere. That is the one lock on this schema worth refusing a
 * convenience over. An FK to `operators` or `voice_corpus` carries no such
 * path, so a plain `references` to those is allowed (migration 074 is the
 * precedent - it FKs to `operators` and is otherwise purely additive).
 */
const FK_REFERENCE_ALLOWED: readonly string[] = [
  'engagement_events',
  'voice_corpus',
  'operators',
]

/**
 * Keywords that refuse the file wherever they appear, scanned over the
 * comment-stripped SQL before any statement is classified.
 *
 * This is belt-and-braces with the per-statement allowlist: if the splitter
 * or the matcher gets something wrong, this still catches the statement kinds
 * that cost data. Every entry is here because it is destructive, tightening,
 * or a replacement wearing an additive-looking keyword.
 */
const FORBIDDEN_PATTERNS: ReadonlyArray<{ pattern: RegExp; why: string }> = [
  // ORDER MATTERS, for the message rather than the verdict: `alter column
  // lesson drop not null` matches both this and the bare DROP below, and
  // "a DROP is never additive" would send the reader looking for a dropped
  // object that does not exist. First match wins, so the specific patterns
  // come first.
  {
    pattern: /\balter\s+column\b/,
    why: 'ALTER COLUMN changes a type, a default or a nullability constraint on data that already exists',
  },
  {
    pattern: /\bset\s+not\s+null\b/,
    why: 'SET NOT NULL is backwards-incompatible: deploy the code first (root CLAUDE.md)',
  },
  { pattern: /\bdrop\b/, why: 'a DROP is never additive' },
  { pattern: /\btruncate\b/, why: 'TRUNCATE deletes every row' },
  { pattern: /\bdelete\s+from\b/, why: 'DELETE removes data' },
  {
    pattern: /(^|;)\s*update\s/,
    why: 'UPDATE rewrites existing rows - additive means nothing is overwritten',
  },
  {
    pattern: /\brename\b/,
    why: 'a RENAME is backwards-incompatible: deploy the code first (root CLAUDE.md)',
  },
  {
    pattern: /\bor\s+replace\b/,
    why: 'CREATE OR REPLACE is a replacement of behaviour wearing the word "create"',
  },
  {
    pattern: /\balter\s+constraint\b/,
    why: 'altering a constraint changes what existing rows are allowed to be',
  },
  { pattern: /\brevoke\b/, why: 'REVOKE removes access' },
  {
    pattern: /\brow\s+level\s+security\b/,
    why: 'RLS is the auth boundary - a hard stop regardless of verb (root CLAUDE.md)',
  },
  {
    pattern: /\bcreate\s+policy\b/,
    why: 'a policy is the auth boundary - a hard stop regardless of verb (root CLAUDE.md)',
  },
  {
    pattern: /\bdo\s+update\b/,
    why: 'ON CONFLICT DO UPDATE overwrites an existing row (DO NOTHING is fine)',
  },
]

export interface ParsedArgs {
  /** Bare filename inside db/migrations. Never a path. */
  file: string
  dryRun: boolean
  skipTypes: boolean
}

/**
 * Parse argv. Lives in the `-pure` half because scripts/CLAUDE.md records
 * that an `import.meta.url === file://${process.argv[1]}` main-guard silently
 * never matches on a path containing a character that gets percent-encoded -
 * a space, a curly apostrophe - and the fix is to split the parser out, not
 * to guard the module.
 *
 * REFUSES A PATH, not just normalizes one. The tool applies a committed
 * migration and nothing else, so `../`, an absolute path or any separator is
 * rejected rather than resolved: "what ran is what is in db/migrations" is
 * the property that makes the apply reviewable after the fact.
 */
export function parseApplyArgs(
  argv: readonly string[],
): { ok: true; args: ParsedArgs } | { ok: false; error: string } {
  const positional = argv.filter((a) => !a.startsWith('--'))
  const flags = argv.filter((a) => a.startsWith('--'))
  const unknown = flags.filter((f) => f !== '--dry-run' && f !== '--skip-types')
  if (unknown.length > 0)
    return { ok: false, error: `unknown flag(s): ${unknown.join(', ')}` }
  if (positional.length !== 1)
    return {
      ok: false,
      error:
        'usage: npm run db:apply -- <NNN_name.sql> [--dry-run] [--skip-types]',
    }
  const file = positional[0]
  if (file.includes('/') || file.includes('\\') || file.includes('..'))
    return {
      ok: false,
      error: `"${file}" is a path. Pass a bare filename; the tool only ever reads db/migrations/`,
    }
  if (!/^[0-9]{3}_[a-z0-9_]+\.sql$/.test(file))
    return {
      ok: false,
      error: `"${file}" is not a migration filename (NNN_snake_case.sql)`,
    }
  return {
    ok: true,
    args: {
      file,
      dryRun: flags.includes('--dry-run'),
      skipTypes: flags.includes('--skip-types'),
    },
  }
}

export interface StatementClassification {
  /** The statement, comments stripped and whitespace collapsed. */
  statement: string
  /** Short label for the printed table, e.g. "create table golden_runs". */
  kind: string
}

export type ClassifyResult =
  | { ok: true; statements: StatementClassification[]; createdTables: string[] }
  | { ok: false; reason: string; statement: string | null }

/**
 * Strip comments and split into top-level statements.
 *
 * Quote-aware because a function body is dollar-quoted and contains
 * semicolons: splitting naively would read `$$ ... ; ... $$` as several
 * statements and classify fragments of a body as DDL. Single-quoted strings
 * keep their contents (a comment-on text is data), but `--` and block
 * comments are replaced with a space so a keyword in prose cannot be matched
 * as SQL - and so a migration header, which is 60 to 90 lines of exactly that
 * prose in this repo, does not refuse its own file.
 */
export function splitStatements(sql: string): string[] {
  const statements: string[] = []
  let current = ''
  let i = 0

  while (i < sql.length) {
    const two = sql.slice(i, i + 2)

    if (two === '--') {
      const end = sql.indexOf('\n', i)
      i = end === -1 ? sql.length : end
      current += ' '
      continue
    }
    if (two === '/*') {
      const end = sql.indexOf('*/', i + 2)
      i = end === -1 ? sql.length : end + 2
      current += ' '
      continue
    }
    if (sql[i] === "'") {
      // Single-quoted literal. '' is an escaped quote, not a terminator.
      let j = i + 1
      while (j < sql.length) {
        if (sql[j] === "'" && sql[j + 1] === "'") {
          j += 2
          continue
        }
        if (sql[j] === "'") break
        j += 1
      }
      current += sql.slice(i, Math.min(j + 1, sql.length))
      i = j + 1
      continue
    }
    if (sql[i] === '$') {
      // Dollar quote: $$ or $tag$. Only a valid tag opens one; a lone $ in
      // other positions is left alone.
      const tagMatch = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i))
      if (tagMatch) {
        const tag = tagMatch[0]
        const end = sql.indexOf(tag, i + tag.length)
        const stop = end === -1 ? sql.length : end + tag.length
        current += sql.slice(i, stop)
        i = stop
        continue
      }
    }
    if (sql[i] === ';') {
      statements.push(current)
      current = ''
      i += 1
      continue
    }
    current += sql[i]
    i += 1
  }
  if (current.trim().length > 0) statements.push(current)

  return statements
    .map((s) => s.replace(/\s+/g, ' ').trim())
    .filter((s) => s.length > 0)
}

/** The table a `create table` creates, or null when the shape is unexpected. */
function createdTableName(normalized: string): string | null {
  const m = /^create table (?:if not exists )?([a-z0-9_]+)/.exec(normalized)
  return m ? m[1] : null
}

/**
 * Classify every statement, or refuse the file.
 *
 * `createdTables` accumulates as it goes, which is what lets an index or a
 * constraint be allowed on a table this same file created while being refused
 * on a pre-existing one. The distinction is not pedantry:
 *
 *   CREATE INDEX on a live table takes ACCESS EXCLUSIVE, and db/migrations/
 *   CLAUDE.md records what stalling `messages` costs - the inbound route
 *   answers 200 on failure, so a guest's message is lost silently. On a table
 *   created three statements earlier there is nothing to lock out.
 *
 *   ADD CONSTRAINT on a live column is a tightened CHECK, which root
 *   CLAUDE.md classes as backwards-incompatible and deploy-code-first.
 *   Deciding whether a constraint touches only new columns needs a real
 *   parser, so this refuses rather than guesses.
 */
export function classifyMigration(sql: string): ClassifyResult {
  const statements = splitStatements(sql)
  if (statements.length === 0)
    return { ok: false, reason: 'no statements found', statement: null }

  // The file must own its own atomicity. Every migration in this repo already
  // wraps itself; requiring it means a half-applied file is not a state this
  // tool can produce, and it is one less thing to reason about than guessing
  // whether the API wraps a batch.
  const lower = statements.map((s) => s.toLowerCase())
  if (lower[0] !== 'begin' || lower[lower.length - 1] !== 'commit')
    return {
      ok: false,
      reason:
        "the file must open with `begin;` and close with `commit;` - atomicity is the migration's own responsibility",
      statement: null,
    }

  const classified: StatementClassification[] = []
  const createdTables: string[] = []

  for (const statement of statements) {
    const n = statement.toLowerCase()

    for (const { pattern, why } of FORBIDDEN_PATTERNS) {
      if (pattern.test(n)) return { ok: false, reason: why, statement }
    }
    // Hard-stop scan. FK clauses to the reference-allowed tables are removed
    // first, so a new table may declare `references operators(id)` while
    // `alter table operators ...` or `insert into operators ...` still
    // refuses - the mention is not the problem, the target is.
    const withoutAllowedFks = FK_REFERENCE_ALLOWED.reduce(
      (acc, table) =>
        acc.replace(
          new RegExp(`references\\s+${table}\\s*\\([^)]*\\)`, 'g'),
          ' ',
        ),
      n,
    )
    for (const table of HARD_STOP_TABLES) {
      if (new RegExp(`\\b${table}\\b`).test(withoutAllowedFks))
        return {
          ok: false,
          reason: `touches \`${table}\`, a high-stakes table - a human drives this one (root CLAUDE.md)`,
          statement,
        }
    }

    if (n === 'begin' || n === 'commit') {
      classified.push({ statement, kind: n })
      continue
    }
    // `set local lock_timeout = '5s'` is this schema's documented lock-safety
    // practice (db/migrations/CLAUDE.md: take locks up front, under a
    // timeout, so a busy table makes the migration fail cleanly instead of
    // queueing behind it). The first version of this classifier refused it,
    // which meant it refused precisely the most careful migrations - found by
    // running it over all 77 files rather than by reading it. `set local` and
    // only the timeout knobs: a bare `set` could mean `set role` or
    // `set search_path`, which change who the statements run as and where
    // they land.
    if (
      /^set local (lock_timeout|statement_timeout|idle_in_transaction_session_timeout) =/.test(
        n,
      )
    ) {
      classified.push({ statement, kind: 'set local timeout' })
      continue
    }
    if (n.startsWith('create table')) {
      const table = createdTableName(n)
      if (table === null)
        return {
          ok: false,
          reason: 'could not read the table name off this CREATE TABLE',
          statement,
        }
      createdTables.push(table)
      classified.push({ statement, kind: `create table ${table}` })
      continue
    }
    if (/^create (unique )?index/.test(n)) {
      const m = /\bon ([a-z0-9_]+)/.exec(n)
      if (m === null)
        return {
          ok: false,
          reason: 'could not read the target table off this CREATE INDEX',
          statement,
        }
      if (!createdTables.includes(m[1]))
        return {
          ok: false,
          reason: `CREATE INDEX on \`${m[1]}\`, which this file does not create - a plain CREATE INDEX takes ACCESS EXCLUSIVE on a live table. Apply this one in Studio, outside opening hours`,
          statement,
        }
      classified.push({ statement, kind: `create index on ${m[1]}` })
      continue
    }
    if (n.startsWith('alter table')) {
      const m = /^alter table (?:if exists )?([a-z0-9_]+) (.+)$/.exec(n)
      if (m === null)
        return {
          ok: false,
          reason: 'could not read the table and action off this ALTER TABLE',
          statement,
        }
      const [, table, actions] = m
      if (/^add constraint\b/.test(actions)) {
        if (!createdTables.includes(table))
          return {
            ok: false,
            reason: `ADD CONSTRAINT on \`${table}\`, which this file does not create - on existing data that is a tightened CHECK, which is deploy-code-first. Apply this one in Studio`,
            statement,
          }
        classified.push({ statement, kind: `add constraint on ${table}` })
        continue
      }
      if (!/^add column\b/.test(actions))
        return {
          ok: false,
          reason:
            'the only ALTER TABLE actions in the allowlist are ADD COLUMN and ADD CONSTRAINT on a table this file creates',
          statement,
        }
      // A multi-action ALTER can mix an add with something else. The forbidden
      // scan above already ran over this whole statement, so an `alter column`
      // or `drop` riding along has refused the file by now.
      classified.push({ statement, kind: `add column on ${table}` })
      continue
    }
    if (n.startsWith('insert into')) {
      const m = /^insert into ([a-z0-9_]+)/.exec(n)
      classified.push({
        statement,
        kind: `insert into ${m ? m[1] : '(unread)'}`,
      })
      continue
    }
    if (n.startsWith('comment on')) {
      classified.push({ statement, kind: 'comment on' })
      continue
    }
    if (n.startsWith('grant ')) {
      classified.push({ statement, kind: 'grant' })
      continue
    }
    if (n.startsWith('create function')) {
      classified.push({ statement, kind: 'create function' })
      continue
    }

    return {
      ok: false,
      reason:
        'not in the additive allowlist (create table, create index on a new table, add column, add constraint on a new table, insert, comment on, grant, create function) - apply this one in Studio',
      statement,
    }
  }

  return { ok: true, statements: classified, createdTables }
}

/**
 * Objects the file claims to create, for the post-apply verification.
 *
 * A statement batch returning 201 is not evidence that anything was created:
 * the independent check is asking `information_schema` afterwards. This
 * extracts what to ask about.
 */
export function claimedObjects(sql: string): {
  tables: string[]
  columns: Array<{ table: string; column: string }>
} {
  const tables: string[] = []
  const columns: Array<{ table: string; column: string }> = []
  for (const statement of splitStatements(sql)) {
    const n = statement.toLowerCase()
    const created = n.startsWith('create table') ? createdTableName(n) : null
    if (created !== null) tables.push(created)
    const altered =
      /^alter table (?:if exists )?([a-z0-9_]+) add column (?:if not exists )?([a-z0-9_]+)/.exec(
        n,
      )
    if (altered !== null)
      columns.push({ table: altered[1], column: altered[2] })
  }
  return { tables, columns }
}
