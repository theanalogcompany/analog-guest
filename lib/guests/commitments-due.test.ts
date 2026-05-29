/* eslint-disable @typescript-eslint/no-unused-vars */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// waitUntil is the @vercel/functions primitive we use to fire pushes
// without blocking the cron route's return. Mock to a no-op so tests don't
// pull in Vercel runtime.
const waitUntilMock = vi.fn<(p: Promise<unknown>) => void>()
vi.mock('@vercel/functions', () => ({
  waitUntil: (p: Promise<unknown>) => waitUntilMock(p),
}))

vi.mock('@/lib/db/admin', () => ({
  createAdminClient: vi.fn(),
}))

// We test commitments-due against the real findDueCommitments +
// transitionToPendingAck via the supabase mock — but stub the push module.
const sendCommitmentArrivalPushMock = vi.fn<
  (input: unknown) => Promise<void>
>()
vi.mock('@/lib/notifications/send-commitment-push', () => ({
  sendCommitmentArrivalPush: (input: unknown) =>
    sendCommitmentArrivalPushMock(input),
}))

import { createAdminClient } from '@/lib/db/admin'
import { processDueCommitments } from './commitments-due'

const NOW = new Date('2026-05-29T09:00:00Z')
const VENUE_ID = 'venue-1'
const GUEST_ID = 'guest-1'

function makeDueRow(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    guest_id: GUEST_ID,
    venue_id: VENUE_ID,
    type: 'comp',
    description: 'oat latte',
    code: '7K2P',
    status: 'open',
    expected_arrival: '2026-05-29T08:30:00Z',
    arrival_signal: 'scheduled',
    created_by: 'agent',
    expires_at: null,
    acknowledged_at: null,
    acknowledged_by: null,
    redeemed_at: null,
    source_message_id: null,
    created_at: '2026-05-29T00:00:00Z',
    updated_at: '2026-05-29T00:00:00Z',
    ...overrides,
  }
}

// State for the supabase mock — handles guest_commitments (select+update),
// venues (select), guests (select).
interface DBState {
  dueRows: unknown[]
  selectError: { message: string } | null
  updateReturnByRowId: Map<string, unknown[]>
  updateErrorByRowId: Map<string, { message: string }>
  venues: Array<{ id: string; timezone: string }>
  guests: Array<{ id: string; first_name: string | null }>
}

function newState(overrides: Partial<DBState> = {}): DBState {
  return {
    dueRows: [],
    selectError: null,
    updateReturnByRowId: new Map(),
    updateErrorByRowId: new Map(),
    venues: [{ id: VENUE_ID, timezone: 'America/Los_Angeles' }],
    guests: [{ id: GUEST_ID, first_name: 'Jaipal' }],
    ...overrides,
  }
}

function makeMockClient(state: DBState) {
  return {
    from: (table: string) => {
      if (table === 'guest_commitments') {
        return {
          select: (_cols: string) => {
            // SELECT chain for findDueCommitments
            const chain = {
              eq: (_f: string, _v: unknown) => chain,
              not: (_f: string, _op: string, _v: unknown) => chain,
              lte: (_f: string, _v: unknown) => chain,
              order: (_f: string, _opts: unknown) =>
                Promise.resolve({
                  data: state.dueRows,
                  error: state.selectError,
                }),
            }
            return chain
          },
          update: (_payload: Record<string, unknown>) => {
            let capturedId: string | null = null
            const chain = {
              eq: (field: string, value: unknown) => {
                if (field === 'id') capturedId = String(value)
                return chain
              },
              select: async () => {
                if (capturedId === null) {
                  return { data: [], error: null }
                }
                const err = state.updateErrorByRowId.get(capturedId)
                if (err) return { data: null, error: err }
                return {
                  data: state.updateReturnByRowId.get(capturedId) ?? [],
                  error: null,
                }
              },
            }
            return chain
          },
        }
      }
      if (table === 'venues') {
        return {
          select: (_cols: string) => ({
            in: async (_field: string, _values: unknown[]) => ({
              data: state.venues,
              error: null,
            }),
          }),
        }
      }
      if (table === 'guests') {
        return {
          select: (_cols: string) => ({
            in: async (_field: string, _values: unknown[]) => ({
              data: state.guests,
              error: null,
            }),
          }),
        }
      }
      throw new Error(`Unmocked table ${table}`)
    },
  }
}

beforeEach(() => {
  waitUntilMock.mockReset()
  sendCommitmentArrivalPushMock.mockReset()
  sendCommitmentArrivalPushMock.mockResolvedValue(undefined)
  vi.mocked(createAdminClient).mockReset()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('processDueCommitments', () => {
  it('returns zero counts when no rows are due', async () => {
    const state = newState({ dueRows: [] })
    vi.mocked(createAdminClient).mockReturnValue(
      makeMockClient(state) as unknown as ReturnType<typeof createAdminClient>,
    )
    const r = await processDueCommitments(NOW)
    expect(r.scanned).toBe(0)
    expect(r.transitioned).toBe(0)
    expect(r.pushed).toBe(0)
    expect(sendCommitmentArrivalPushMock).not.toHaveBeenCalled()
    expect(waitUntilMock).not.toHaveBeenCalled()
  })

  it('CAS-rowcount-gates push — transitioned=true fires push exactly once', async () => {
    const row = makeDueRow('cmt-1')
    const transitionedRow = { ...row, status: 'pending_ack', arrival_signal: 'scheduled' }
    const state = newState({
      dueRows: [row],
      updateReturnByRowId: new Map([['cmt-1', [transitionedRow]]]),
    })
    vi.mocked(createAdminClient).mockReturnValue(
      makeMockClient(state) as unknown as ReturnType<typeof createAdminClient>,
    )
    const r = await processDueCommitments(NOW)
    expect(r.scanned).toBe(1)
    expect(r.transitioned).toBe(1)
    expect(r.pushed).toBe(1)
    expect(r.skipped).toBe(0)
    expect(waitUntilMock).toHaveBeenCalledOnce()
    expect(sendCommitmentArrivalPushMock).toHaveBeenCalledOnce()
    const call = sendCommitmentArrivalPushMock.mock.calls[0][0] as {
      commitmentId: string
      type: string
      arrivalSignal: string
      venueTimezone: string
      agentRunId: string | null
    }
    expect(call.commitmentId).toBe('cmt-1')
    expect(call.type).toBe('comp')
    expect(call.arrivalSignal).toBe('scheduled')
    expect(call.venueTimezone).toBe('America/Los_Angeles')
    expect(call.agentRunId).toBeNull()
  })

  it('CAS-rowcount-gates push — transitioned=false (rowcount=0) skips push', async () => {
    const row = makeDueRow('cmt-2')
    const state = newState({
      dueRows: [row],
      // Empty update return = CAS lost
      updateReturnByRowId: new Map([['cmt-2', []]]),
    })
    vi.mocked(createAdminClient).mockReturnValue(
      makeMockClient(state) as unknown as ReturnType<typeof createAdminClient>,
    )
    const r = await processDueCommitments(NOW)
    expect(r.scanned).toBe(1)
    expect(r.transitioned).toBe(0)
    expect(r.skipped).toBe(1)
    expect(r.pushed).toBe(0)
    expect(waitUntilMock).not.toHaveBeenCalled()
    expect(sendCommitmentArrivalPushMock).not.toHaveBeenCalled()
  })

  it('errored row logs + continues; summary counts the rest', async () => {
    const row1 = makeDueRow('cmt-3')
    const row2 = makeDueRow('cmt-4')
    const state = newState({
      dueRows: [row1, row2],
      updateErrorByRowId: new Map([['cmt-3', { message: 'connection lost' }]]),
      updateReturnByRowId: new Map([
        ['cmt-4', [{ ...row2, status: 'pending_ack', arrival_signal: 'scheduled' }]],
      ]),
    })
    vi.mocked(createAdminClient).mockReturnValue(
      makeMockClient(state) as unknown as ReturnType<typeof createAdminClient>,
    )
    const r = await processDueCommitments(NOW)
    expect(r.scanned).toBe(2)
    expect(r.errored).toBe(1)
    expect(r.transitioned).toBe(1)
    expect(r.pushed).toBe(1)
    expect(sendCommitmentArrivalPushMock).toHaveBeenCalledOnce()
  })

  it('invalid row (null arrival_signal) is dropped without a transition', async () => {
    const row = makeDueRow('cmt-5', { arrival_signal: null })
    const state = newState({
      dueRows: [row],
    })
    vi.mocked(createAdminClient).mockReturnValue(
      makeMockClient(state) as unknown as ReturnType<typeof createAdminClient>,
    )
    const r = await processDueCommitments(NOW)
    expect(r.scanned).toBe(1)
    expect(r.invalid).toBe(1)
    expect(r.transitioned).toBe(0)
    expect(r.pushed).toBe(0)
  })
})
