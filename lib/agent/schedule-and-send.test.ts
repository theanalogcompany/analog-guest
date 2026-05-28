import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { persistOrRegenQueuedDraft } from './schedule-and-send'
import type { RuntimeContext } from './types'
import type { GenerateMessageResult } from '@/lib/ai'

// ---------------------------------------------------------------------------
// persistOrRegenQueuedDraft (TAC-264)
// ---------------------------------------------------------------------------
//
// Coverage matrix per the TAC-264 plan:
//   1. No prior pending, INSERT succeeds            → action='inserted'
//   2. Prior pending, UPDATE succeeds (regenerate)  → action='updated'
//   3. No prior pending, INSERT raises 23505        → race-recovery to UPDATE
//   4. Prior pending, UPDATE rowcount=0 (operator
//      already acted)                               → fallback INSERT
//
// Plus failure paths: non-23505 INSERT error → red alert + throw; sustained
// race exhausts RACE_RECOVERY_MAX_ATTEMPTS → alert + throw.

// Mock createAdminClient with a per-test programmable scenario. We don't try
// to mirror Supabase's full PostgrestBuilder semantics — just the chain
// shape persistOrRegenQueuedDraft actually walks:
//   - .from('messages').insert(payload).select('id').single() → {data, error}
//   - .from('messages').select('review_reason').eq('id', _).eq('review_state', _).maybeSingle()
//   - .from('messages').update(payload).eq('id', _).eq('review_state', _).select('id').maybeSingle()
//   - .from('messages').select('id').eq().eq().eq().eq().limit(1).maybeSingle()
//
// The mock dispatches by inspecting the first call after .from('messages')
// to disambiguate INSERT vs SELECT (review_reason) vs UPDATE vs SELECT (id).

interface ScenarioRecorder {
  inserts: Array<Record<string, unknown>>
  updates: Array<{ payload: Record<string, unknown>; id: string; reviewState: string }>
  // Stack-of-responses each builder pops from.
  insertResponses: Array<{ data: { id: string } | null; error: { code?: string; message: string } | null }>
  updateResponses: Array<{ data: { id: string } | null; error: { message: string } | null }>
  priorReasonResponses: Array<{ data: { review_reason: string | null } | null; error: { message: string } | null }>
  findPendingResponses: Array<{ data: { id: string } | null; error: { message: string } | null }>
}

let scenario: ScenarioRecorder

function freshScenario(): ScenarioRecorder {
  return {
    inserts: [],
    updates: [],
    insertResponses: [],
    updateResponses: [],
    priorReasonResponses: [],
    findPendingResponses: [],
  }
}

vi.mock('@/lib/db/admin', () => ({
  createAdminClient: () => ({
    from: () => ({
      insert: (payload: Record<string, unknown>) => {
        scenario.inserts.push(payload)
        const resp = scenario.insertResponses.shift() ?? { data: null, error: { message: 'no insert response queued' } }
        return {
          select: () => ({
            single: () => Promise.resolve(resp),
          }),
        }
      },
      select: (cols: string) => {
        // Three select shapes are exercised:
        //   - .select('review_reason').eq('id', _).eq('review_state', _).maybeSingle()
        //     → prior-reason capture before UPDATE
        //   - .select('id').eq('id', _).eq('review_state', _).select('id').maybeSingle()
        //     (chained AFTER an update() — handled in update() below)
        //   - .select('id').eq().eq().eq().eq().limit(1).maybeSingle()
        //     → findOpenPendingRow after 23505
        if (cols === 'review_reason') {
          return makePriorReasonBuilder()
        }
        return makeFindPendingBuilder()
      },
      update: (payload: Record<string, unknown>) => ({
        eq: (_col1: string, val1: unknown) => ({
          eq: (_col2: string, val2: unknown) => {
            // col1='id', col2='review_state'
            return {
              select: () => ({
                maybeSingle: () => {
                  scenario.updates.push({
                    payload,
                    id: String(val1),
                    reviewState: String(val2),
                  })
                  const resp = scenario.updateResponses.shift() ?? {
                    data: null,
                    error: { message: 'no update response queued' },
                  }
                  return Promise.resolve(resp)
                },
              }),
            }
          },
        }),
      }),
    }),
  }),
}))

function makePriorReasonBuilder() {
  return {
    eq: () => ({
      eq: () => ({
        maybeSingle: () => {
          const resp = scenario.priorReasonResponses.shift() ?? {
            data: null,
            error: null,
          }
          return Promise.resolve(resp)
        },
      }),
    }),
  }
}

function makeFindPendingBuilder() {
  // Four .eq() calls then .limit(1).maybeSingle()
  return {
    eq: () => ({
      eq: () => ({
        eq: () => ({
          eq: () => ({
            limit: () => ({
              maybeSingle: () => {
                const resp = scenario.findPendingResponses.shift() ?? {
                  data: null,
                  error: null,
                }
                return Promise.resolve(resp)
              },
            }),
          }),
        }),
      }),
    }),
  }
}

// Red-alert is fire-and-forget. The persist layer awaits it; the test
// just needs the call to resolve without disrupting the flow.
const fireRedAlertMock = vi.fn().mockResolvedValue(undefined)
vi.mock('./alerts', () => ({
  fireRedAlert: (...args: unknown[]) => fireRedAlertMock(...args),
}))

// Schedule sample + messaging are referenced at module load by
// schedule-and-send.ts; stub them so the import doesn't pull in the real
// SDK init paths.
vi.mock('./timing', () => ({
  sampleTiming: () => ({
    totalDelayMs: 0,
    markAsReadGapMs: 0,
    preTypingPauseMs: 0,
    typingDurationMs: 0,
  }),
}))

vi.mock('@/lib/messaging', () => ({
  markAsRead: vi.fn(),
  sendMessage: vi.fn(),
  sendTypingIndicator: vi.fn(),
}))

function makeCtx(overrides: Partial<RuntimeContext> = {}): RuntimeContext {
  return {
    agentRunId: 'run-1',
    venue: { id: 'venue-1' } as RuntimeContext['venue'],
    guest: { id: 'guest-1', firstName: 'Sam' } as RuntimeContext['guest'],
    currentMessage: { id: 'inbound-1', body: 'hi', providerMessageId: 'p1' } as RuntimeContext['currentMessage'],
    followupTrigger: null,
    recentMessages: [],
    recognition: {} as RuntimeContext['recognition'],
    mechanics: [],
    recentVisits: [],
    corpus: null,
    knowledgeCorpus: null,
    classification: { category: 'reply' } as RuntimeContext['classification'],
    trace: { id: '' } as RuntimeContext['trace'],
    ...overrides,
  }
}

function makeGeneration(): GenerateMessageResult {
  return {
    body: 'regenerated draft body',
    voiceFidelity: 0.78,
    reasoning: 'matches venue voice',
    requiresOperatorApproval: false,
    approvalReason: '',
    contextUpdate: {},
    attempts: 1,
    attemptScores: [0.78],
    attemptHistory: [],
    systemPrompt: '',
    userPrompt: '',
    promptVersion: 'v1.15.0',
    dashViolationPersisted: false,
  }
}

describe('persistOrRegenQueuedDraft (TAC-264)', () => {
  beforeEach(() => {
    scenario = freshScenario()
    fireRedAlertMock.mockClear()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  // ---- Path 1: no prior pending, INSERT succeeds ----
  it('inserts a fresh pending row when no prior draft exists', async () => {
    scenario.insertResponses.push({ data: { id: 'new-msg-1' }, error: null })

    const result = await persistOrRegenQueuedDraft(
      makeCtx(),
      makeGeneration(),
      'fidelity_below_auto_send_floor',
      null,
    )

    expect(result).toEqual({
      outboundMessageId: 'new-msg-1',
      action: 'inserted',
      priorReviewReason: null,
    })
    expect(scenario.inserts).toHaveLength(1)
    expect(scenario.updates).toHaveLength(0)
    // Insert payload carries the queue-path overrides.
    expect(scenario.inserts[0]).toMatchObject({
      status: 'pending_review',
      review_state: 'pending',
      review_reason: 'fidelity_below_auto_send_floor',
      body: 'regenerated draft body',
    })
    expect(fireRedAlertMock).not.toHaveBeenCalled()
  })

  // ---- Path 2: prior pending → UPDATE succeeds ----
  it('regenerates an existing pending row in place when existingPendingDraftId is provided', async () => {
    scenario.priorReasonResponses.push({
      data: { review_reason: 'model_flagged' },
      error: null,
    })
    scenario.updateResponses.push({ data: { id: 'existing-msg-1' }, error: null })

    const result = await persistOrRegenQueuedDraft(
      makeCtx(),
      makeGeneration(),
      'comp_regex_backstop',
      'existing-msg-1',
    )

    expect(result).toEqual({
      outboundMessageId: 'existing-msg-1',
      action: 'updated',
      priorReviewReason: 'model_flagged',
    })
    expect(scenario.inserts).toHaveLength(0)
    expect(scenario.updates).toHaveLength(1)
    // The UPDATE payload includes only the regen-mutable column subset.
    // Critically: it does NOT include status / review_state / created_at /
    // last_operator_action_at — those must be preserved across regen.
    const updPayload = scenario.updates[0].payload
    expect(updPayload).toMatchObject({
      body: 'regenerated draft body',
      voice_fidelity: 0.78,
      prompt_version: 'v1.15.0',
      category: 'reply',
      reply_to_message_id: 'inbound-1',
      review_reason: 'comp_regex_backstop',
    })
    expect(updPayload).not.toHaveProperty('status')
    expect(updPayload).not.toHaveProperty('review_state')
    expect(updPayload).not.toHaveProperty('created_at')
    expect(updPayload).not.toHaveProperty('last_operator_action_at')
    expect(updPayload).not.toHaveProperty('last_operator_id')
    expect(updPayload).not.toHaveProperty('previous_review_state')
    // Conditional UPDATE is gated on review_state='pending'.
    expect(scenario.updates[0].reviewState).toBe('pending')
    expect(fireRedAlertMock).not.toHaveBeenCalled()
  })

  // ---- Path 3: no prior pending detected, INSERT races → 23505 → recover ----
  it('falls back to UPDATE on race-recovery when INSERT hits unique_violation', async () => {
    // First INSERT loses the race: 23505.
    scenario.insertResponses.push({
      data: null,
      error: { code: '23505', message: 'duplicate key' },
    })
    // findOpenPendingRow surfaces the racing row.
    scenario.findPendingResponses.push({ data: { id: 'racing-msg-1' }, error: null })
    // Prior-reason capture for the regen UPDATE on the racing row.
    scenario.priorReasonResponses.push({
      data: { review_reason: 'model_flagged' },
      error: null,
    })
    // UPDATE succeeds.
    scenario.updateResponses.push({ data: { id: 'racing-msg-1' }, error: null })

    const result = await persistOrRegenQueuedDraft(
      makeCtx(),
      makeGeneration(),
      'fidelity_below_auto_send_floor',
      null, // We didn't know about the racing row.
    )

    expect(result).toEqual({
      outboundMessageId: 'racing-msg-1',
      action: 'updated',
      priorReviewReason: 'model_flagged',
    })
    expect(scenario.inserts).toHaveLength(1)
    expect(scenario.updates).toHaveLength(1)
    expect(fireRedAlertMock).not.toHaveBeenCalled()
  })

  // ---- Path 4: prior pending, UPDATE rowcount=0 (TOCTOU vs. dispatch) → INSERT ----
  it('falls through to INSERT when conditional UPDATE rowcount=0 (operator dispatched in the gap)', async () => {
    // Prior-reason capture comes back empty — row is no longer pending.
    scenario.priorReasonResponses.push({ data: null, error: null })
    // Loop ticks again with existingId cleared → INSERT.
    scenario.insertResponses.push({ data: { id: 'fresh-msg-after-toctou' }, error: null })

    const result = await persistOrRegenQueuedDraft(
      makeCtx(),
      makeGeneration(),
      'model_flagged',
      'pending-msg-that-got-dispatched',
    )

    expect(result).toEqual({
      outboundMessageId: 'fresh-msg-after-toctou',
      action: 'inserted',
      priorReviewReason: null,
    })
    expect(scenario.inserts).toHaveLength(1)
    // The UPDATE call was attempted at the prior-reason capture step only —
    // no actual update() was issued because we bailed at the SELECT.
    expect(scenario.updates).toHaveLength(0)
    expect(fireRedAlertMock).not.toHaveBeenCalled()
  })

  // ---- Failure path: non-23505 INSERT error → red alert + throw ----
  it('fires red alert and throws on non-23505 INSERT error', async () => {
    scenario.insertResponses.push({
      data: null,
      error: { code: '42P01', message: 'relation does not exist' },
    })

    await expect(
      persistOrRegenQueuedDraft(makeCtx(), makeGeneration(), 'model_flagged', null),
    ).rejects.toThrow(/relation does not exist/)
    expect(fireRedAlertMock).toHaveBeenCalledTimes(1)
    const alertArg = fireRedAlertMock.mock.calls[0][0] as { stage: string; extra?: { regen?: boolean } }
    expect(alertArg.stage).toBe('persist')
    expect(alertArg.extra?.regen).toBe(false)
  })

  // ---- Failure path: regen UPDATE non-rowcount-zero error → alert + throw ----
  it('fires red alert and throws when the regen UPDATE itself errors', async () => {
    scenario.priorReasonResponses.push({
      data: { review_reason: 'model_flagged' },
      error: null,
    })
    scenario.updateResponses.push({
      data: null,
      error: { message: 'connection reset' },
    })

    await expect(
      persistOrRegenQueuedDraft(
        makeCtx(),
        makeGeneration(),
        'comp_regex_backstop',
        'existing-msg-1',
      ),
    ).rejects.toThrow(/connection reset/)
    expect(fireRedAlertMock).toHaveBeenCalledTimes(1)
    const alertArg = fireRedAlertMock.mock.calls[0][0] as { stage: string; extra?: { regen?: boolean } }
    expect(alertArg.stage).toBe('persist')
    expect(alertArg.extra?.regen).toBe(true)
  })

  // ---- Composite path: 23505 → found racing row → UPDATE rowcount_zero → fresh INSERT ----
  // Exercises the double-fault recovery composition: a concurrent inbound
  // wins the unique-index race (we get 23505), we find their pending row,
  // but by the time our UPDATE fires, the operator has already dispatched it
  // (rowcount_zero) — so we fall back to a fresh INSERT in the now-empty
  // slot. Implicit in the path-3 and path-4 tests but the composite isn't
  // asserted there.
  it('recovers from 23505 → racing row found → UPDATE rowcount_zero → fresh INSERT', async () => {
    // Attempt 1: INSERT races and loses.
    scenario.insertResponses.push({
      data: null,
      error: { code: '23505', message: 'duplicate key' },
    })
    // findOpenPendingRow surfaces the racing row.
    scenario.findPendingResponses.push({ data: { id: 'racing-msg-1' }, error: null })
    // Attempt 2: prior-reason SELECT returns null (racing row was acted on
    // between our INSERT-race and our UPDATE — TOCTOU vs. dispatch).
    scenario.priorReasonResponses.push({ data: null, error: null })
    // Attempt 3: pending slot is now empty (the racing row got dispatched),
    // fresh INSERT succeeds.
    scenario.insertResponses.push({ data: { id: 'fresh-after-double-fault' }, error: null })

    const result = await persistOrRegenQueuedDraft(
      makeCtx(),
      makeGeneration(),
      'fidelity_below_auto_send_floor',
      null,
    )

    expect(result).toEqual({
      outboundMessageId: 'fresh-after-double-fault',
      action: 'inserted',
      priorReviewReason: null,
    })
    expect(scenario.inserts).toHaveLength(2)
    expect(scenario.updates).toHaveLength(0) // bailed at prior-reason SELECT
    expect(fireRedAlertMock).not.toHaveBeenCalled()
  })

  // ---- Failure path: sustained ping-pong exceeds race-recovery cap ----
  it('alerts and throws when race-recovery exceeds the bounded retry limit', async () => {
    // Every INSERT hits 23505; every findOpenPendingRow returns null
    // (operator immediately dispatches). The loop ticks 3x then bails.
    for (let i = 0; i < 3; i++) {
      scenario.insertResponses.push({
        data: null,
        error: { code: '23505', message: 'duplicate key' },
      })
      scenario.findPendingResponses.push({ data: null, error: null })
    }

    await expect(
      persistOrRegenQueuedDraft(makeCtx(), makeGeneration(), 'model_flagged', null),
    ).rejects.toThrow(/race-recovery/)
    expect(fireRedAlertMock).toHaveBeenCalledTimes(1)
  })
})
