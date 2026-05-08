/* eslint-disable @typescript-eslint/no-unused-vars */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const generateObjectMock = vi.fn()
vi.mock('ai', () => ({
  generateObject: (...args: unknown[]) => generateObjectMock(...args),
}))
vi.mock('@/lib/ai/client', () => ({
  getGenerationModel: () => 'mock-model',
}))
vi.mock('@/lib/db/admin', () => ({
  createAdminClient: vi.fn(),
}))

import { createAdminClient } from '@/lib/db/admin'
import {
  findActiveClusters,
  findPatternClusterForCritique,
} from './find-pattern-cluster'

const VENUE_ID = '11111111-1111-4111-8111-111111111111'
const NEW_ID = '22222222-2222-4222-8222-222222222222'
const MSG_ID = '33333333-3333-4333-8333-333333333333'
const ID_A = '44444444-4444-4444-8444-444444444444'
const ID_B = '55555555-5555-4555-8555-555555555555'

interface RpcMockState {
  rpcResult: { data: unknown[]; error: { message: string } | null }
  selectResult: { data: unknown[]; error: { message: string } | null }
  rpcCalls: Array<{ name: string; args: Record<string, unknown> }>
}

function newState(overrides: Partial<RpcMockState> = {}): RpcMockState {
  return {
    rpcResult: { data: [], error: null },
    selectResult: { data: [], error: null },
    rpcCalls: [],
    ...overrides,
  }
}

function makeAdminMock(state: RpcMockState) {
  return {
    rpc: async (name: string, args: Record<string, unknown>) => {
      state.rpcCalls.push({ name, args })
      return state.rpcResult
    },
    from: (_table: string) => ({
      select: (_cols: string) => ({
        eq: (_f: string, _v: unknown) => ({
          eq: (_f2: string, _v2: unknown) => ({
            is: (_f3: string, _v3: unknown) => ({
              is: async (_f4: string, _v4: unknown) => state.selectResult,
            }),
          }),
        }),
      }),
    }),
  }
}

beforeEach(() => {
  generateObjectMock.mockReset()
  vi.mocked(createAdminClient).mockReset()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('findPatternClusterForCritique', () => {
  it('returns null without calling verification when prior matches < 2', async () => {
    const state = newState({
      rpcResult: {
        data: [
          {
            id: ID_A,
            message_id: MSG_ID,
            critique_text: 'too eager',
            similarity: 0.9,
          },
        ],
        error: null,
      },
    })
    vi.mocked(createAdminClient).mockReturnValue(
      makeAdminMock(state) as unknown as ReturnType<typeof createAdminClient>,
    )

    const cluster = await findPatternClusterForCritique({
      venueId: VENUE_ID,
      critiqueId: NEW_ID,
      critiqueText: 'too eager',
      messageId: MSG_ID,
      embedding: [0.1, 0.2, 0.3],
    })

    expect(cluster).toBeNull()
    expect(generateObjectMock).not.toHaveBeenCalled()
  })

  it('returns null when verification rejects the cluster', async () => {
    const state = newState({
      rpcResult: {
        data: [
          { id: ID_A, message_id: MSG_ID, critique_text: 'a', similarity: 0.9 },
          { id: ID_B, message_id: MSG_ID, critique_text: 'b', similarity: 0.88 },
        ],
        error: null,
      },
    })
    vi.mocked(createAdminClient).mockReturnValue(
      makeAdminMock(state) as unknown as ReturnType<typeof createAdminClient>,
    )
    generateObjectMock.mockResolvedValueOnce({
      object: { same_problem: false, reasoning: 'mixed signals' },
    })

    const cluster = await findPatternClusterForCritique({
      venueId: VENUE_ID,
      critiqueId: NEW_ID,
      critiqueText: 'too eager',
      messageId: MSG_ID,
      embedding: [0.1],
    })

    expect(cluster).toBeNull()
  })

  it('returns ClusterPayload when verification confirms', async () => {
    const state = newState({
      rpcResult: {
        data: [
          { id: ID_A, message_id: MSG_ID, critique_text: 'a', similarity: 0.9 },
          { id: ID_B, message_id: MSG_ID, critique_text: 'b', similarity: 0.88 },
        ],
        error: null,
      },
    })
    vi.mocked(createAdminClient).mockReturnValue(
      makeAdminMock(state) as unknown as ReturnType<typeof createAdminClient>,
    )
    generateObjectMock.mockResolvedValueOnce({
      object: {
        same_problem: true,
        reasoning: 'all marketing tone',
        proposed_rule_text: 'no marketing flourishes',
      },
    })

    const cluster = await findPatternClusterForCritique({
      venueId: VENUE_ID,
      critiqueId: NEW_ID,
      critiqueText: 'too eager',
      messageId: MSG_ID,
      embedding: [0.1],
    })

    expect(cluster).not.toBeNull()
    if (!cluster) return
    expect(cluster.proposedRuleText).toBe('no marketing flourishes')
    expect(cluster.critiqueIds).toContain(NEW_ID)
    expect(cluster.critiqueIds).toContain(ID_A)
    expect(cluster.critiqueIds).toContain(ID_B)
  })

  it('passes the just-committed id as exclude_id to find_similar_critiques', async () => {
    const state = newState()
    vi.mocked(createAdminClient).mockReturnValue(
      makeAdminMock(state) as unknown as ReturnType<typeof createAdminClient>,
    )

    await findPatternClusterForCritique({
      venueId: VENUE_ID,
      critiqueId: NEW_ID,
      critiqueText: 'x',
      messageId: MSG_ID,
      embedding: [0.1],
    })

    expect(state.rpcCalls).toHaveLength(1)
    expect(state.rpcCalls[0].name).toBe('find_similar_critiques')
    expect(state.rpcCalls[0].args.exclude_id).toBe(NEW_ID)
    expect(state.rpcCalls[0].args.similarity_threshold).toBe(0.85)
  })

  it('returns null when the rpc errors', async () => {
    const state = newState({
      rpcResult: { data: [], error: { message: 'connection lost' } },
    })
    vi.mocked(createAdminClient).mockReturnValue(
      makeAdminMock(state) as unknown as ReturnType<typeof createAdminClient>,
    )

    const cluster = await findPatternClusterForCritique({
      venueId: VENUE_ID,
      critiqueId: NEW_ID,
      critiqueText: 'x',
      messageId: MSG_ID,
      embedding: [0.1],
    })

    expect(cluster).toBeNull()
    expect(generateObjectMock).not.toHaveBeenCalled()
  })
})

describe('findActiveClusters', () => {
  it('returns [] when no unresolved critiques', async () => {
    const state = newState()
    vi.mocked(createAdminClient).mockReturnValue(
      makeAdminMock(state) as unknown as ReturnType<typeof createAdminClient>,
    )

    const clusters = await findActiveClusters(VENUE_ID)
    expect(clusters).toEqual([])
  })

  it('skips rows with unparseable embeddings', async () => {
    const state = newState({
      selectResult: {
        data: [
          { id: NEW_ID, message_id: MSG_ID, critique_text: 'x', embedding: 'not-a-vector' },
        ],
        error: null,
      },
    })
    vi.mocked(createAdminClient).mockReturnValue(
      makeAdminMock(state) as unknown as ReturnType<typeof createAdminClient>,
    )

    const clusters = await findActiveClusters(VENUE_ID)
    expect(clusters).toEqual([])
    expect(state.rpcCalls).toEqual([])
  })
})
