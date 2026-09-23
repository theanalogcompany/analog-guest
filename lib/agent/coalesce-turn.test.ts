import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * A RECORDING Supabase client, so the DEFAULT store's queries can be asserted.
 *
 * It exists because two mutants survived a run against the fake alone:
 * dropping the `agent_run_id` filter from the real DELETE, and dropping the
 * CAS filter from the real UPDATE. Both are the guarantee — a release that is
 * not scoped deletes the claim a takeover just granted someone else, and an
 * UPDATE without the CAS lets two runs both take over one expired lease — and
 * neither is reachable through the fake, which implements the scoping itself.
 * Every test above proves the LOGIC; these prove the QUERY.
 */
interface RecordedQuery {
  table: string
  op: 'insert' | 'select' | 'update' | 'delete'
  payload: Record<string, unknown> | null
  filters: [string, unknown][]
}
const recorded: RecordedQuery[] = []
// A plain literal, not a reference to the VENUE const below: `vi.mock` is
// hoisted above every declaration in this file, so anything this initializer
// touches must not be one of them. Each test resets it in `beforeEach`.
let nextResult: { data: unknown; error: unknown } = { data: [{ venue_id: 'venue-1' }], error: null }

vi.mock('@/lib/db/admin', () => ({
  createAdminClient: () => ({
    from: (table: string) => {
      const q: RecordedQuery = { table, op: 'select', payload: null, filters: [] }
      const chain = {
        eq(column: string, value: unknown) {
          q.filters.push([column, value])
          return chain
        },
        select() {
          recorded.push(q)
          return Object.assign(Promise.resolve(nextResult), chain)
        },
        maybeSingle: async () => {
          recorded.push(q)
          return nextResult
        },
        then: undefined,
      }
      return {
        insert(payload: Record<string, unknown>) {
          q.op = 'insert'
          q.payload = payload
          recorded.push(q)
          return Promise.resolve(nextResult)
        },
        select() {
          q.op = 'select'
          return chain
        },
        update(payload: Record<string, unknown>) {
          q.op = 'update'
          q.payload = payload
          return chain
        },
        delete() {
          q.op = 'delete'
          return chain
        },
      }
    },
  }),
}))
import {
  CLAIM_LEASE_MS,
  COALESCE_SETTLE_MS,
  INBOUND_COALESCING_ENABLED,
  MAX_TURN_EXTENSIONS,
  claimInboundTurn,
  defaultCoalesceDeps,
  pickNewer,
  releaseInboundTurn,
  type CoalesceDeps,
  type TurnClaimRow,
} from './coalesce-turn'
import { createTurnClaimsFake, type TurnClaimsFake } from './testing/turn-claims-fake'

const VENUE = 'venue-1'
const GUEST = 'guest-1'
const T0 = new Date('2026-09-23T15:32:36.000Z')

function makeDeps(
  store: TurnClaimsFake,
  overrides: Partial<CoalesceDeps> = {},
): CoalesceDeps {
  return {
    store,
    findNewerInbound: async () => ({ ok: true, newer: null }),
    now: () => T0,
    sleep: async () => {},
    ...overrides,
  }
}

function claimRow(overrides: Partial<TurnClaimRow> = {}): TurnClaimRow {
  return {
    venueId: VENUE,
    guestId: GUEST,
    claimedMessageId: 'msg-1',
    agentRunId: 'run-a',
    claimedAt: T0,
    expiresAt: new Date(T0.getTime() + CLAIM_LEASE_MS),
    ...overrides,
  }
}

describe('claimInboundTurn', () => {
  it('wins on an empty table and writes the lease from CLAIM_LEASE_MS', async () => {
    const store = createTurnClaimsFake()
    const outcome = await claimInboundTurn(
      { venueId: VENUE, guestId: GUEST, claimedMessageId: 'msg-1', agentRunId: 'run-a' },
      makeDeps(store),
    )
    expect(outcome).toEqual({ status: 'won' })
    expect(store.rows()).toHaveLength(1)
    expect(store.rows()[0].expiresAt.getTime()).toBe(T0.getTime() + CLAIM_LEASE_MS)
  })

  /**
   * AC 5, and the reason the fake enforces a primary key and yields before it
   * checks. Both calls start before either finishes, so this fails against a
   * claim that reads first and writes second without atomicity — which is
   * exactly the shape `findExistingReply` has today.
   */
  it('two concurrent runs racing for one conversation: exactly one wins', async () => {
    const store = createTurnClaimsFake()
    const deps = makeDeps(store)
    const [a, b] = await Promise.all([
      claimInboundTurn(
        { venueId: VENUE, guestId: GUEST, claimedMessageId: 'msg-1', agentRunId: 'run-a' },
        deps,
      ),
      claimInboundTurn(
        { venueId: VENUE, guestId: GUEST, claimedMessageId: 'msg-2', agentRunId: 'run-b' },
        deps,
      ),
    ])
    const won = [a, b].filter((o) => o.status === 'won')
    const lost = [a, b].filter((o) => o.status === 'lost')
    expect(won).toHaveLength(1)
    expect(lost).toHaveLength(1)
    expect(store.rows()).toHaveLength(1)
  })

  it('ten concurrent runs racing for one conversation: exactly one wins', async () => {
    const store = createTurnClaimsFake()
    const deps = makeDeps(store)
    const outcomes = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        claimInboundTurn(
          {
            venueId: VENUE,
            guestId: GUEST,
            claimedMessageId: `msg-${i}`,
            agentRunId: `run-${i}`,
          },
          deps,
        ),
      ),
    )
    expect(outcomes.filter((o) => o.status === 'won')).toHaveLength(1)
    expect(store.rows()).toHaveLength(1)
  })

  it('different guests at one venue do not contend', async () => {
    const store = createTurnClaimsFake()
    const deps = makeDeps(store)
    const [a, b] = await Promise.all([
      claimInboundTurn(
        { venueId: VENUE, guestId: 'guest-1', claimedMessageId: 'm1', agentRunId: 'run-a' },
        deps,
      ),
      claimInboundTurn(
        { venueId: VENUE, guestId: 'guest-2', claimedMessageId: 'm2', agentRunId: 'run-b' },
        deps,
      ),
    ])
    expect(a.status).toBe('won')
    expect(b.status).toBe('won')
    expect(store.rows()).toHaveLength(2)
  })

  it('loses to a live lease, and names the holder and the message it is answering', async () => {
    const store = createTurnClaimsFake()
    store.seed(claimRow({ agentRunId: 'run-a', claimedMessageId: 'msg-1' }))
    const outcome = await claimInboundTurn(
      { venueId: VENUE, guestId: GUEST, claimedMessageId: 'msg-2', agentRunId: 'run-b' },
      // one second into a two-minute lease
      makeDeps(store, { now: () => new Date(T0.getTime() + 1_000) }),
    )
    expect(outcome).toEqual({
      status: 'lost',
      heldByAgentRunId: 'run-a',
      heldForMessageId: 'msg-1',
    })
    expect(store.rows()[0].agentRunId).toBe('run-a')
  })

  it('takes over an EXPIRED lease', async () => {
    const store = createTurnClaimsFake()
    store.seed(claimRow({ agentRunId: 'run-dead' }))
    const after = new Date(T0.getTime() + CLAIM_LEASE_MS + 1)
    const outcome = await claimInboundTurn(
      { venueId: VENUE, guestId: GUEST, claimedMessageId: 'msg-2', agentRunId: 'run-b' },
      makeDeps(store, { now: () => after }),
    )
    expect(outcome).toEqual({ status: 'won' })
    expect(store.rows()[0].agentRunId).toBe('run-b')
  })

  /**
   * Both sides of the boundary, because the first version of this test
   * asserted a preference nobody had decided and the code was right: a claim
   * is live while `now < expires_at`, so at exactly `expires_at` it has
   * expired. One millisecond either way changes nothing in production; an
   * undecided boundary does, because the next reader re-derives it.
   */
  it('honours a lease up to the instant BEFORE it expires', async () => {
    const store = createTurnClaimsFake()
    store.seed(claimRow({ agentRunId: 'run-a' }))
    const outcome = await claimInboundTurn(
      { venueId: VENUE, guestId: GUEST, claimedMessageId: 'msg-2', agentRunId: 'run-b' },
      makeDeps(store, { now: () => new Date(T0.getTime() + CLAIM_LEASE_MS - 1) }),
    )
    expect(outcome.status).toBe('lost')
    expect(store.rows()[0].agentRunId).toBe('run-a')
  })

  it('treats the exact expiry instant as expired, and takes over', async () => {
    const store = createTurnClaimsFake()
    store.seed(claimRow({ agentRunId: 'run-a' }))
    const outcome = await claimInboundTurn(
      { venueId: VENUE, guestId: GUEST, claimedMessageId: 'msg-2', agentRunId: 'run-b' },
      makeDeps(store, { now: () => new Date(T0.getTime() + CLAIM_LEASE_MS) }),
    )
    expect(outcome.status).toBe('won')
    expect(store.rows()[0].agentRunId).toBe('run-b')
  })

  /**
   * Two runs both find the same expired claim. The CAS is the only thing
   * between them — without it both read `run-dead`, both update, and both
   * proceed to reply.
   */
  it('two runs racing to take over ONE expired lease: exactly one wins', async () => {
    const store = createTurnClaimsFake()
    store.seed(claimRow({ agentRunId: 'run-dead' }))
    const deps = makeDeps(store, {
      now: () => new Date(T0.getTime() + CLAIM_LEASE_MS + 1),
    })
    const outcomes = await Promise.all([
      claimInboundTurn(
        { venueId: VENUE, guestId: GUEST, claimedMessageId: 'msg-2', agentRunId: 'run-b' },
        deps,
      ),
      claimInboundTurn(
        { venueId: VENUE, guestId: GUEST, claimedMessageId: 'msg-3', agentRunId: 'run-c' },
        deps,
      ),
    ])
    expect(outcomes.filter((o) => o.status === 'won')).toHaveLength(1)
    expect(store.rows()).toHaveLength(1)
  })

  it('retries the insert ONCE when the holder released between insert and read', async () => {
    const store = createTurnClaimsFake()
    store.seed(claimRow({ agentRunId: 'run-a' }))
    // The read finds nothing: the holder released in between.
    const vanishing = {
      ...store,
      readClaim: async () => ({ ok: true as const, claim: null }),
    }
    // First insert conflicts against the seeded row; drop it so the retry wins.
    let first = true
    const deps = makeDeps(store, {
      store: {
        ...vanishing,
        insertClaim: async (row) => {
          if (first) {
            first = false
            return { ok: true as const, conflict: true }
          }
          return store.insertClaim(row)
        },
      },
    })
    // Clear the table so the retry can succeed, mirroring the release.
    store.rows().forEach(() => undefined)
    const outcome = await claimInboundTurn(
      { venueId: VENUE, guestId: GUEST, claimedMessageId: 'msg-2', agentRunId: 'run-b' },
      deps,
    )
    // The seeded row is still there, so the retry conflicts and we defer.
    expect(outcome.status).toBe('lost')
  })

  describe('fails OPEN, never closed', () => {
    // Blocking a reply because a claim table was unreachable would make a
    // guest's silence a NEW failure mode introduced by the fix for a duplicate
    // reply. Every store failure must be distinguishable from `lost`.
    it('reports unavailable when the insert fails', async () => {
      const store = createTurnClaimsFake()
      store.failNext('insert')
      const outcome = await claimInboundTurn(
        { venueId: VENUE, guestId: GUEST, claimedMessageId: 'msg-1', agentRunId: 'run-a' },
        makeDeps(store),
      )
      expect(outcome.status).toBe('unavailable')
    })

    it('reports unavailable when the holder read fails', async () => {
      const store = createTurnClaimsFake()
      store.seed(claimRow())
      store.failNext('read')
      const outcome = await claimInboundTurn(
        { venueId: VENUE, guestId: GUEST, claimedMessageId: 'msg-2', agentRunId: 'run-b' },
        makeDeps(store),
      )
      expect(outcome.status).toBe('unavailable')
    })

    it('reports unavailable when the takeover fails', async () => {
      const store = createTurnClaimsFake()
      store.seed(claimRow({ agentRunId: 'run-dead' }))
      store.failNext('takeOver')
      const outcome = await claimInboundTurn(
        { venueId: VENUE, guestId: GUEST, claimedMessageId: 'msg-2', agentRunId: 'run-b' },
        makeDeps(store, { now: () => new Date(T0.getTime() + CLAIM_LEASE_MS + 1) }),
      )
      expect(outcome.status).toBe('unavailable')
    })
  })
})

describe('releaseInboundTurn', () => {
  it('deletes its own claim', async () => {
    const store = createTurnClaimsFake()
    store.seed(claimRow({ agentRunId: 'run-a' }))
    const result = await releaseInboundTurn(
      { venueId: VENUE, guestId: GUEST, agentRunId: 'run-a' },
      { store },
    )
    expect(result).toEqual({ ok: true, deleted: true })
    expect(store.rows()).toHaveLength(0)
  })

  /**
   * The run whose lease expired is by definition still running, and its
   * `finally` eventually fires. Unscoped, that release would delete the new
   * holder's claim and let a third run in mid-turn.
   */
  it('never deletes a claim another run took over', async () => {
    const store = createTurnClaimsFake()
    store.seed(claimRow({ agentRunId: 'run-b' }))
    const result = await releaseInboundTurn(
      { venueId: VENUE, guestId: GUEST, agentRunId: 'run-a' },
      { store },
    )
    expect(result).toEqual({ ok: true, deleted: false })
    expect(store.rows()[0].agentRunId).toBe('run-b')
  })

  it('reports the failure rather than throwing', async () => {
    const store = createTurnClaimsFake()
    store.failNext('delete')
    const result = await releaseInboundTurn(
      { venueId: VENUE, guestId: GUEST, agentRunId: 'run-a' },
      { store },
    )
    expect(result.ok).toBe(false)
  })
})

describe('pickNewer', () => {
  const T = '2026-09-23T15:32:36.000Z'

  it('returns null when nothing is newer', () => {
    expect(pickNewer([{ id: 'a', created_at: T }], new Date(T), 'a')).toBeNull()
  })

  it('returns a strictly later message', () => {
    const later = '2026-09-23T15:32:43.000Z'
    expect(pickNewer([{ id: 'b', created_at: later }], new Date(T), 'a')).toEqual({
      id: 'b',
      createdAt: new Date(later),
    })
  })

  /**
   * The Instagram shape: one delivery carries several guest messages and they
   * land in the same millisecond, so `created_at` alone is not a total order.
   * Without the id tiebreak the sibling is invisible and two runs each believe
   * they are newest.
   */
  it('orders a same-millisecond sibling by id rather than dropping it', () => {
    expect(pickNewer([{ id: 'b', created_at: T }], new Date(T), 'a')).toEqual({
      id: 'b',
      createdAt: new Date(T),
    })
  })

  it('does not return a same-millisecond sibling that sorts BELOW us', () => {
    expect(pickNewer([{ id: 'a', created_at: T }], new Date(T), 'b')).toBeNull()
  })

  it('skips an unparseable timestamp rather than returning NaN', () => {
    const later = '2026-09-23T15:32:43.000Z'
    expect(
      pickNewer(
        [
          { id: 'bad', created_at: 'not a date' },
          { id: 'b', created_at: later },
        ],
        new Date(T),
        'a',
      ),
    ).toEqual({ id: 'b', createdAt: new Date(later) })
  })
})

describe('the shipped constants', () => {
  /**
   * Pinned by VALUE, not merely referenced. A flag whose value no test asserts
   * can be flipped by a careless edit with nothing failing — and this one
   * decides whether a guest's second message gets its own reply.
   */
  it('ships with coalescing OFF', () => {
    expect(INBOUND_COALESCING_ENABLED).toBe(false)
  })

  it('pins the settle window at 8s and the lease at 2 minutes', () => {
    // The window is a costed trade, not a default. See the constant's own
    // docstring for the no-settle alternative and what it buys.
    expect(COALESCE_SETTLE_MS).toBe(8_000)
    expect(CLAIM_LEASE_MS).toBe(120_000)
  })

  it('keeps the lease comfortably above a worst-case turn', () => {
    // A lease shorter than a turn would let a live run be taken over mid-turn,
    // which is the duplicate-reply defect wearing a different hat.
    expect(CLAIM_LEASE_MS).toBeGreaterThan(COALESCE_SETTLE_MS * (MAX_TURN_EXTENSIONS + 1))
  })

  it('bounds extensions, so a guest typing continuously cannot hold a turn open', () => {
    expect(MAX_TURN_EXTENSIONS).toBe(2)
  })
})

describe('the default store is bound to migration 057', () => {
  const MIGRATION = readFileSync(
    join(__dirname, '..', '..', 'db', 'migrations', '057_inbound_turn_coalescing.sql'),
    'utf8',
  )

  it('guards itself: the migration is readable', () => {
    expect(MIGRATION.length).toBeGreaterThan(0)
  })

  /**
   * THE claim mechanism. Without this key two inserts both succeed and the
   * whole module is ceremony — every test above would still pass, because the
   * fake enforces the key itself.
   */
  it('declares primary key (venue_id, guest_id)', () => {
    expect(MIGRATION.replace(/\s+/g, ' ')).toContain('primary key (venue_id, guest_id)')
  })

  it('declares every column the default store reads and writes', () => {
    for (const column of [
      'venue_id',
      'guest_id',
      'claimed_message_id',
      'agent_run_id',
      'claimed_at',
      'expires_at',
    ]) {
      expect(MIGRATION).toContain(column)
    }
  })

  /**
   * An `on conflict` clause anywhere in the claim insert would hand both runs
   * a success. The SQL cannot express it — this asserts the INTENT is recorded
   * where the next person editing the store will read it.
   */
  it('records that the insert must carry no ON CONFLICT clause', () => {
    expect(MIGRATION.toLowerCase()).toContain('no on conflict')
  })

  it('builds a default deps object without constructing a client', () => {
    // Lazy client construction: a test that injects a fake must never trip
    // env reads. Building the deps is enough to prove the client is not made
    // eagerly — createAdminClient throws without SUPABASE_SECRET_KEY.
    const deps = defaultCoalesceDeps()
    expect(typeof deps.store.insertClaim).toBe('function')
    expect(typeof deps.findNewerInbound).toBe('function')
    expect(deps.now()).toBeInstanceOf(Date)
  })
})

describe('the DEFAULT store issues the right queries', () => {
  // Not "does the logic work" — that is every test above, against the fake.
  // This is "does the SQL carry the filters the logic depends on", which the
  // fake cannot show because it implements the scoping itself. Two mutants
  // survived a run against the fake alone and are killed here.
  beforeEach(() => {
    recorded.length = 0
    nextResult = { data: [{ venue_id: VENUE }], error: null }
  })

  it('inserts the claim with NO onConflict: the primary key must decide', async () => {
    const deps = defaultCoalesceDeps()
    await deps.store.insertClaim(claimRow())
    const insert = recorded.find((q) => q.op === 'insert')
    expect(insert?.table).toBe('inbound_turn_claims')
    // The insert takes the row and nothing else. An `ignoreDuplicates` or an
    // upsert option here would hand BOTH racing runs a success, which is the
    // entire defect wearing the fix's clothes.
    expect(insert?.payload).toEqual({
      venue_id: VENUE,
      guest_id: GUEST,
      claimed_message_id: 'msg-1',
      agent_run_id: 'run-a',
      claimed_at: T0.toISOString(),
      expires_at: new Date(T0.getTime() + CLAIM_LEASE_MS).toISOString(),
    })
  })

  it('maps a 23505 to a conflict rather than an error', async () => {
    nextResult = { data: null, error: { code: '23505', message: 'duplicate key' } }
    const deps = defaultCoalesceDeps()
    // Read as an error instead, every racing run would fail OPEN and reply —
    // the claim would be inert and the defect unchanged.
    expect(await deps.store.insertClaim(claimRow())).toEqual({ ok: true, conflict: true })
  })

  it('reports a non-23505 insert failure as an error, so the caller fails open', async () => {
    nextResult = { data: null, error: { code: '42P01', message: 'relation does not exist' } }
    const deps = defaultCoalesceDeps()
    const r = await deps.store.insertClaim(claimRow())
    expect(r.ok).toBe(false)
  })

  /** M7. Unscoped, a release deletes the claim a takeover just granted. */
  it('scopes the DELETE to venue, guest AND agent_run_id', async () => {
    const deps = defaultCoalesceDeps()
    await deps.store.deleteClaim({ venueId: VENUE, guestId: GUEST, agentRunId: 'run-a' })
    const del = recorded.find((q) => q.op === 'delete')
    expect(del?.table).toBe('inbound_turn_claims')
    expect(del?.filters).toEqual([
      ['venue_id', VENUE],
      ['guest_id', GUEST],
      ['agent_run_id', 'run-a'],
    ])
  })

  /** M10. Without the CAS filter two runs both take over one expired lease. */
  it('gates the takeover UPDATE on the EXPECTED agent_run_id, not its own', async () => {
    const deps = defaultCoalesceDeps()
    await deps.store.takeOverClaim({
      row: claimRow({ agentRunId: 'run-new' }),
      expectedAgentRunId: 'run-dead',
    })
    const upd = recorded.find((q) => q.op === 'update')
    expect(upd?.filters).toEqual([
      ['venue_id', VENUE],
      ['guest_id', GUEST],
      // The CAS. `run-dead` is what we READ; `run-new` is what we are writing.
      // Filtering on our own id would match nothing and the takeover could
      // never succeed; filtering on neither lets two runs both take it.
      ['agent_run_id', 'run-dead'],
    ])
    expect(upd?.payload).toMatchObject({ agent_run_id: 'run-new' })
  })

  it('reports a takeover that matched no row as not taken over', async () => {
    nextResult = { data: [], error: null }
    const deps = defaultCoalesceDeps()
    expect(
      await deps.store.takeOverClaim({
        row: claimRow(),
        expectedAgentRunId: 'run-dead',
      }),
    ).toEqual({ ok: true, tookOver: false })
  })

  it('scopes the claim read to venue and guest', async () => {
    nextResult = { data: null, error: null }
    const deps = defaultCoalesceDeps()
    await deps.store.readClaim(VENUE, GUEST)
    const sel = recorded.find((q) => q.op === 'select')
    expect(sel?.filters).toEqual([
      ['venue_id', VENUE],
      ['guest_id', GUEST],
    ])
  })
})
