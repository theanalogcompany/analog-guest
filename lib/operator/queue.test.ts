// Offline tests for listPendingQueue's row-normalization layer. The lateral
// join itself runs in Postgres (migration 018's list_operator_queue RPC) and
// is covered by the four-scenario manual UAT in the PR description. Here we
// verify the TypeScript glue: jsonb null → [], recognition state filter,
// pendingSinceMs computation, and short-circuit on empty allowlist.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { listPendingQueue } from './queue'

const rpcMock = vi.fn()
const adminMock = vi.fn(() => ({ rpc: rpcMock }))

vi.mock('@/lib/db/admin', () => ({
  createAdminClient: () => adminMock(),
}))

describe('listPendingQueue', () => {
  beforeEach(() => {
    rpcMock.mockReset()
    adminMock.mockClear()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('short-circuits to empty drafts when the operator has no venue access', async () => {
    const result = await listPendingQueue([])
    expect(result).toEqual({ ok: true, drafts: [] })
    expect(rpcMock).not.toHaveBeenCalled()
  })

  it('passes allowedVenueIds through to the RPC verbatim', async () => {
    rpcMock.mockResolvedValue({ data: [], error: null })
    await listPendingQueue(['venue-a', 'venue-b'])
    expect(rpcMock).toHaveBeenCalledWith('list_operator_queue', {
      venue_ids: ['venue-a', 'venue-b'],
    })
  })

  it('normalizes a jsonb null recent_context to an empty array', async () => {
    rpcMock.mockResolvedValue({
      data: [
        {
          draft_id: 'd1',
          venue_id: 'v1',
          venue_slug: 'mock-cafe',
          guest_id: 'g1',
          guest_display_name: 'Test',
          guest_phone: '+15555550001',
          guest_opted_out_at: null,
          draft_body: 'hello',
          category: 'reply',
          voice_fidelity: 0.85,
          review_reason: null,
          recognition_state: 'returning',
          created_at: '2026-05-12T20:00:00.000Z',
          langfuse_trace_id: null,
          recent_context: null, // ← jsonb_agg returned null (no prior messages)
        },
      ],
      error: null,
    })
    const result = await listPendingQueue(['v1'], Date.parse('2026-05-12T21:00:00.000Z'))
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.drafts).toHaveLength(1)
      expect(result.drafts[0]!.recentContext).toEqual([])
    }
  })

  it('preserves recent_context entries with valid shape and drops malformed ones', async () => {
    rpcMock.mockResolvedValue({
      data: [
        {
          draft_id: 'd1',
          venue_id: 'v1',
          venue_slug: 'mock-cafe',
          guest_id: 'g1',
          guest_display_name: null,
          guest_phone: '+15555550002',
          guest_opted_out_at: null,
          draft_body: 'hello',
          category: null,
          voice_fidelity: null,
          review_reason: null,
          recognition_state: 'regular',
          created_at: '2026-05-12T20:00:00.000Z',
          langfuse_trace_id: null,
          recent_context: [
            // valid
            {
              id: 'ctx-1',
              direction: 'inbound',
              body: 'last text from guest',
              createdAt: '2026-05-12T19:55:00.000Z',
            },
            // valid (outbound)
            {
              id: 'ctx-2',
              direction: 'outbound',
              body: 'prior reply',
              createdAt: '2026-05-12T19:50:00.000Z',
            },
            // invalid direction — dropped
            {
              id: 'ctx-3',
              direction: 'sideways',
              body: 'oops',
              createdAt: '2026-05-12T19:45:00.000Z',
            },
            // missing field — dropped
            { id: 'ctx-4', direction: 'inbound', body: 'no createdAt' },
            // null entry — dropped
            null,
          ],
        },
      ],
      error: null,
    })
    const result = await listPendingQueue(['v1'])
    expect(result.ok).toBe(true)
    if (result.ok) {
      const ctx = result.drafts[0]!.recentContext
      expect(ctx).toHaveLength(2)
      expect(ctx.map((e) => e.id)).toEqual(['ctx-1', 'ctx-2'])
    }
  })

  it('normalizes unknown recognition_state values to null', async () => {
    rpcMock.mockResolvedValue({
      data: [
        {
          draft_id: 'd1',
          venue_id: 'v1',
          venue_slug: 'x',
          guest_id: 'g1',
          guest_display_name: null,
          guest_phone: '+15555550003',
          guest_opted_out_at: null,
          draft_body: 'hi',
          category: null,
          voice_fidelity: null,
          review_reason: null,
          recognition_state: 'super_regular', // not in the closed enum
          created_at: '2026-05-12T20:00:00.000Z',
          langfuse_trace_id: null,
          recent_context: null,
        },
      ],
      error: null,
    })
    const result = await listPendingQueue(['v1'])
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.drafts[0]!.recognitionState).toBeNull()
    }
  })

  it('computes pendingSinceMs from created_at vs nowMs (clamped to 0 minimum)', async () => {
    rpcMock.mockResolvedValue({
      data: [
        {
          draft_id: 'd1',
          venue_id: 'v1',
          venue_slug: 'x',
          guest_id: 'g1',
          guest_display_name: null,
          guest_phone: '+15555550004',
          guest_opted_out_at: null,
          draft_body: 'hi',
          category: null,
          voice_fidelity: null,
          review_reason: null,
          recognition_state: null,
          created_at: '2026-05-12T20:00:00.000Z',
          langfuse_trace_id: null,
          recent_context: null,
        },
      ],
      error: null,
    })
    const now = Date.parse('2026-05-12T20:05:00.000Z')
    const result = await listPendingQueue(['v1'], now)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.drafts[0]!.pendingSinceMs).toBe(5 * 60 * 1000)
    }
  })

  it('returns ok: false with the error message on RPC failure', async () => {
    rpcMock.mockResolvedValue({
      data: null,
      error: { message: 'function does not exist' },
    })
    const result = await listPendingQueue(['v1'])
    expect(result).toEqual({ ok: false, error: 'function does not exist' })
  })
})
