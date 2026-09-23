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
  bounds: ['gte' | 'gt', string, unknown][]
  orders: [string, boolean][]
  limit: number | null
}
const recorded: RecordedQuery[] = []
// A plain literal, not a reference to the VENUE const below: `vi.mock` is
// hoisted above every declaration in this file, so anything this initializer
// touches must not be one of them. Each test resets it in `beforeEach`.
let nextResult: { data: unknown; error: unknown } = { data: [{ venue_id: 'venue-1' }], error: null }

vi.mock('@/lib/db/admin', () => ({
  createAdminClient: () => ({
    from: (table: string) => {
      const q: RecordedQuery = {
        table,
        op: 'select',
        payload: null,
        filters: [],
        bounds: [],
        orders: [],
        limit: null,
      }
      const chain = {
        eq(column: string, value: unknown) {
          q.filters.push([column, value])
          return chain
        },
        gte(column: string, value: unknown) {
          q.bounds.push(['gte', column, value])
          return chain
        },
        gt(column: string, value: unknown) {
          q.bounds.push(['gt', column, value])
          return chain
        },
        order(column: string, opts: { ascending: boolean }) {
          q.orders.push([column, opts.ascending])
          return chain
        },
        limit(n: number) {
          q.limit = n
          recorded.push(q)
          return Promise.resolve(nextResult)
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
  findUncoveredInbound,
  shouldRetryTurn,
  pickNewer,
  releaseInboundTurn,
  type CoalesceDeps,
  type InboundTurnState,
  type TurnClaimRow,
} from './coalesce-turn'
import { createTurnClaimsFake, type TurnClaimsFake } from './testing/turn-claims-fake'
import type { AgentResult } from './types'

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

  /**
   * The holder released between our INSERT and our read, so the claim is
   * free again and one retry takes it.
   *
   * ASSERTS THE INSERT COUNT, because the first version asserted only the
   * final status — which is the SAME whether the retry happens or not when
   * the retry also conflicts, so deleting the entire retry branch passed. The
   * fixture also carried a line that cleared nothing under a comment saying it
   * cleared the table, and a second comment four lines below contradicting the
   * first. Both are gone.
   */
  it('retries the insert ONCE and WINS when the holder released in between', async () => {
    const store = createTurnClaimsFake()
    let inserts = 0
    const deps = makeDeps(store, {
      store: {
        ...store,
        insertClaim: async (row) => {
          inserts += 1
          // First attempt races a holder that is gone by the time we look.
          if (inserts === 1) return { ok: true as const, conflict: true }
          return store.insertClaim(row)
        },
        readClaim: async () => ({ ok: true as const, claim: null }),
      },
    })
    const outcome = await claimInboundTurn(
      { venueId: VENUE, guestId: GUEST, claimedMessageId: 'msg-2', agentRunId: 'run-b' },
      deps,
    )
    expect(outcome).toEqual({ status: 'won' })
    expect(inserts).toBe(2)
  })

  it('retries the insert AT MOST once, then defers', async () => {
    const store = createTurnClaimsFake()
    let inserts = 0
    const deps = makeDeps(store, {
      store: {
        ...store,
        insertClaim: async () => {
          inserts += 1
          return { ok: true as const, conflict: true }
        },
        readClaim: async () => ({ ok: true as const, claim: null }),
      },
    })
    const outcome = await claimInboundTurn(
      { venueId: VENUE, guestId: GUEST, claimedMessageId: 'msg-2', agentRunId: 'run-b' },
      deps,
    )
    // Bounded: a third party can always take it, and a caller that fails open
    // loses nothing by deferring. Unbounded, this is a spin against a busy
    // conversation.
    expect(inserts).toBe(2)
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
  it('ships with coalescing ON', () => {
    // Pinned by VALUE, so a revert is deliberate rather than accidental. Every
    // behavioural test forces the gate through the `enabled` parameter instead
    // of reading this constant, which is what keeps the SHUT path covered
    // after the flip — and the shut path is exactly what a rollback restores.
    expect(INBOUND_COALESCING_ENABLED).toBe(true)
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

describe('the DEFAULT findNewerInbound query', () => {
  /**
   * Its own block because it was missed entirely, and the mutant that found
   * the gap is the worst in this change:
   *
   *   DELETING `.eq('direction', 'inbound')` SURVIVED THE WHOLE SUITE.
   *
   * In production an outbound reply is always newer than the inbound it
   * answers, so without that filter EVERY turn finds its own reply as the
   * "newer inbound", re-enters with an outbound id, and `loadInbound` throws
   * on `direction !== 'inbound'` — discarding a reply it had already generated
   * and returning `failed`. Total silencing, one deleted line, zero coverage.
   *
   * The in-memory inbox fake used by the orchestrator tests models none of
   * these filters, which is precisely why it could not show them: the same
   * "a fake that enforces the guarantee cannot show the QUERY carries it"
   * lesson already recorded for the DELETE scope and the takeover CAS, not
   * applied to this fourth query until a mutant found it.
   */
  beforeEach(() => {
    recorded.length = 0
    nextResult = { data: [], error: null }
  })

  const AFTER = new Date('2026-09-23T15:32:36.000Z')

  it('scopes to this venue, this guest, and INBOUND only', async () => {
    const deps = defaultCoalesceDeps()
    await deps.findNewerInbound({
      venueId: VENUE,
      guestId: GUEST,
      afterCreatedAt: AFTER,
      afterId: 'msg-1',
    })
    const q = recorded.at(-1)
    expect(q?.table).toBe('messages')
    expect(q?.filters).toEqual([
      ['venue_id', VENUE],
      ['guest_id', GUEST],
      // Without this every turn finds its own outbound reply. See above.
      ['direction', 'inbound'],
    ])
  })

  it('bounds on created_at with gte, not gt', async () => {
    const deps = defaultCoalesceDeps()
    await deps.findNewerInbound({
      venueId: VENUE,
      guestId: GUEST,
      afterCreatedAt: AFTER,
      afterId: 'msg-1',
    })
    // `gte`, deliberately: two messages of one Instagram delivery can share a
    // millisecond, and a strict `gt` on the timestamp drops the sibling this
    // query exists to find. `pickNewer`'s id tiebreak excludes the row itself.
    expect(recorded.at(-1)?.bounds).toEqual([['gte', 'created_at', AFTER.toISOString()]])
  })

  it('orders on (created_at, id) DESC and takes two', async () => {
    const deps = defaultCoalesceDeps()
    await deps.findNewerInbound({
      venueId: VENUE,
      guestId: GUEST,
      afterCreatedAt: AFTER,
      afterId: 'msg-1',
    })
    const q = recorded.at(-1)
    // Both orders: `created_at` alone is not a total order across one
    // Instagram batch, which is the tie the claim exists to break safely.
    expect(q?.orders).toEqual([
      ['created_at', false],
      ['id', false],
    ])
    // Two rows, not one: with `gte` the first row back can be the anchor
    // itself, so a limit of 1 would hide a same-millisecond sibling.
    expect(q?.limit).toBe(2)
  })

  it('reports a read failure rather than pretending nothing is newer', async () => {
    nextResult = { data: null, error: { message: 'connection reset' } }
    const deps = defaultCoalesceDeps()
    const r = await deps.findNewerInbound({
      venueId: VENUE,
      guestId: GUEST,
      afterCreatedAt: AFTER,
      afterId: 'msg-1',
    })
    // Load-bearing: folded into "nothing newer", a failed read at close time
    // silences a folded message permanently. findUncoveredInbound's third
    // state depends on this staying distinguishable.
    expect(r.ok).toBe(false)
  })
})

describe('findUncoveredInbound tells "nothing" apart from "could not check"', () => {
  const answered = { id: 'msg-1', createdAt: new Date('2026-09-23T15:32:36.000Z') }
  const turnOf = (enabled: boolean): InboundTurnState => ({
    claim: { venueId: VENUE, guestId: GUEST },
    extensionsUsed: 0,
    answered,
    enabled,
    retryDepth: 0,
  })

  it('reports none when the read succeeded and found nothing', async () => {
    expect(
      await findUncoveredInbound({ venueId: VENUE, guestId: GUEST }, turnOf(true), {
        findNewerInbound: async () => ({ ok: true, newer: null }),
      }),
    ).toEqual({ status: 'none' })
  })

  it('reports found when there is something newer', async () => {
    const message = { id: 'msg-2', createdAt: new Date('2026-09-23T15:32:43.000Z') }
    expect(
      await findUncoveredInbound({ venueId: VENUE, guestId: GUEST }, turnOf(true), {
        findNewerInbound: async () => ({ ok: true, newer: message }),
      }),
    ).toEqual({ status: 'found', message })
  })

  /**
   * THE DISTINCTION THIS TYPE EXISTS FOR. Folded into `none`, a failed read at
   * close time means no handoff — and the run that would have covered that
   * message has already stood down, so the guest is silenced permanently with
   * nothing logged. The old two-state version did exactly that, and its own
   * docstring claimed every null "means carry on".
   */
  it('reports unreadable when the read FAILED, never none', async () => {
    const r = await findUncoveredInbound({ venueId: VENUE, guestId: GUEST }, turnOf(true), {
      findNewerInbound: async () => ({ ok: false, error: 'connection reset' }),
    })
    expect(r).toEqual({ status: 'unreadable', error: 'connection reset' })
  })

  it('does not look at all when coalescing is off', async () => {
    let called = false
    const r = await findUncoveredInbound({ venueId: VENUE, guestId: GUEST }, turnOf(false), {
      findNewerInbound: async () => {
        called = true
        return { ok: true, newer: null }
      },
    })
    expect(r).toEqual({ status: 'none' })
    expect(called).toBe(false)
  })
})

describe('never throws, which the module claims at the top', () => {
  /**
   * The claim was false until the flag was flipped and the existing
   * orchestrator tests started failing: supabase-js surfaces most failures as
   * `{ error }` but THROWS on some (an unreachable host, a malformed client),
   * and an escaping throw lands in `runInboundTurn`'s top-level catch and
   * fails the whole turn. That is fail-CLOSED — a guest silenced because a
   * claim table hiccuped — which is the exact inversion this module exists to
   * avoid.
   *
   * Found by flipping the flag, not by any of the 30 mutants. A `satisfies`
   * or a type cannot express "does not throw"; only a test can.
   */
  const throwingStore = {
    insertClaim: async () => {
      throw new Error('socket hang up')
    },
    readClaim: async () => {
      throw new Error('socket hang up')
    },
    takeOverClaim: async () => {
      throw new Error('socket hang up')
    },
    deleteClaim: async () => {
      throw new Error('socket hang up')
    },
  }

  it('claimInboundTurn reports unavailable instead of throwing', async () => {
    const deps = makeDeps(createTurnClaimsFake(), { store: throwingStore })
    const outcome = await claimInboundTurn(
      { venueId: VENUE, guestId: GUEST, claimedMessageId: 'msg-1', agentRunId: 'run-a' },
      deps,
    )
    // `unavailable`, never `lost`: the caller must proceed as it does today.
    expect(outcome.status).toBe('unavailable')
  })

  it('releaseInboundTurn reports the failure instead of throwing', async () => {
    const r = await releaseInboundTurn(
      { venueId: VENUE, guestId: GUEST, agentRunId: 'run-a' },
      { store: throwingStore },
    )
    expect(r.ok).toBe(false)
  })

  it('findUncoveredInbound reports UNREADABLE on a throw, never none', async () => {
    const r = await findUncoveredInbound(
      { venueId: VENUE, guestId: GUEST },
      {
        claim: { venueId: VENUE, guestId: GUEST },
        extensionsUsed: 0,
        answered: { id: 'msg-1', createdAt: T0 },
        enabled: true,
        retryDepth: 0,
      },
      {
        findNewerInbound: async () => {
          throw new Error('socket hang up')
        },
      },
    )
    // Folding a throw into `none` would reintroduce the silencing blocker by
    // a different route.
    expect(r.status).toBe('unreadable')
  })
})

describe('shouldRetryTurn — the bound, and which outcomes earn a second attempt', () => {
  /**
   * Unit-level because the orchestrator path cannot reach all of it, and
   * because the bound is the ruling: the retry restores the second attempt the
   * claim removed, and NOTHING more.
   *
   * The depth cases especially. An orchestrator test for the bound has to make
   * the failure self-limiting, or the unbounded build crashes the worker
   * rather than failing — which reads as SURVIVED. Here it is arithmetic.
   */
  const base = (over: Partial<InboundTurnState> = {}): InboundTurnState => ({
    claim: { venueId: VENUE, guestId: GUEST },
    extensionsUsed: 0,
    answered: { id: 'msg-1', createdAt: T0 },
    enabled: true,
    retryDepth: 0,
    ...over,
  })

  it('retries a failed turn at depth 0', () => {
    expect(shouldRetryTurn({ status: 'failed', stage: 'context_build', error: 'x' }, base())).toBe(
      true,
    )
  })

  it('does NOT retry at the bound', () => {
    // MAX_TURN_RETRIES = 1, so depth 1 is the retry itself and gets no second.
    expect(
      shouldRetryTurn({ status: 'failed', stage: 'context_build', error: 'x' }, base({ retryDepth: 1 })),
    ).toBe(false)
  })

  it('does NOT retry past the bound either', () => {
    expect(
      shouldRetryTurn({ status: 'failed', stage: 'context_build', error: 'x' }, base({ retryDepth: 9 })),
    ).toBe(false)
  })

  it('retries a THROW, which is the strongest case: no result at all', () => {
    expect(shouldRetryTurn(null, base())).toBe(true)
  })

  it('does not retry when coalescing is off', () => {
    // Unreachable through closeCoalescedTurn today — with the gate shut no
    // claim is taken, so it returns before asking. Pinned here anyway: this is
    // the function's own contract, and a caller that acquired a claim some
    // other way must not get a retry it never earned.
    expect(shouldRetryTurn(null, base({ enabled: false }))).toBe(false)
  })

  it('does not retry a turn that never answered anything', () => {
    expect(shouldRetryTurn(null, base({ answered: null }))).toBe(false)
  })

  /**
   * The whole vocabulary, as a literal table. `RETRYABLE_OUTCOME` is a total
   * map so a new AgentResult member fails `tsc` until someone decides — this
   * is what pins the decisions it already carries.
   */
  it.each([
    ['sent', { status: 'sent', outboundMessageId: 'o1' }, false],
    ['queued', { status: 'queued', outboundMessageId: 'c1', triggers: [], primaryTrigger: 'x' }, false],
    ['skipped_duplicate', { status: 'skipped_duplicate' }, false],
    ['refused', { status: 'refused', reason: 'low_fidelity', attemptScores: [0.1] }, true],
    // A draft that lost a slot loses it again: the card that took the slot is
    // still there, so a retry is a guaranteed-useless second generation.
    ['dropped', { status: 'dropped', reason: 'slot_occupied', protectedDraftId: 'd', triggers: [] }, false],
    ['superseded', { status: 'superseded', byMessageId: 'm' }, false],
    ['coalesced', { status: 'coalesced', intoAgentRunId: 'r', intoMessageId: 'm' }, false],
    ['silenced', { status: 'silenced' }, false],
    ['failed', { status: 'failed', stage: 'generation', error: 'x' }, true],
  ] as const)('%s → %s', (_name, result, expected) => {
    expect(shouldRetryTurn(result as AgentResult, base())).toBe(expected)
  })
})
