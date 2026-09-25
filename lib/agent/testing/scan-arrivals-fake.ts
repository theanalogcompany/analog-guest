// TAC-536: an in-memory store for the scan-greeting processor's tests.
//
// It answers ONLY the query shapes processDueScanGreetings sends. Anything
// else is undefined on it and throws, so a read or write the processor must
// never make fails the test rather than being answered by a mock's opinion of
// what it meant. Same posture as lib/messaging/instagram/testing/db-fake.ts.
//
// IT MODELS MIGRATION 064'S PARTIAL UNIQUE INDEX, and that is the whole point
// of the file. The once-per-venue-day greeting guard is a Postgres index, not
// application logic, so a fake without it would let the guard be deleted and
// every test still pass. The key is written out longhand here rather than
// imported from the code under test, for the reason pending-rows-fake.ts
// gives about migration 054's sentinel: a fake that reuses the code it is
// checking agrees with it by construction.
//
//   unique (venue_id, guest_id, venue_local_date) where claimed_at is not null
//
// A violation returns { code: '23505' } as PostgREST does and writes nothing.
// As in Postgres, a row with a NULL in the key never conflicts.

export interface ScanArrivalRow {
  id: string
  venue_id: string
  guest_id: string
  scan_message_id: string | null
  scanned_at: string
  had_prior_conversation: boolean
  claimed_at: string | null
  venue_local_date: string | null
  outcome: string | null
  resolved_at: string | null
}

export interface VenueRow {
  id: string
  timezone: string | null
  status: string | null
}

export interface GuestRow {
  id: string
  opted_out_at: string | null
}

export interface MessageRow {
  id: string
  venue_id: string
  guest_id: string
  direction: string
  provider_message_id: string | null
  created_at: string
}

export interface ScanArrivalsSeed {
  arrivals?: ScanArrivalRow[]
  venues?: VenueRow[]
  guests?: GuestRow[]
  messages?: MessageRow[]
  venueInfo?: Record<string, unknown> | null
}

type FakeError = { code?: string; message: string }

/**
 * The partial unique index. Returns true when `candidate` would collide with a
 * row already in the index.
 */
function violatesOneGreetingPerDay(
  rows: ScanArrivalRow[],
  candidate: { id: string; venue_id: string; guest_id: string; venue_local_date: string | null },
): boolean {
  // A NULL in the key is never in the index, exactly as in Postgres.
  if (candidate.venue_local_date === null) return false
  return rows.some(
    (row) =>
      row.id !== candidate.id &&
      row.claimed_at !== null &&
      row.venue_id === candidate.venue_id &&
      row.guest_id === candidate.guest_id &&
      row.venue_local_date === candidate.venue_local_date,
  )
}

export function createScanArrivalsFake(seed: ScanArrivalsSeed = {}) {
  const arrivals: ScanArrivalRow[] = (seed.arrivals ?? []).map((r) => ({ ...r }))
  const venues = seed.venues ?? []
  const guests = seed.guests ?? []
  const messages = seed.messages ?? []
  const venueInfo = seed.venueInfo === undefined ? {} : seed.venueInfo
  const queuedErrors: Array<{ table: string; op: 'select' | 'update'; error: FakeError }> = []

  function takeError(table: string, op: 'select' | 'update'): FakeError | null {
    const i = queuedErrors.findIndex((q) => q.table === table && q.op === op)
    if (i === -1) return null
    return queuedErrors.splice(i, 1)[0]?.error ?? null
  }

  function arrivalsSelect() {
    const filters: Array<[string, 'is', unknown]> = []
    const builder = {
      is(column: string, value: unknown) {
        filters.push([column, 'is', value])
        return builder
      },
      eq(column: string, value: unknown) {
        filters.push([column, 'is', value])
        return builder
      },
      order() {
        return builder
      },
      limit(n: number) {
        const error = takeError('instagram_scan_arrivals', 'select')
        if (error) return Promise.resolve({ data: null, error })
        const matched = arrivals
          .filter((row) =>
            filters.every(([c, , v]) => (row as unknown as Record<string, unknown>)[c] === v),
          )
          .sort((a, b) => a.scanned_at.localeCompare(b.scanned_at))
          .slice(0, n)
        return Promise.resolve({ data: matched, error: null })
      },
      // loadScanCarryForward reads one row newest-first; not used by the
      // processor, so deliberately absent here.
    }
    return builder
  }

  function arrivalsUpdate(patch: Record<string, unknown>) {
    const filters: Array<[string, 'eq' | 'is', unknown]> = []
    const apply = () => {
      const error = takeError('instagram_scan_arrivals', 'update')
      if (error) return { data: null, error }
      const matched = arrivals.filter((row) =>
        filters.every(([c, , v]) => (row as unknown as Record<string, unknown>)[c] === v),
      )
      for (const row of matched) {
        const candidate = {
          id: row.id,
          venue_id: row.venue_id,
          guest_id: row.guest_id,
          venue_local_date:
            'venue_local_date' in patch
              ? (patch.venue_local_date as string | null)
              : row.venue_local_date,
        }
        const wouldBeClaimed =
          'claimed_at' in patch ? patch.claimed_at !== null : row.claimed_at !== null
        if (wouldBeClaimed && violatesOneGreetingPerDay(arrivals, candidate)) {
          return {
            data: null,
            error: { code: '23505', message: 'duplicate key value violates unique constraint' },
          }
        }
        Object.assign(row, patch)
      }
      return { data: matched.map((r) => ({ id: r.id })), error: null }
    }
    const builder = {
      eq(column: string, value: unknown) {
        filters.push([column, 'eq', value])
        return builder
      },
      is(column: string, value: unknown) {
        filters.push([column, 'is', value])
        return builder
      },
      select() {
        return Promise.resolve(apply())
      },
      then<R>(onFulfilled: (v: { data: unknown; error: FakeError | null }) => R): Promise<R> {
        return Promise.resolve(onFulfilled(apply()))
      },
    }
    return builder
  }

  function messagesSelect() {
    const eqs: Array<[string, unknown]> = []
    let notNullColumn: string | null = null
    let gteAt: string | null = null
    const builder = {
      eq(column: string, value: unknown) {
        eqs.push([column, value])
        return builder
      },
      // Only `.not(col, 'is', null)` is sent, so the operator and value are
      // not read. Recording the column is what the filter below needs.
      not(column: string) {
        notNullColumn = column
        return builder
      },
      gte(_column: string, value: string) {
        gteAt = value
        return builder
      },
      limit() {
        return builder
      },
      maybeSingle() {
        const error = takeError('messages', 'select')
        if (error) return Promise.resolve({ data: null, error })
        const match = messages.find((row) => {
          const r = row as unknown as Record<string, unknown>
          if (!eqs.every(([c, v]) => r[c] === v)) return false
          if (notNullColumn !== null && r[notNullColumn] == null) return false
          if (gteAt !== null && row.created_at < gteAt) return false
          return true
        })
        return Promise.resolve({ data: match ? { id: match.id } : null, error: null })
      },
    }
    return builder
  }

  function rowSelect(table: 'venues' | 'guests' | 'venue_configs', columns: string) {
    const eqs: Array<[string, unknown]> = []
    const builder = {
      eq(column: string, value: unknown) {
        eqs.push([column, value])
        return builder
      },
      maybeSingle() {
        const error = takeError(table, 'select')
        if (error) return Promise.resolve({ data: null, error })
        if (table === 'venue_configs') {
          return Promise.resolve({ data: { venue_info: venueInfo }, error: null })
        }
        const source: Array<Record<string, unknown>> =
          table === 'venues'
            ? (venues as unknown as Array<Record<string, unknown>>)
            : (guests as unknown as Array<Record<string, unknown>>)
        const match = source.find((row) => eqs.every(([c, v]) => row[c] === v))
        if (!match) return Promise.resolve({ data: null, error: null })
        const projected: Record<string, unknown> = {}
        for (const column of columns.split(',').map((c) => c.trim())) {
          projected[column] = match[column] ?? null
        }
        return Promise.resolve({ data: projected, error: null })
      },
    }
    return builder
  }

  const client = {
    from(table: string) {
      if (table === 'instagram_scan_arrivals') {
        return {
          select: () => arrivalsSelect(),
          update: (patch: Record<string, unknown>) => arrivalsUpdate(patch),
        }
      }
      if (table === 'messages') return { select: () => messagesSelect() }
      if (table === 'venues' || table === 'guests' || table === 'venue_configs') {
        return { select: (columns: string) => rowSelect(table, columns) }
      }
      throw new Error(`scan-arrivals fake: unexpected table ${table}`)
    },
  }

  return {
    // The cast is the same one every fake in this repo takes: it answers the
    // shapes the code under test sends, not the whole SupabaseClient surface.
    client: client as never,
    arrivals,
    failNext(table: string, op: 'select' | 'update', error: FakeError) {
      queuedErrors.push({ table, op, error })
    },
  }
}
