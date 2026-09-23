// TAC-394: an in-memory `messages` table for the pending-slot tests.
//
// It implements ONLY the query shapes the pending-slot code paths send, and
// throws on anything else, so a new query shape fails loudly instead of being
// answered by a mock's opinion of what the query meant.
//
// Two properties are the reason it exists:
//
//   ADVERSARIAL ORDER. A read with no `.order()` returns rows in INSERTION
//   order, and `.maybeSingle()` returns the first of them. Postgres gives no
//   ordering guarantee without ORDER BY, and insertion order is exactly the
//   order that makes a careless read look right in a test. So tests seed the
//   WRONG slot's row first: a read that forgot to order, or forgot to name its
//   slot, is handed the wrong card.
//
//   INDEX MODES. '020' enforces migration 020 (one pending row per venue and
//   guest). '041' enforces migration 041 (one per slot). '054' enforces
//   migration 054: one obligation card per guest, and one CONVERSATION card
//   per inbound (reply_to_message_id, with NULL folded onto a sentinel exactly
//   as the SQL coalesce does). A violation, on INSERT or on UPDATE, returns
//   `{ code: '23505' }` as PostgREST does and writes nothing. 'none' enforces
//   nothing.
//
// The slot condition below is written out from migration 041's SQL on purpose,
// NOT imported from lib/agent/pending-slots.ts. A fake that reused the code
// under test would agree with it by construction.

export type PendingIndexMode = '020' | '041' | '054' | 'none'

// Migration 054's sentinel, written out here rather than imported for the same
// reason the slot condition is: a fake that reused the code under test would
// agree with it by construction.
const NULL_REPLY_SENTINEL_FROM_MIGRATION_054 = '00000000-0000-0000-0000-000000000000'

export interface FakeMessageRow {
  id: string
  venue_id: string
  guest_id: string
  direction: string
  review_state: string | null
  review_reason: string | null
  body: string
  pending_until: string | null
  pending_commitment: unknown
  created_at: string
  // TAC-397: migration 054 keys the conversation index on this, and the
  // persist layer reads it to tell a duplicate delivery of one message from a
  // different message winning the slot.
  reply_to_message_id: string | null
  [column: string]: unknown
}

type Filter = { column: string; value: unknown } | { anyOf: string }
type DbError = { code?: string; message: string }

const OBLIGATION_TYPES_FROM_MIGRATION_041 = ['comp', 'hold', 'discount']

function slotOfRow(row: FakeMessageRow): 'obligation' | 'conversation' {
  const carrier = row.pending_commitment
  const type =
    carrier !== null && typeof carrier === 'object' && !Array.isArray(carrier)
      ? (carrier as Record<string, unknown>).type
      : undefined
  return typeof type === 'string' && OBLIGATION_TYPES_FROM_MIGRATION_041.includes(type)
    ? 'obligation'
    : 'conversation'
}

export function createPendingRowsFake(mode: PendingIndexMode) {
  const rows: FakeMessageRow[] = []
  let nextId = 1
  let clock = Date.parse('2026-09-14T16:00:00.000Z')

  function uniqueKey(row: FakeMessageRow): string | null {
    if (row.review_state !== 'pending') return null
    if (mode === 'none') return null
    const base = `${row.venue_id}|${row.guest_id}`
    if (mode === '020') return base
    const slot = slotOfRow(row)
    if (mode === '041' || slot === 'obligation') return `${base}|${slot}`
    // '054', conversation slot: one card per inbound.
    const reply =
      typeof row.reply_to_message_id === 'string' && row.reply_to_message_id.length > 0
        ? row.reply_to_message_id
        : NULL_REPLY_SENTINEL_FROM_MIGRATION_054
    return `${base}|${slot}|${reply}`
  }

  function violates(candidate: FakeMessageRow[]): boolean {
    const seen = new Set<string>()
    for (const row of candidate) {
      const key = uniqueKey(row)
      if (key === null) continue
      if (seen.has(key)) return true
      seen.add(key)
    }
    return false
  }

  const uniqueViolation: DbError = {
    code: '23505',
    message: 'duplicate key value violates unique constraint',
  }

  // PostgREST `.or()` legs, only the shapes the pending reads send:
  // `column.not.is.null`, `column.is.null`, `column.eq.value`.
  function matchesOrLeg(row: FakeMessageRow, leg: string): boolean {
    const [column, ...rest] = leg.split('.')
    const op = rest.join('.')
    if (op === 'not.is.null') return row[column] !== null && row[column] !== undefined
    if (op === 'is.null') return row[column] === null || row[column] === undefined
    if (op.startsWith('eq.')) return row[column] === op.slice('eq.'.length)
    throw new Error(`pending-rows-fake: unsupported or() leg "${leg}"`)
  }

  function matches(row: FakeMessageRow, filters: Filter[]): boolean {
    return filters.every((f) =>
      'anyOf' in f
        ? f.anyOf.split(',').some((leg) => matchesOrLeg(row, leg))
        : row[f.column] === f.value,
    )
  }

  function project(row: FakeMessageRow, columns: string): Record<string, unknown> {
    const out: Record<string, unknown> = {}
    for (const raw of columns.split(',')) {
      const column = raw.trim()
      if (!(column in row)) {
        throw new Error(`pending-rows-fake: selected unknown column "${column}"`)
      }
      out[column] = row[column]
    }
    return structuredClone(out)
  }

  function buildRow(payload: Record<string, unknown>): FakeMessageRow {
    clock += 1000
    return {
      id: `row-${nextId++}`,
      direction: 'outbound',
      review_state: null,
      review_reason: null,
      body: '',
      pending_until: null,
      pending_commitment: null,
      created_at: new Date(clock).toISOString(),
      reply_to_message_id: null,
      ...structuredClone(payload),
    } as FakeMessageRow
  }

  function selectBuilder(columns: string) {
    const filters: Filter[] = []
    let orderBy: { column: string; ascending: boolean } | null = null
    let limit: number | null = null

    function run(): Record<string, unknown>[] {
      let found = rows.filter((r) => matches(r, filters))
      if (orderBy !== null) {
        const { column, ascending } = orderBy
        found = [...found].sort((a, b) => {
          const av = String(a[column])
          const bv = String(b[column])
          return ascending ? av.localeCompare(bv) : bv.localeCompare(av)
        })
      }
      if (limit !== null) found = found.slice(0, limit)
      return found.map((r) => project(r, columns))
    }

    const builder = {
      eq(column: string, value: unknown) {
        filters.push({ column, value })
        return builder
      },
      or(anyOf: string) {
        filters.push({ anyOf })
        return builder
      },
      order(column: string, opts: { ascending: boolean }) {
        orderBy = { column, ascending: opts.ascending }
        return builder
      },
      limit(n: number) {
        limit = n
        return builder
      },
      maybeSingle() {
        const found = run()
        return Promise.resolve({ data: found[0] ?? null, error: null })
      },
      then<T>(
        resolve: (value: { data: Record<string, unknown>[]; error: null }) => T,
        reject?: (reason: unknown) => T,
      ) {
        try {
          return Promise.resolve(resolve({ data: run(), error: null }))
        } catch (e) {
          if (reject) return Promise.resolve(reject(e))
          throw e
        }
      },
    }
    return builder
  }

  function updateBuilder(payload: Record<string, unknown>) {
    const filters: Filter[] = []
    const builder = {
      eq(column: string, value: unknown) {
        filters.push({ column, value })
        return builder
      },
      select(columns: string) {
        return {
          maybeSingle() {
            const targets = rows.filter((r) => matches(r, filters))
            if (targets.length > 1) {
              throw new Error('pending-rows-fake: UPDATE matched more than one row')
            }
            const target = targets[0]
            if (target === undefined) return Promise.resolve({ data: null, error: null })
            const updated = { ...target, ...structuredClone(payload) } as FakeMessageRow
            const candidate = rows.map((r) => (r === target ? updated : r))
            if (violates(candidate)) {
              return Promise.resolve({ data: null, error: uniqueViolation })
            }
            rows[rows.indexOf(target)] = updated
            return Promise.resolve({ data: project(updated, columns), error: null })
          },
        }
      },
    }
    return builder
  }

  const client = {
    from(table: string) {
      if (table !== 'messages') {
        throw new Error(`pending-rows-fake: only the messages table is modelled, got "${table}"`)
      }
      return {
        select: (columns: string) => selectBuilder(columns),
        update: (payload: Record<string, unknown>) => updateBuilder(payload),
        insert: (payload: Record<string, unknown>) => ({
          select: (columns: string) => ({
            single() {
              const row = buildRow(payload)
              if (violates([...rows, row])) {
                return Promise.resolve({ data: null, error: uniqueViolation })
              }
              rows.push(row)
              return Promise.resolve({ data: project(row, columns), error: null })
            },
          }),
        }),
      }
    },
  }

  return {
    client,
    /** Every row, in insertion order. Read-only by convention; tests assert on it. */
    rows,
    /**
     * Insert a row directly, as the database already holds it. Enforces the
     * index mode too, so a test cannot seed a state the migration forbids.
     */
    seed(row: Partial<FakeMessageRow> & { id: string; venue_id: string; guest_id: string }) {
      const built = buildRow(row)
      if (violates([...rows, built])) {
        throw new Error(`pending-rows-fake: seeding ${row.id} violates the ${mode} index`)
      }
      rows.push(built)
      return built
    },
    /** A deep copy of one row, for byte-for-byte comparisons. */
    snapshot(id: string): FakeMessageRow | undefined {
      const row = rows.find((r) => r.id === id)
      return row === undefined ? undefined : structuredClone(row)
    },
  }
}
