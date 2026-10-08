// Apply a PURELY ADDITIVE migration from db/migrations, then verify it
// actually created what it claimed and regenerate db/types.ts.
//
//   npm run db:apply -- 078_golden_runs.sql
//   npm run db:apply -- 078_golden_runs.sql --dry-run    classify only
//
// WHAT THIS DOES NOT CHANGE. Anything backwards-incompatible - a DROP, a
// RENAME, a SET NOT NULL, a tightened CHECK, an ALTER COLUMN - and anything
// touching a high-stakes table is still the operator in Supabase Studio, and
// is still deploy-the-code-first. The classifier refuses all of it
// (apply-migration-pure.ts); this script only carries the half that cannot
// break a deployed reader. The apply-ORDER rules are untouched too: an
// additive migration whose column the deployed code reads still goes in
// before the merge, because Vercel deploys on merge and the first request
// after it would otherwise fail - invisibly on a webhook path, where the
// route answers 200 and the guest's message is lost.
//
// THE CREDENTIAL IS NOT A GUARD. SUPABASE_ACCESS_TOKEN authenticates to the
// Management API as the `postgres` role; it would accept `drop table
// messages` without complaint, and Supabase offers no narrower credential.
// The classifier is therefore the entire guard, which is why it fails closed
// on anything it cannot classify and why this script feeds it the committed
// file rather than a constructed string.
//
// That token is LOCAL-ONLY. It must never be set on Vercel: nothing in the
// deployed app reads it, and a production function holding a key that can
// rewrite the schema is a far worse exposure than the inconvenience it saves.

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  claimedObjects,
  classifyMigration,
  parseApplyArgs,
} from './apply-migration-pure'

const MIGRATIONS_DIR = 'db/migrations'

interface QueryResult {
  ok: true
  rows: Array<Record<string, unknown>>
}
interface QueryFailure {
  ok: false
  error: string
}

/**
 * One SQL round trip to the Management API.
 *
 * The token is never printed, and an error body is passed through as-is
 * because Postgres's own message ("column foo does not exist", "relation
 * already exists") is the whole value of a failed apply - but it is truncated,
 * since the API echoes the submitted query on some failures and a 90-line
 * migration header in a terminal buries the one line that matters.
 */
async function runSql(
  ref: string,
  token: string,
  query: string,
): Promise<QueryResult | QueryFailure> {
  let res: Response
  try {
    res = await fetch(
      `https://api.supabase.com/v1/projects/${ref}/database/query`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ query }),
      },
    )
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
  const text = await res.text()
  if (!res.ok)
    return { ok: false, error: `HTTP ${res.status}: ${text.slice(0, 600)}` }
  try {
    const parsed: unknown = JSON.parse(text)
    return {
      ok: true,
      rows: Array.isArray(parsed)
        ? (parsed as Array<Record<string, unknown>>)
        : [],
    }
  } catch {
    // A 2xx that is not JSON is still a success for a DDL batch (it returns
    // no rows), so this is not a failure - just nothing to read.
    return { ok: true, rows: [] }
  }
}

/** The project ref the APP talks to, so this can never apply to another one. */
function projectRef():
  { ok: true; ref: string } | { ok: false; error: string } {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  if (!url) return { ok: false, error: 'NEXT_PUBLIC_SUPABASE_URL is not set' }
  const m = /^https:\/\/([a-z0-9]+)\.supabase\./.exec(url)
  // Derived from the app's own URL rather than hardcoded or taken as a flag:
  // the ref is then the same project every other code path in this repo
  // reads, and a tool that applies DDL cannot be pointed somewhere else by a
  // typo.
  return m
    ? { ok: true, ref: m[1] }
    : {
        ok: false,
        error: `could not read a project ref out of NEXT_PUBLIC_SUPABASE_URL ("${url}")`,
      }
}

/**
 * Did the objects the file claimed to create actually appear?
 *
 * A DDL batch returns 201 with no rows, which is not evidence of anything -
 * exactly the class of claim this repo gets bitten by ("ask what would fail
 * if it were untrue"). This asks information_schema afterwards, which is a
 * different source than the thing being checked.
 */
async function verifyObjects(
  ref: string,
  token: string,
  sql: string,
): Promise<string[]> {
  const { tables, columns } = claimedObjects(sql)
  const problems: string[] = []
  // Identifiers come off the classifier's own [a-z0-9_]+ captures; asserted
  // again here because this is the one place they are interpolated into SQL.
  const safe = (id: string): boolean => /^[a-z0-9_]+$/.test(id)

  if (tables.length > 0) {
    if (!tables.every(safe)) return ['refusing to verify: unsafe identifier']
    const list = tables.map((t) => `'${t}'`).join(', ')
    const found = await runSql(
      ref,
      token,
      `select table_name from information_schema.tables where table_schema = 'public' and table_name in (${list})`,
    )
    if (!found.ok) return [`verification query failed: ${found.error}`]
    const names = new Set(found.rows.map((r) => String(r.table_name)))
    for (const t of tables)
      if (!names.has(t)) problems.push(`table ${t} was NOT created`)
  }

  if (columns.length > 0) {
    if (!columns.every((c) => safe(c.table) && safe(c.column)))
      return ['refusing to verify: unsafe identifier']
    const list = columns.map((c) => `('${c.table}', '${c.column}')`).join(', ')
    const found = await runSql(
      ref,
      token,
      `select table_name, column_name from information_schema.columns where table_schema = 'public' and (table_name, column_name) in (${list})`,
    )
    if (!found.ok) return [`verification query failed: ${found.error}`]
    const pairs = new Set(
      found.rows.map((r) => `${String(r.table_name)}.${String(r.column_name)}`),
    )
    for (const c of columns)
      if (!pairs.has(`${c.table}.${c.column}`))
        problems.push(`column ${c.table}.${c.column} was NOT created`)
  }

  return problems
}

async function main(): Promise<void> {
  const parsed = parseApplyArgs(process.argv.slice(2))
  if (!parsed.ok) {
    console.error(parsed.error)
    process.exit(1)
  }
  const { file, dryRun, skipTypes } = parsed.args

  const path = join(MIGRATIONS_DIR, file)
  let sql: string
  try {
    sql = readFileSync(path, 'utf8')
  } catch {
    console.error(`cannot read ${path}`)
    process.exit(1)
  }

  const classification = classifyMigration(sql)
  if (!classification.ok) {
    console.error(`\nREFUSED: ${file} is not purely additive.\n`)
    console.error(`  why:  ${classification.reason}`)
    if (classification.statement !== null)
      console.error(`  on:   ${classification.statement.slice(0, 300)}`)
    console.error(
      `\nThis one goes to the operator: apply it in Supabase Studio, and check the` +
        `\napply-order rule in db/migrations/CLAUDE.md first - backwards-incompatible` +
        `\nmeans the code deploys BEFORE the migration.\n`,
    )
    process.exit(1)
  }

  console.log(`\n${file}: ${classification.statements.length} statements\n`)
  for (const s of classification.statements) console.log(`  ${s.kind}`)
  if (dryRun) {
    console.log('\n--dry-run: classified only, nothing applied.\n')
    return
  }

  const ref = projectRef()
  if (!ref.ok) {
    console.error(`\n${ref.error}`)
    process.exit(1)
  }
  const token = process.env.SUPABASE_ACCESS_TOKEN
  if (!token) {
    console.error(
      '\nSUPABASE_ACCESS_TOKEN is not set. It is local-only and lives in the main' +
        "\ncheckout's .env.local - never write that file, and never set this on Vercel." +
        '\nIf it looks missing or wrong, stop and ask the operator (root CLAUDE.md).\n',
    )
    process.exit(1)
  }

  console.log(`\napplying to project ${ref.ref} ...`)
  // The file verbatim, in one request, so its own begin/commit is the
  // transaction. The classifier has already required that pair, which is what
  // makes a half-applied file impossible from here.
  const applied = await runSql(ref.ref, token, sql)
  if (!applied.ok) {
    console.error(`\nAPPLY FAILED: ${applied.error}\n`)
    process.exit(1)
  }
  console.log('applied.')

  const problems = await verifyObjects(ref.ref, token, sql)
  if (problems.length > 0) {
    console.error('\nVERIFICATION FAILED - the apply reported success but:')
    for (const p of problems) console.error(`  ${p}`)
    console.error('')
    process.exit(1)
  }
  const { tables, columns } = claimedObjects(sql)
  console.log(
    `verified in information_schema: ${tables.length} table(s), ${columns.length} column(s).`,
  )

  if (skipTypes) {
    console.log('\n--skip-types: remember to run `npm run db:types`.\n')
    return
  }
  console.log('\nregenerating db/types.ts ...')
  try {
    execFileSync('npm', ['run', 'db:types'], { stdio: 'inherit' })
  } catch {
    console.error(
      '\ndb:types failed. The migration IS applied - rerun `npm run db:types` ' +
        'separately.\n',
    )
    process.exit(1)
  }
  const changed = execFileSync(
    'git',
    ['status', '--porcelain', 'db/types.ts'],
    {
      encoding: 'utf8',
    },
  ).trim()
  console.log(
    changed.length > 0
      ? '\ndb/types.ts changed - commit it with the migration.\n'
      : '\ndb/types.ts unchanged.\n',
  )
}

void main()
