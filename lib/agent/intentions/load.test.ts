import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/db/admin', () => ({
  createAdminClient: vi.fn(),
}))

import { createAdminClient } from '@/lib/db/admin'
import { loadIntentionRows } from './load'

// TAC-380 trap 1. Since migration 040, guest_intention_prompts holds two kinds
// of row — prompted (prompted_at set) and eligibility (prompted_at null). Every
// reader written before that keyed on row EXISTENCE, and read that way an
// eligibility row makes every eligible intention look already asked: nothing
// renders, nothing records, and a test that doesn't inspect the query stays
// green. The filters are pinned here directly because the mock, like every
// supabase mock in this repo, ignores its own arguments.

interface Call {
  method: string
  args: unknown[]
}

interface MockResult {
  data: unknown
  error: { message: string } | null
}

function mockClient(results: { prompted: MockResult; eligible: MockResult }) {
  const queries: Call[][] = []
  const from = vi.fn((table: string) => {
    const calls: Call[] = [{ method: 'from', args: [table] }]
    queries.push(calls)
    const builder: Record<string, unknown> = {}
    for (const method of ['select', 'eq', 'is', 'not']) {
      builder[method] = vi.fn((...args: unknown[]) => {
        calls.push({ method, args })
        return builder
      })
    }
    // The supabase builder is thenable. Route by the filter the query applied,
    // so a query that loses its filter also loses its data — the captured-call
    // assertions below are what actually catch that, this just keeps the
    // behavioural tests honest about which query produced which rows.
    builder.then = (resolve: (v: unknown) => unknown) => {
      const isPromptedQuery = calls.some((c) => c.method === 'not')
      return Promise.resolve(isPromptedQuery ? results.prompted : results.eligible).then(resolve)
    }
    return builder
  })
  vi.mocked(createAdminClient).mockReturnValue({ from } as unknown as ReturnType<
    typeof createAdminClient
  >)
  return { queries, from }
}

const EMPTY: MockResult = { data: [], error: null }

beforeEach(() => {
  vi.clearAllMocks()
})

describe('loadIntentionRows', () => {
  it('filters prompted rows with prompted_at IS NOT NULL and eligibility rows with IS NULL, in SQL (trap 1)', async () => {
    const { queries } = mockClient({ prompted: EMPTY, eligible: EMPTY })

    await loadIntentionRows('v1', 'g1')

    expect(queries).toHaveLength(2)
    for (const q of queries) {
      expect(q[0]).toEqual({ method: 'from', args: ['guest_intention_prompts'] })
      expect(q.filter((c) => c.method === 'eq')).toEqual([
        { method: 'eq', args: ['venue_id', 'v1'] },
        { method: 'eq', args: ['guest_id', 'g1'] },
      ])
    }

    const prompted = queries.find((q) =>
      q.some((c) => c.method === 'select' && String(c.args[0]).includes('prompt_source')),
    )
    const eligible = queries.find((q) => q !== prompted)
    expect(prompted?.filter((c) => c.method === 'not')).toEqual([
      { method: 'not', args: ['prompted_at', 'is', null] },
    ])
    expect(prompted?.some((c) => c.method === 'is')).toBe(false)
    expect(eligible?.filter((c) => c.method === 'is')).toEqual([
      { method: 'is', args: ['prompted_at', null] },
    ])
    expect(eligible?.some((c) => c.method === 'not')).toBe(false)
  })

  it('maps both row kinds, converting timestamps to Dates', async () => {
    mockClient({
      prompted: {
        data: [
          {
            intention_key: 'understand_order',
            prompted_at: '2026-09-13T10:00:00.000Z',
            eligible_at: '2026-09-12T09:00:00.000Z',
            prompt_source: 'classified',
            message_id: 'm1',
          },
        ],
        error: null,
      },
      eligible: {
        data: [{ intention_key: 'learn_name', eligible_at: '2026-09-13T11:00:00.000Z' }],
        error: null,
      },
    })

    const rows = await loadIntentionRows('v1', 'g1')

    expect(rows).toEqual({
      prompted: [
        {
          intentionKey: 'understand_order',
          promptedAt: new Date('2026-09-13T10:00:00.000Z'),
          eligibleAt: new Date('2026-09-12T09:00:00.000Z'),
          promptSource: 'classified',
          messageId: 'm1',
        },
      ],
      eligible: [{ intentionKey: 'learn_name', eligibleAt: new Date('2026-09-13T11:00:00.000Z') }],
    })
  })

  it('preserves a null eligible_at and null prompt_source (rows written before migration 040)', async () => {
    mockClient({
      prompted: {
        data: [
          {
            intention_key: 'invite_contact_save',
            prompted_at: '2026-09-13T10:00:00.000Z',
            eligible_at: null,
            prompt_source: null,
            message_id: null,
          },
        ],
        error: null,
      },
      eligible: EMPTY,
    })

    const rows = await loadIntentionRows('v1', 'g1')

    expect(rows?.prompted).toEqual([
      {
        intentionKey: 'invite_contact_save',
        promptedAt: new Date('2026-09-13T10:00:00.000Z'),
        eligibleAt: null,
        promptSource: null,
        messageId: null,
      },
    ])
  })

  it('returns empty lists for a guest with no rows', async () => {
    mockClient({ prompted: EMPTY, eligible: EMPTY })
    await expect(loadIntentionRows('v1', 'g1')).resolves.toEqual({ prompted: [], eligible: [] })
  })

  // Fail CLOSED on every failure. A null result is what tells the derivation
  // to render nothing, which costs a missed nudge; failing open could re-ask a
  // guest something they were already asked.
  it('fails closed (null) when the prompted read errors', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    mockClient({ prompted: { data: null, error: { message: 'connection reset' } }, eligible: EMPTY })
    await expect(loadIntentionRows('v1', 'g1')).resolves.toBeNull()
    warn.mockRestore()
  })

  it('fails closed (null) when the eligibility read errors', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    mockClient({ prompted: EMPTY, eligible: { data: null, error: { message: 'connection reset' } } })
    await expect(loadIntentionRows('v1', 'g1')).resolves.toBeNull()
    warn.mockRestore()
  })

  // The SQL filter guarantees this can't happen. If a prompted-query row ever
  // arrives with a null prompted_at, the filter is gone, and the row could be
  // either kind — so refuse to guess.
  it('fails closed (null) when a prompted-query row carries a null prompted_at', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    mockClient({
      prompted: {
        data: [
          {
            intention_key: 'learn_name',
            prompted_at: null,
            eligible_at: '2026-09-13T11:00:00.000Z',
            prompt_source: null,
            message_id: null,
          },
        ],
        error: null,
      },
      eligible: EMPTY,
    })
    await expect(loadIntentionRows('v1', 'g1')).resolves.toBeNull()
    warn.mockRestore()
  })

  it('fails closed (null) when the client throws', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.mocked(createAdminClient).mockImplementation(() => {
      throw new Error('missing env')
    })
    await expect(loadIntentionRows('v1', 'g1')).resolves.toBeNull()
    warn.mockRestore()
  })
})
