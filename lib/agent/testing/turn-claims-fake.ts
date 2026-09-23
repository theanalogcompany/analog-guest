/**
 * TAC-526: an in-memory `inbound_turn_claims` table for the coalescing tests.
 *
 * Sibling of `pending-rows-fake.ts`, and it exists for the same reason: the
 * guarantee under test is a DATABASE guarantee, so a mock that simply returns
 * what the test wants proves nothing about it.
 *
 * Two properties are the whole point:
 *
 *   THE PRIMARY KEY IS ENFORCED, and a conflicting insert returns
 *   `{ code: '23505' }` the way PostgREST does, writing nothing. Migration
 *   057's `primary key (venue_id, guest_id)` is what makes exactly one run
 *   win; a fake that let both inserts through would make the concurrency test
 *   pass against code that has no claim at all.
 *
 *   IT YIELDS BEFORE IT CHECKS. Every operation awaits a microtask before it
 *   touches the map, so two `claimInboundTurn` calls started together really
 *   do interleave. Without that the runtime serialises them by luck and the
 *   test asserts nothing about concurrency — it would pass against a
 *   read-then-write claim that has no atomicity anywhere in it.
 *
 * The primary key is written out here rather than imported from the module
 * under test, for the reason `pending-rows-fake.ts` gives: a fake that reused
 * the code under test would agree with it by construction.
 */

import type {
  DeleteClaimResult,
  InsertClaimResult,
  ReadClaimResult,
  TakeOverClaimResult,
  TurnClaimRow,
  TurnClaimStore,
} from '../coalesce-turn'

/** Migration 057's primary key, written out rather than derived. */
function primaryKeyOf(row: { venueId: string; guestId: string }): string {
  return `${row.venueId}::${row.guestId}`
}

export interface TurnClaimsFake extends TurnClaimStore {
  /** Every claim currently held, for assertions. */
  rows(): TurnClaimRow[]
  /** Seed a claim directly, bypassing the insert path. */
  seed(row: TurnClaimRow): void
  /** Make the next N operations of `kind` fail, for the fail-open tests. */
  failNext(kind: 'insert' | 'read' | 'takeOver' | 'delete', times?: number): void
  /** How many times each operation ran. */
  calls: { insert: number; read: number; takeOver: number; delete: number }
}

export function createTurnClaimsFake(): TurnClaimsFake {
  const table = new Map<string, TurnClaimRow>()
  const failures: Record<string, number> = { insert: 0, read: 0, takeOver: 0, delete: 0 }
  const calls = { insert: 0, read: 0, takeOver: 0, delete: 0 }

  // The yield. Awaiting a resolved promise hands control back to the
  // microtask queue, so a second caller's body runs before this one's check.
  const yieldToPeers = () => Promise.resolve()

  const shouldFail = (kind: string): boolean => {
    if (failures[kind] > 0) {
      failures[kind] -= 1
      return true
    }
    return false
  }

  return {
    calls,
    rows: () => [...table.values()],
    seed: (row) => {
      table.set(primaryKeyOf(row), row)
    },
    failNext: (kind, times = 1) => {
      failures[kind] += times
    },

    async insertClaim(row): Promise<InsertClaimResult> {
      calls.insert += 1
      await yieldToPeers()
      if (shouldFail('insert')) return { ok: false, error: 'insertClaim: fake failure' }
      const key = primaryKeyOf(row)
      // The primary key. A conflicting insert writes NOTHING and reports the
      // violation, exactly as Postgres does.
      if (table.has(key)) return { ok: true, conflict: true }
      table.set(key, { ...row })
      return { ok: true, conflict: false }
    },

    async readClaim(venueId, guestId): Promise<ReadClaimResult> {
      calls.read += 1
      await yieldToPeers()
      if (shouldFail('read')) return { ok: false, error: 'readClaim: fake failure' }
      const held = table.get(primaryKeyOf({ venueId, guestId }))
      return { ok: true, claim: held ? { ...held } : null }
    },

    async takeOverClaim({ row, expectedAgentRunId }): Promise<TakeOverClaimResult> {
      calls.takeOver += 1
      await yieldToPeers()
      if (shouldFail('takeOver')) return { ok: false, error: 'takeOverClaim: fake failure' }
      const key = primaryKeyOf(row)
      const held = table.get(key)
      // The CAS. A holder that changed since the caller read it means another
      // run took over first, and this one must not.
      if (!held || held.agentRunId !== expectedAgentRunId) return { ok: true, tookOver: false }
      table.set(key, { ...row })
      return { ok: true, tookOver: true }
    },

    async deleteClaim({ venueId, guestId, agentRunId }): Promise<DeleteClaimResult> {
      calls.delete += 1
      await yieldToPeers()
      if (shouldFail('delete')) return { ok: false, error: 'deleteClaim: fake failure' }
      const key = primaryKeyOf({ venueId, guestId })
      const held = table.get(key)
      // Scoped to the holder, as the real DELETE is.
      if (!held || held.agentRunId !== agentRunId) return { ok: true, deleted: false }
      table.delete(key)
      return { ok: true, deleted: true }
    },
  }
}
