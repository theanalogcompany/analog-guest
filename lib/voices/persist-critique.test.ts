/* eslint-disable @typescript-eslint/no-unused-vars */

import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/db/admin', () => ({
  createAdminClient: vi.fn(),
}))
vi.mock('@/lib/rag', () => ({
  embedText: vi.fn(),
}))

import { createAdminClient } from '@/lib/db/admin'
import { embedText } from '@/lib/rag'
import { persistCritique } from './persist-critique'

const VENUE_ID = '11111111-1111-4111-8111-111111111111'
const MESSAGE_ID = '22222222-2222-4222-8222-222222222222'
const OPERATOR_ID = '33333333-3333-4333-8333-333333333333'
const NEW_ID = '44444444-4444-4444-8444-444444444444'

interface MockState {
  insertCalls: Array<Record<string, unknown>>
  insertedRow: { id: string } | null
  insertError: { message: string } | null
}

function newState(overrides: Partial<MockState> = {}): MockState {
  return {
    insertCalls: [],
    insertedRow: { id: NEW_ID },
    insertError: null,
    ...overrides,
  }
}

function makeAdminMock(state: MockState) {
  return {
    from: (_table: string) => ({
      insert: (row: Record<string, unknown>) => ({
        select: (_cols: string) => ({
          single: async () => {
            state.insertCalls.push(row)
            if (state.insertError) {
              return { data: null, error: state.insertError }
            }
            return { data: state.insertedRow, error: null }
          },
        }),
      }),
    }),
  }
}

beforeEach(() => {
  vi.mocked(createAdminClient).mockReset()
  vi.mocked(embedText).mockReset()
})

describe('persistCritique — happy path', () => {
  it('embeds + inserts row, returns id and embedding', async () => {
    const state = newState()
    vi.mocked(createAdminClient).mockReturnValue(
      makeAdminMock(state) as unknown as ReturnType<typeof createAdminClient>,
    )
    vi.mocked(embedText).mockResolvedValue({
      ok: true,
      data: { embedding: [0.1, 0.2, 0.3], model: 'voyage-3-large' },
    })

    const result = await persistCritique({
      venueId: VENUE_ID,
      messageId: MESSAGE_ID,
      critiqueText: 'too eager',
      kind: 'edit_only',
      createdByOperatorId: OPERATOR_ID,
    })

    expect(result).toEqual({
      ok: true,
      critiqueId: NEW_ID,
      embedding: [0.1, 0.2, 0.3],
    })
    expect(state.insertCalls).toHaveLength(1)
    expect(state.insertCalls[0]).toMatchObject({
      venue_id: VENUE_ID,
      message_id: MESSAGE_ID,
      critique_text: 'too eager',
      kind: 'edit_only',
      created_by_operator_id: OPERATOR_ID,
    })
    // Embedding serialized as pgvector literal
    expect(state.insertCalls[0].embedding).toBe('[0.1,0.2,0.3]')
    expect(embedText).toHaveBeenCalledWith('too eager', 'document')
  })

  it('omits created_by_operator_id when not provided', async () => {
    const state = newState()
    vi.mocked(createAdminClient).mockReturnValue(
      makeAdminMock(state) as unknown as ReturnType<typeof createAdminClient>,
    )
    vi.mocked(embedText).mockResolvedValue({
      ok: true,
      data: { embedding: [0.1], model: 'voyage-3-large' },
    })

    await persistCritique({
      venueId: VENUE_ID,
      messageId: MESSAGE_ID,
      critiqueText: 'x',
      kind: 'edit_and_rule',
    })

    expect(state.insertCalls[0]).not.toHaveProperty('created_by_operator_id')
  })
})

describe('persistCritique — error paths', () => {
  it('returns embed_failed and never inserts on Voyage error', async () => {
    const state = newState()
    vi.mocked(createAdminClient).mockReturnValue(
      makeAdminMock(state) as unknown as ReturnType<typeof createAdminClient>,
    )
    vi.mocked(embedText).mockResolvedValue({
      ok: false,
      error: 'voyage 502',
      errorCode: 'voyage_api_error',
    })

    const result = await persistCritique({
      venueId: VENUE_ID,
      messageId: MESSAGE_ID,
      critiqueText: 'x',
      kind: 'edit_only',
    })

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.errorCode).toBe('embed_failed')
      expect(result.error).toContain('voyage 502')
    }
    expect(state.insertCalls).toEqual([])
  })

  it('returns db_error on insert failure', async () => {
    const state = newState({ insertError: { message: 'unique violation' } })
    vi.mocked(createAdminClient).mockReturnValue(
      makeAdminMock(state) as unknown as ReturnType<typeof createAdminClient>,
    )
    vi.mocked(embedText).mockResolvedValue({
      ok: true,
      data: { embedding: [0.1], model: 'voyage-3-large' },
    })

    const result = await persistCritique({
      venueId: VENUE_ID,
      messageId: MESSAGE_ID,
      critiqueText: 'x',
      kind: 'edit_only',
    })

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.errorCode).toBe('db_error')
  })

  it('rejects empty critique text without calling embed', async () => {
    const result = await persistCritique({
      venueId: VENUE_ID,
      messageId: MESSAGE_ID,
      critiqueText: '   ',
      kind: 'edit_only',
    })

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.errorCode).toBe('invalid_input')
    expect(embedText).not.toHaveBeenCalled()
  })
})
