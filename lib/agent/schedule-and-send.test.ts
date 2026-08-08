import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { markAsRead, sendMessage, sendTypingIndicator } from '@/lib/messaging'
import { createCommitmentFromPending } from '@/lib/guests/commitments'
import { persistOrRegenQueuedDraft, scheduleAndSend } from './schedule-and-send'
import { BUBBLE_DELIMITER } from './split-message'
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

// TAC-313: scheduleAndSend materializes commitments inline after dispatch.
vi.mock('@/lib/guests/commitments', () => ({
  createCommitmentFromPending: vi.fn(),
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
    activeCommitments: [],
    pendingQuestion: null,
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
  complaintIntent: 'none' as const,
    knowledgeGap: false,
    contextUpdate: {},
    commitment: {},
    arrivalCapture: {},
    attempts: 1,
    attemptScores: [0.78],
    attemptHistory: [],
    systemPrompt: '',
    userPrompt: '',
    promptVersion: 'v1.16.0',
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
      prompt_version: 'v1.16.0',
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

// ---------------------------------------------------------------------------
// TAC-308: pending_until threading
// ---------------------------------------------------------------------------

describe('persistOrRegenQueuedDraft — pending_until (TAC-308)', () => {
  const WHEN = new Date('2026-08-07T12:05:00Z')

  beforeEach(() => {
    scenario = freshScenario()
  })

  it('stamps the clock on INSERT when a card is being armed', async () => {
    scenario.insertResponses.push({ data: { id: 'new-draft' }, error: null })
    await persistOrRegenQueuedDraft(makeCtx(), makeGeneration(), 'knowledge_gap', null, {
      pendingUntil: WHEN,
    })
    expect(scenario.inserts[0]?.pending_until).toBe(WHEN.toISOString())
  })

  it('leaves the clock null on INSERT for an ordinary queued draft', async () => {
    scenario.insertResponses.push({ data: { id: 'new-draft' }, error: null })
    await persistOrRegenQueuedDraft(makeCtx(), makeGeneration(), 'model_flagged', null, {})
    expect(scenario.inserts[0]?.pending_until).toBeNull()
  })

  // The two behaviors that depend on the key being ABSENT rather than null:
  // a chatty guest can't push the deadline out by asking again, and the
  // timeout regen can't re-arm the clock it just fired (which would send a
  // second holding message five minutes later).
  it('omits pending_until from the UPDATE payload so an existing clock survives', async () => {
    scenario.priorReasonResponses.push({ data: { review_reason: 'knowledge_gap' }, error: null })
    scenario.updateResponses.push({ data: { id: 'existing' }, error: null })
    await persistOrRegenQueuedDraft(makeCtx(), makeGeneration(), 'knowledge_gap', 'existing', {})
    expect(scenario.updates[0]?.payload).not.toHaveProperty('pending_until')
  })

  it('writes pending_until on UPDATE only when a fresh clock is passed', async () => {
    scenario.priorReasonResponses.push({
      data: { review_reason: 'comp_regex_backstop' },
      error: null,
    })
    scenario.updateResponses.push({ data: { id: 'existing' }, error: null })
    await persistOrRegenQueuedDraft(makeCtx(), makeGeneration(), 'knowledge_gap', 'existing', {
      pendingUntil: WHEN,
    })
    expect(scenario.updates[0]?.payload.pending_until).toBe(WHEN.toISOString())
  })

  // Defaulted parameter: every pre-TAC-308 call site omits the options arg
  // entirely and must keep behaving exactly as it did.
  it('is backward compatible with call sites that pass no options', async () => {
    scenario.insertResponses.push({ data: { id: 'new-draft' }, error: null })
    await persistOrRegenQueuedDraft(makeCtx(), makeGeneration(), 'model_flagged', null)
    expect(scenario.inserts[0]?.pending_until).toBeNull()
  })
})

describe('persistOrRegenQueuedDraft — updateOnly (TAC-308)', () => {
  beforeEach(() => {
    scenario = freshScenario()
  })

  // THE REGRESSION THIS EXISTS TO PREVENT: without updateOnly, a vanished
  // target row falls through to INSERT. For the timeout regen that would
  // create a phantom pending card — answering a question the guest was
  // already answered, protected forever by review_reason='knowledge_gap',
  // invisible to the timer (pending_until null) and never pushed. It would
  // surface only when the operator next opened the queue.
  it('returns skipped instead of INSERTing when the target row is gone', async () => {
    scenario.priorReasonResponses.push({ data: null, error: null }) // row vanished
    const result = await persistOrRegenQueuedDraft(
      makeCtx(),
      makeGeneration(),
      'knowledge_gap',
      'card-1',
      { updateOnly: true },
    )
    expect(result.action).toBe('skipped')
    expect(result.outboundMessageId).toBeNull()
    expect(scenario.inserts).toHaveLength(0)
  })

  it('still UPDATEs normally when the row is present', async () => {
    scenario.priorReasonResponses.push({
      data: { review_reason: 'knowledge_gap' },
      error: null,
    })
    scenario.updateResponses.push({ data: { id: 'card-1' }, error: null })
    const result = await persistOrRegenQueuedDraft(
      makeCtx(),
      makeGeneration(),
      'knowledge_gap',
      'card-1',
      { updateOnly: true },
    )
    expect(result.action).toBe('updated')
    expect(scenario.inserts).toHaveLength(0)
  })

  // The orchestrators must keep the old recovery behavior: for them, a
  // vanished row means the pending slot is free and the draft still needs
  // somewhere to live.
  it('leaves the INSERT fallback intact for callers that do not opt in', async () => {
    scenario.priorReasonResponses.push({ data: null, error: null })
    scenario.insertResponses.push({ data: { id: 'fresh' }, error: null })
    const result = await persistOrRegenQueuedDraft(
      makeCtx(),
      makeGeneration(),
      'model_flagged',
      'gone-row',
    )
    expect(result.action).toBe('inserted')
    expect(scenario.inserts).toHaveLength(1)
  })
})

describe('persistOrRegenQueuedDraft — blankBody (TAC-309)', () => {
  beforeEach(() => {
    scenario = freshScenario()
  })

  // The whole point of TAC-309: the model's attempted answer is DISCARDED,
  // never persisted, never surfaced as a hint. The first live card read
  // "Not sure on the specific matcha we source. I can find out if that
  // matters for your order." — the exact promise phrasing TAC-308 had just
  // deleted from the corpus, sitting in a field an operator can swipe.
  it('persists an empty body on INSERT and discards the generated text', async () => {
    scenario.insertResponses.push({ data: { id: 'gap-card' }, error: null })
    await persistOrRegenQueuedDraft(makeCtx(), makeGeneration(), 'knowledge_gap', null, {
      blankBody: true,
    })
    expect(scenario.inserts[0]?.body).toBe('')
    expect(scenario.inserts[0]?.body).not.toContain('regenerated draft body')
  })

  // A blank card carrying 0.78 would be claiming a voice score for text that
  // does not exist.
  it('nulls voice_fidelity alongside the body', async () => {
    scenario.insertResponses.push({ data: { id: 'gap-card' }, error: null })
    await persistOrRegenQueuedDraft(makeCtx(), makeGeneration(), 'knowledge_gap', null, {
      blankBody: true,
    })
    expect(scenario.inserts[0]?.voice_fidelity).toBeNull()
  })

  // A second unanswerable question refreshes the card in place; it must be
  // just as blank as the first one.
  it('blanks on the UPDATE path too', async () => {
    scenario.priorReasonResponses.push({
      data: { review_reason: 'knowledge_gap' },
      error: null,
    })
    scenario.updateResponses.push({ data: { id: 'gap-card' }, error: null })
    await persistOrRegenQueuedDraft(makeCtx(), makeGeneration(), 'knowledge_gap', 'gap-card', {
      blankBody: true,
    })
    expect(scenario.updates[0]?.payload.body).toBe('')
    expect(scenario.updates[0]?.payload.voice_fidelity).toBeNull()
  })

  // Ordinary queued drafts are untouched — the operator still gets the
  // model's text to review on every other trigger.
  it('leaves a normal queued draft prefilled', async () => {
    scenario.insertResponses.push({ data: { id: 'normal' }, error: null })
    await persistOrRegenQueuedDraft(makeCtx(), makeGeneration(), 'model_flagged', null, {})
    expect(scenario.inserts[0]?.body).toBe('regenerated draft body')
    expect(scenario.inserts[0]?.voice_fidelity).toBe(0.78)
  })
})

// ---------------------------------------------------------------------------
// scheduleAndSend — message splitting (TAC-313)
// ---------------------------------------------------------------------------
//
// The auto-send path. One generation becomes up to MAX_BUBBLES_PER_RESPONSE
// Sendblue messages, each with its own `messages` row sharing a generation_id.
//
// Most tests pass skipHumanFeelDelay so no real time passes; the one test that
// exercises the inter-bubble pause says so in its name.

const okSend = (providerMessageId: string) => ({
  ok: true as const,
  data: { providerMessageId, status: 'sent' },
})

function queueSends(...ids: string[]): void {
  const send = vi.mocked(sendMessage)
  for (const id of ids) send.mockResolvedValueOnce(okSend(id))
}

function queueInserts(...ids: string[]): void {
  for (const id of ids) scenario.insertResponses.push({ data: { id }, error: null })
}

function generationWithBody(body: string): GenerateMessageResult {
  return { ...makeGeneration(), body }
}

const NO_DELAY = { skipHumanFeelDelay: true }

describe('scheduleAndSend — message splitting (TAC-313)', () => {
  beforeEach(() => {
    scenario = freshScenario()
    fireRedAlertMock.mockClear()
    vi.mocked(sendMessage).mockReset()
    vi.mocked(markAsRead).mockReset().mockResolvedValue({ ok: true } as never)
    vi.mocked(sendTypingIndicator).mockReset().mockResolvedValue({ ok: true } as never)
    vi.mocked(createCommitmentFromPending)
      .mockReset()
      .mockResolvedValue({ ok: true, data: { id: 'commitment-1' } } as never)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  // ── unchanged single-bubble behavior ──────────────────────────────────

  it('sends a delimiter-free body as ONE message and ONE row', async () => {
    queueSends('provider-1')
    queueInserts('msg-1')

    const result = await scheduleAndSend(makeCtx(), generationWithBody('Open until 4'), NO_DELAY)

    expect(vi.mocked(sendMessage)).toHaveBeenCalledTimes(1)
    expect(scenario.inserts).toHaveLength(1)
    expect(scenario.inserts[0]!.body).toBe('Open until 4')
    expect(result.outboundMessageId).toBe('msg-1')
    expect(result.providerMessageId).toBe('provider-1')
    expect(result.bubbleCount).toBe(1)
  })

  // ── the split ─────────────────────────────────────────────────────────

  it('dispatches one message per beat, in order', async () => {
    queueSends('p1', 'p2')
    queueInserts('m1', 'm2')

    await scheduleAndSend(
      makeCtx(),
      generationWithBody(`I'd go for the Frosty Gandhi${BUBBLE_DELIMITER}Espresso, chai, peppermint`),
      NO_DELAY,
    )

    const sent = vi.mocked(sendMessage).mock.calls.map((c) => (c[0] as { body: string }).body)
    expect(sent).toEqual(["I'd go for the Frosty Gandhi", 'Espresso, chai, peppermint'])
  })

  it('persists one row per bubble, each carrying its own text', async () => {
    queueSends('p1', 'p2')
    queueInserts('m1', 'm2')

    await scheduleAndSend(makeCtx(), generationWithBody(`first${BUBBLE_DELIMITER}second`), NO_DELAY)

    expect(scenario.inserts).toHaveLength(2)
    expect(scenario.inserts.map((r) => r.body)).toEqual(['first', 'second'])
  })

  it('stamps every row of a response with the SAME generation_id', async () => {
    queueSends('p1', 'p2', 'p3')
    queueInserts('m1', 'm2', 'm3')

    const result = await scheduleAndSend(
      makeCtx(),
      generationWithBody(`a${BUBBLE_DELIMITER}b${BUBBLE_DELIMITER}c`),
      NO_DELAY,
    )

    const ids = scenario.inserts.map((r) => r.generation_id)
    expect(new Set(ids).size).toBe(1)
    expect(ids[0]).toBe(result.generationId)
    expect(ids[0]).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)
  })

  it('mints a DIFFERENT generation_id per dispatch', async () => {
    queueSends('p1')
    queueInserts('m1')
    const first = await scheduleAndSend(makeCtx(), generationWithBody('one'), NO_DELAY)

    queueSends('p2')
    queueInserts('m2')
    const second = await scheduleAndSend(makeCtx(), generationWithBody('two'), NO_DELAY)

    expect(first.generationId).not.toBe(second.generationId)
  })

  it('never lets the delimiter reach Sendblue or the database', async () => {
    queueSends('p1', 'p2')
    queueInserts('m1', 'm2')

    await scheduleAndSend(
      makeCtx(),
      generationWithBody(`first${BUBBLE_DELIMITER}second`),
      NO_DELAY,
    )

    for (const call of vi.mocked(sendMessage).mock.calls) {
      expect((call[0] as { body: string }).body).not.toContain('BREAK')
    }
    for (const insert of scenario.inserts) {
      expect(String(insert.body)).not.toContain('BREAK')
    }
  })

  it('enforces the cap of three in the SENDER, not just the prompt', async () => {
    queueSends('p1', 'p2', 'p3')
    queueInserts('m1', 'm2', 'm3')

    const result = await scheduleAndSend(
      makeCtx(),
      generationWithBody(['a', 'b', 'c', 'd', 'e'].join(BUBBLE_DELIMITER)),
      NO_DELAY,
    )

    expect(vi.mocked(sendMessage)).toHaveBeenCalledTimes(3)
    expect(result.bubbleCount).toBe(3)
    // Text past the cap is merged into the last bubble, never dropped.
    const sent = vi.mocked(sendMessage).mock.calls.map((c) => (c[0] as { body: string }).body)
    expect(sent[2]).toBe('c d e')
  })

  it('returns the FIRST bubble ids so existing consumers are unaffected', async () => {
    queueSends('provider-first', 'provider-second')
    queueInserts('msg-first', 'msg-second')

    const result = await scheduleAndSend(
      makeCtx(),
      generationWithBody(`a${BUBBLE_DELIMITER}b`),
      NO_DELAY,
    )

    expect(result.outboundMessageId).toBe('msg-first')
    expect(result.providerMessageId).toBe('provider-first')
  })

  // ── timing ────────────────────────────────────────────────────────────

  it('shows a typing indicator before each later bubble (real inter-bubble pause)', async () => {
    queueSends('p1', 'p2')
    queueInserts('m1', 'm2')

    await scheduleAndSend(makeCtx(), generationWithBody(`a${BUBBLE_DELIMITER}b`))

    // Once in the opening sequence, once before the second bubble.
    expect(vi.mocked(sendTypingIndicator)).toHaveBeenCalledTimes(2)
    // markAsRead fires once for the response, not once per bubble.
    expect(vi.mocked(markAsRead)).toHaveBeenCalledTimes(1)
  })

  it('skips the inter-bubble pause entirely when skipHumanFeelDelay is set', async () => {
    queueSends('p1', 'p2')
    queueInserts('m1', 'm2')

    await scheduleAndSend(makeCtx(), generationWithBody(`a${BUBBLE_DELIMITER}b`), NO_DELAY)

    expect(vi.mocked(sendTypingIndicator)).not.toHaveBeenCalled()
    expect(vi.mocked(markAsRead)).not.toHaveBeenCalled()
  })

  // ── failure asymmetry: "have we committed anything to the guest yet" ──

  it('THROWS when the first bubble fails to send, persisting nothing', async () => {
    vi.mocked(sendMessage).mockResolvedValueOnce({
      ok: false,
      error: 'sendblue down',
      errorCode: 'provider_error',
    } as never)

    await expect(
      scheduleAndSend(makeCtx(), generationWithBody(`a${BUBBLE_DELIMITER}b`), NO_DELAY),
    ).rejects.toThrow(/sendMessage failed/)

    expect(scenario.inserts).toHaveLength(0)
    expect(fireRedAlertMock).toHaveBeenCalledTimes(1)
  })

  it('does NOT throw when a LATER bubble fails — it truncates', async () => {
    // Throwing here maps to AgentResult.failed, which for the follow-up engine
    // releases the claim and re-dispatches — sending the guest bubble 1 twice.
    // A truncated reply beats a duplicated one.
    queueSends('p1')
    vi.mocked(sendMessage).mockResolvedValueOnce({
      ok: false,
      error: 'sendblue down',
      errorCode: 'provider_error',
    } as never)
    queueInserts('m1')

    const result = await scheduleAndSend(
      makeCtx(),
      generationWithBody(`first${BUBBLE_DELIMITER}second`),
      NO_DELAY,
    )

    expect(result.outboundMessageId).toBe('m1')
    expect(result.bubbleCount).toBe(1)
    expect(scenario.inserts).toHaveLength(1)
  })

  it('alerts on a truncated response so it is never silent', async () => {
    queueSends('p1')
    vi.mocked(sendMessage).mockResolvedValueOnce({
      ok: false,
      error: 'sendblue down',
      errorCode: 'provider_error',
    } as never)
    queueInserts('m1')

    await scheduleAndSend(makeCtx(), generationWithBody(`a${BUBBLE_DELIMITER}b`), NO_DELAY)

    expect(fireRedAlertMock).toHaveBeenCalledTimes(1)
    const alert = fireRedAlertMock.mock.calls[0]![0] as {
      stage: string
      extra: { bubbleIndex: number; deliveredBubbles: number }
    }
    expect(alert.stage).toBe('send')
    expect(alert.extra.bubbleIndex).toBe(1)
    expect(alert.extra.deliveredBubbles).toBe(1)
  })

  it('THROWS when the first bubble persists badly (no id to return)', async () => {
    queueSends('p1')
    scenario.insertResponses.push({ data: null, error: { message: 'db down' } })

    await expect(
      scheduleAndSend(makeCtx(), generationWithBody('single'), NO_DELAY),
    ).rejects.toThrow(/persist failed/)
  })

  it('truncates rather than throwing when a LATER bubble persists badly', async () => {
    queueSends('p1', 'p2')
    queueInserts('m1')
    scenario.insertResponses.push({ data: null, error: { message: 'db down' } })

    const result = await scheduleAndSend(
      makeCtx(),
      generationWithBody(`a${BUBBLE_DELIMITER}b`),
      NO_DELAY,
    )

    expect(result.bubbleCount).toBe(1)
    expect(fireRedAlertMock).toHaveBeenCalledTimes(1)
  })

  it('throws without sending when the body yields no bubbles', async () => {
    await expect(
      scheduleAndSend(makeCtx(), generationWithBody(BUBBLE_DELIMITER), NO_DELAY),
    ).rejects.toThrow(/no sendable bubbles/)

    expect(vi.mocked(sendMessage)).not.toHaveBeenCalled()
    expect(scenario.inserts).toHaveLength(0)
  })

  // ── commitments ───────────────────────────────────────────────────────

  it('materializes a commitment ONCE, anchored to the first bubble', async () => {
    queueSends('p1', 'p2')
    queueInserts('m1', 'm2')

    const generation: GenerateMessageResult = {
      ...generationWithBody(`holding it for you${BUBBLE_DELIMITER}see you at 8`),
      commitment: { type: 'hold', description: 'holding a loaf' },
    }

    await scheduleAndSend(makeCtx(), generation, NO_DELAY)

    expect(vi.mocked(createCommitmentFromPending)).toHaveBeenCalledTimes(1)
    const arg = vi.mocked(createCommitmentFromPending).mock.calls[0]![0] as {
      sourceMessageId: string
    }
    expect(arg.sourceMessageId).toBe('m1')
  })
})

// ---------------------------------------------------------------------------
// persistOrRegenQueuedDraft — delimiter strip (TAC-313)
// ---------------------------------------------------------------------------
//
// The queue path is one row an operator reads and approves verbatim, and
// approve dispatches messages.body unchanged. A delimiter surviving into the
// row would reach a guest over text the operator was never shown.

describe('persistOrRegenQueuedDraft — delimiter strip (TAC-313)', () => {
  beforeEach(() => {
    scenario = freshScenario()
    fireRedAlertMock.mockClear()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('collapses the delimiter to a space on INSERT', async () => {
    scenario.insertResponses.push({ data: { id: 'msg-1' }, error: null })

    await persistOrRegenQueuedDraft(
      makeCtx(),
      generationWithBody(`I'd go for the Frosty Gandhi${BUBBLE_DELIMITER}Espresso, chai, peppermint`),
      'model_flagged',
      null,
    )

    expect(scenario.inserts[0]!.body).toBe(
      "I'd go for the Frosty Gandhi Espresso, chai, peppermint",
    )
  })

  it('collapses the delimiter on the regen UPDATE path too', async () => {
    scenario.priorReasonResponses.push({ data: { review_reason: 'model_flagged' }, error: null })
    scenario.updateResponses.push({ data: { id: 'existing-1' }, error: null })

    await persistOrRegenQueuedDraft(
      makeCtx(),
      generationWithBody(`first${BUBBLE_DELIMITER}second`),
      'model_flagged',
      'existing-1',
    )

    expect(scenario.updates[0]!.payload.body).toBe('first second')
  })

  it('leaves no bracketed BREAK in a persisted draft for any near-miss variant', async () => {
    for (const variant of ['[[BREAK]]', '[BREAK]', '[[break]]', '[[ BREAK ]]']) {
      scenario = freshScenario()
      scenario.insertResponses.push({ data: { id: 'msg-1' }, error: null })

      await persistOrRegenQueuedDraft(
        makeCtx(),
        generationWithBody(`a${variant}b`),
        'model_flagged',
        null,
      )

      expect(scenario.inserts[0]!.body).toBe('a b')
    }
  })

  it('still blanks the body when blankBody wins over the strip', async () => {
    scenario.insertResponses.push({ data: { id: 'msg-1' }, error: null })

    await persistOrRegenQueuedDraft(
      makeCtx(),
      generationWithBody(`a${BUBBLE_DELIMITER}b`),
      'knowledge_gap',
      null,
      { blankBody: true },
    )

    expect(scenario.inserts[0]!.body).toBe('')
  })
})
