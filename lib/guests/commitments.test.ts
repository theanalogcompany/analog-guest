/* eslint-disable @typescript-eslint/no-unused-vars */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/db/admin', () => ({
  createAdminClient: vi.fn(),
}))

vi.mock('@/lib/analytics/posthog', () => ({
  captureCommitmentDeduped: vi.fn(),
  captureCommitmentDedupCheckFailed: vi.fn(),
  captureCommitmentEscalated: vi.fn(),
}))

import { captureCommitmentEscalated } from '@/lib/analytics/posthog'
import { createAdminClient } from '@/lib/db/admin'
import type { PendingCommitment } from '@/lib/schemas/guest-commitment'
import { grantedVenues } from '@/lib/auth/venue-scope'
import {
  cancelCommitmentForGuest,
  commitmentDedupKey,
  createCommitmentFromPending,
  findActiveCommitmentsForGuest,
  findEarliestAcknowledgedArrival,
  findOpenObligations,
  findScheduledOpenCommitments,
  markAcknowledged,
  markCancelled,
  markEscalated,
  markExpired,
  scheduleArrival,
  transitionToPendingAck,
} from './commitments'

const COMMITMENT_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const GUEST_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const VENUE_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const MESSAGE_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
const OPERATOR_ID = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
const NOW = new Date('2026-05-28T15:30:00Z')

function makeRow(overrides: Record<string, unknown> = {}) {
  return {
    id: COMMITMENT_ID,
    guest_id: GUEST_ID,
    venue_id: VENUE_ID,
    type: 'comp',
    description: 'oat latte',
    code: '7K2P',
    status: 'open',
    expected_arrival: null,
    arrival_signal: null,
    created_by: 'agent',
    expires_at: null,
    acknowledged_at: null,
    acknowledged_by: null,
    escalated_at: null,
    redeemed_at: null,
    source_message_id: MESSAGE_ID,
    created_at: '2026-05-28T12:00:00Z',
    updated_at: '2026-05-28T12:00:00Z',
    ...overrides,
  }
}

interface MockState {
  insertedPayload: Record<string, unknown> | null
  insertedReturn: Record<string, unknown> | null
  insertError: { message: string; code?: string } | null
  insertCallCount: number
  updatePayload: Record<string, unknown> | null
  updateEqCalls: Array<{ field: string; value: unknown }>
  updateInCalls: Array<{ field: string; values: unknown[] }>
  updateReturn: Record<string, unknown>[] | null
  updateError: { message: string } | null
  selectReturn: Record<string, unknown>[] | null
  // TAC-318: when set, each select() consumes the next entry instead of
  // selectReturn — lets one call sequence the dedup read and the post-23505
  // recovery read independently.
  selectReturnQueue: Record<string, unknown>[][] | null
  selectCallCount: number
  selectError: { message: string } | null
  selectEqCalls: Array<{ field: string; value: unknown }>
  selectInCalls: Array<{ field: string; values: unknown[] }>
  // TAC-341: the scan's filters are not observable through returned rows —
  // the mock ignores them — so they are captured and asserted directly. Same
  // technique handle-operator-decline.test.ts uses for its import-set check.
  selectNotCalls: Array<{ field: string; op: string; value: unknown }>
  selectOrderCalls: Array<{ field: string; opts: unknown }>
  selectLimitCalls: number[]
  selectTables: string[]
  updateIsCalls: Array<{ field: string; value: unknown }>
  /** venues.timezone lookup for the hold horizon. */
  venueRow: Record<string, unknown> | null
  /** venue_configs.venue_info lookup for the hold horizon. */
  configRow: Record<string, unknown> | null
  maybeSingleCallCount: number
}

function newState(overrides: Partial<MockState> = {}): MockState {
  return {
    insertedPayload: null,
    insertedReturn: makeRow(),
    insertError: null,
    insertCallCount: 0,
    updatePayload: null,
    updateEqCalls: [],
    updateInCalls: [],
    updateReturn: [makeRow()],
    updateError: null,
    selectReturn: [],
    selectReturnQueue: null,
    selectCallCount: 0,
    selectError: null,
    selectEqCalls: [],
    selectInCalls: [],
    selectNotCalls: [],
    selectOrderCalls: [],
    selectLimitCalls: [],
    selectTables: [],
    updateIsCalls: [],
    venueRow: { timezone: 'America/Los_Angeles' },
    configRow: { venue_info: { hours: { friday: '7:00 AM – 3:00 PM' } } },
    maybeSingleCallCount: 0,
    ...overrides,
  }
}

function makeSupabaseMock(state: MockState) {
  return {
    from: (table: string) => ({
      insert: (payload: Record<string, unknown>) => {
        state.insertedPayload = payload
        state.insertCallCount += 1
        return {
          select: () => ({
            single: async () => ({
              data: state.insertedReturn,
              error: state.insertError,
            }),
          }),
        }
      },
      update: (payload: Record<string, unknown>) => {
        state.updatePayload = payload
        const chain = {
          eq: (field: string, value: unknown) => {
            state.updateEqCalls.push({ field, value })
            return chain
          },
          in: (field: string, values: unknown[]) => {
            state.updateInCalls.push({ field, values })
            return chain
          },
          is: (field: string, value: unknown) => {
            state.updateIsCalls.push({ field, value })
            return chain
          },
          select: async () => ({
            data: state.updateReturn,
            error: state.updateError,
          }),
        }
        return chain
      },
      select: (_cols: string) => {
        const callIndex = state.selectCallCount
        state.selectCallCount += 1
        state.selectTables.push(table)
        const chain = {
          eq: (field: string, value: unknown) => {
            state.selectEqCalls.push({ field, value })
            return chain
          },
          in: (field: string, values: unknown[]) => {
            state.selectInCalls.push({ field, values })
            return chain
          },
          not: (field: string, op: string, value: unknown) => {
            state.selectNotCalls.push({ field, op, value })
            return chain
          },
          lte: (_field: string, _value: unknown) => chain,
          maybeSingle: async () => {
            state.maybeSingleCallCount += 1
            return {
              data: table === 'venues' ? state.venueRow : state.configRow,
              error: null,
            }
          },
          // Awaitable AND chainable: most callers await order() directly,
          // findEarliestAcknowledgedArrival chains .limit(1) onto it.
          order: (field: string, opts: unknown) => {
            state.selectOrderCalls.push({ field, opts })
            const result = {
              data: state.selectReturnQueue
                ? (state.selectReturnQueue[callIndex] ?? [])
                : state.selectReturn,
              error: state.selectError,
            }
            return {
              limit: (n: number) => {
                state.selectLimitCalls.push(n)
                return Promise.resolve(result)
              },
              then: (
                resolve: (v: typeof result) => unknown,
                reject?: (e: unknown) => unknown,
              ) => Promise.resolve(result).then(resolve, reject),
            }
          },
        }
        return chain
      },
    }),
  }
}

beforeEach(() => {
  vi.mocked(createAdminClient).mockReset()
  // Reset the analytics mock too. vi.restoreAllMocks() in afterEach does not
  // clear call history on a vi.fn() from a module factory, so without this
  // calls accumulate across tests and any `not.toHaveBeenCalled()` assertion
  // in this file fails for a reason that has nothing to do with its subject.
  vi.mocked(captureCommitmentEscalated).mockReset()
})

afterEach(() => {
  vi.restoreAllMocks()
})

const PENDING: PendingCommitment = {
  type: 'comp',
  description: 'oat latte',
  code: '7K2P',
  expiresAt: null,
}

describe('createCommitmentFromPending', () => {
  it('inserts an open row with agent created_by + source message link', async () => {
    const state = newState()
    vi.mocked(createAdminClient).mockReturnValue(
      makeSupabaseMock(state) as unknown as ReturnType<typeof createAdminClient>,
    )
    const r = await createCommitmentFromPending({
      guestId: GUEST_ID,
      venueId: VENUE_ID,
      pendingCommitment: PENDING,
      sourceMessageId: MESSAGE_ID,
      now: NOW,
    })
    expect(r.ok).toBe(true)
    expect(state.insertedPayload).toMatchObject({
      guest_id: GUEST_ID,
      venue_id: VENUE_ID,
      type: 'comp',
      description: 'oat latte',
      code: '7K2P',
      status: 'open',
      created_by: 'agent',
      source_message_id: MESSAGE_ID,
    })
  })

  it('returns db_write_failed on insert error', async () => {
    const state = newState({ insertError: { message: 'fk violation' } })
    vi.mocked(createAdminClient).mockReturnValue(
      makeSupabaseMock(state) as unknown as ReturnType<typeof createAdminClient>,
    )
    const r = await createCommitmentFromPending({
      guestId: GUEST_ID,
      venueId: VENUE_ID,
      pendingCommitment: PENDING,
      sourceMessageId: MESSAGE_ID,
      now: NOW,
    })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.errorCode).toBe('db_write_failed')
      expect(r.error).toContain('fk violation')
    }
  })

  it('returns db_write_threw when admin client throws', async () => {
    vi.mocked(createAdminClient).mockImplementation(() => {
      throw new Error('env missing')
    })
    const r = await createCommitmentFromPending({
      guestId: GUEST_ID,
      venueId: VENUE_ID,
      pendingCommitment: PENDING,
      sourceMessageId: MESSAGE_ID,
      now: NOW,
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.errorCode).toBe('db_write_threw')
  })
})

describe('createCommitmentFromPending — TAC-318 dedup', () => {
  // These tests exist because the unique index alone makes the TABLE look
  // correct even if the app-level check never runs. Asserting a row count, or
  // asserting `ok: true`, would pass with the whole check deleted. So the
  // load-bearing assertion throughout is `state.insertCallCount === 0` — the
  // INSERT was never ATTEMPTED, which only the app path can achieve.
  //
  // Mutation-verified: deleting the early return in
  // createCommitmentFromPending (so it falls through to the insert) fails
  // every test in this block that asserts insertCallCount === 0.

  function mockWith(state: MockState) {
    vi.mocked(createAdminClient).mockReturnValue(
      makeSupabaseMock(state) as unknown as ReturnType<typeof createAdminClient>,
    )
  }

  function mint(pending: PendingCommitment = PENDING) {
    return createCommitmentFromPending({
      guestId: GUEST_ID,
      venueId: VENUE_ID,
      pendingCommitment: pending,
      sourceMessageId: MESSAGE_ID,
      now: NOW,
    })
  }

  const OPEN_REC = makeRow({
    id: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
    type: 'recommendation',
    description: 'Blossom Tonic',
    code: null,
    status: 'open',
  })

  const REC: PendingCommitment = {
    type: 'recommendation',
    description: 'Blossom Tonic',
    code: null,
    expiresAt: null,
  }

  it('does NOT attempt the insert when an open row already matches', async () => {
    const state = newState({ selectReturn: [OPEN_REC], updateReturn: [OPEN_REC] })
    mockWith(state)

    const r = await mint(REC)

    // The assertion that matters. The index would also produce one row; only
    // the app check produces ZERO insert attempts.
    expect(state.insertCallCount).toBe(0)
    expect(state.insertedPayload).toBeNull()
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.data.id).toBe(OPEN_REC.id)
  })

  it('scopes the dedup read to this venue, this guest, and status=open', async () => {
    const state = newState({ selectReturn: [OPEN_REC] })
    mockWith(state)

    await mint(REC)

    // Mirrors the index predicate. A read missing the venue filter would
    // collapse commitments across venues, breaking the isolation invariant.
    expect(state.selectEqCalls).toEqual([
      { field: 'venue_id', value: VENUE_ID },
      { field: 'guest_id', value: GUEST_ID },
      { field: 'status', value: 'open' },
    ])
  })

  it('matches case- and whitespace-insensitively, mirroring lower(trim(...))', async () => {
    const state = newState({ selectReturn: [makeRow({ description: 'blossom tonic' })] })
    mockWith(state)

    const r = await mint({ ...REC, description: '  BLOSSOM TONIC  ' })

    expect(state.insertCallCount).toBe(0)
    expect(r.ok).toBe(true)
  })

  it('bumps updated_at on the existing row but never created_at', async () => {
    const bumped = makeRow({ ...OPEN_REC, updated_at: NOW.toISOString() })
    const state = newState({ selectReturn: [OPEN_REC], updateReturn: [bumped] })
    mockWith(state)

    const r = await mint(REC)

    // created_at renders as "promised N ago" and TAC-341 keys the expiry
    // horizon off it. Bumping it would make a stale commitment immortal.
    expect(state.updatePayload).toEqual({ updated_at: NOW.toISOString() })
    expect(state.updatePayload).not.toHaveProperty('created_at')
    expect(state.updateEqCalls).toEqual([
      { field: 'id', value: OPEN_REC.id },
      { field: 'status', value: 'open' },
    ])
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.data.updated_at).toBe(NOW.toISOString())
  })

  it('still dedups when the updated_at touch fails', async () => {
    const state = newState({
      selectReturn: [OPEN_REC],
      updateError: { message: 'transient' },
    })
    mockWith(state)

    const r = await mint(REC)

    // The dedup decision stands; the timestamp is an audit nicety. A failed
    // touch must never convert a correct dedup into a caller-visible error.
    expect(state.insertCallCount).toBe(0)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.data.id).toBe(OPEN_REC.id)
  })

  it('inserts when the open rows are for a different description', async () => {
    const state = newState({ selectReturn: [makeRow({ description: 'SoFi' })] })
    mockWith(state)

    const r = await mint(REC)

    // The negative half: dedup must not swallow a genuinely new promise.
    expect(state.insertCallCount).toBe(1)
    expect(state.insertedPayload).toMatchObject({ description: 'Blossom Tonic' })
    expect(r.ok).toBe(true)
  })

  it('inserts when no open rows exist at all', async () => {
    const state = newState({ selectReturn: [] })
    mockWith(state)

    await mint(REC)

    expect(state.insertCallCount).toBe(1)
  })

  it('fails OPEN and inserts when an open row is unparseable', async () => {
    const state = newState({
      // `status: 'bogus'` is off GuestCommitmentStatusSchema's closed enum.
      // The realistic route here is a future migration widening one of the
      // enums without updating the Zod schema.
      selectReturn: [makeRow({ status: 'bogus', description: 'Blossom Tonic' })],
    })
    mockWith(state)

    const r = await mint(REC)

    // Fail-OPEN, matching findActiveCommitmentsForGuest: one unreadable row
    // must not fail the whole write. The duplicate this may admit is what the
    // unique index is for; a dropped commitment has no backstop at all.
    expect(state.insertCallCount).toBe(1)
    expect(r.ok).toBe(true)
  })

  it('keeps scanning PAST an unparseable row to find a real match', async () => {
    const state = newState({
      selectReturn: [
        makeRow({ status: 'bogus', description: 'something else' }),
        OPEN_REC,
      ],
      updateReturn: [OPEN_REC],
    })
    mockWith(state)

    const r = await mint(REC)

    // This is the assertion that actually pins `continue` rather than
    // `return`. The test above cannot: aborting the read on a bad row is
    // BEHAVIOURALLY IDENTICAL there, because the caller fails open and
    // inserts either way. The difference only shows when a genuine match sits
    // behind the unreadable row — abort loses it and mints a duplicate.
    expect(state.insertCallCount).toBe(0)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.data.id).toBe(OPEN_REC.id)
  })

  it('fails OPEN and inserts when the dedup read errors', async () => {
    const state = newState({ selectError: { message: 'connection reset' } })
    mockWith(state)

    const r = await mint(REC)

    // A hiccuped SELECT must never cost a real commitment. The index is the
    // backstop for the duplicate this might let through.
    expect(state.insertCallCount).toBe(1)
    expect(r.ok).toBe(true)
  })

  it('resolves a 23505 to the existing row rather than erroring', async () => {
    const state = newState({
      // dedup read finds nothing (lost the race), recovery read finds the winner
      selectReturnQueue: [[], [OPEN_REC]],
      updateReturn: [OPEN_REC],
      insertError: { message: 'duplicate key value', code: '23505' },
    })
    mockWith(state)

    const r = await mint(REC)

    expect(state.insertCallCount).toBe(1)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.data.id).toBe(OPEN_REC.id)
  })

  it('reports a 23505 it cannot resolve rather than claiming success', async () => {
    const state = newState({
      selectReturnQueue: [[], []],
      insertError: { message: 'duplicate key value', code: '23505' },
    })
    mockWith(state)

    const r = await mint(REC)

    // The conflicting row left 'open' between the violation and the read.
    // Returning ok here would report a commitment that does not exist.
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.errorCode).toBe('db_write_failed')
      expect(r.error).toContain('guest_commitments_open_dedup')
    }
  })

  it('dedups a comp without touching its code or lifecycle', async () => {
    const openComp = makeRow({ type: 'comp', description: 'oat latte', code: '7K2P' })
    const state = newState({
      selectReturn: [openComp],
      updateReturn: [openComp],
      // A DIFFERENT code on the insert-return, so the code assertion below can
      // actually fail. With the shared default (also 7K2P) it held on both
      // branches and proved nothing.
      insertedReturn: makeRow({ code: 'ZZZZ' }),
    })
    mockWith(state)

    // Second promise of the same comp arrives carrying a freshly generated code.
    const r = await mint({ ...PENDING, code: 'ZZZZ' })

    // The guest keeps the ONE code they were already texted. A second row
    // would hand them a second code against a single promise.
    expect(state.insertCallCount).toBe(0)
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.data.code).toBe('7K2P')
      expect(r.data.status).toBe('open')
    }
  })

  it('does not dedup against a pending_ack row with a matching description', async () => {
    // The index is `WHERE status = 'open'`, deliberately narrower than the
    // ## Active commitments block's open+pending_ack filter. Once the guest
    // has signalled arrival the row is mid-flight against a specific visit,
    // so a later promise is genuinely new and gets its own row.
    //
    // The row is put IN the read on purpose. The mock ignores .eq() filters,
    // so this reaches the JS matcher — which is the point: it proves the
    // exclusion survives even if the server-side filter is ever lost (the
    // inviting refactor is reusing findActiveCommitmentsForGuest, which
    // selects open + pending_ack). An earlier version of this test passed an
    // EMPTY read and asserted only that `.eq('status','open')` was called,
    // which proved the filter existed but nothing about the matcher.
    const state = newState({
      selectReturn: [makeRow({ status: 'pending_ack', description: 'Blossom Tonic' })],
    })
    mockWith(state)

    await mint(REC)

    expect(state.insertCallCount).toBe(1)
  })

  it('filters the dedup read to open rows server-side as well', async () => {
    const state = newState({ selectReturn: [] })
    mockWith(state)

    await mint(REC)

    // The other half of the pair above: the JS guard is belt, this is braces.
    expect(state.selectEqCalls).toContainEqual({ field: 'status', value: 'open' })
  })
})

describe('createCommitmentFromPending — TAC-318 cross-type resolution', () => {
  // The dedup key excludes `type`, so these cases decide what happens when a
  // repeat promise is a DIFFERENT kind of promise. Found in code review: the
  // first implementation reused the existing row unconditionally, which
  // silently discarded an operator-approved comp.

  function mockWith(state: MockState) {
    vi.mocked(createAdminClient).mockReturnValue(
      makeSupabaseMock(state) as unknown as ReturnType<typeof createAdminClient>,
    )
  }

  const OPEN_REC = makeRow({
    type: 'recommendation',
    description: 'croissant',
    code: null,
    status: 'open',
  })

  const COMP_ON_SAME_ITEM: PendingCommitment = {
    type: 'comp',
    description: 'croissant',
    code: 'Q4X9',
    expiresAt: null,
  }

  it('upgrades an open recommendation in place when a comp lands on it', async () => {
    const state = newState({ selectReturn: [OPEN_REC] })
    mockWith(state)

    const r = await createCommitmentFromPending({
      guestId: GUEST_ID,
      venueId: VENUE_ID,
      pendingCommitment: COMP_ON_SAME_ITEM,
      sourceMessageId: MESSAGE_ID,
      now: NOW,
    })

    // Recommend the croissant, guest says it was stale, operator approves a
    // comp on a croissant. Reusing the rec row would leave the guest with no
    // verification code and the arrival push announcing "recommendation".
    // The index forbids a second open row, so the upgrade has to happen here.
    expect(state.insertCallCount).toBe(0)

    // toEqual, NOT toMatchObject. This is the assertion that pins the FULL
    // field set: a partial match passes while `code` silently goes missing,
    // which is the exact shape of the defect being fixed — a comp on the
    // ledger with no verification code. Both arrival-push call sites
    // (handle-inbound.ts:754, commitments-due.ts:234) read `type` and `code`
    // OFF THE ROW, so these four columns are what decides whether the push
    // says "comp ... Q4X9" or "recommendation" with nothing.
    //
    // TAC-341 ADDS expires_at to this set. TAC-318 deliberately omitted it and
    // pinned the omission; this ticket is the one that owns the derivation, so
    // the omission is now the bug. Still toEqual, never toMatchObject — the
    // reason that mattered for `code` is exactly as true for the horizon.
    expect(state.updatePayload).toEqual({
      type: 'comp',
      code: 'Q4X9',
      source_message_id: MESSAGE_ID,
      // Sixty days from the row's OWN created_at (2026-05-28), not from NOW.
      expires_at: '2026-07-27T12:00:00.000Z',
      updated_at: NOW.toISOString(),
    })
    expect(r.ok).toBe(true)
  })

  it('leaves every field an upgrade must NOT move', async () => {
    const state = newState({ selectReturn: [OPEN_REC] })
    mockWith(state)

    await createCommitmentFromPending({
      guestId: GUEST_ID,
      venueId: VENUE_ID,
      pendingCommitment: COMP_ON_SAME_ITEM,
      sourceMessageId: MESSAGE_ID,
      now: NOW,
    })

    const payload = state.updatePayload ?? {}
    // The negative half of the toEqual above, named field by field so a
    // future reader sees the reasoning rather than just an exact-match blob.
    //
    //   created_at   — renders as "promised N ago"; TAC-341 keys the expiry
    //                  horizon off it. Bumping makes a stale row immortal.
    //   status       — a comp also starts 'open', and the CAS filter below
    //                  requires it; writing it would be a no-op at best.
    //   created_by   — hardcoded 'agent' at the only insert site (and the
    //                  column defaults to 'agent'), so it is invariant on
    //                  this path. Nothing to carry.
    //   description  — equal to the incoming one under commitmentDedupKey by
    //                  construction; only case/whitespace can differ.
    //   expected_arrival / arrival_signal — belong to this row's own arrival
    //                  lifecycle. If the guest already signalled against the
    //                  recommendation, that signal is still about the same
    //                  visit and survives the type change.
    //
    // expires_at was on this list under TAC-318 and is NOT any more: TAC-341
    // owns the derivation and an upgraded row now receives the comp horizon.
    // See the dedicated test below.
    for (const field of [
      'created_at',
      'status',
      'created_by',
      'description',
      'expected_arrival',
      'arrival_signal',
      'guest_id',
      'venue_id',
      'id',
    ]) {
      expect(payload).not.toHaveProperty(field)
    }
  })

  it('derives the upgrade horizon from created_at, ignoring the emission', async () => {
    const state = newState({ selectReturn: [OPEN_REC] })
    mockWith(state)

    await createCommitmentFromPending({
      guestId: GUEST_ID,
      venueId: VENUE_ID,
      // A non-null emission value, so the assertion proves the derivation
      // WINS rather than merely that null-in gave null-out.
      pendingCommitment: { ...COMP_ON_SAME_ITEM, expiresAt: '2027-01-01T00:00:00Z' },
      sourceMessageId: MESSAGE_ID,
      now: NOW,
    })

    // REVERSES the TAC-318 test of the same name, deliberately. That ticket
    // pinned the omission precisely so this one could fill it, and its own
    // comment named the two wrong behaviours: writing the emission's value
    // (a null horizon that never elapses) and keeping the recommendation's
    // horizon (an upgraded comp dying after a month).
    //
    // Three distinct dates are in play and only one is correct:
    //   2027-01-01  the emission's own value          — ignored, server-derived
    //   2026-07-27  created_at + 60d                  — CORRECT
    //   2026-07-27T15:30 would be NOW + 60d           — wrong, see below
    expect(state.updatePayload).toHaveProperty('expires_at', '2026-07-27T12:00:00.000Z')
    expect(state.updatePayload).not.toHaveProperty(
      'expires_at',
      '2027-01-01T00:00:00.000Z',
    )
  })

  // Separated from the test above because the two dates differ by hours, not
  // years, and a fixture where created_at and NOW coincided would let a
  // now-keyed implementation pass. The promise is as old as it always was;
  // keying off NOW would extend the horizon every time the guest mentioned it.
  it('keys the upgrade horizon off the row age, not the moment of the repeat', async () => {
    const state = newState({ selectReturn: [OPEN_REC] })
    mockWith(state)

    await createCommitmentFromPending({
      guestId: GUEST_ID,
      venueId: VENUE_ID,
      pendingCommitment: COMP_ON_SAME_ITEM,
      sourceMessageId: MESSAGE_ID,
      now: NOW,
    })

    const nowPlusHorizon = new Date(NOW)
    nowPlusHorizon.setUTCDate(nowPlusHorizon.getUTCDate() + 60)
    expect(state.updatePayload?.expires_at).not.toBe(nowPlusHorizon.toISOString())
    expect(state.updatePayload?.expires_at).toBe('2026-07-27T12:00:00.000Z')
  })

  it('has no gating field to carry — gating happens before the row exists', () => {
    // Recorded as a test so the question does not get re-asked. There is no
    // gating column on guest_commitments (migration 026): the gate is
    // isCommitmentTypeGated(generation) in stages.ts, which reads the
    // EMISSION and runs pre-dispatch. By the time an upgrade runs the
    // operator has already approved, so there is nothing gating-shaped left
    // to move onto the row.
    const columns = Object.keys(makeRow())
    expect(columns).not.toContain('requires_operator_approval')
    expect(columns).not.toContain('gated')
    expect(columns).toContain('code')
    expect(columns).toContain('type')
  })

  it('never downgrades a comp to a recommendation', async () => {
    const openComp = makeRow({ type: 'comp', description: 'croissant', code: '7K2P' })
    const state = newState({ selectReturn: [openComp], updateReturn: [openComp] })
    mockWith(state)

    const r = await createCommitmentFromPending({
      guestId: GUEST_ID,
      venueId: VENUE_ID,
      pendingCommitment: {
        type: 'recommendation',
        description: 'croissant',
        code: null,
        expiresAt: null,
      },
      sourceMessageId: MESSAGE_ID,
      now: NOW,
    })

    // Would destroy a code the guest has already been texted.
    expect(state.insertCallCount).toBe(0)
    expect(state.updatePayload).toEqual({ updated_at: NOW.toISOString() })
    expect(state.updatePayload).not.toHaveProperty('type')
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.data.code).toBe('7K2P')
  })

  it('keeps the app check exactly as wide as its index (no type narrowing)', async () => {
    // Mutation-motivated. A reviewer showed that adding
    // `&& parsed.data.type === pendingCommitment.type` to the matcher was
    // caught only by another test's fixture default — tidying that fixture
    // would have removed the coverage silently. This test names the property.
    //
    // Narrowing the app check below the index is the specific drift to
    // prevent: the index has no type, so a narrowed check would pass the
    // insert straight to a 23505 and the primary path would stop running for
    // every cross-type case.
    const state = newState({ selectReturn: [OPEN_REC] })
    mockWith(state)

    await createCommitmentFromPending({
      guestId: GUEST_ID,
      venueId: VENUE_ID,
      pendingCommitment: COMP_ON_SAME_ITEM,
      sourceMessageId: MESSAGE_ID,
      now: NOW,
    })

    expect(state.insertCallCount).toBe(0)
  })

  it('upgrades on the 23505 path too, not just the app-check path', async () => {
    const state = newState({
      selectReturnQueue: [[], [OPEN_REC]],
      insertError: { message: 'duplicate key value', code: '23505' },
    })
    mockWith(state)

    const r = await createCommitmentFromPending({
      guestId: GUEST_ID,
      venueId: VENUE_ID,
      pendingCommitment: COMP_ON_SAME_ITEM,
      sourceMessageId: MESSAGE_ID,
      now: NOW,
    })

    // The race path is the WORSE place to forget the upgrade, since it is
    // reached exactly when the app check already missed. Both paths share
    // resolveToExisting so they cannot drift.
    expect(state.updatePayload).toMatchObject({ type: 'comp', code: 'Q4X9' })
    expect(r.ok).toBe(true)
  })
})

describe('guest_commitments_open_dedup — SQL/JS mirror', () => {
  // `commitmentDedupKey` and migration 037's index expression are a dual
  // source of truth, the same shape as UNIVERSAL_RULES_DISPLAY vs
  // SYSTEM_TEMPLATE. This is the lockstep guard.
  //
  // BE CLEAR ABOUT WHAT THIS CATCHES, because a guard that is trusted for
  // more than it does is worse than none (CLAUDE.md records three of those).
  //   CATCHES: someone editing migration 037 in place so the index no longer
  //            says what commitmentDedupKey's docstring claims it says.
  //   DOES NOT CATCH: a LATER migration replacing this index — migrations are
  //            append-only, and this test reads 037 by name. A future
  //            038 that redefines the key must update this test itself.
  //   DOES NOT CATCH: a change to the JS side. That is pinned behaviourally
  //            by the commitmentDedupKey block below, which is why both
  //            exist.
  const sql = readFileSync(
    join(process.cwd(), 'db/migrations/037_guest_commitments_open_dedup.sql'),
    'utf8',
  )

  it('indexes lower(trim(both from description)), which is what the JS mirrors', () => {
    expect(sql).toContain('lower(trim(both from description))')
  })

  it('is scoped to venue_id, guest_id and status=open', () => {
    expect(sql).toContain('(venue_id, guest_id, lower(trim(both from description)))')
    expect(sql).toContain("where (status = 'open')")
  })

  it('is UNIQUE and carries the name the writer reports in its error text', () => {
    // createCommitmentFromPending names this index in the unresolvable-23505
    // error, and an operator greps for it.
    expect(sql).toContain('create unique index guest_commitments_open_dedup')
  })

  it('does not include type in the key', () => {
    // The exclusion is load-bearing and is what shouldUpgrade exists to
    // handle. If a future migration adds type, that decision has to be made
    // deliberately, with this test and shouldUpgrade revisited together.
    const keyLine = sql.split('\n').find((l) => l.includes('using btree'))
    expect(keyLine).toBeDefined()
    expect(keyLine).not.toContain('type')
  })
})

describe('commitmentDedupKey', () => {
  it('mirrors lower(trim(...)) from the migration 037 index', () => {
    expect(commitmentDedupKey('  Blossom Tonic  ')).toBe('blossom tonic')
    expect(commitmentDedupKey('BLOSSOM TONIC')).toBe(commitmentDedupKey('blossom tonic'))
  })

  it('strips whitespace Postgres trim(both from) would leave behind', () => {
    // The safety argument for the two-layer design rests on this direction:
    // PG trim() strips SPACES only, JS .trim() strips all whitespace, so this
    // side collapses a strict superset. The space-padded case above is the
    // one place the two layers agree and so cannot demonstrate it.
    expect(commitmentDedupKey('oat latte\n')).toBe('oat latte')
    expect(commitmentDedupKey('\toat latte ')).toBe('oat latte')
  })

  it('does not collapse genuinely different descriptions', () => {
    // The documented near-match limit: exact-match dedup leaves these as two
    // rows. Containment-based collapsing is proposed on TAC-318 but not built
    // here, and this test pins the current behaviour so a future change to it
    // is deliberate.
    expect(commitmentDedupKey('cortado or Frosty Gandhi')).not.toBe(
      commitmentDedupKey('cortado'),
    )
  })
})

describe('transitionToPendingAck', () => {
  it('returns transitioned=true with the row when CAS wins (rowcount=1)', async () => {
    const state = newState({
      updateReturn: [makeRow({ status: 'pending_ack', arrival_signal: 'imminent' })],
    })
    vi.mocked(createAdminClient).mockReturnValue(
      makeSupabaseMock(state) as unknown as ReturnType<typeof createAdminClient>,
    )
    const r = await transitionToPendingAck({
      commitmentId: COMMITMENT_ID,
      venueId: VENUE_ID,
      guestId: GUEST_ID,
      expectedArrival: NOW,
      arrivalSignal: 'imminent',
      now: NOW,
    })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.data.transitioned).toBe(true)
      expect(r.data.row?.status).toBe('pending_ack')
      expect(r.data.row?.arrival_signal).toBe('imminent')
    }
    expect(state.updateEqCalls).toContainEqual({ field: 'id', value: COMMITMENT_ID })
    expect(state.updateEqCalls).toContainEqual({ field: 'status', value: 'open' })
  })

  it('returns transitioned=false when CAS loses (rowcount=0) — empty data', async () => {
    const state = newState({ updateReturn: [] })
    vi.mocked(createAdminClient).mockReturnValue(
      makeSupabaseMock(state) as unknown as ReturnType<typeof createAdminClient>,
    )
    const r = await transitionToPendingAck({
      commitmentId: COMMITMENT_ID,
      venueId: VENUE_ID,
      guestId: GUEST_ID,
      expectedArrival: NOW,
      arrivalSignal: 'imminent',
      now: NOW,
    })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.data.transitioned).toBe(false)
      expect(r.data.row).toBeNull()
    }
  })

  it('returns db_write_failed on update error', async () => {
    const state = newState({
      updateError: { message: 'connection lost' },
      updateReturn: null,
    })
    vi.mocked(createAdminClient).mockReturnValue(
      makeSupabaseMock(state) as unknown as ReturnType<typeof createAdminClient>,
    )
    const r = await transitionToPendingAck({
      commitmentId: COMMITMENT_ID,
      venueId: VENUE_ID,
      guestId: GUEST_ID,
      expectedArrival: NOW,
      arrivalSignal: 'imminent',
      now: NOW,
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.errorCode).toBe('db_write_failed')
  })
})

// TAC-363: the CAS is venue- and guest-scoped, so a commitment id that belongs
// to someone else cannot be transitioned by passing it in.
//
// These assert by APPLYING the predicate the code built to a small row set,
// not by checking that the query mentions the right column names. The
// difference matters: `.eq('guest_id', guestId)` with the wrong value, or with
// the columns transposed, names every expected column and still reaches the
// wrong row. `rowsMatching` is the honest half of the mock — the supabase
// double records filters without applying them, so nothing else in this file
// can tell a scoped query from an unscoped one.
function rowsMatching(
  eqCalls: Array<{ field: string; value: unknown }>,
  rows: Array<Record<string, unknown>>,
): Array<Record<string, unknown>> {
  return rows.filter((row) => eqCalls.every((c) => row[c.field] === c.value))
}

describe('arrival CAS is venue- and guest-scoped (TAC-363)', () => {
  const OTHER_GUEST_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
  const OTHER_VENUE_ID = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'

  // The row the caller means, plus three it must never reach: the same
  // commitment id under another guest, under another venue, and a row that is
  // no longer open.
  const WORLD = [
    makeRow(),
    makeRow({ guest_id: OTHER_GUEST_ID }),
    makeRow({ venue_id: OTHER_VENUE_ID }),
    makeRow({ status: 'acknowledged' }),
  ]

  it('transitionToPendingAck reaches only the caller\u2019s own open row', async () => {
    const state = newState({ updateReturn: [makeRow({ status: 'pending_ack' })] })
    vi.mocked(createAdminClient).mockReturnValue(
      makeSupabaseMock(state) as unknown as ReturnType<typeof createAdminClient>,
    )
    await transitionToPendingAck({
      commitmentId: COMMITMENT_ID,
      venueId: VENUE_ID,
      guestId: GUEST_ID,
      expectedArrival: NOW,
      arrivalSignal: 'imminent',
      now: NOW,
    })
    const matched = rowsMatching(state.updateEqCalls, WORLD)
    expect(matched).toHaveLength(1)
    expect(matched[0]).toMatchObject({
      id: COMMITMENT_ID,
      venue_id: VENUE_ID,
      guest_id: GUEST_ID,
      status: 'open',
    })
  })

  it('an id belonging to ANOTHER GUEST does not transition', async () => {
    // The shape of the live hole: the model copies a uuid out of the prompt
    // block and it is not this guest's. Before TAC-363 the predicate was id +
    // status, so this row moved and the caller got a clean CAS win back.
    const state = newState({ updateReturn: [] })
    vi.mocked(createAdminClient).mockReturnValue(
      makeSupabaseMock(state) as unknown as ReturnType<typeof createAdminClient>,
    )
    await transitionToPendingAck({
      commitmentId: COMMITMENT_ID,
      venueId: VENUE_ID,
      guestId: GUEST_ID,
      expectedArrival: NOW,
      arrivalSignal: 'imminent',
      now: NOW,
    })
    const otherGuestsRow = makeRow({ guest_id: OTHER_GUEST_ID })
    expect(rowsMatching(state.updateEqCalls, [otherGuestsRow])).toEqual([])
  })

  it('an id belonging to ANOTHER VENUE does not transition', async () => {
    const state = newState({ updateReturn: [] })
    vi.mocked(createAdminClient).mockReturnValue(
      makeSupabaseMock(state) as unknown as ReturnType<typeof createAdminClient>,
    )
    await transitionToPendingAck({
      commitmentId: COMMITMENT_ID,
      venueId: VENUE_ID,
      guestId: GUEST_ID,
      expectedArrival: NOW,
      arrivalSignal: 'imminent',
      now: NOW,
    })
    expect(rowsMatching(state.updateEqCalls, [makeRow({ venue_id: OTHER_VENUE_ID })])).toEqual([])
  })

  it('scheduleArrival is scoped the same way', async () => {
    const state = newState({ updateReturn: [] })
    vi.mocked(createAdminClient).mockReturnValue(
      makeSupabaseMock(state) as unknown as ReturnType<typeof createAdminClient>,
    )
    await scheduleArrival({
      commitmentId: COMMITMENT_ID,
      venueId: VENUE_ID,
      guestId: GUEST_ID,
      expectedArrival: NOW,
      arrivalSignal: 'scheduled',
      now: NOW,
    })
    expect(rowsMatching(state.updateEqCalls, WORLD)).toHaveLength(1)
    expect(rowsMatching(state.updateEqCalls, [makeRow({ guest_id: OTHER_GUEST_ID })])).toEqual([])
  })
})

describe('scheduleArrival', () => {
  it('writes expected_arrival + arrival_signal without flipping status', async () => {
    const future = new Date('2026-05-29T08:00:00Z')
    const state = newState({
      updateReturn: [
        makeRow({
          status: 'open',
          expected_arrival: future.toISOString(),
          arrival_signal: 'scheduled',
        }),
      ],
    })
    vi.mocked(createAdminClient).mockReturnValue(
      makeSupabaseMock(state) as unknown as ReturnType<typeof createAdminClient>,
    )
    const r = await scheduleArrival({
      commitmentId: COMMITMENT_ID,
      venueId: VENUE_ID,
      guestId: GUEST_ID,
      expectedArrival: future,
      arrivalSignal: 'scheduled',
      now: NOW,
    })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.data.transitioned).toBe(true)
      expect(r.data.row?.status).toBe('open')
      expect(r.data.row?.arrival_signal).toBe('scheduled')
    }
    expect(state.updatePayload).not.toHaveProperty('status')
  })

  it('returns transitioned=false when row is not open (CAS gate fires)', async () => {
    const state = newState({ updateReturn: [] })
    vi.mocked(createAdminClient).mockReturnValue(
      makeSupabaseMock(state) as unknown as ReturnType<typeof createAdminClient>,
    )
    const r = await scheduleArrival({
      commitmentId: COMMITMENT_ID,
      venueId: VENUE_ID,
      guestId: GUEST_ID,
      expectedArrival: NOW,
      arrivalSignal: 'scheduled',
      now: NOW,
    })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.data.transitioned).toBe(false)
  })
})

describe('markAcknowledged', () => {
  it('short-circuits when the scope grants no venues (no round trip)', async () => {
    const r = await markAcknowledged({
      commitmentId: COMMITMENT_ID,
      operatorId: OPERATOR_ID,
      venueScope: grantedVenues([]),
      now: NOW,
    })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.data.transitioned).toBe(false)
    expect(vi.mocked(createAdminClient)).not.toHaveBeenCalled()
  })

  it('flips status to acknowledged on CAS win with allowed venue', async () => {
    const state = newState({
      updateReturn: [
        makeRow({
          status: 'acknowledged',
          acknowledged_at: NOW.toISOString(),
          acknowledged_by: OPERATOR_ID,
        }),
      ],
    })
    vi.mocked(createAdminClient).mockReturnValue(
      makeSupabaseMock(state) as unknown as ReturnType<typeof createAdminClient>,
    )
    const r = await markAcknowledged({
      commitmentId: COMMITMENT_ID,
      operatorId: OPERATOR_ID,
      venueScope: grantedVenues([VENUE_ID]),
      now: NOW,
    })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.data.transitioned).toBe(true)
      expect(r.data.row?.status).toBe('acknowledged')
    }
    expect(state.updateEqCalls).toContainEqual({ field: 'status', value: 'pending_ack' })
    expect(state.updateInCalls).toContainEqual({ field: 'venue_id', values: [VENUE_ID] })
  })

  it('returns transitioned=false on CAS loss (out-of-allowlist OR already acknowledged)', async () => {
    const state = newState({ updateReturn: [] })
    vi.mocked(createAdminClient).mockReturnValue(
      makeSupabaseMock(state) as unknown as ReturnType<typeof createAdminClient>,
    )
    const r = await markAcknowledged({
      commitmentId: COMMITMENT_ID,
      operatorId: OPERATOR_ID,
      venueScope: grantedVenues([VENUE_ID]),
      now: NOW,
    })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.data.transitioned).toBe(false)
  })
})

describe('markCancelled (TAC-299)', () => {
  it('short-circuits when the scope grants no venues (no round trip)', async () => {
    const r = await markCancelled({
      commitmentId: COMMITMENT_ID,
      operatorId: OPERATOR_ID,
      venueScope: grantedVenues([]),
      now: NOW,
    })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.data.transitioned).toBe(false)
    expect(vi.mocked(createAdminClient)).not.toHaveBeenCalled()
  })

  it('flips status to cancelled on CAS win with allowed venue', async () => {
    const state = newState({
      updateReturn: [makeRow({ status: 'cancelled' })],
    })
    vi.mocked(createAdminClient).mockReturnValue(
      makeSupabaseMock(state) as unknown as ReturnType<typeof createAdminClient>,
    )
    const r = await markCancelled({
      commitmentId: COMMITMENT_ID,
      operatorId: OPERATOR_ID,
      venueScope: grantedVenues([VENUE_ID]),
      now: NOW,
    })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.data.transitioned).toBe(true)
      expect(r.data.row?.status).toBe('cancelled')
    }
    expect(state.updatePayload).toMatchObject({ status: 'cancelled' })
    // CAS gate: status='pending_ack' (the only valid prior state)
    expect(state.updateEqCalls).toContainEqual({ field: 'status', value: 'pending_ack' })
    expect(state.updateInCalls).toContainEqual({ field: 'venue_id', values: [VENUE_ID] })
  })

  it('does NOT write cancelled_at or cancelled_by columns (no migration)', async () => {
    const state = newState({
      updateReturn: [makeRow({ status: 'cancelled' })],
    })
    vi.mocked(createAdminClient).mockReturnValue(
      makeSupabaseMock(state) as unknown as ReturnType<typeof createAdminClient>,
    )
    await markCancelled({
      commitmentId: COMMITMENT_ID,
      operatorId: OPERATOR_ID,
      venueScope: grantedVenues([VENUE_ID]),
      now: NOW,
    })
    expect(state.updatePayload).not.toHaveProperty('cancelled_at')
    expect(state.updatePayload).not.toHaveProperty('cancelled_by')
  })

  it('returns transitioned=false on CAS loss (already acknowledged OR out-of-allowlist)', async () => {
    const state = newState({ updateReturn: [] })
    vi.mocked(createAdminClient).mockReturnValue(
      makeSupabaseMock(state) as unknown as ReturnType<typeof createAdminClient>,
    )
    const r = await markCancelled({
      commitmentId: COMMITMENT_ID,
      operatorId: OPERATOR_ID,
      venueScope: grantedVenues([VENUE_ID]),
      now: NOW,
    })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.data.transitioned).toBe(false)
      expect(r.data.row).toBeNull()
    }
  })

  it('returns db_write_failed on update error', async () => {
    const state = newState({
      updateError: { message: 'connection lost' },
      updateReturn: null,
    })
    vi.mocked(createAdminClient).mockReturnValue(
      makeSupabaseMock(state) as unknown as ReturnType<typeof createAdminClient>,
    )
    const r = await markCancelled({
      commitmentId: COMMITMENT_ID,
      operatorId: OPERATOR_ID,
      venueScope: grantedVenues([VENUE_ID]),
      now: NOW,
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.errorCode).toBe('db_write_failed')
  })
})

// TAC-436 ruling 3. The arrival half of "a visit is confirmed". This is the one
// arrival signal that creates no transaction row, which is what makes it usable
// for arming an intention that any transaction closes.
describe('findEarliestAcknowledgedArrival', () => {
  function mockWith(state: MockState) {
    vi.mocked(createAdminClient).mockReturnValue(
      makeSupabaseMock(state) as unknown as ReturnType<typeof createAdminClient>,
    )
  }

  it('returns the acknowledged_at of the earliest acknowledged commitment', async () => {
    const state = newState({ selectReturn: [{ acknowledged_at: '2026-09-10T14:00:00.000Z' }] })
    mockWith(state)

    const r = await findEarliestAcknowledgedArrival({ venueId: VENUE_ID, guestId: GUEST_ID })

    expect(r.ok).toBe(true)
    if (r.ok) expect(r.data).toEqual(new Date('2026-09-10T14:00:00.000Z'))
  })

  // NON-BEHAVIOURAL, and the only thing that proves the query is scoped. The
  // mock hands back selectReturn whatever is asked for, so without these a
  // build that dropped the status filter, the venue scoping or the ordering
  // would pass every assertion above while reading another venue's rows or the
  // LATEST arrival instead of the earliest.
  it('scopes to this venue, this guest, and acknowledged rows with a timestamp', async () => {
    const state = newState({ selectReturn: [{ acknowledged_at: '2026-09-10T14:00:00.000Z' }] })
    mockWith(state)

    await findEarliestAcknowledgedArrival({ venueId: VENUE_ID, guestId: GUEST_ID })

    expect(state.selectEqCalls).toContainEqual({ field: 'venue_id', value: VENUE_ID })
    expect(state.selectEqCalls).toContainEqual({ field: 'guest_id', value: GUEST_ID })
    expect(state.selectEqCalls).toContainEqual({ field: 'status', value: 'acknowledged' })
    expect(state.selectNotCalls).toContainEqual({
      field: 'acknowledged_at',
      op: 'is',
      value: null,
    })
  })

  // EARLIEST, not latest. understand_order does not re-arm, and its window runs
  // from the anchor, so a later visit must not renew an ask about the first
  // order nobody heard. A mutant flipping ascending to false fails here.
  it('asks for the EARLIEST arrival, not the latest', async () => {
    const state = newState({ selectReturn: [{ acknowledged_at: '2026-09-10T14:00:00.000Z' }] })
    mockWith(state)

    await findEarliestAcknowledgedArrival({ venueId: VENUE_ID, guestId: GUEST_ID })

    expect(state.selectOrderCalls).toContainEqual({
      field: 'acknowledged_at',
      opts: { ascending: true },
    })
    expect(state.selectLimitCalls).toEqual([1])
  })

  it('returns null when the guest has no acknowledged arrival', async () => {
    const state = newState({ selectReturn: [] })
    mockWith(state)

    const r = await findEarliestAcknowledgedArrival({ venueId: VENUE_ID, guestId: GUEST_ID })

    expect(r.ok).toBe(true)
    if (r.ok) expect(r.data).toBeNull()
  })

  // Never Invalid Date. The derivation carries this straight into an expiry
  // comparison, and NaN there silently never expires.
  it('returns null rather than an Invalid Date for an unparseable timestamp', async () => {
    const state = newState({ selectReturn: [{ acknowledged_at: 'not a date' }] })
    mockWith(state)

    const r = await findEarliestAcknowledgedArrival({ venueId: VENUE_ID, guestId: GUEST_ID })

    expect(r.ok).toBe(true)
    if (r.ok) expect(r.data).toBeNull()
  })

  it('returns db_read_failed on a supabase error rather than null', async () => {
    const state = newState({ selectError: { message: 'connection lost' }, selectReturn: null })
    mockWith(state)

    const r = await findEarliestAcknowledgedArrival({ venueId: VENUE_ID, guestId: GUEST_ID })

    // Distinguishable from "no arrival": the caller holds the arrival-armed
    // half of the turn rather than reading a hiccup as "never visited".
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.errorCode).toBe('db_read_failed')
  })
})

describe('findActiveCommitmentsForGuest', () => {
  it('returns rows from the DB, parsed', async () => {
    const state = newState({
      selectReturn: [makeRow({ status: 'open' }), makeRow({ id: 'eee', status: 'pending_ack' })],
    })
    vi.mocked(createAdminClient).mockReturnValue(
      makeSupabaseMock(state) as unknown as ReturnType<typeof createAdminClient>,
    )
    const r = await findActiveCommitmentsForGuest({
      venueId: VENUE_ID,
      guestId: GUEST_ID,
    })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.data).toHaveLength(2)
      expect(r.data[0].status).toBe('open')
      expect(r.data[1].status).toBe('pending_ack')
    }
    expect(state.selectInCalls).toContainEqual({ field: 'status', values: ['open', 'pending_ack'] })
  })

  it('fails OPEN on a malformed row — drops it, keeps the rest', async () => {
    const state = newState({
      selectReturn: [
        makeRow({ status: 'open' }),
        { not: 'a valid row' },
        makeRow({ id: 'eee', status: 'pending_ack' }),
      ],
    })
    vi.mocked(createAdminClient).mockReturnValue(
      makeSupabaseMock(state) as unknown as ReturnType<typeof createAdminClient>,
    )
    const r = await findActiveCommitmentsForGuest({
      venueId: VENUE_ID,
      guestId: GUEST_ID,
    })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.data).toHaveLength(2)
  })

  it('returns db_read_failed on supabase error', async () => {
    const state = newState({
      selectError: { message: 'connection lost' },
      selectReturn: null,
    })
    vi.mocked(createAdminClient).mockReturnValue(
      makeSupabaseMock(state) as unknown as ReturnType<typeof createAdminClient>,
    )
    const r = await findActiveCommitmentsForGuest({
      venueId: VENUE_ID,
      guestId: GUEST_ID,
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.errorCode).toBe('db_read_failed')
  })
})

describe('findScheduledOpenCommitments', () => {
  it('returns rows with status=open AND arrival_signal=scheduled, no time filter', async () => {
    const state = newState({
      selectReturn: [
        makeRow({
          status: 'open',
          // Future-dated — the morning-of model means this still surfaces
          // here; the processor decides eligibility per-venue.
          expected_arrival: '2026-06-15T12:00:00Z',
          arrival_signal: 'scheduled',
        }),
      ],
    })
    vi.mocked(createAdminClient).mockReturnValue(
      makeSupabaseMock(state) as unknown as ReturnType<typeof createAdminClient>,
    )
    const r = await findScheduledOpenCommitments()
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.data).toHaveLength(1)
    // Both filters land via .eq() — imminent rows must be excluded at the SQL
    // boundary so a pathological cron tick can't transition them.
    expect(state.selectEqCalls).toContainEqual({ field: 'status', value: 'open' })
    expect(state.selectEqCalls).toContainEqual({
      field: 'arrival_signal',
      value: 'scheduled',
    })
  })
})

// ===== TAC-341: server-derived horizons + the lifecycle scan/writers =====

describe('createCommitmentFromPending — TAC-341 horizons', () => {
  function mockWith(state: MockState) {
    vi.mocked(createAdminClient).mockReturnValue(
      makeSupabaseMock(state) as unknown as ReturnType<typeof createAdminClient>,
    )
  }

  it('derives a two-year horizon for a comp', async () => {
    const state = newState()
    mockWith(state)
    await createCommitmentFromPending({
      guestId: GUEST_ID,
      venueId: VENUE_ID,
      pendingCommitment: PENDING,
      sourceMessageId: MESSAGE_ID,
      now: NOW,
    })
    expect(state.insertedPayload).toMatchObject({
      expires_at: '2026-07-27T15:30:00.000Z',
      escalated_at: null,
    })
  })

  // The emission's own expiresAt has never been populated (the prompt does not
  // mention the field) and must stay ignored if it ever is: server-derived,
  // never agent-set. A non-null fixture is what makes this assertion mean
  // something.
  it('ignores an agent-supplied expiresAt', async () => {
    const state = newState()
    mockWith(state)
    await createCommitmentFromPending({
      guestId: GUEST_ID,
      venueId: VENUE_ID,
      pendingCommitment: { ...PENDING, expiresAt: '2027-01-01T00:00:00Z' },
      sourceMessageId: MESSAGE_ID,
      now: NOW,
    })
    expect(state.insertedPayload?.expires_at).toBe('2026-07-27T15:30:00.000Z')
  })

  // The scope cut at the creation layer. A recommendation is still created,
  // still deduped, still rendered — it just carries no horizon, so the
  // lifecycle scan's `expires_at IS NOT NULL` filter can never see it.
  it('leaves a recommendation with a null horizon', async () => {
    const state = newState({ insertedReturn: makeRow({ type: 'recommendation' }) })
    mockWith(state)
    await createCommitmentFromPending({
      guestId: GUEST_ID,
      venueId: VENUE_ID,
      pendingCommitment: {
        type: 'recommendation',
        description: 'blossom tonic',
        code: null,
        expiresAt: null,
      },
      sourceMessageId: MESSAGE_ID,
      now: NOW,
    })
    expect(state.insertedPayload).toMatchObject({
      type: 'recommendation',
      expires_at: null,
      escalated_at: null,
    })
  })

  // Cost control, and a real one: this is the hot path on every dispatched
  // commitment. Only a hold needs the venue clock, so a comp must not pay for
  // two extra round trips.
  it('does not load the venue clock for a comp', async () => {
    const state = newState()
    mockWith(state)
    await createCommitmentFromPending({
      guestId: GUEST_ID,
      venueId: VENUE_ID,
      pendingCommitment: PENDING,
      sourceMessageId: MESSAGE_ID,
      now: NOW,
    })
    expect(state.maybeSingleCallCount).toBe(0)
    expect(state.selectTables).not.toContain('venues')
    expect(state.selectTables).not.toContain('venue_configs')
  })

  it('loads the venue clock for a hold and expires it at close', async () => {
    const state = newState({
      insertedReturn: makeRow({ type: 'hold', code: null }),
      venueRow: { timezone: 'America/Los_Angeles' },
      configRow: { venue_info: { hours: { friday: '7:00 AM – 3:00 PM' } } },
    })
    mockWith(state)
    await createCommitmentFromPending({
      guestId: GUEST_ID,
      venueId: VENUE_ID,
      pendingCommitment: {
        type: 'hold',
        description: 'almond croissant',
        code: 'H4LD',
        expiresAt: null,
      },
      sourceMessageId: MESSAGE_ID,
      // Friday 2026-07-10, 11:00 PDT.
      now: new Date('2026-07-10T18:00:00Z'),
    })
    expect(state.selectTables).toContain('venues')
    expect(state.selectTables).toContain('venue_configs')
    expect(state.insertedPayload).toMatchObject({
      expires_at: '2026-07-10T22:00:00.000Z',
      escalated_at: null,
    })
  })

  // The fallback is stamped escalated AT CREATION, and that is the only
  // moment it can be: a 23:59 guess is indistinguishable later from a venue
  // that genuinely closes at midnight, so the cron reading this row tomorrow
  // could not tell.
  it('stamps escalated_at and alerts when a hold horizon is a fallback', async () => {
    const state = newState({
      insertedReturn: makeRow({
        type: 'hold',
        code: null,
        expires_at: '2026-07-11T06:59:00.000Z',
      }),
      configRow: { venue_info: { hours: {} } },
    })
    mockWith(state)
    await createCommitmentFromPending({
      guestId: GUEST_ID,
      venueId: VENUE_ID,
      pendingCommitment: {
        type: 'hold',
        description: 'almond croissant',
        code: 'H4LD',
        expiresAt: null,
      },
      sourceMessageId: MESSAGE_ID,
      now: new Date('2026-07-10T18:00:00Z'),
    })
    expect(state.insertedPayload).toMatchObject({
      expires_at: '2026-07-11T06:59:00.000Z',
      escalated_at: '2026-07-10T18:00:00.000Z',
    })
    expect(captureCommitmentEscalated).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'hold_horizon_unknown' }),
    )
  })

  it('falls back rather than throwing when the venue clock cannot be read', async () => {
    const state = newState({
      insertedReturn: makeRow({ type: 'hold', code: null }),
      venueRow: null,
      configRow: null,
    })
    mockWith(state)
    const r = await createCommitmentFromPending({
      guestId: GUEST_ID,
      venueId: VENUE_ID,
      pendingCommitment: {
        type: 'hold',
        description: 'almond croissant',
        code: 'H4LD',
        expiresAt: null,
      },
      sourceMessageId: MESSAGE_ID,
      now: new Date('2026-07-10T18:00:00Z'),
    })
    // The message has already been sent to the guest by this point; a missing
    // venue record must not convert that into a failed materialization.
    expect(r.ok).toBe(true)
    // An exact value, not merely non-null: `not.toBeNull()` also passes on
    // `undefined`, which is what a dropped field looks like. 23:59 UTC on the
    // creation day, since there is no venue zone to resolve against.
    expect(state.insertedPayload?.expires_at).toBe('2026-07-10T23:59:00.000Z')
    expect(state.insertedPayload?.escalated_at).toBe('2026-07-10T18:00:00.000Z')
  })
})

describe('createCommitmentFromPending — upgrade to a hold on unreadable hours', () => {
  // The MAJOR found in code review. shouldUpgrade permits recommendation →
  // hold, and touchOpenCommitment stamps escalated_at on the fallback — but
  // resolveToExisting emitted nothing, so the marker was set with no Slack
  // post and no event. The cron then skips the row forever (escalated_at is
  // non-null) and reports hadEscalated: true when it expires. Setting an
  // idempotency marker without the thing it marks having happened is the same
  // shape as the blocker in the processor.
  it('stamps escalated_at AND emits when an upgraded hold takes the fallback', async () => {
    const OPEN_REC = makeRow({ type: 'recommendation', code: null })
    const state = newState({
      selectReturn: [OPEN_REC],
      updateReturn: [makeRow({ type: 'hold', code: 'H4LD' })],
      configRow: { venue_info: { hours: {} } },
    })
    vi.mocked(createAdminClient).mockReturnValue(
      makeSupabaseMock(state) as unknown as ReturnType<typeof createAdminClient>,
    )

    await createCommitmentFromPending({
      guestId: GUEST_ID,
      venueId: VENUE_ID,
      pendingCommitment: {
        type: 'hold',
        description: 'oat latte',
        code: 'H4LD',
        expiresAt: null,
      },
      sourceMessageId: MESSAGE_ID,
      now: NOW,
    })

    expect(state.insertCallCount).toBe(0)
    expect(state.updatePayload).toHaveProperty('escalated_at', NOW.toISOString())
    expect(captureCommitmentEscalated).toHaveBeenCalledWith(
      expect.objectContaining({
        reason: 'hold_horizon_unknown',
        type: 'hold',
        commitmentId: COMMITMENT_ID,
      }),
    )
  })

  it('does not re-stamp or re-emit when the row already escalated', async () => {
    const ALREADY = makeRow({
      type: 'recommendation',
      code: null,
      escalated_at: '2026-05-01T00:00:00Z',
    })
    const state = newState({
      selectReturn: [ALREADY],
      updateReturn: [makeRow({ type: 'hold' })],
      configRow: { venue_info: { hours: {} } },
    })
    vi.mocked(createAdminClient).mockReturnValue(
      makeSupabaseMock(state) as unknown as ReturnType<typeof createAdminClient>,
    )

    await createCommitmentFromPending({
      guestId: GUEST_ID,
      venueId: VENUE_ID,
      pendingCommitment: {
        type: 'hold',
        description: 'oat latte',
        code: 'H4LD',
        expiresAt: null,
      },
      sourceMessageId: MESSAGE_ID,
      now: NOW,
    })

    // The write guard and the emit guard must agree; if they drift, one
    // commitment produces a second alert years after the first.
    expect(state.updatePayload).not.toHaveProperty('escalated_at')
    expect(captureCommitmentEscalated).not.toHaveBeenCalled()
  })
})

describe('findOpenObligations', () => {
  // Non-behavioural on purpose: the mock ignores its filters, so the only way
  // to prove the scan cannot reach a recommendation — or a pending_ack row —
  // is to assert the query it builds.
  it('scans only open obligations carrying a horizon', async () => {
    const state = newState({ selectReturn: [] })
    vi.mocked(createAdminClient).mockReturnValue(
      makeSupabaseMock(state) as unknown as ReturnType<typeof createAdminClient>,
    )
    await findOpenObligations()

    expect(state.selectEqCalls).toContainEqual({ field: 'status', value: 'open' })
    expect(state.selectNotCalls).toContainEqual({
      field: 'expires_at',
      op: 'is',
      value: null,
    })
    const typeFilter = state.selectInCalls.find((c) => c.field === 'type')
    expect(typeFilter).toBeDefined()
    expect([...(typeFilter?.values ?? [])].sort()).toEqual(['comp', 'discount', 'hold'])
  })

  // The regression check for the 2026-09-14 scope cut, at the layer that
  // decides it. An allowlist narrowed to a `neq('recommendation')` exclusion
  // would pass every behavioural test in this file.
  it('never admits recommendations', async () => {
    const state = newState({ selectReturn: [] })
    vi.mocked(createAdminClient).mockReturnValue(
      makeSupabaseMock(state) as unknown as ReturnType<typeof createAdminClient>,
    )
    await findOpenObligations()
    const typeFilter = state.selectInCalls.find((c) => c.field === 'type')
    expect(typeFilter?.values).not.toContain('recommendation')
  })

  it('skips an unparseable row rather than failing the whole scan', async () => {
    const state = newState({
      selectReturn: [makeRow(), { id: 'broken' }, makeRow({ id: 'also-fine' })],
    })
    vi.mocked(createAdminClient).mockReturnValue(
      makeSupabaseMock(state) as unknown as ReturnType<typeof createAdminClient>,
    )
    const r = await findOpenObligations()
    expect(r.ok).toBe(true)
    // Keeps scanning PAST the unreadable row — a `return` here instead of a
    // `continue` would silently drop every obligation behind it.
    expect(r.ok && r.data).toHaveLength(2)
  })
})

describe('markEscalated', () => {
  it('CAS-gates on open AND not-yet-escalated', async () => {
    const state = newState({ updateReturn: [makeRow({ escalated_at: NOW.toISOString() })] })
    vi.mocked(createAdminClient).mockReturnValue(
      makeSupabaseMock(state) as unknown as ReturnType<typeof createAdminClient>,
    )
    const r = await markEscalated({ commitmentId: COMMITMENT_ID, now: NOW })

    expect(r.ok && r.data.transitioned).toBe(true)
    expect(state.updateEqCalls).toContainEqual({ field: 'status', value: 'open' })
    // The half that makes escalation fire exactly once under overlapping
    // ticks. Without it both ticks win their CAS and the guest's operator
    // gets two alerts for one commitment.
    expect(state.updateIsCalls).toContainEqual({ field: 'escalated_at', value: null })
  })

  it('does not change status — an escalated commitment is still owed', async () => {
    const state = newState()
    vi.mocked(createAdminClient).mockReturnValue(
      makeSupabaseMock(state) as unknown as ReturnType<typeof createAdminClient>,
    )
    await markEscalated({ commitmentId: COMMITMENT_ID, now: NOW })
    expect(state.updatePayload).toEqual({
      escalated_at: NOW.toISOString(),
      updated_at: NOW.toISOString(),
    })
  })

  it('reports a lost CAS as transitioned=false, not as an error', async () => {
    const state = newState({ updateReturn: [] })
    vi.mocked(createAdminClient).mockReturnValue(
      makeSupabaseMock(state) as unknown as ReturnType<typeof createAdminClient>,
    )
    const r = await markEscalated({ commitmentId: COMMITMENT_ID, now: NOW })
    expect(r.ok).toBe(true)
    expect(r.ok && r.data.transitioned).toBe(false)
  })
})

describe('markExpired', () => {
  it('moves an open row to expired, CAS-gated on open', async () => {
    const state = newState({ updateReturn: [makeRow({ status: 'expired' })] })
    vi.mocked(createAdminClient).mockReturnValue(
      makeSupabaseMock(state) as unknown as ReturnType<typeof createAdminClient>,
    )
    const r = await markExpired({ commitmentId: COMMITMENT_ID, now: NOW })

    expect(r.ok && r.data.transitioned).toBe(true)
    expect(state.updatePayload).toEqual({
      status: 'expired',
      updated_at: NOW.toISOString(),
    })
    // status='open' is what makes pending_ack, acknowledged and cancelled
    // rows untouchable here — not a guard in the processor loop.
    expect(state.updateEqCalls).toContainEqual({ field: 'status', value: 'open' })
  })

  it('leaves a row that moved to pending_ack alone', async () => {
    const state = newState({ updateReturn: [] })
    vi.mocked(createAdminClient).mockReturnValue(
      makeSupabaseMock(state) as unknown as ReturnType<typeof createAdminClient>,
    )
    const r = await markExpired({ commitmentId: COMMITMENT_ID, now: NOW })
    expect(r.ok && r.data.transitioned).toBe(false)
  })
})

// TAC-513. The incident: a comp that was `open` (never pending_ack, no arrival
// signal) was declared cancelled to the guest and stayed open. markCancelled
// could not have touched it, so these tests are largely about the CAS
// predicate: which states it accepts, and that it is scoped to one guest.
describe('cancelCommitmentForGuest (TAC-513)', () => {
  it('flips an OPEN commitment to cancelled', async () => {
    // The incident state exactly. If this ever stops passing the ticket is
    // unfixed.
    const state = newState({ updateReturn: [makeRow({ status: 'cancelled' })] })
    vi.mocked(createAdminClient).mockReturnValue(
      makeSupabaseMock(state) as unknown as ReturnType<typeof createAdminClient>,
    )
    const r = await cancelCommitmentForGuest({
      commitmentId: COMMITMENT_ID,
      venueId: VENUE_ID,
      guestId: GUEST_ID,
      now: NOW,
    })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.data.transitioned).toBe(true)
      expect(r.data.row?.status).toBe('cancelled')
    }
    expect(state.updatePayload).toMatchObject({ status: 'cancelled' })
  })

  it('accepts BOTH open and pending_ack, and nothing else', async () => {
    // Asserted on the filter rather than a returned row: the mock ignores
    // filters, so a returned row proves nothing about the predicate. Dropping
    // 'open' here is the mutant that un-fixes the ticket.
    const state = newState({ updateReturn: [makeRow({ status: 'cancelled' })] })
    vi.mocked(createAdminClient).mockReturnValue(
      makeSupabaseMock(state) as unknown as ReturnType<typeof createAdminClient>,
    )
    await cancelCommitmentForGuest({
      commitmentId: COMMITMENT_ID,
      venueId: VENUE_ID,
      guestId: GUEST_ID,
      now: NOW,
    })
    expect(state.updateInCalls).toContainEqual({
      field: 'status',
      values: ['open', 'pending_ack'],
    })
  })

  it('scopes the update to the commitment, the venue AND the guest', async () => {
    // The cross-guest guard, in Postgres rather than in application code.
    // Dropping guest_id lets a hallucinated id cancel another guest's comp.
    const state = newState({ updateReturn: [makeRow({ status: 'cancelled' })] })
    vi.mocked(createAdminClient).mockReturnValue(
      makeSupabaseMock(state) as unknown as ReturnType<typeof createAdminClient>,
    )
    await cancelCommitmentForGuest({
      commitmentId: COMMITMENT_ID,
      venueId: VENUE_ID,
      guestId: GUEST_ID,
      now: NOW,
    })
    expect(state.updateEqCalls).toContainEqual({ field: 'id', value: COMMITMENT_ID })
    expect(state.updateEqCalls).toContainEqual({ field: 'venue_id', value: VENUE_ID })
    expect(state.updateEqCalls).toContainEqual({ field: 'guest_id', value: GUEST_ID })
  })

  it('reports transitioned=false when the CAS matches nothing', async () => {
    // Already acknowledged, redeemed, expired, cancelled, or another guest's.
    // The caller logs this and does not fail the dispatch.
    const state = newState({ updateReturn: [] })
    vi.mocked(createAdminClient).mockReturnValue(
      makeSupabaseMock(state) as unknown as ReturnType<typeof createAdminClient>,
    )
    const r = await cancelCommitmentForGuest({
      commitmentId: COMMITMENT_ID,
      venueId: VENUE_ID,
      guestId: GUEST_ID,
      now: NOW,
    })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.data.transitioned).toBe(false)
      expect(r.data.row).toBeNull()
    }
  })

  it('writes status and updated_at, and no audit columns', async () => {
    // No cancelled_at / cancelled_by exist. Pinned with an exact key set so
    // adding one silently is a failure rather than a surprise in Studio.
    const state = newState({ updateReturn: [makeRow({ status: 'cancelled' })] })
    vi.mocked(createAdminClient).mockReturnValue(
      makeSupabaseMock(state) as unknown as ReturnType<typeof createAdminClient>,
    )
    await cancelCommitmentForGuest({
      commitmentId: COMMITMENT_ID,
      venueId: VENUE_ID,
      guestId: GUEST_ID,
      now: NOW,
    })
    expect(Object.keys(state.updatePayload ?? {}).sort()).toEqual([
      'status',
      'updated_at',
    ])
    expect(state.updatePayload).toEqual({
      status: 'cancelled',
      updated_at: NOW.toISOString(),
    })
  })

  it('returns an error value on a DB failure, never throws', async () => {
    const state = newState({ updateError: { message: 'boom' } })
    vi.mocked(createAdminClient).mockReturnValue(
      makeSupabaseMock(state) as unknown as ReturnType<typeof createAdminClient>,
    )
    const r = await cancelCommitmentForGuest({
      commitmentId: COMMITMENT_ID,
      venueId: VENUE_ID,
      guestId: GUEST_ID,
      now: NOW,
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.errorCode).toBe('db_write_failed')
  })

  it('returns an error value when the returned row is malformed', async () => {
    const state = newState({ updateReturn: [{ id: COMMITMENT_ID }] })
    vi.mocked(createAdminClient).mockReturnValue(
      makeSupabaseMock(state) as unknown as ReturnType<typeof createAdminClient>,
    )
    const r = await cancelCommitmentForGuest({
      commitmentId: COMMITMENT_ID,
      venueId: VENUE_ID,
      guestId: GUEST_ID,
      now: NOW,
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.errorCode).toBe('db_write_invalid_shape')
  })

  it('leaves markCancelled untouched: it still gates on pending_ack alone', async () => {
    // TAC-389 owns the decline path. This is the guard that the new helper was
    // added BESIDE markCancelled rather than by widening it.
    const state = newState({ updateReturn: [makeRow({ status: 'cancelled' })] })
    vi.mocked(createAdminClient).mockReturnValue(
      makeSupabaseMock(state) as unknown as ReturnType<typeof createAdminClient>,
    )
    await markCancelled({
      commitmentId: COMMITMENT_ID,
      operatorId: OPERATOR_ID,
      venueScope: grantedVenues([VENUE_ID]),
      now: NOW,
    })
    expect(state.updateEqCalls).toContainEqual({ field: 'status', value: 'pending_ack' })
    expect(state.updateInCalls).not.toContainEqual({
      field: 'status',
      values: ['open', 'pending_ack'],
    })
  })
})
