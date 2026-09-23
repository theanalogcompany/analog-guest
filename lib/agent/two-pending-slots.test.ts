// TAC-394, option F, end to end against an in-memory `messages` table.
//
// The real approval gate, the real persist layer and the real
// findPendingQuestion, run against lib/agent/testing/pending-rows-fake.ts
// instead of per-query mocks. The fake returns rows in INSERTION order unless a
// read orders them, enforces migration 020 or migration 041, and answers a
// violation with 23505. So these tests exercise what the ticket is about:
//
//   - AC4: two inbounds in quick succession, the first producing a gated comp
//     draft, do not lose the comp draft.
//   - Race recovery reaches a card the gate never saw, and decides it the same
//     way the gate would have.
//   - A read that forgot its slot is handed the wrong card: the tests insert
//     the other slot's card first. A read that forgot its ORDER within one slot
//     is caught by pending-slots.test.ts and by the findPendingQuestion test.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { GenerateMessageResult } from '@/lib/ai'
import { createPendingRowsFake, type PendingIndexMode } from './testing/pending-rows-fake'
import type { RuntimeContext } from './types'

const mockAdmin: { client: unknown } = { client: null }
const fireRedAlertMock = vi.fn()

vi.mock('voyageai', () => ({ VoyageAIClient: class {} }))
vi.mock('@/lib/db/admin', () => ({
  createAdminClient: () => mockAdmin.client,
}))
vi.mock('./alerts', () => ({
  fireRedAlert: (...args: unknown[]) => fireRedAlertMock(...args),
  capturePostHogEvent: vi.fn(),
}))
vi.mock('@/lib/rag', () => ({
  retrieveContext: vi.fn(),
  retrieveKnowledgeContext: vi.fn(),
}))
vi.mock('@/lib/ai', () => ({
  classifyMessage: vi.fn(),
  generateMessage: vi.fn(),
  verifyGrounding: vi.fn(),
  verifyMechanicOffer: vi.fn(),
  verifyProsePromise: vi.fn(),
}))
vi.mock('@/lib/messaging', () => ({
  markAsRead: vi.fn(),
  sendMessage: vi.fn(),
  sendTypingIndicator: vi.fn(),
}))
vi.mock('@/lib/analytics/posthog', () => ({
  captureClassificationLowConfidence: vi.fn(),
  captureCommitmentDedupCheckFailed: vi.fn(),
  captureCommitmentDeduped: vi.fn(),
  captureCommitmentEscalated: vi.fn(),
  captureCorpusRetrievalBelowThreshold: vi.fn(),
  captureDashViolationPersisted: vi.fn(),
  captureDemoBypassedApprovalGate: vi.fn(),
  captureEmojiDirectiveViolated: vi.fn(),
  captureGroundingVerifierUnavailable: vi.fn(),
  captureMechanicOfferBackstopCaught: vi.fn(),
  capturePostHogEvent: vi.fn(),
  captureRegenerationTriggered: vi.fn(),
  captureUngroundedClaimCaught: vi.fn(),
  captureVoiceFidelityLow: vi.fn(),
  CLASSIFICATION_CONFIDENCE_LOW_THRESHOLD: 0.7,
  CLASSIFICATION_CONFIDENCE_REROUTE_THRESHOLD: 0.3,
  CORPUS_TOP_SIMILARITY_LOW_THRESHOLD: 0.5,
  VOICE_FIDELITY_LOW_THRESHOLD: 0.5,
}))

import { findPendingQuestion } from './pending-question'
import type { SlotCallerPolicy } from './pending-slots'
import { persistOrRegenQueuedDraft } from './schedule-and-send'
import {
  applyApprovalPolicyStage,
  type CancellationBackstopResult,
  type ProsePromiseBackstopResult,
} from './stages'

const VENUE = '00000000-0000-4000-8000-0000000000aa'
const GUEST = '18694d6a-6a80-470e-b334-acea7be1ed95'

const compA = {
  type: 'comp',
  description: 'a free cortado on your next visit',
  code: '7K2P',
  expiresAt: null,
}

function useFake(mode: PendingIndexMode) {
  const fake = createPendingRowsFake(mode)
  mockAdmin.client = fake.client
  return fake
}

function ctxFor(opts: { category: string; held?: boolean; manual?: boolean }): RuntimeContext {
  return {
    agentRunId: 'run-1',
    venue: {
      id: VENUE,
      holdAllOutbound: false,
      approvalPolicy: opts.held
        ? { default: 'operator_approval', perCategory: {} }
        : { default: 'auto_send', perCategory: {} },
    },
    guest: { id: GUEST, firstName: 'Sam', phoneNumber: '+15555550853', isDemo: false },
    currentMessage: opts.manual
      ? null
      : {
          id: 'inbound-1',
          body: 'what time do you open on sundaus',
          providerMessageId: 'p1',
          receivedAt: new Date(),
        },
    followupTrigger: opts.manual ? { reason: 'manual', triggeredAt: new Date() } : null,
    classification: {
      category: opts.category,
      classifierConfidence: 0.9,
      reasoning: 'test',
      crisisSafety: false,
    },
    pendingQuestion: null,
    recentMessages: [],
    recentVisits: [],
    activeCommitments: [],
    openIntentions: [],
    mechanics: [],
    corpus: null,
    knowledgeCorpus: null,
    trace: { id: '' },
  } as unknown as RuntimeContext
}

function generation(over: Partial<GenerateMessageResult> = {}): GenerateMessageResult {
  return {
    body: 'a reply',
    voiceFidelity: 0.85,
    reasoning: 'r',
    unverifiedUrls: [],
    requiresOperatorApproval: false,
    approvalReason: '',
    complaintIntent: 'none',
    knowledgeGap: false,
    contextUpdate: {},
    commitment: {},
    arrivalCapture: {},
    cancelsCommitmentId: '',
    attempts: 1,
    attemptScores: [0.85],
    attemptHistory: [],
    systemPrompt: '',
    userPrompt: '',
    promptVersion: 'v1.60.0',
    dashViolationPersisted: false,
    selfTalkViolationPersisted: false,
    emojiDirectiveViolated: false,
    ...over,
  }
}

/** One agent turn: the real gate, then the real persist layer when it queues. */
async function runTurn(
  ctx: RuntimeContext,
  gen: GenerateMessageResult,
  callerPolicy: SlotCallerPolicy = 'regen',
  // TAC-401: what verifyProsePromiseStage found. Defaults to the pre-TAC-401
  // behaviour, so every existing test in this file reads unchanged.
  prosePromise: ProsePromiseBackstopResult = { status: 'skipped' },
  // TAC-513: what verifyCancellationClaimStage found. Defaults to the
  // pre-TAC-513 behaviour, so every existing test in this file reads unchanged.
  cancellation: CancellationBackstopResult = {
    resolution: { status: 'none' },
    claim: 'skipped',
  },
) {
  const decision = await applyApprovalPolicyStage(
    ctx,
    gen,
    { status: 'clean' },
    { status: 'skipped' },
    prosePromise,
    cancellation,
  )
  if (decision.action !== 'queue') return { decision, persisted: null }
  const persisted = await persistOrRegenQueuedDraft(
    ctx,
    gen,
    decision.primaryTrigger,
    decision.existingPendingDraftId,
    {
      pendingUntil: decision.pendingUntil,
      blankBody: decision.blankBody,
      reviewTriggers: decision.triggers,
      ungroundedClaims: decision.ungroundedClaims,
      // TAC-401: the carrier the gate resolved. Dropping this line is the
      // mutant the end-to-end tests below exist to kill — every per-mock
      // assertion in the repo would stay green without it, because a mock
      // returns its fixture whatever it is handed.
      promisedCommitment: decision.promisedCommitment,
      // TAC-513: same reasoning as the line above. Dropping it is the mutant
      // the end-to-end test below kills, and no per-mock assertion would.
      pendingCancellation: decision.pendingCancellation,
      callerPolicy,
    },
  )
  return { decision, persisted }
}

const COMP_REPLY = "Really sorry to hear that. Come back in and the next one's on us."
const COMP_TURN = generation({
  body: COMP_REPLY,
  commitment: { type: 'comp', description: "the next one's on us" },
})

beforeEach(() => {
  fireRedAlertMock.mockReset()
  fireRedAlertMock.mockResolvedValue(undefined)
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('AC4: two inbounds in quick succession, the first producing a gated comp draft (TAC-394)', () => {
  it('041: the comp card survives a held reply to the next question, which becomes a second card', async () => {
    const fake = useFake('041')

    const turn1 = await runTurn(ctxFor({ category: 'comp_complaint' }), COMP_TURN)
    expect(turn1.persisted).toMatchObject({ action: 'inserted' })
    const compCardId = turn1.persisted!.outboundMessageId as string
    const compCard = fake.snapshot(compCardId)
    expect(compCard?.pending_commitment).toMatchObject({ type: 'comp' })

    const turn2 = await runTurn(
      ctxFor({ category: 'new_question', held: true }),
      generation({ body: '7am on Sundays' }),
    )

    expect(turn2.decision).toMatchObject({
      action: 'queue',
      slot: 'conversation',
      existingPendingDraftId: null,
      otherSlotOccupied: true,
    })
    expect(turn2.persisted).toMatchObject({ action: 'inserted' })
    expect(fake.snapshot(compCardId)).toEqual(compCard)
    expect(fake.rows.filter((r) => r.review_state === 'pending').map((r) => r.body)).toEqual([
      COMP_REPLY,
      '7am on Sundays',
    ])
  })

  it('041: the comp card survives an unheld reply to the next question, which sends', async () => {
    const fake = useFake('041')

    const turn1 = await runTurn(ctxFor({ category: 'comp_complaint' }), COMP_TURN)
    const compCardId = turn1.persisted!.outboundMessageId as string
    const compCard = fake.snapshot(compCardId)

    const turn2 = await runTurn(
      ctxFor({ category: 'new_question' }),
      generation({ body: '7am on Sundays' }),
    )

    expect(turn2.decision).toEqual({ action: 'send' })
    expect(fake.snapshot(compCardId)).toEqual(compCard)
    expect(fake.rows.filter((r) => r.review_state === 'pending')).toHaveLength(1)
  })

  // Why migration 041 is applied BEFORE merge. New code against migration 020
  // cannot fit a second card: its INSERT hits 020's index, the slot re-read
  // finds the conversation slot empty, and after the bounded retries the turn
  // fails with a red alert. It fails loudly, and it still never overwrites the
  // comp card. That is the deploy-window answer for "merged before the index
  // swap", stated as a test.
  it('020 (new code, index swap not applied): a second card fails loudly and never overwrites the comp card', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const fake = useFake('020')

    const turn1 = await runTurn(ctxFor({ category: 'comp_complaint' }), COMP_TURN)
    const compCardId = turn1.persisted!.outboundMessageId as string
    const compCard = fake.snapshot(compCardId)

    await expect(
      runTurn(ctxFor({ category: 'new_question', held: true }), generation({ body: '7am on Sundays' })),
    ).rejects.toThrow(/exceeded 3 race-recovery attempts/)

    expect(fireRedAlertMock).toHaveBeenCalledWith(expect.objectContaining({ stage: 'persist' }))
    expect(fake.snapshot(compCardId)).toEqual(compCard)
    expect(fake.rows.filter((r) => r.review_state === 'pending')).toHaveLength(1)
  })
})

describe('race recovery decides a card the gate never saw (TAC-394)', () => {
  function seedCompCard(fake: ReturnType<typeof createPendingRowsFake>) {
    return fake.seed({
      id: 'card-a',
      venue_id: VENUE,
      guest_id: GUEST,
      review_state: 'pending',
      status: 'pending_review',
      review_reason: 'commitment_type_gated',
      body: COMP_REPLY,
      pending_commitment: compA,
      created_at: '2026-09-14T16:26:34.999Z',
    })
  }

  // The ruling's case again, reached through the race path: the gate's read
  // missed card A (a failed read or a concurrent run), so persistence is handed
  // existingPendingDraftId=null and the INSERT collides.
  it('comp A pending, a comp B INSERT collides: dropped, card A byte-identical', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const fake = useFake('041')
    seedCompCard(fake)
    const cardA = fake.snapshot('card-a')

    const result = await persistOrRegenQueuedDraft(
      ctxFor({ category: 'comp_complaint' }),
      generation({ body: 'a free croissant next time', commitment: { type: 'comp', description: 'a free croissant' } }),
      'commitment_type_gated',
      null,
      { reviewTriggers: ['commitment_type_gated'], callerPolicy: 'regen' },
    )

    expect(result).toEqual({
      outboundMessageId: null,
      action: 'dropped',
      priorReviewReason: null,
      reason: 'obligation_slot_taken',
      protectedDraftId: 'card-a',
      protectedCommitment: {
        type: 'comp',
        description: 'a free cortado on your next visit',
        code: '7K2P',
      },
      droppedCommitment: { type: 'comp', description: 'a free croissant', code: null },
    })
    expect(fake.snapshot('card-a')).toEqual(cardA)
    expect(fake.rows).toHaveLength(1)
  })

  // Wrong slot first: the comp card was inserted before the conversation card,
  // so an unordered single-row read would have handed recovery the comp card.
  it('a colliding conversation INSERT regenerates the conversation card, never the comp card inserted first', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const fake = useFake('041')
    seedCompCard(fake)
    fake.seed({
      id: 'card-conv',
      venue_id: VENUE,
      guest_id: GUEST,
      review_state: 'pending',
      review_reason: 'category_requires_approval',
      body: 'we open at 7',
      created_at: '2026-09-14T16:31:23.000Z',
    })
    const cardA = fake.snapshot('card-a')

    const result = await persistOrRegenQueuedDraft(
      ctxFor({ category: 'new_question', held: true }),
      generation({ body: '7am on Sundays' }),
      'category_requires_approval',
      null,
      { reviewTriggers: ['category_requires_approval'], callerPolicy: 'regen' },
    )

    expect(result).toEqual({
      outboundMessageId: 'card-conv',
      action: 'updated',
      priorReviewReason: 'category_requires_approval',
    })
    expect(fake.snapshot('card-a')).toEqual(cardA)
    expect(fake.snapshot('card-conv')?.body).toBe('7am on Sundays')
  })

  // The gate armed a clock without seeing this gap card. Regenerating it must
  // keep the card's deadline: pushing it out would let a chatty guest delay the
  // holding message, and re-arming a fired one would send it twice.
  it('regenerating a knowledge-gap card found by recovery keeps its original clock', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const fake = useFake('041')
    fake.seed({
      id: 'gap-conv',
      venue_id: VENUE,
      guest_id: GUEST,
      review_state: 'pending',
      review_reason: 'knowledge_gap',
      pending_until: '2026-09-14T16:30:00.000Z',
      body: '',
    })

    const result = await persistOrRegenQueuedDraft(
      ctxFor({ category: 'new_question' }),
      generation({ body: 'a second guess', knowledgeGap: true }),
      'knowledge_gap',
      null,
      {
        pendingUntil: new Date('2026-09-14T17:00:00.000Z'),
        blankBody: true,
        reviewTriggers: ['knowledge_gap'],
        callerPolicy: 'regen',
      },
    )

    expect(result).toMatchObject({ action: 'updated', outboundMessageId: 'gap-conv' })
    expect(fake.snapshot('gap-conv')?.pending_until).toBe('2026-09-14T16:30:00.000Z')
  })

  // The retry reads BOTH slots: a gap card in the other slot holds the guest's
  // clock, so the card recovery regenerates must not start a second one.
  it('a card recovery regenerates arms no clock while a gap card sits in the other slot', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const fake = useFake('041')
    fake.seed({
      id: 'gap-comp',
      venue_id: VENUE,
      guest_id: GUEST,
      review_state: 'pending',
      review_reason: 'knowledge_gap_backstop',
      pending_until: '2026-09-14T16:30:00.000Z',
      pending_commitment: compA,
      body: "Sorry about that. The next one's on us.",
    })
    fake.seed({
      id: 'conv',
      venue_id: VENUE,
      guest_id: GUEST,
      review_state: 'pending',
      review_reason: 'category_requires_approval',
      pending_until: null,
      body: '7am on Sundays',
    })

    const result = await persistOrRegenQueuedDraft(
      ctxFor({ category: 'new_question' }),
      generation({ body: 'a second guess', knowledgeGap: true }),
      'knowledge_gap',
      null,
      {
        pendingUntil: new Date('2026-09-14T17:00:00.000Z'),
        blankBody: true,
        reviewTriggers: ['knowledge_gap'],
        callerPolicy: 'regen',
      },
    )

    expect(result).toMatchObject({ action: 'updated', outboundMessageId: 'conv' })
    expect(fake.snapshot('conv')?.pending_until).toBeNull()
    expect(fake.snapshot('gap-comp')?.pending_until).toBe('2026-09-14T16:30:00.000Z')
  })

  // A re-read withheld the clock because of a gap card, then an operator acted
  // on that card before the regenerate landed. The card is gone, and so is the
  // reason: the card written in its place carries the clock the gate armed.
  it('when the gap card recovery found is handled mid-write, the card written in its place keeps the clock', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const fake = useFake('041')
    fake.seed({
      id: 'gap-conv',
      venue_id: VENUE,
      guest_id: GUEST,
      review_state: 'pending',
      review_reason: 'knowledge_gap',
      pending_until: '2026-09-14T16:30:00.000Z',
      body: '',
    })
    const real = fake.client
    mockAdmin.client = {
      from(table: string) {
        const t = real.from(table)
        return {
          ...t,
          update: (payload: Record<string, unknown>) => {
            // An operator approves the card between recovery's read and its write.
            const card = fake.rows.find((r) => r.id === 'gap-conv')
            if (card) card.review_state = 'approved'
            return t.update(payload)
          },
        }
      },
    }

    const result = await persistOrRegenQueuedDraft(
      ctxFor({ category: 'new_question' }),
      generation({ body: 'a second guess', knowledgeGap: true }),
      'knowledge_gap',
      null,
      {
        pendingUntil: new Date('2026-09-14T17:00:00.000Z'),
        blankBody: true,
        reviewTriggers: ['knowledge_gap'],
        callerPolicy: 'regen',
      },
    )

    expect(result.action).toBe('inserted')
    const written = fake.rows.find((r) => r.id === result.outboundMessageId)
    expect(written?.review_state).toBe('pending')
    expect(written?.pending_until).toBe('2026-09-14T17:00:00.000Z')
  })

  // The mirror case. Only the lost card leaves: a gap card still in the OTHER
  // slot keeps holding the guest's clock, so the card written in place of the
  // lost one must not start a second.
  it('when the card recovery regenerates is handled mid-write, a gap card in the other slot still withholds the clock', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const alertsBefore = fireRedAlertMock.mock.calls.length
    const fake = useFake('041')
    fake.seed({
      id: 'gap-comp',
      venue_id: VENUE,
      guest_id: GUEST,
      review_state: 'pending',
      review_reason: 'knowledge_gap_backstop',
      pending_until: '2026-09-14T16:30:00.000Z',
      pending_commitment: compA,
      body: "Sorry about that. The next one's on us.",
    })
    fake.seed({
      id: 'conv',
      venue_id: VENUE,
      guest_id: GUEST,
      review_state: 'pending',
      review_reason: 'category_requires_approval',
      pending_until: null,
      body: '7am on Sundays',
    })
    const real = fake.client
    mockAdmin.client = {
      from(table: string) {
        const t = real.from(table)
        return {
          ...t,
          update: (payload: Record<string, unknown>) => {
            // An operator approves the card between recovery's read and its write.
            const card = fake.rows.find((r) => r.id === 'conv')
            if (card) card.review_state = 'approved'
            return t.update(payload)
          },
        }
      },
    }

    const result = await persistOrRegenQueuedDraft(
      ctxFor({ category: 'new_question' }),
      generation({ body: 'a second guess', knowledgeGap: true }),
      'knowledge_gap',
      null,
      {
        pendingUntil: new Date('2026-09-14T17:00:00.000Z'),
        blankBody: true,
        reviewTriggers: ['knowledge_gap'],
        callerPolicy: 'regen',
      },
    )

    expect(result.action).toBe('inserted')
    const written = fake.rows.find((r) => r.id === result.outboundMessageId)
    expect(written?.review_state).toBe('pending')
    expect(written?.pending_until).toBeNull()
    expect(fake.snapshot('gap-comp')?.pending_until).toBe('2026-09-14T16:30:00.000Z')
    expect(
      fake.rows
        .filter((r) => r.review_state === 'pending')
        .map((r) => r.id)
        .sort(),
    ).toEqual(['gap-comp', String(result.outboundMessageId)].sort())
    expect(fireRedAlertMock.mock.calls.length).toBe(alertsBefore)
  })

  it('a manual followup that collides with an occupied slot is refused, and nothing is written', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const fake = useFake('041')
    fake.seed({
      id: 'waiting-card',
      venue_id: VENUE,
      guest_id: GUEST,
      review_state: 'pending',
      review_reason: 'model_flagged',
      body: 'an earlier draft an operator is about to approve',
    })
    const waiting = fake.snapshot('waiting-card')

    const result = await persistOrRegenQueuedDraft(
      ctxFor({ category: 'manual', held: true, manual: true }),
      generation({ body: 'checking in' }),
      'category_requires_approval',
      null,
      { reviewTriggers: ['category_requires_approval'], callerPolicy: 'never_regen' },
    )

    expect(result).toMatchObject({
      action: 'dropped',
      reason: 'slot_occupied',
      protectedDraftId: 'waiting-card',
    })
    expect(fake.snapshot('waiting-card')).toEqual(waiting)
    expect(fake.rows).toHaveLength(1)
  })

  it('the generation-failure card never overwrites an ordinary conversation card, even through recovery', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const fake = useFake('041')
    fake.seed({
      id: 'card-conv',
      venue_id: VENUE,
      guest_id: GUEST,
      review_state: 'pending',
      review_reason: 'model_flagged',
      body: 'a real draft',
    })
    const conv = fake.snapshot('card-conv')

    const result = await persistOrRegenQueuedDraft(
      ctxFor({ category: 'new_question' }),
      generation({ body: '(generation failed)' }),
      'generation_failed',
      null,
      { blankBody: true, callerPolicy: 'regen_gap_card_only' },
    )

    expect(result).toMatchObject({ action: 'dropped', reason: 'slot_occupied' })
    expect(fake.snapshot('card-conv')).toEqual(conv)
  })
})

describe('the gate reads the right slot whichever card was inserted first (TAC-394)', () => {
  it('a same-commitment comp regenerates the comp card when the conversation card was inserted first', async () => {
    const fake = useFake('041')
    fake.seed({
      id: 'card-conv',
      venue_id: VENUE,
      guest_id: GUEST,
      review_state: 'pending',
      review_reason: 'category_requires_approval',
      body: 'we open at 7',
    })
    fake.seed({
      id: 'card-a',
      venue_id: VENUE,
      guest_id: GUEST,
      review_state: 'pending',
      review_reason: 'commitment_type_gated',
      body: COMP_REPLY,
      pending_commitment: compA,
    })

    const turn = await runTurn(
      ctxFor({ category: 'comp_complaint' }),
      generation({
        body: 'So sorry. Your next cortado is on us.',
        commitment: { type: 'comp', description: 'A free cortado on your next visit' },
      }),
    )

    expect(turn.decision).toMatchObject({
      action: 'queue',
      slot: 'obligation',
      existingPendingDraftId: 'card-a',
    })
    expect(turn.persisted).toMatchObject({ action: 'updated', outboundMessageId: 'card-a' })
    expect(fake.snapshot('card-conv')?.body).toBe('we open at 7')
  })
})

describe('findPendingQuestion with a knowledge-gap card in each slot (TAC-394)', () => {
  // Both slots can hold a gap card: a blank self-reported card in the
  // conversation slot, a backstop-caught comp in the obligation slot. The NEWER
  // card is inserted first, so a read without ORDER BY returns the wrong one.
  it("returns the OLDEST card's question, whatever order the cards were inserted in", async () => {
    const fake = useFake('041')
    fake.seed({
      id: 'in-parking',
      venue_id: VENUE,
      guest_id: GUEST,
      direction: 'inbound',
      body: 'is there parking nearby?',
      provider_message_id: 'p-parking',
      created_at: '2026-09-14T16:00:00.000Z',
    })
    fake.seed({
      id: 'in-oat',
      venue_id: VENUE,
      guest_id: GUEST,
      direction: 'inbound',
      body: 'do you do oat milk?',
      provider_message_id: 'p-oat',
      created_at: '2026-09-14T16:15:00.000Z',
    })
    fake.seed({
      id: 'gap-comp',
      venue_id: VENUE,
      guest_id: GUEST,
      review_state: 'pending',
      review_reason: 'knowledge_gap_backstop',
      pending_until: '2026-09-14T16:25:00.000Z',
      pending_commitment: compA,
      reply_to_message_id: 'in-oat',
      created_at: '2026-09-14T16:20:00.000Z',
    })
    fake.seed({
      id: 'gap-conv',
      venue_id: VENUE,
      guest_id: GUEST,
      review_state: 'pending',
      review_reason: 'knowledge_gap',
      pending_until: null,
      reply_to_message_id: 'in-parking',
      created_at: '2026-09-14T16:10:00.000Z',
    })

    const loaded = await findPendingQuestion(VENUE, GUEST)

    expect(loaded?.draftId).toBe('gap-conv')
    expect(loaded?.question.question).toBe('is there parking nearby?')
  })
})


describe('a prose promise becomes a tracked commitment on the card (TAC-401)', () => {
  // The reply that measured as the live leak: A2 #40, eligible-perks arm. No
  // carrier, clean grounding, no self-flag, no regex, and it auto-sends at
  // Le Mil's today.
  const PROSE_PROMISE_REPLY =
    '7am every day. and sorry again about the cortado this morning, I want to make that right for you'

  const FLAGGED: ProsePromiseBackstopResult = {
    status: 'flagged',
    commitment: {
      type: 'comp',
      description: 'a replacement cortado',
      code: 'A1B2',
      expiresAt: null,
    },
  }

  it('041: the carrier the check named reaches messages.pending_commitment', async () => {
    const fake = useFake('041')
    const gen = generation({ body: PROSE_PROMISE_REPLY })

    const turn = await runTurn(ctxFor({ category: 'new_question' }), gen, 'regen', FLAGGED)

    expect(turn.persisted).toMatchObject({ action: 'inserted' })
    const row = fake.rows.find((r) => r.id === turn.persisted!.outboundMessageId)
    // This is the acceptance criterion: the promise is no longer an obligation
    // nothing tracks. dispatchOperatorOutbound reads this column on approval
    // and materializes a guest_commitments row from it.
    expect(row?.pending_commitment).toEqual({
      type: 'comp',
      description: 'a replacement cortado',
      code: 'A1B2',
      expiresAt: null,
    })
    expect(row?.review_reason).toBe('prose_promise_backstop')
  })

  it('041: the draft lands in the obligation slot, beside a conversation card', async () => {
    const fake = useFake('041')

    // A plain held reply takes the conversation slot first.
    const conversationTurn = await runTurn(
      ctxFor({ category: 'new_question' }),
      generation({ body: 'we open at 7', voiceFidelity: 0.5 }),
    )
    expect(conversationTurn.persisted).toMatchObject({ action: 'inserted' })

    // The promise takes the obligation slot rather than regenerating over it.
    const promiseTurn = await runTurn(
      ctxFor({ category: 'new_question' }),
      generation({ body: PROSE_PROMISE_REPLY }),
      'regen',
      FLAGGED,
    )
    expect(promiseTurn.persisted).toMatchObject({ action: 'inserted' })
    expect(promiseTurn.decision.action).toBe('queue')
    if (promiseTurn.decision.action !== 'queue') return
    expect(promiseTurn.decision.slot).toBe('obligation')
    expect(fake.rows.filter((r) => r.review_state === 'pending')).toHaveLength(2)
  })

  // RULING 3 AS NARROWED (2026-09-21), end to end, and this assertion is the
  // REVERSE of what it was: the model emitted a recommendation, the check
  // found a comp in the prose, and the COMP is what the row carries.
  //
  // A recommendation is an intention, not an obligation (TAC-380) — it costs
  // the venue nothing and carries no code — so it must never be the reason a
  // comp goes untracked. Under the old behaviour this card queued, an operator
  // approved it, and the guest_commitments row created was a drink suggestion
  // for a comp the venue owed.
  it('041: an obligation the check finds replaces a recommendation on the row', async () => {
    const fake = useFake('041')
    const gen = generation({
      body: PROSE_PROMISE_REPLY,
      commitment: { type: 'recommendation', description: 'the Blossom Tonic' },
    })

    const turn = await runTurn(ctxFor({ category: 'new_question' }), gen, 'regen', FLAGGED)

    expect(turn.persisted).toMatchObject({ action: 'inserted' })
    const row = fake.rows.find((r) => r.id === turn.persisted!.outboundMessageId)
    expect(row?.pending_commitment).toEqual({
      type: 'comp',
      description: 'a replacement cortado',
      code: 'A1B2',
      expiresAt: null,
    })
    // And it therefore moves to the obligation slot, which is what it is.
    if (turn.decision.action !== 'queue') return
    expect(turn.decision.slot).toBe('obligation')
  })

  // The half of the ruling that did not move, end to end. In production the
  // stage skips entirely on isCommitmentTypeGated, so the check never runs
  // here — this pins that a comp reaching the gate alongside a flagged verdict
  // still writes the model's own comp, unchanged, code and all.
  it('041: a comp generation emitted is written unchanged, never a second one', async () => {
    const fake = useFake('041')
    const gen = generation({
      body: PROSE_PROMISE_REPLY,
      commitment: { type: 'comp', description: 'the oat latte', code: 'Z9Y8' },
    })

    const turn = await runTurn(ctxFor({ category: 'new_question' }), gen, 'regen', FLAGGED)

    expect(turn.persisted).toMatchObject({ action: 'inserted' })
    const row = fake.rows.find((r) => r.id === turn.persisted!.outboundMessageId)
    expect(row?.pending_commitment).toEqual({
      type: 'comp',
      description: 'the oat latte',
      code: 'Z9Y8',
      expiresAt: null,
    })
  })

  it('041: a failed check queues the draft with no carrier at all', async () => {
    const fake = useFake('041')

    const turn = await runTurn(
      ctxFor({ category: 'new_question' }),
      generation({ body: PROSE_PROMISE_REPLY }),
      'regen',
      { status: 'check_failed' },
    )

    expect(turn.persisted).toMatchObject({ action: 'inserted' })
    const row = fake.rows.find((r) => r.id === turn.persisted!.outboundMessageId)
    expect(row?.pending_commitment).toBeNull()
    expect(row?.review_reason).toBe('prose_promise_check_failed')
  })
})


// TAC-401, and this is the regression the code review caught: a failed
// prose-promise check must NOT cost the guest a reply.
//
// The mechanism is TAC-367's, twelve lines above its own definition in
// stages.ts. A check that could not complete reports an ABSENCE of information
// about the reply, not a finding against it, so it is excluded from isGapTurn.
// That is right FORWARD (no clock, no protected card) and wrong BACKWARD: the
// trigger it pushes makes triggers.length > 0, which cancels the protected-card
// carve-out, and a turn that fired no trigger at all before this ticket — and
// therefore SENT — is destroyed instead. A guest already waiting on a
// knowledge-gap card would get silence because a Haiku call failed twice, which
// is worse than either failing open or failing closed.
describe('a failed prose-promise check never costs the guest a reply (TAC-401)', () => {
  function seedGapCard(fake: ReturnType<typeof useFake>) {
    fake.seed({
      id: 'gap-conv',
      venue_id: VENUE,
      guest_id: GUEST,
      review_state: 'pending',
      review_reason: 'knowledge_gap',
      pending_until: '2026-09-14T16:30:00.000Z',
      body: '',
    })
  }

  it('041: regenerates beside a protected knowledge-gap card instead of dropping', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const fake = useFake('041')
    seedGapCard(fake)

    const turn = await runTurn(
      ctxFor({ category: 'new_question' }),
      generation({ body: 'we open at 7 tomorrow' }),
      'regen',
      { status: 'check_failed' },
    )

    expect(turn.decision.action).toBe('queue')
    if (turn.decision.action !== 'queue') return
    expect(turn.decision.triggers).toContain('prose_promise_check_failed')
    expect(turn.persisted).toMatchObject({ action: 'updated', outboundMessageId: 'gap-conv' })
    // The card keeps its own clock, exactly as a truncated grounding check does.
    expect(fake.snapshot('gap-conv')?.pending_until).toBe('2026-09-14T16:30:00.000Z')
  })

  // The race-recovery mirror. gapFlagsFromTriggers is what 23505 recovery
  // decides with, and it reads the trigger STRINGS off the row rather than the
  // gate's own flags — so the two computations have to be widened together or
  // the gate spares a draft and recovery destroys it.
  it('041: recovery reaching the same card decides it the same way', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const fake = useFake('041')
    seedGapCard(fake)

    // existingPendingDraftId null: the gate never saw the card, so the INSERT
    // takes a 23505 and recovery has to decide it from the trigger set alone.
    const result = await persistOrRegenQueuedDraft(
      ctxFor({ category: 'new_question' }),
      generation({ body: 'we open at 7 tomorrow' }),
      'prose_promise_check_failed',
      null,
      {
        reviewTriggers: ['prose_promise_check_failed'],
        callerPolicy: 'regen',
      },
    )

    expect(result).toMatchObject({ action: 'updated', outboundMessageId: 'gap-conv' })
  })

  // The negative half. A check failure is an absence; a caught promise is a
  // finding, and a finding beside a protected card still drops, exactly as
  // every other non-gap trigger does.
  it('041: a FLAGGED promise beside a protected gap card still drops', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const fake = useFake('041')
    seedGapCard(fake)

    const turn = await runTurn(
      ctxFor({ category: 'new_question' }),
      generation({ body: "sorry about that, next one's on us" }),
      'regen',
      {
        status: 'flagged',
        commitment: {
          type: 'comp',
          description: 'a replacement cortado',
          code: 'A1B2',
          expiresAt: null,
        },
      },
    )

    // It lands in the OBLIGATION slot, which the gap card does not hold, so it
    // queues as a second card rather than dropping. The drop case is the one
    // below, where the carrier is null and both land in the conversation slot.
    expect(turn.decision.action).toBe('queue')
    if (turn.decision.action !== 'queue') return
    expect(turn.decision.slot).toBe('obligation')
  })

  it('041: a flagged promise the check could not NAME drops, like any other finding', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const fake = useFake('041')
    seedGapCard(fake)

    const turn = await runTurn(
      ctxFor({ category: 'new_question' }),
      generation({ body: "we'll sort you out next time" }),
      'regen',
      { status: 'flagged', commitment: null },
    )

    expect(turn.decision.action).toBe('drop')
    if (turn.decision.action !== 'drop') return
    expect(turn.decision.reason).toBe('knowledge_gap_card_protected')
    expect(turn.persisted).toBeNull()
  })
})

// TAC-513, end to end through the real gate and the real persist layer: the
// carrier has to reach the ROW, not just the decision. A per-mock assertion
// cannot show this, because a mock returns its fixture whatever it is handed.
describe('a cancellation reaches messages.pending_cancellation (TAC-513)', () => {
  const TONIC = {
    id: 'cfa37ed7-1041-4679-a258-92062726f4c2',
    type: 'comp' as const,
    description: 'replacement blossom tonic',
    code: 'GWPZ',
    status: 'open' as const,
    expected_arrival: null,
    arrival_signal: null,
    created_at: '2026-09-21T22:49:02.075Z',
  }

  it('writes the carrier onto the inserted row', async () => {
    const fake = useFake('041')
    const ctx = ctxFor({ category: 'reply' })
    const { decision, persisted } = await runTurn(
      ctx,
      generation({ body: "got it, just the cortado then. that one's off." }),
      'regen',
      { status: 'skipped' },
      {
        resolution: {
          status: 'resolved',
          cancellation: { commitmentId: TONIC.id },
          commitment: TONIC,
        },
        claim: 'skipped',
      },
    )
    expect(decision.action).toBe('queue')
    expect(persisted?.action).toBe('inserted')
    const row = fake.rows.at(-1)
    expect(row?.pending_cancellation).toEqual({ commitmentId: TONIC.id })
  })

  it('leaves the column null on an ordinary queued draft', async () => {
    const fake = useFake('041')
    const ctx = ctxFor({ category: 'comp_complaint' })
    await runTurn(ctx, COMP_TURN)
    const row = fake.rows.at(-1)
    expect(row?.pending_cancellation ?? null).toBeNull()
  })

  // The REGEN path, and it is the dangerous one. TAC-264 rewrites a pending
  // card in place when the guest's next turn queues into the same slot, so a
  // regen that merely OMITS the column leaves Postgres holding the previous
  // draft's carrier. The operator then reads a reply about opening hours,
  // approves it, and a comp is cancelled that nothing on the card mentioned
  // and the guest was never told about.
  //
  // The INSERT case above cannot catch that: it never runs the UPDATE
  // statement, which is a second, independent expression. A mutant deleting
  // the column from the regen payload survived the whole suite.
  it('CLEARS a stale carrier when the card is regenerated by a turn that cancels nothing', async () => {
    const fake = useFake('041')
    const ctx = ctxFor({ category: 'reply' })

    const first = await runTurn(
      ctx,
      generation({ body: "got it, just the cortado then. that one's off." }),
      'regen',
      { status: 'skipped' },
      {
        resolution: {
          status: 'resolved',
          cancellation: { commitmentId: TONIC.id },
          commitment: TONIC,
        },
        claim: 'skipped',
      },
    )
    expect(first.persisted?.action).toBe('inserted')
    expect(fake.rows.at(-1)?.pending_cancellation).toEqual({ commitmentId: TONIC.id })
    const cardId = first.persisted?.outboundMessageId

    // The guest's next turn: a plain question, queued into the SAME slot, so
    // the gate regenerates the card in place rather than opening a second one.
    const second = await runTurn(
      ctx,
      generation({ body: "we're open till 3 tomorrow" }),
      'regen',
    )
    expect(second.persisted?.action).toBe('updated')
    expect(second.persisted?.outboundMessageId).toBe(cardId)

    const regenerated = fake.rows.find((r) => r.id === cardId)
    expect(regenerated?.body).toContain('open till 3')
    expect(regenerated?.pending_cancellation ?? null).toBeNull()
  })
})
