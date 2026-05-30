/* eslint-disable @typescript-eslint/no-unused-vars */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/db/admin', () => ({
  createAdminClient: vi.fn(),
}))

import { createAdminClient } from '@/lib/db/admin'
import type { PendingCommitment } from '@/lib/schemas/guest-commitment'
import {
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
  insertError: { message: string } | null
  updatePayload: Record<string, unknown> | null
  updateEqCalls: Array<{ field: string; value: unknown }>
  updateInCalls: Array<{ field: string; values: unknown[] }>
  updateReturn: Record<string, unknown>[] | null
  updateError: { message: string } | null
  selectReturn: Record<string, unknown>[] | null
  selectError: { message: string } | null
  selectEqCalls: Array<{ field: string; value: unknown }>
  selectInCalls: Array<{ field: string; values: unknown[] }>
}

function newState(overrides: Partial<MockState> = {}): MockState {
  return {
    insertedPayload: null,
    insertedReturn: makeRow(),
    insertError: null,
    updatePayload: null,
    updateEqCalls: [],
    updateInCalls: [],
    updateReturn: [makeRow()],
    updateError: null,
    selectReturn: [],
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
            data: state.selectReturn,
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
