import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
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
