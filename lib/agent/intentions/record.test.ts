import { afterEach, describe, expect, it, vi } from 'vitest'
import type { OpenIntention } from './derive'

const classifyIntentionPromptsMock = vi.fn()
vi.mock('@/lib/ai', () => ({
  classifyIntentionPrompts: (...a: unknown[]) => classifyIntentionPromptsMock(...a),
}))

interface SupabaseMockState {
  upsertError: { message: string } | null
  upsertPayload: Record<string, unknown>[] | null
  upsertOptions: Record<string, unknown> | null
}

function newSupabaseState(overrides: Partial<SupabaseMockState> = {}): SupabaseMockState {
  return {
    upsertError: null,
    upsertPayload: null,
    upsertOptions: null,
    ...overrides,
  }
}

function makeSupabaseMock(state: SupabaseMockState) {
  return {
    from: (table: string) => {
      if (table === 'guest_intention_prompts') {
        return {
          upsert: (payload: Record<string, unknown>[], options: Record<string, unknown>) => {
            state.upsertPayload = payload
            state.upsertOptions = options
            return Promise.resolve({ error: state.upsertError })
          },
        }
      }
      throw new Error(`unexpected table in test mock: ${table}`)
    },
  }
}

let currentState = newSupabaseState()
vi.mock('@/lib/db/admin', () => ({
  createAdminClient: () => makeSupabaseMock(currentState),
}))

// Import after mocks so the module under test picks them up.
import { recordIntentionPrompts } from './record'

const bothOpen: OpenIntention[] = [
  { key: 'learn_first_order', promptLine: "You haven't heard what this guest ordered yet." },
  { key: 'invite_contact_save', promptLine: "You haven't told them to save your number." },
]

afterEach(() => {
  classifyIntentionPromptsMock.mockReset()
  currentState = newSupabaseState()
})

describe('recordIntentionPrompts', () => {
  it('short-circuits with no_open_intentions and never calls the classifier when openIntentions is empty', async () => {
    const result = await recordIntentionPrompts({
      venueId: 'v1',
      guestId: 'g1',
      messageId: 'm1',
      sentBody: 'hello',
      openIntentions: [],
    })
    expect(result).toEqual({ kind: 'no_open_intentions' })
    expect(classifyIntentionPromptsMock).not.toHaveBeenCalled()
  })

  it('writes one row per raised key, on conflict do nothing', async () => {
    classifyIntentionPromptsMock.mockResolvedValue({
      ok: true,
      data: { raisedKeys: ['learn_first_order'], promptVersion: 'v1.0.0' },
    })

    const result = await recordIntentionPrompts({
      venueId: 'v1',
      guestId: 'g1',
      messageId: 'm1',
      sentBody: "what'd you end up getting?",
      openIntentions: bothOpen,
    })

    expect(result).toEqual({ kind: 'recorded', raisedKeys: ['learn_first_order'] })
    expect(currentState.upsertPayload).toEqual([
      { venue_id: 'v1', guest_id: 'g1', intention_key: 'learn_first_order', message_id: 'm1' },
    ])
    expect(currentState.upsertOptions).toEqual({
      onConflict: 'guest_id,intention_key',
      ignoreDuplicates: true,
    })
  })

  // Code-review fix: the classifier description now comes from
  // INTENTION_DEFINITIONS (single source of truth), not a second lib/ai-side
  // lookup — lock that recordIntentionPrompts actually threads a real
  // description through, not just a bare key.
  it('passes key+description pairs (sourced from INTENTION_DEFINITIONS) to the classifier, not bare keys', async () => {
    classifyIntentionPromptsMock.mockResolvedValue({
      ok: true,
      data: { raisedKeys: [], promptVersion: 'v1.0.0' },
    })

    await recordIntentionPrompts({
      venueId: 'v1',
      guestId: 'g1',
      messageId: 'm1',
      sentBody: 'text',
      openIntentions: bothOpen,
    })

    const callArgs = classifyIntentionPromptsMock.mock.calls[0]?.[0] as
      | { openIntentions?: { key: string; description: string }[] }
      | undefined
    expect(callArgs?.openIntentions).toHaveLength(2)
    for (const o of callArgs?.openIntentions ?? []) {
      expect(typeof o.description).toBe('string')
      expect(o.description.length).toBeGreaterThan(0)
    }
  })

  it('writes multiple rows when multiple intentions are raised in one send', async () => {
    classifyIntentionPromptsMock.mockResolvedValue({
      ok: true,
      data: { raisedKeys: ['learn_first_order', 'invite_contact_save'], promptVersion: 'v1.0.0' },
    })

    const result = await recordIntentionPrompts({
      venueId: 'v1',
      guestId: 'g1',
      messageId: 'm1',
      sentBody: 'what did you get, and save this number for next time',
      openIntentions: bothOpen,
    })

    expect(result.kind).toBe('recorded')
    expect(currentState.upsertPayload).toHaveLength(2)
  })

  it('returns nothing_raised and writes no row when the classifier raises nothing', async () => {
    classifyIntentionPromptsMock.mockResolvedValue({
      ok: true,
      data: { raisedKeys: [], promptVersion: 'v1.0.0' },
    })

    const result = await recordIntentionPrompts({
      venueId: 'v1',
      guestId: 'g1',
      messageId: 'm1',
      sentBody: 'we close at 8 tonight',
      openIntentions: bothOpen,
    })

    expect(result).toEqual({ kind: 'nothing_raised' })
    expect(currentState.upsertPayload).toBeNull()
  })

  // Structural constraint at the AI layer already makes this near-impossible
  // (the per-call z.enum), but the orchestrator filters defensively too —
  // a key outside the caller's own open set must never reach the DB write.
  it('filters out a classifier-returned key that was not in the open set', async () => {
    classifyIntentionPromptsMock.mockResolvedValue({
      ok: true,
      data: { raisedKeys: ['learn_first_order', 'some_future_key'], promptVersion: 'v1.0.0' },
    })

    const result = await recordIntentionPrompts({
      venueId: 'v1',
      guestId: 'g1',
      messageId: 'm1',
      sentBody: 'text',
      openIntentions: [bothOpen[0]],
    })

    expect(result).toEqual({ kind: 'recorded', raisedKeys: ['learn_first_order'] })
  })

  it('returns failed and never throws when the classifier call fails', async () => {
    classifyIntentionPromptsMock.mockResolvedValue({ ok: false, error: 'anthropic timeout' })

    const result = await recordIntentionPrompts({
      venueId: 'v1',
      guestId: 'g1',
      messageId: 'm1',
      sentBody: 'text',
      openIntentions: bothOpen,
    })

    expect(result).toEqual({ kind: 'failed', error: 'anthropic timeout' })
  })

  it('returns failed and never throws when the DB write fails', async () => {
    currentState = newSupabaseState({ upsertError: { message: 'db down' } })
    classifyIntentionPromptsMock.mockResolvedValue({
      ok: true,
      data: { raisedKeys: ['learn_first_order'], promptVersion: 'v1.0.0' },
    })

    const result = await recordIntentionPrompts({
      venueId: 'v1',
      guestId: 'g1',
      messageId: 'm1',
      sentBody: 'text',
      openIntentions: bothOpen,
    })

    expect(result).toEqual({ kind: 'failed', error: 'db down' })
  })

  it('returns failed and never throws when the classifier call rejects unexpectedly', async () => {
    classifyIntentionPromptsMock.mockRejectedValue(new Error('unexpected'))

    const result = await recordIntentionPrompts({
      venueId: 'v1',
      guestId: 'g1',
      messageId: 'm1',
      sentBody: 'text',
      openIntentions: bothOpen,
    })

    expect(result).toEqual({ kind: 'failed', error: 'unexpected' })
  })
})
