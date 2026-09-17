import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { markAsRead, sendMessage, sendTypingIndicator } from '@/lib/messaging'
import { createCommitmentFromPending } from '@/lib/guests/commitments'
import { persistOrRegenQueuedDraft, scheduleAndSend } from './schedule-and-send'
import { BUBBLE_DELIMITER, INTER_BUBBLE_GAP_MS } from './split-message'
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
//   - .from('messages').select(PENDING_SLOT_ROW_COLUMNS).eq() x4 .order().limit() (TAC-394)
//
// The mock dispatches by inspecting the first call after .from('messages')
// to disambiguate INSERT vs SELECT (review_reason) vs UPDATE vs SELECT (id).

interface ScenarioRecorder {
  inserts: Array<Record<string, unknown>>
  updates: Array<{ payload: Record<string, unknown>; id: string; reviewState: string }>
  // Stack-of-responses each builder pops from.
  insertResponses: Array<{ data: { id: string } | null; error: { code?: string; message: string } | null }>
  updateResponses: Array<{ data: { id: string } | null; error: { code?: string; message: string } | null }>
  priorReasonResponses: Array<{ data: { review_reason: string | null } | null; error: { message: string } | null }>
  // TAC-394: loadPendingRowsBySlot rows. `data` is one row, an array of rows,
  // or null for none.
  findPendingResponses: Array<{ data: unknown; error: { message: string } | null }>
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
        //   - .select(PENDING_SLOT_ROW_COLUMNS).eq() x4 .order().limit()
        //     → loadPendingRowsBySlot after 23505 (TAC-394)
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
  // TAC-394: loadPendingRowsBySlot's chain, .eq() x4 .order().limit(), awaited
  // as an array. A queued `{ data: row }` is a guest with that one pending row;
  // a row with no pending_commitment is a conversation-slot card.
  const chain = {
    eq: () => chain,
    order: () => chain,
    limit: async () => {
      const resp = scenario.findPendingResponses.shift() ?? { data: null, error: null }
      const data =
        resp.data === null || resp.data === undefined
          ? []
          : Array.isArray(resp.data)
            ? resp.data
            : [resp.data]
      return { data, error: resp.error }
    },
  }
  return chain
}

// Red-alert is fire-and-forget. The persist layer awaits it; the test
// just needs the call to resolve without disrupting the flow.
const fireRedAlertMock = vi.fn().mockResolvedValue(undefined)
vi.mock('./alerts', () => ({
  fireRedAlert: (...args: unknown[]) => fireRedAlertMock(...args),
}))

// Messaging is referenced at module load by schedule-and-send.ts; stub it so
// the import doesn't pull in the real SDK init paths.
//
// There is deliberately NO './timing' mock here (TAC-421 deleted that module).
// The old one pinned every sampled sleep to 0, which meant an assertion that
// "no delay occurs before the first send" passed against code that still
// slept. The no-sleep guarantee is now asserted with fake timers instead —
// see the TAC-421 describe block at the bottom of this file.
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
    openIntentions: [],
    intentionDerivation: { newlyEligible: [], brakeEngaged: false },
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
    selfTalkViolationPersisted: false,
    emojiDirectiveViolated: false,
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
    // The slot re-read surfaces the racing row.
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
    // The slot re-read surfaces the racing row.
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
    // Every INSERT hits 23505; every slot re-read finds nothing
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

describe('scheduleAndSend — deterministic splitting (TAC-313 dispatch shape, TAC-319 decision)', () => {
  // TAC-319: the model no longer decides the split. Dispatch sentence-splits
  // the body and flips a fair coin for 2-3 sentence replies; the rng is
  // injected through options so each branch is pinned deterministically.
  const SPLIT = { skipHumanFeelDelay: true, rng: () => 0 }
  const SINGLE = { skipHumanFeelDelay: true, rng: () => 0.99 }

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

  // ── single-sentence bodies never flip ─────────────────────────────────

  it('sends a one-sentence body as ONE message and ONE row without consulting the rng', async () => {
    queueSends('provider-1')
    queueInserts('msg-1')
    const rng = vi.fn(() => 0)

    const result = await scheduleAndSend(makeCtx(), generationWithBody('Open until 4'), {
      skipHumanFeelDelay: true,
      rng,
    })

    expect(rng).not.toHaveBeenCalled()
    expect(vi.mocked(sendMessage)).toHaveBeenCalledTimes(1)
    expect(scenario.inserts).toHaveLength(1)
    expect(scenario.inserts[0]!.body).toBe('Open until 4')
    expect(result.outboundMessageId).toBe('msg-1')
    expect(result.providerMessageId).toBe('provider-1')
    expect(result.bubbleCount).toBe(1)
  })

  // ── the flip ──────────────────────────────────────────────────────────

  it('dispatches one message per sentence, in order, when the flip says split', async () => {
    queueSends('p1', 'p2')
    queueInserts('m1', 'm2')

    await scheduleAndSend(
      makeCtx(),
      generationWithBody('Espresso with foam on top. Stronger than a cortado.'),
      SPLIT,
    )

    const sent = vi.mocked(sendMessage).mock.calls.map((c) => (c[0] as { body: string }).body)
    // Terminal periods are stripped on split pieces; ? and ! would survive.
    expect(sent).toEqual(['Espresso with foam on top', 'Stronger than a cortado'])
  })

  it('sends the same multi-sentence body as ONE untouched block when the flip says no', async () => {
    queueSends('p1')
    queueInserts('m1')

    const result = await scheduleAndSend(
      makeCtx(),
      generationWithBody('Espresso with foam on top. Stronger than a cortado.'),
      SINGLE,
    )

    expect(vi.mocked(sendMessage)).toHaveBeenCalledTimes(1)
    const sent = (vi.mocked(sendMessage).mock.calls[0]![0] as { body: string }).body
    expect(sent).toBe('Espresso with foam on top. Stronger than a cortado.')
    expect(result.bubbleCount).toBe(1)
  })

  it('persists one row per bubble, each carrying its own text', async () => {
    queueSends('p1', 'p2')
    queueInserts('m1', 'm2')

    await scheduleAndSend(
      makeCtx(),
      generationWithBody('First one here. Second one here.'),
      SPLIT,
    )

    expect(scenario.inserts).toHaveLength(2)
    expect(scenario.inserts.map((r) => r.body)).toEqual(['First one here', 'Second one here'])
  })

  it('stamps every row of a response with the SAME generation_id', async () => {
    queueSends('p1', 'p2', 'p3')
    queueInserts('m1', 'm2', 'm3')

    const result = await scheduleAndSend(
      makeCtx(),
      generationWithBody('First one here. Second one here. Third one here.'),
      SPLIT,
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

  it('strips stray model-emitted delimiters so none reach Sendblue or the database', async () => {
    // TAC-319: the model no longer controls splitting, so a leftover [[BREAK]]
    // is noise, not a boundary. It is stripped on BOTH branches.
    queueSends('p1', 'p2')
    queueInserts('m1', 'm2')

    await scheduleAndSend(
      makeCtx(),
      generationWithBody(`First one here.${BUBBLE_DELIMITER}Second one here.`),
      SPLIT,
    )

    for (const call of vi.mocked(sendMessage).mock.calls) {
      expect((call[0] as { body: string }).body).not.toContain('BREAK')
    }
    for (const insert of scenario.inserts) {
      expect(String(insert.body)).not.toContain('BREAK')
    }
  })

  it('a stray delimiter is NOT itself a split instruction', async () => {
    queueSends('p1')
    queueInserts('m1')

    // Two sentences joined by a stray marker, flip says no split: one block.
    const result = await scheduleAndSend(
      makeCtx(),
      generationWithBody(`First one here.${BUBBLE_DELIMITER}Second one here.`),
      SINGLE,
    )

    expect(result.bubbleCount).toBe(1)
    const sent = (vi.mocked(sendMessage).mock.calls[0]![0] as { body: string }).body
    expect(sent).toBe('First one here. Second one here.')
  })

  it('sends a 4+ sentence body as ONE block without consulting the rng (all-or-nothing)', async () => {
    // TAC-319 ruling #1: past MAX_BUBBLES_PER_RESPONSE sentences the cap
    // would force partial grouping, so long answers stay single and the coin
    // is never flipped.
    queueSends('p1')
    queueInserts('m1')
    const rng = vi.fn(() => 0)

    const body = 'One here. Two here. Three here. Four here.'
    const result = await scheduleAndSend(makeCtx(), generationWithBody(body), {
      skipHumanFeelDelay: true,
      rng,
    })

    expect(rng).not.toHaveBeenCalled()
    expect(vi.mocked(sendMessage)).toHaveBeenCalledTimes(1)
    expect(result.bubbleCount).toBe(1)
    expect(scenario.inserts[0]!.body).toBe(body)
  })

  it('returns the FIRST bubble ids so existing consumers are unaffected', async () => {
    queueSends('provider-first', 'provider-second')
    queueInserts('msg-first', 'msg-second')

    const result = await scheduleAndSend(
      makeCtx(),
      generationWithBody('First one here. Second one here.'),
      SPLIT,
    )

    expect(result.outboundMessageId).toBe('msg-first')
    expect(result.providerMessageId).toBe('provider-first')
  })

  // ── timing ────────────────────────────────────────────────────────────

  it('shows a typing indicator before each later bubble (real inter-bubble pause)', async () => {
    queueSends('p1', 'p2')
    queueInserts('m1', 'm2')

    await scheduleAndSend(
      makeCtx(),
      generationWithBody('First one here. Second one here.'),
      { rng: () => 0 },
    )

    // Once in the opening sequence, once before the second bubble.
    expect(vi.mocked(sendTypingIndicator)).toHaveBeenCalledTimes(2)
    // markAsRead fires once for the response, not once per bubble.
    expect(vi.mocked(markAsRead)).toHaveBeenCalledTimes(1)
  })

  it('skips the inter-bubble pause entirely when skipHumanFeelDelay is set', async () => {
    queueSends('p1', 'p2')
    queueInserts('m1', 'm2')

    await scheduleAndSend(
      makeCtx(),
      generationWithBody('First one here. Second one here.'),
      SPLIT,
    )

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
      scheduleAndSend(
        makeCtx(),
        generationWithBody('First one here. Second one here.'),
        SPLIT,
      ),
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
      generationWithBody('First one here. Second one here.'),
      SPLIT,
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

    await scheduleAndSend(
      makeCtx(),
      generationWithBody('First one here. Second one here.'),
      SPLIT,
    )

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
      generationWithBody('First one here. Second one here.'),
      SPLIT,
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
      ...generationWithBody('Holding it for you. See you at 8.'),
      commitment: { type: 'hold', description: 'holding a loaf' },
    }

    await scheduleAndSend(makeCtx(), generation, SPLIT)

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

// ---------------------------------------------------------------------------
// TAC-364: review_triggers + ungrounded_claims at both persist sites
// ---------------------------------------------------------------------------
//
// `review_reason` keeps holding the priority-selected primary; these two carry
// what it cannot. Before this, a comp commitment that was ALSO below the
// auto-send fidelity floor reached the operator labelled only "Commitment
// requires approval" and the second condition was unrecoverable — triggers[]
// lived in memory and in a PostHog payload, nowhere the card could read.
describe('persistOrRegenQueuedDraft — TAC-364 review detail', () => {
  beforeEach(() => {
    scenario = freshScenario()
  })

  it('writes both columns on the INSERT path', async () => {
    scenario.insertResponses.push({ data: { id: 'new-msg-1' }, error: null })

    await persistOrRegenQueuedDraft(makeCtx(), makeGeneration(), 'commitment_type_gated', null, {
      reviewTriggers: ['fidelity_below_auto_send_floor', 'commitment_type_gated'],
      ungroundedClaims: ['We open at 6am on Sundays.'],
    })

    expect(scenario.inserts[0]).toMatchObject({
      review_reason: 'commitment_type_gated',
      review_triggers: ['fidelity_below_auto_send_floor', 'commitment_type_gated'],
      ungrounded_claims: ['We open at 6am on Sundays.'],
    })
  })

  it('writes NULL for both when the caller passes neither', async () => {
    // The two non-gate callers — the generation-failure card and the operator
    // decline — never ran applyApprovalPolicyStage, so they have no trigger SET
    // to record, only the single reason they stamp themselves. NULL says that;
    // a synthesized one-element array would claim the gate ran and found
    // exactly one thing.
    scenario.insertResponses.push({ data: { id: 'new-msg-1' }, error: null })

    await persistOrRegenQueuedDraft(makeCtx(), makeGeneration(), 'generation_failed', null)

    expect(scenario.inserts[0]).toMatchObject({
      review_triggers: null,
      ungrounded_claims: null,
    })
  })

  it('nulls ungrounded_claims on a blank card but KEEPS review_triggers', async () => {
    // A claim is a quotation FROM the body, and a blank card has no body — so
    // keeping it would point the operator at text they cannot see. Why the card
    // exists is still true with or without a body, so the triggers stay.
    scenario.insertResponses.push({ data: { id: 'new-msg-1' }, error: null })

    await persistOrRegenQueuedDraft(makeCtx(), makeGeneration(), 'knowledge_gap', null, {
      blankBody: true,
      reviewTriggers: ['knowledge_gap'],
      ungroundedClaims: ['should not survive blanking'],
    })

    expect(scenario.inserts[0]).toMatchObject({
      body: '',
      ungrounded_claims: null,
      review_triggers: ['knowledge_gap'],
    })
  })

  it('OVERWRITES both on the regen UPDATE path', async () => {
    // The distinction that matters, and the reason these three columns sit
    // together in the payload: `pending_until` below is preserve-by-default
    // because it describes the GUEST'S wait, which a regen didn't reset. These
    // two describe THIS draft. A regen that no longer fabricates must not keep
    // the previous attempt's flagged claim.
    scenario.priorReasonResponses.push({
      data: { review_reason: 'knowledge_gap_backstop' },
      error: null,
    })
    scenario.updateResponses.push({ data: { id: 'existing-msg-1' }, error: null })

    await persistOrRegenQueuedDraft(
      makeCtx(),
      makeGeneration(),
      'model_flagged',
      'existing-msg-1',
      { reviewTriggers: ['model_flagged'], ungroundedClaims: [] },
    )

    const payload = scenario.updates[0].payload
    expect(payload).toMatchObject({
      review_reason: 'model_flagged',
      review_triggers: ['model_flagged'],
      ungrounded_claims: [],
    })
    // Not preserve-by-default — the key is PRESENT in the payload, which is
    // what makes it an overwrite rather than a no-op. Contrast pending_until,
    // whose absence from the payload is load-bearing.
    expect(payload).toHaveProperty('ungrounded_claims')
    expect(payload).not.toHaveProperty('pending_until')
  })

  // TAC-364 ruling 3: the column is three-state and the write path has to
  // preserve all three. `[]` is NOT a spelling of null here — it is the
  // positive record that the grounding check ran and found nothing, and the
  // whole reason to record it is that TAC-367 was filed over a check that
  // silently didn't run being invisible everywhere.
  it('writes [] — not null — when the check ran and found nothing', async () => {
    scenario.insertResponses.push({ data: { id: 'new-msg-1' }, error: null })

    await persistOrRegenQueuedDraft(makeCtx(), makeGeneration(), 'model_flagged', null, {
      reviewTriggers: ['model_flagged'],
      ungroundedClaims: [],
    })

    expect(scenario.inserts[0]!.ungrounded_claims).toEqual([])
    expect(scenario.inserts[0]!.ungrounded_claims).not.toBeNull()
  })

  it('writes null when the caller says the check did not run', async () => {
    scenario.insertResponses.push({ data: { id: 'new-msg-1' }, error: null })

    await persistOrRegenQueuedDraft(makeCtx(), makeGeneration(), 'model_flagged', null, {
      reviewTriggers: ['model_flagged'],
      ungroundedClaims: null,
    })

    expect(scenario.inserts[0]!.ungrounded_claims).toBeNull()
  })

  it('keeps [] and null distinguishable end to end at the persist boundary', async () => {
    // The pair, asserted together — a `?? []` or `|| null` anywhere on this
    // path collapses them and passes each single-state test above.
    scenario.insertResponses.push({ data: { id: 'a' }, error: null })
    scenario.insertResponses.push({ data: { id: 'b' }, error: null })

    await persistOrRegenQueuedDraft(makeCtx(), makeGeneration(), 'model_flagged', null, {
      ungroundedClaims: [],
    })
    await persistOrRegenQueuedDraft(makeCtx(), makeGeneration(), 'model_flagged', null, {
      ungroundedClaims: null,
    })

    expect(scenario.inserts[0]!.ungrounded_claims).toEqual([])
    expect(scenario.inserts[1]!.ungrounded_claims).toBeNull()
  })

  it('nulls BOTH columns on regen when the caller passes no options', async () => {
    // This is the non-gate regen path — the generation-failure card and the
    // operator decline both land here — and it is the one a reader is most
    // likely to get backwards, because `pending_until` in the same payload IS
    // preserve-by-default and omission there means "leave it alone".
    //
    // Omission here means NULL, and both assertions are load-bearing against a
    // real surviving mutant: rewriting either line as
    // `...(options.x !== undefined ? { x } : {})` — i.e. making it match
    // pending_until's shape, which the option's own docstring wrongly claimed
    // it did until TAC-364's code review — passes the entire rest of the suite.
    // The consequence would be a crash card inheriting the previous draft's
    // trigger chips and flagged sentence: an operator reading "Commitment
    // requires approval" next to "Something went wrong writing this one", for
    // a draft that no longer exists.
    scenario.priorReasonResponses.push({
      data: { review_reason: 'knowledge_gap_backstop' },
      error: null,
    })
    scenario.updateResponses.push({ data: { id: 'existing-msg-1' }, error: null })

    await persistOrRegenQueuedDraft(
      makeCtx(),
      makeGeneration(),
      'previous_pending_held',
      'existing-msg-1',
    )

    const payload = scenario.updates[0].payload
    expect(payload).toMatchObject({ review_triggers: null, ungrounded_claims: null })
    // Present-and-null, not absent. An absent key is the preserve-by-default
    // shape, and that is exactly the mutation above.
    expect(payload).toHaveProperty('review_triggers')
    expect(payload).toHaveProperty('ungrounded_claims')
  })
})

// ---------------------------------------------------------------------------
// TAC-394: race recovery on two pending slots
// ---------------------------------------------------------------------------
//
// The fake-table versions of these (a comp A card against a comp B INSERT, a
// conversation INSERT beside a comp card) are in two-pending-slots.test.ts. These
// pin the persist layer's own branches with this file's scripted responses.
describe('persistOrRegenQueuedDraft — two pending slots (TAC-394)', () => {
  beforeEach(() => {
    scenario = freshScenario()
    fireRedAlertMock.mockClear()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  // The live bug on main: a manual followup's INSERT hit the unique index and
  // recovery UPDATEd the card anyway. 'never_regen' refuses instead.
  it('refuses instead of regenerating when a manual followup races into an occupied slot', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    scenario.insertResponses.push({
      data: null,
      error: { code: '23505', message: 'duplicate key' },
    })
    scenario.findPendingResponses.push({
      data: {
        id: 'waiting-card',
        body: 'earlier draft',
        pending_until: null,
        review_reason: 'model_flagged',
        pending_commitment: null,
        created_at: '2026-09-14T16:26:34.000Z',
      },
      error: null,
    })

    const result = await persistOrRegenQueuedDraft(
      makeCtx(),
      makeGeneration(),
      'category_requires_approval',
      null,
      { callerPolicy: 'never_regen' },
    )

    expect(result).toEqual({
      outboundMessageId: null,
      action: 'dropped',
      priorReviewReason: null,
      reason: 'slot_occupied',
      protectedDraftId: 'waiting-card',
      protectedCommitment: null,
      droppedCommitment: null,
    })
    expect(scenario.inserts).toHaveLength(1)
    expect(scenario.updates).toHaveLength(0)
    expect(fireRedAlertMock).not.toHaveBeenCalled()
  })

  it('retries the INSERT when the slot re-read after a 23505 fails', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    scenario.insertResponses.push(
      { data: null, error: { code: '23505', message: 'duplicate key' } },
      { data: { id: 'new-msg-1' }, error: null },
    )
    scenario.findPendingResponses.push({ data: null, error: { message: 'connection reset' } })

    const result = await persistOrRegenQueuedDraft(
      makeCtx(),
      makeGeneration(),
      'model_flagged',
      null,
    )

    expect(result).toEqual({
      outboundMessageId: 'new-msg-1',
      action: 'inserted',
      priorReviewReason: null,
    })
    expect(scenario.inserts).toHaveLength(2)
    expect(scenario.updates).toHaveLength(0)
  })

  // Unreachable from the new code, which only regenerates the card in the
  // draft's own slot, and reachable from OLD code in migration 041's deploy
  // window. It must not be mistaken for an ordinary write failure.
  it('reports a unique violation on the regen UPDATE as its own red alert and writes nothing', async () => {
    scenario.priorReasonResponses.push({ data: { review_reason: 'model_flagged' }, error: null })
    scenario.updateResponses.push({
      data: null,
      error: { code: '23505', message: 'duplicate key' },
    })

    await expect(
      persistOrRegenQueuedDraft(makeCtx(), makeGeneration(), 'model_flagged', 'card-conv'),
    ).rejects.toThrow(/unique violation/)

    expect(fireRedAlertMock).toHaveBeenCalledTimes(1)
    expect(fireRedAlertMock).toHaveBeenCalledWith(
      expect.objectContaining({
        stage: 'persist',
        errorMessage: expect.stringContaining('occupied pending slot'),
        extra: expect.objectContaining({
          uniqueViolation: true,
          attemptedPendingDraftId: 'card-conv',
        }),
      }),
    )
    expect(scenario.inserts).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// TAC-385 PR 1: rendered_intentions at both persist sites
// ---------------------------------------------------------------------------
//
// The carrier that lets dispatchOperatorOutbound record the ask when an
// operator approves or edits a card. Before this, those sends recorded nothing
// — 13 of 34 sent replies at Le Mil's in the 30 days to 2026-09-14.
//
// The column follows review_triggers' policy, NOT pending_until's: it describes
// THIS draft, so a regen overwrites it wholesale.
describe('persistOrRegenQueuedDraft — rendered_intentions (TAC-385)', () => {
  const ANCHOR = new Date('2026-09-14T10:00:00.000Z')

  beforeEach(() => {
    scenario = freshScenario()
  })

  it('writes the rendered set on the INSERT path', async () => {
    scenario.insertResponses.push({ data: { id: 'new-msg-1' }, error: null })

    await persistOrRegenQueuedDraft(makeCtx(), makeGeneration(), 'model_flagged', null, {
      renderedIntentions: [
        { key: 'understand_order', promptLine: 'unused on the wire', eligibleAt: ANCHOR },
      ],
    })

    // promptLine is deliberately NOT carried: recording reads only
    // classifierDescription, off the definition, so storing the line would be a
    // second copy of a constant that can go stale against it.
    expect(scenario.inserts[0]!.rendered_intentions).toEqual([
      { key: 'understand_order', eligibleAt: '2026-09-14T10:00:00.000Z' },
    ])
  })

  it('writes NULL when the caller passes nothing', async () => {
    // Followup, decline and crash-card drafts. build-runtime-context derives
    // intentions only when there is a current message, so those paths carry
    // openIntentions: [] by construction and have nothing to record.
    scenario.insertResponses.push({ data: { id: 'new-msg-1' }, error: null })

    await persistOrRegenQueuedDraft(makeCtx(), makeGeneration(), 'generation_failed', null)

    expect(scenario.inserts[0]!.rendered_intentions).toBeNull()
  })

  it('nulls the column on a blank knowledge-gap card', async () => {
    // Ruled 2026-09-15. The dispatched text on a blank card is entirely
    // operator-authored, so the model's rendered set is not a claim about it,
    // and a classifier double-failure would close intentions the model never
    // attempted to raise — TAC-332's failure through a new door.
    scenario.insertResponses.push({ data: { id: 'new-msg-1' }, error: null })

    await persistOrRegenQueuedDraft(makeCtx(), makeGeneration(), 'knowledge_gap', null, {
      blankBody: true,
      renderedIntentions: [
        { key: 'understand_order', promptLine: 'unused on the wire', eligibleAt: ANCHOR },
      ],
    })

    expect(scenario.inserts[0]!.body).toBe('')
    expect(scenario.inserts[0]!.rendered_intentions).toBeNull()
  })

  it('OVERWRITES on the regen UPDATE path, and is not preserve-by-default', async () => {
    scenario.priorReasonResponses.push({
      data: { review_reason: 'knowledge_gap' },
      error: null,
    })
    scenario.updateResponses.push({ data: { id: 'existing-msg-1' }, error: null })

    await persistOrRegenQueuedDraft(
      makeCtx(),
      makeGeneration(),
      'model_flagged',
      'existing-msg-1',
      {
        renderedIntentions: [
          { key: 'learn_name', promptLine: 'unused on the wire', eligibleAt: ANCHOR },
        ],
      },
    )

    const payload = scenario.updates[0].payload
    expect(payload.rendered_intentions).toEqual([
      { key: 'learn_name', eligibleAt: '2026-09-14T10:00:00.000Z' },
    ])
    // The key being PRESENT is what makes it an overwrite. A regen that renders
    // a different set must not leave the previous attempt's behind, because a
    // classifier double-failure closes everything it is offered.
    expect(payload).toHaveProperty('rendered_intentions')
    expect(payload).not.toHaveProperty('pending_until')
  })

  // The UPDATE half of the blankBody rule, and it is REACHABLE, which is why it
  // needs its own test rather than riding on the INSERT one: a gap turn
  // regenerating a NON-gap card in the same slot (turn 1 queues model_flagged,
  // turn 2 self-reports a knowledge gap) has pendingQuestion === null, so
  // renderableIntentions returns a NON-EMPTY set, and blankBody is true. Without
  // the `blank ||` guard that blank card carries the model's rendered set, and an
  // operator approving text they typed themselves gets the model's intentions
  // recorded against their words. Found by code review as a surviving mutant.
  it('nulls the column on a regen that BLANKS a previously non-gap card', async () => {
    scenario.priorReasonResponses.push({
      data: { review_reason: 'model_flagged' },
      error: null,
    })
    scenario.updateResponses.push({ data: { id: 'existing-msg-1' }, error: null })

    await persistOrRegenQueuedDraft(
      makeCtx(),
      makeGeneration(),
      'knowledge_gap',
      'existing-msg-1',
      {
        blankBody: true,
        renderedIntentions: [
          { key: 'understand_order', promptLine: 'unused on the wire', eligibleAt: ANCHOR },
        ],
      },
    )

    const payload = scenario.updates[0].payload
    expect(payload.body).toBe('')
    expect(payload.rendered_intentions).toBeNull()
  })

  it('nulls the column on a regen that renders nothing', async () => {
    scenario.priorReasonResponses.push({
      data: { review_reason: 'model_flagged' },
      error: null,
    })
    scenario.updateResponses.push({ data: { id: 'existing-msg-1' }, error: null })

    await persistOrRegenQueuedDraft(
      makeCtx(),
      makeGeneration(),
      'model_flagged',
      'existing-msg-1',
      {},
    )

    expect(scenario.updates[0].payload.rendered_intentions).toBeNull()
  })
})
// ---------------------------------------------------------------------------
// TAC-421 — no pre-send pause
// ---------------------------------------------------------------------------
//
// scheduleAndSend used to sample a "human-feel" timing plan and sleep through
// it before marking as read. That sleep ran after generation, the backstops
// and the approval gate, so it was ~6.5s of dead time on a pipeline that
// already took 14-17s (TAC-420). It is gone; the read receipt and the opening
// typing beat are not.
//
// Both tests here install fake timers and carry an explicit 2s per-test
// timeout. That combination IS the assertion: a reintroduced sleep leaves its
// setTimeout unfired, the promise never settles, and the test fails on its own
// timeout instead of hanging the suite. Verified by actually re-adding
// `await sleep(6500)` and watching each one fail -- an assertion this file
// could not make before, because the deleted './timing' mock pinned every
// sampled sleep to 0 and would have let a sleeping implementation pass.
// ---------------------------------------------------------------------------
// TAC-436 ruling 4: rendered_intentions on the AUTO-SEND path
// ---------------------------------------------------------------------------
//
// Until this, the column was written only by persistOrRegenQueuedDraft, so
// every auto-sent row carried NULL and TAC-385's raising-half audit had to
// infer what rendered on those turns rather than read it. Nothing downstream
// consumes it here — the auto-send path records inline — so this is audit, and
// the assertions are about what lands in the row.
describe('scheduleAndSend — rendered_intentions (TAC-436)', () => {
  const ANCHOR = new Date('2026-09-14T10:00:00.000Z')
  const RENDERED = [
    { key: 'understand_order' as const, promptLine: 'unused on the wire', eligibleAt: ANCHOR },
  ]

  beforeEach(() => {
    scenario = freshScenario()
    vi.mocked(sendMessage).mockReset()
    vi.mocked(markAsRead).mockReset().mockResolvedValue({ ok: true } as never)
    vi.mocked(sendTypingIndicator).mockReset().mockResolvedValue({ ok: true } as never)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('writes the rendered set on an auto-sent row', async () => {
    queueSends('provider-1')
    queueInserts('msg-1')

    await scheduleAndSend(makeCtx(), generationWithBody('Open until 4'), {
      ...NO_DELAY,
      renderedIntentions: RENDERED,
    })

    // Same wire shape the queue path writes: key + anchor, never promptLine.
    expect(scenario.inserts[0]!.rendered_intentions).toEqual([
      { key: 'understand_order', eligibleAt: '2026-09-14T10:00:00.000Z' },
    ])
  })

  it('writes NULL when the caller passes nothing', async () => {
    queueSends('provider-1')
    queueInserts('msg-1')

    await scheduleAndSend(makeCtx(), generationWithBody('Open until 4'), NO_DELAY)

    expect(scenario.inserts[0]!.rendered_intentions).toBeNull()
  })

  // THE ONE THAT MATTERS ON A SPLIT. One prompt, one rendered set, so the
  // column belongs to the response and not to each bubble of it. Without the
  // index guard a two-bubble turn writes it twice and a count of non-null rows
  // counts bubbles instead of responses.
  it('writes it on the FIRST row only when the response splits', async () => {
    queueSends('provider-1', 'provider-2')
    queueInserts('msg-1', 'msg-2')

    await scheduleAndSend(
      makeCtx(),
      generationWithBody('Open until 4. Come by whenever.'),
      { skipHumanFeelDelay: true, rng: () => 0, renderedIntentions: RENDERED },
    )

    expect(scenario.inserts).toHaveLength(2)
    expect(scenario.inserts[0]!.rendered_intentions).toEqual([
      { key: 'understand_order', eligibleAt: '2026-09-14T10:00:00.000Z' },
    ])
    expect(scenario.inserts[1]!.rendered_intentions).toBeNull()
  })

  // EQUIVALENCE. handle-inbound hoists one value above the queue/send fork, so
  // a card and an auto-send describe the same prompt. This pins the two
  // PAYLOADS equal for one rendered set, so a divergence in either writer's
  // serialization fails here rather than in production six weeks later.
  it('writes the same payload the queue path writes for the same rendered set', async () => {
    queueSends('provider-1')
    queueInserts('msg-1')
    await scheduleAndSend(makeCtx(), generationWithBody('Open until 4'), {
      ...NO_DELAY,
      renderedIntentions: RENDERED,
    })
    const autoSent = scenario.inserts[0]!.rendered_intentions

    scenario = freshScenario()
    scenario.insertResponses.push({ data: { id: 'new-msg-1' }, error: null })
    await persistOrRegenQueuedDraft(makeCtx(), makeGeneration(), 'model_flagged', null, {
      renderedIntentions: RENDERED,
    })
    const queued = scenario.inserts[0]!.rendered_intentions

    expect(autoSent).toEqual(queued)
  })
})

describe('scheduleAndSend — no pre-send pause (TAC-421)', () => {
  beforeEach(() => {
    scenario = freshScenario()
    fireRedAlertMock.mockClear()
    vi.mocked(sendMessage).mockReset()
    vi.mocked(markAsRead).mockReset().mockResolvedValue({ ok: true } as never)
    vi.mocked(sendTypingIndicator).mockReset().mockResolvedValue({ ok: true } as never)
    vi.mocked(createCommitmentFromPending)
      .mockReset()
      .mockResolvedValue({ ok: true, data: { id: 'commitment-1' } } as never)
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it(
    'marks as read, shows typing, then sends — with no timer awaited in between',
    async () => {
      queueSends('provider-1')
      queueInserts('msg-1')

      // skipHumanFeelDelay deliberately NOT set: this is the ordinary
      // auto-send path, the one that used to sleep. The clock is never
      // advanced below.
      await scheduleAndSend(makeCtx(), generationWithBody('Open until 4'), {
        rng: () => 0.99,
      })

      const read = vi.mocked(markAsRead).mock.invocationCallOrder[0]!
      const typing = vi.mocked(sendTypingIndicator).mock.invocationCallOrder[0]!
      const sent = vi.mocked(sendMessage).mock.invocationCallOrder[0]!

      expect(read).toBeLessThan(typing)
      expect(typing).toBeLessThan(sent)
      expect(vi.mocked(sendMessage)).toHaveBeenCalledTimes(1)
    },
    2000,
  )

  it(
    'still holds the second bubble behind INTER_BUBBLE_GAP_MS',
    async () => {
      queueSends('p1', 'p2')
      queueInserts('m1', 'm2')

      const dispatch = scheduleAndSend(
        makeCtx(),
        generationWithBody('First one here. Second one here.'),
        { rng: () => 0 },
      )

      // Flush microtasks WITHOUT moving the clock. The first bubble clears;
      // the second must still be waiting on its gap. Advancing first and then
      // asserting two sends would pass with the gap removed, which is the
      // version of this test worth avoiding.
      await vi.advanceTimersByTimeAsync(0)
      expect(vi.mocked(sendMessage)).toHaveBeenCalledTimes(1)

      await vi.advanceTimersByTimeAsync(INTER_BUBBLE_GAP_MS)
      await dispatch

      expect(vi.mocked(sendMessage)).toHaveBeenCalledTimes(2)
    },
    2000,
  )

  // The engine-followup shape. This is the SECOND of the two paths that used
  // to sleep, and the one where the wait bought least: `buildRuntimeContext`
  // sets currentMessage null for a followup, so the ~6.5s pause was not even
  // followed by a read receipt. Nothing else in this file passes a null
  // currentMessage, so without this case deleting the `if (ctx.currentMessage)`
  // guard in schedule-and-send.ts is a TypeError on every engine followup in
  // production that survives the entire suite — the orchestrator tests mock
  // ./schedule-and-send, so they cannot reach it either.
  it(
    'sends a followup with no read receipt when there is no inbound to mark',
    async () => {
      queueSends('provider-1')
      queueInserts('msg-1')

      await scheduleAndSend(
        makeCtx({ currentMessage: null }),
        generationWithBody('Open until 4'),
        { rng: () => 0.99 },
      )

      expect(vi.mocked(markAsRead)).not.toHaveBeenCalled()
      expect(vi.mocked(sendTypingIndicator)).toHaveBeenCalledTimes(1)
      expect(vi.mocked(sendMessage)).toHaveBeenCalledTimes(1)
    },
    2000,
  )
})
