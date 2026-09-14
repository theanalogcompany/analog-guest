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
}))

import { createAdminClient } from '@/lib/db/admin'
import type { PendingCommitment } from '@/lib/schemas/guest-commitment'
import {
  commitmentDedupKey,
  createCommitmentFromPending,
  findActiveCommitmentsForGuest,
  findScheduledOpenCommitments,
  markAcknowledged,
  markCancelled,
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
    ...overrides,
  }
}

function makeSupabaseMock(state: MockState) {
  return {
    from: (_table: string) => ({
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
        const chain = {
          eq: (field: string, value: unknown) => {
            state.selectEqCalls.push({ field, value })
            return chain
          },
          in: (field: string, values: unknown[]) => {
            state.selectInCalls.push({ field, values })
            return chain
          },
          not: (_field: string, _op: string, _value: unknown) => chain,
          lte: (_field: string, _value: unknown) => chain,
          order: (_field: string, _opts: unknown) => Promise.resolve({
            data: state.selectReturnQueue
              ? (state.selectReturnQueue[callIndex] ?? [])
              : state.selectReturn,
            error: state.selectError,
          }),
        }
        return chain
      },
    }),
  }
}

beforeEach(() => {
  vi.mocked(createAdminClient).mockReset()
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
    expect(state.updatePayload).toEqual({
      type: 'comp',
      code: 'Q4X9',
      source_message_id: MESSAGE_ID,
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
    for (const field of [
      'created_at',
      'status',
      'created_by',
      'description',
      'expires_at',
      'expected_arrival',
      'arrival_signal',
      'guest_id',
      'venue_id',
      'id',
    ]) {
      expect(payload).not.toHaveProperty(field)
    }
  })

  it('does not touch expires_at — TAC-341 owns every derivation', async () => {
    const state = newState({ selectReturn: [OPEN_REC] })
    mockWith(state)

    await createCommitmentFromPending({
      guestId: GUEST_ID,
      venueId: VENUE_ID,
      pendingCommitment: { ...COMP_ON_SAME_ITEM, expiresAt: '2027-01-01T00:00:00Z' },
      sourceMessageId: MESSAGE_ID,
      now: NOW,
    })

    // Its own test rather than one entry in the loop above, because this is
    // the one omitted field where leaving it alone is ALSO not obviously
    // right, and the fixture has to carry a non-null expiresAt to prove the
    // omission is deliberate rather than an artifact of null-in-null-out.
    //
    // Both obvious behaviours are wrong once TAC-341 lands: writing the
    // emission's value overwrites a derived expiry with null and the row
    // never expires; keeping the recommendation's own horizon gives an
    // upgraded comp 30 days where a new comp gets two years. TAC-341 owns
    // every derivation, including this one. Reintroducing the field here
    // creates a second derivation site in a file that does not own the
    // horizons.
    expect(state.updatePayload).not.toHaveProperty('expires_at')
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
      expectedArrival: NOW,
      arrivalSignal: 'imminent',
      now: NOW,
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.errorCode).toBe('db_write_failed')
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
      expectedArrival: NOW,
      arrivalSignal: 'scheduled',
      now: NOW,
    })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.data.transitioned).toBe(false)
  })
})

describe('markAcknowledged', () => {
  it('short-circuits when allowedVenueIds is empty (no round trip)', async () => {
    const r = await markAcknowledged({
      commitmentId: COMMITMENT_ID,
      operatorId: OPERATOR_ID,
      allowedVenueIds: [],
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
      allowedVenueIds: [VENUE_ID],
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
      allowedVenueIds: [VENUE_ID],
      now: NOW,
    })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.data.transitioned).toBe(false)
  })
})

describe('markCancelled (TAC-299)', () => {
  it('short-circuits when allowedVenueIds is empty (no round trip)', async () => {
    const r = await markCancelled({
      commitmentId: COMMITMENT_ID,
      operatorId: OPERATOR_ID,
      allowedVenueIds: [],
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
      allowedVenueIds: [VENUE_ID],
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
      allowedVenueIds: [VENUE_ID],
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
      allowedVenueIds: [VENUE_ID],
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
      allowedVenueIds: [VENUE_ID],
      now: NOW,
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.errorCode).toBe('db_write_failed')
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
