// TAC-468: an in-memory `venues` / `guests` / `messages` store for the
// Instagram handler's tests.
//
// It implements ONLY the query shapes handle-events.ts sends:
//   from(t).select(cols).eq(...)...maybeSingle()
//   from(t).insert(row).select(cols).single()
// Anything else (update, delete, upsert, order, a table it doesn't know) is not
// defined on it and throws, so a write the handler must never make, such as an
// update on a read receipt, fails the test rather than being answered by a
// mock's opinion of what the query meant.
//
// TAC-479 adds the one update shape refresh-profile.ts sends, and ONLY for the
// tables a test names in `updatable`:
//   from(t).update(patch).eq(...).is(col, null)...[.select(cols)]
// The handler's tests never name one, so an update from the handler still
// throws there.
//
// Every call is recorded in `calls`, in order, so tests can assert what was
// NOT asked as well as what was.
//
// Unique constraints are written out from the migrations rather than imported:
// 006 (messages.provider_message_id) and 048 (guests (venue_id,
// instagram_scoped_id), venues.instagram_account_id). A violation returns
// `{ code: '23505' }` as PostgREST does and writes nothing. As in Postgres, a
// key with a null column never conflicts.

import type { SupabaseClient } from '@supabase/supabase-js'

import type { Database } from '@/db/types'

export type FakeTable = 'venues' | 'guests' | 'messages'
export type FakeRow = { id: string; [column: string]: unknown }
export type FakeError = { code?: string; message: string }

export type FakeCall =
  | { op: 'select'; table: FakeTable; columns: string; filters: Array<[string, unknown]> }
  | { op: 'insert'; table: FakeTable; row: Record<string, unknown> }
  | {
      op: 'update'
      table: FakeTable
      patch: Record<string, unknown>
      filters: Array<[string, 'eq' | 'is', unknown]>
    }

const UNIQUE_KEYS: Record<FakeTable, string[][]> = {
  venues: [['instagram_account_id']],
  guests: [
    ['venue_id', 'phone_number'],
    ['venue_id', 'instagram_scoped_id'],
  ],
  messages: [['provider_message_id']],
}

const TABLES: ReadonlySet<string> = new Set(['venues', 'guests', 'messages'])

function isTable(name: string): name is FakeTable {
  return TABLES.has(name)
}

function project(row: FakeRow, columns: string): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  // A column the row was seeded without reads as NULL, as Postgres returns it.
  for (const column of columns.split(',').map((c) => c.trim())) out[column] = row[column] ?? null
  return out
}

function conflicts(table: FakeTable, rows: FakeRow[], candidate: Record<string, unknown>): boolean {
  return UNIQUE_KEYS[table].some((key) => {
    if (key.some((column) => candidate[column] === null || candidate[column] === undefined)) return false
    return rows.some((row) => key.every((column) => row[column] === candidate[column]))
  })
}

type FakeOp = 'select' | 'insert' | 'update'

export function createInstagramDbFake(
  seed: Partial<Record<FakeTable, FakeRow[]>> = {},
  options: { updatable?: FakeTable[] } = {},
) {
  const updatable: ReadonlySet<FakeTable> = new Set(options.updatable ?? [])
  const tables: Record<FakeTable, FakeRow[]> = {
    venues: [...(seed.venues ?? [])],
    guests: [...(seed.guests ?? [])],
    messages: [...(seed.messages ?? [])],
  }
  const calls: FakeCall[] = []
  const queuedErrors: Array<{ table: FakeTable; op: FakeOp; error: FakeError }> = []
  const beforeInsert: Array<{ table: FakeTable; run: () => void }> = []
  const beforeUpdate: Array<{ table: FakeTable; run: () => void }> = []
  let nextId = 1

  function takeError(table: FakeTable, op: FakeOp): FakeError | null {
    const index = queuedErrors.findIndex((q) => q.table === table && q.op === op)
    if (index === -1) return null
    const [queued] = queuedErrors.splice(index, 1)
    return queued?.error ?? null
  }

  function selectBuilder(table: FakeTable, columns: string) {
    const filters: Array<[string, unknown]> = []
    const builder = {
      eq(column: string, value: unknown) {
        filters.push([column, value])
        return builder
      },
      async maybeSingle() {
        calls.push({ op: 'select', table, columns, filters: [...filters] })
        const error = takeError(table, 'select')
        if (error) return { data: null, error }
        const matches = tables[table].filter((row) => filters.every(([c, v]) => row[c] === v))
        if (matches.length > 1) {
          return { data: null, error: { code: 'PGRST116', message: 'multiple rows returned' } }
        }
        const [match] = matches
        return { data: match ? project(match, columns) : null, error: null }
      },
    }
    return builder
  }

  function insertBuilder(table: FakeTable, row: Record<string, unknown>) {
    return {
      select(columns: string) {
        return {
          async single() {
            calls.push({ op: 'insert', table, row })
            const hookIndex = beforeInsert.findIndex((h) => h.table === table)
            if (hookIndex !== -1) beforeInsert.splice(hookIndex, 1)[0]?.run()
            const error = takeError(table, 'insert')
            if (error) return { data: null, error }
            if (conflicts(table, tables[table], row)) {
              return {
                data: null,
                error: { code: '23505', message: 'duplicate key value violates unique constraint' },
              }
            }
            const stored: FakeRow = { id: `${table}-${nextId++}`, ...row }
            tables[table].push(stored)
            return { data: project(stored, columns), error: null }
          },
        }
      },
    }
  }

  function updateBuilder(table: FakeTable, patch: Record<string, unknown>) {
    const filters: Array<[string, 'eq' | 'is', unknown]> = []
    let columns: string | null = null
    async function run(): Promise<{ data: Record<string, unknown>[] | null; error: FakeError | null }> {
      calls.push({ op: 'update', table, patch, filters: [...filters] })
      const hookIndex = beforeUpdate.findIndex((h) => h.table === table)
      if (hookIndex !== -1) beforeUpdate.splice(hookIndex, 1)[0]?.run()
      const error = takeError(table, 'update')
      if (error) return { data: null, error }
      // `is` matches a missing column as NULL, as Postgres would.
      const matches = tables[table].filter((row) =>
        filters.every(([column, op, value]) => (op === 'is' ? (row[column] ?? null) === value : row[column] === value)),
      )
      for (const row of matches) Object.assign(row, patch)
      return { data: columns === null ? null : matches.map((row) => project(row, columns ?? '')), error: null }
    }
    const builder = {
      eq(column: string, value: unknown) {
        filters.push([column, 'eq', value])
        return builder
      },
      is(column: string, value: null) {
        filters.push([column, 'is', value])
        return builder
      },
      select(cols: string) {
        columns = cols
        return builder
      },
      then<T>(resolve: (value: Awaited<ReturnType<typeof run>>) => T, reject?: (reason: unknown) => T) {
        return run().then(resolve, reject)
      },
    }
    return builder
  }

  const client = {
    from(table: string) {
      if (!isTable(table)) throw new Error(`db fake: unexpected table ${table}`)
      return {
        select: (columns: string) => selectBuilder(table, columns),
        insert: (row: Record<string, unknown>) => insertBuilder(table, row),
        ...(updatable.has(table) ? { update: (patch: Record<string, unknown>) => updateBuilder(table, patch) } : {}),
      }
    },
  }

  return {
    client: client as unknown as SupabaseClient<Database>,
    tables,
    calls,
    /** Rows passed to insert on `table`, in order, whether or not they were stored. */
    inserts(table: FakeTable): Record<string, unknown>[] {
      return calls.flatMap((c) => (c.op === 'insert' && c.table === table ? [c.row] : []))
    },
    /** Patches passed to update on `table`, in order, with their filters. */
    updates(table: FakeTable): Array<{ patch: Record<string, unknown>; filters: Array<[string, 'eq' | 'is', unknown]> }> {
      return calls.flatMap((c) => (c.op === 'update' && c.table === table ? [{ patch: c.patch, filters: c.filters }] : []))
    },
    /** The next select, insert or update on `table` returns `error` instead. One-shot. */
    failNext(table: FakeTable, op: FakeOp, error: FakeError): void {
      queuedErrors.push({ table, op, error })
    },
    /**
     * Run `run` at the start of the next insert on `table`, before the
     * constraint check: how a test puts a competing row in place between the
     * handler's read and its write.
     */
    beforeNextInsert(table: FakeTable, run: () => void): void {
      beforeInsert.push({ table, run })
    },
    /** The same for the next update: how a test lands a competing claim first. */
    beforeNextUpdate(table: FakeTable, run: () => void): void {
      beforeUpdate.push({ table, run })
    },
  }
}
