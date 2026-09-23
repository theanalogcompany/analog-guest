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
import { APPROVAL_TRIGGERS } from './stages'
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

function ctxFor(opts: {
  category: string
  held?: boolean
  manual?: boolean
  // TAC-397: the classifier's judgement that this message amends the question
  // the pending card is answering. Defaults false, which is `own_card` — a
  // second question gets its own card, the shipped behaviour.
  corrects?: boolean
  // TAC-397: migration 054 keys the conversation index on the inbound, so two
  // turns of one exchange must carry DIFFERENT ids or they collide. Defaults
  // to the single id every pre-existing test in this file used.
  inboundId?: string
  body?: string
}): RuntimeContext {
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
          id: opts.inboundId ?? 'inbound-1',
          body: opts.body ?? 'what time do you open on sundaus',
          providerMessageId: 'p1',
          receivedAt: new Date(),
        },
    followupTrigger: opts.manual ? { reason: 'manual', triggeredAt: new Date() } : null,
    classification: {
      category: opts.category,
      classifierConfidence: 0.9,
      reasoning: 'test',
      crisisSafety: false,
      // TAC-397: stated rather than omitted. This fixture casts through
      // `unknown`, so a missing field is invisible to tsc and every test here
      // would silently read `undefined` — which resolves to own_card and would
      // make the correction tests below assert the opposite of their names.
      correctsPendingReply: opts.corrects === true,
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
    promptVersion: 'v1.65.0',
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
      // TAC-397: same reasoning as the two lines above. Dropping either is a
      // mutant the replay below kills and no per-mock assertion would — the
      // replaced text would silently never reach the row, and recovery would
      // decide a card the gate never saw differently from the gate.
      captureReplacedDraft: decision.captureReplacedDraft,
      conversationDisposition: decision.conversationDisposition,
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
  it('054: the comp card survives a held reply to the next question, which becomes a second card', async () => {
    const fake = useFake('054')

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

  it('054: the comp card survives an unheld reply to the next question, which sends', async () => {
    const fake = useFake('054')

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

  // TAC-397: the same answer one migration later, and the reason migration 054
  // is applied BEFORE merge. New code against migration 041 cannot fit a
  // SECOND CONVERSATION card: the INSERT hits 041's per-guest conversation
  // index, recovery finds no card for this inbound, decides `insert` again,
  // and the bounded retries end in a red alert.
  //
  // It fails loudly and never overwrites the first card, which is the same
  // shape as the 020 case above — but it fails on exactly the turn this ticket
  // exists to fix, so it is worth its own test rather than being assumed from
  // the 020 one.
  it('041 (new code, 054 not applied): a second conversation card fails loudly and overwrites nothing', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const fake = useFake('041')

    const turn1 = await runTurn(
      ctxFor({ category: 'new_question', held: true }),
      generation({ body: 'we open at 7' }),
    )
    const firstCardId = turn1.persisted!.outboundMessageId as string
    const firstCard = fake.snapshot(firstCardId)

    // A DIFFERENT inbound, so under migration 054 this would be its own card.
    const secondCtx = ctxFor({ category: 'new_question', held: true })
    ;(secondCtx as { currentMessage: { id: string } }).currentMessage.id = 'inbound-2'

    await expect(
      runTurn(secondCtx, generation({ body: 'and we close at 3' })),
    ).rejects.toThrow(/exceeded 3 race-recovery attempts/)

    expect(fireRedAlertMock).toHaveBeenCalledWith(expect.objectContaining({ stage: 'persist' }))
    expect(fake.snapshot(firstCardId)).toEqual(firstCard)
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
    const fake = useFake('054')
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
    const fake = useFake('054')
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
      ctxFor({ category: 'new_question', held: true, manual: true }),
      generation({ body: '7am on Sundays' }),
      'category_requires_approval',
      null,
      {
        reviewTriggers: ['category_requires_approval'],
        callerPolicy: 'regen',
        conversationDisposition: 'correction',
      },
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
    const fake = useFake('054')
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
      // TAC-397: no inbound, so this draft's reply_to_message_id is NULL and
      // collides with the seeded card through migration 054's coalesce
      // sentinel — the proactive-card collision that sentinel exists for.
      // With an inbound the two keys differ and the INSERT simply succeeds.
      ctxFor({ category: 'new_question', manual: true }),
      generation({ body: 'a second guess', knowledgeGap: true }),
      'knowledge_gap',
      null,
      {
        pendingUntil: new Date('2026-09-14T17:00:00.000Z'),
        blankBody: true,
        reviewTriggers: ['knowledge_gap'],
        callerPolicy: 'regen',
        conversationDisposition: 'correction',
      },
    )

    expect(result).toMatchObject({ action: 'updated', outboundMessageId: 'gap-conv' })
    expect(fake.snapshot('gap-conv')?.pending_until).toBe('2026-09-14T16:30:00.000Z')
  })

  // The retry reads BOTH slots: a gap card in the other slot holds the guest's
  // clock, so the card recovery regenerates must not start a second one.
  it('a card recovery regenerates arms no clock while a gap card sits in the other slot', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const fake = useFake('054')
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
      // TAC-397: no inbound, so this draft's reply_to_message_id is NULL and
      // collides with the seeded card through migration 054's coalesce
      // sentinel — the proactive-card collision that sentinel exists for.
      // With an inbound the two keys differ and the INSERT simply succeeds.
      ctxFor({ category: 'new_question', manual: true }),
      generation({ body: 'a second guess', knowledgeGap: true }),
      'knowledge_gap',
      null,
      {
        pendingUntil: new Date('2026-09-14T17:00:00.000Z'),
        blankBody: true,
        reviewTriggers: ['knowledge_gap'],
        callerPolicy: 'regen',
        conversationDisposition: 'correction',
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
    const fake = useFake('054')
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
      // TAC-397: no inbound, so this draft's reply_to_message_id is NULL and
      // collides with the seeded card through migration 054's coalesce
      // sentinel — the proactive-card collision that sentinel exists for.
      // With an inbound the two keys differ and the INSERT simply succeeds.
      ctxFor({ category: 'new_question', manual: true }),
      generation({ body: 'a second guess', knowledgeGap: true }),
      'knowledge_gap',
      null,
      {
        pendingUntil: new Date('2026-09-14T17:00:00.000Z'),
        blankBody: true,
        reviewTriggers: ['knowledge_gap'],
        callerPolicy: 'regen',
        conversationDisposition: 'correction',
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
    const fake = useFake('054')
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
      // TAC-397: no inbound, so this draft's reply_to_message_id is NULL and
      // collides with the seeded card through migration 054's coalesce
      // sentinel — the proactive-card collision that sentinel exists for.
      // With an inbound the two keys differ and the INSERT simply succeeds.
      ctxFor({ category: 'new_question', manual: true }),
      generation({ body: 'a second guess', knowledgeGap: true }),
      'knowledge_gap',
      null,
      {
        pendingUntil: new Date('2026-09-14T17:00:00.000Z'),
        blankBody: true,
        reviewTriggers: ['knowledge_gap'],
        callerPolicy: 'regen',
        conversationDisposition: 'correction',
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
    const fake = useFake('054')
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
    const fake = useFake('054')
    fake.seed({
      id: 'card-conv',
      venue_id: VENUE,
      guest_id: GUEST,
      review_state: 'pending',
      review_reason: 'model_flagged',
      body: 'a real draft',
      // TAC-397: migration 054 keys the conversation index on the inbound, so
      // reaching race recovery at all now needs the collision to be real —
      // i.e. this card answers the same message. Without it the INSERT simply
      // succeeds and the test stops exercising recovery.
      reply_to_message_id: 'inbound-1',
    })
    const conv = fake.snapshot('card-conv')

    const result = await persistOrRegenQueuedDraft(
      // This one keeps its inbound: the seeded card answers the SAME message
      // ('inbound-1'), which is what makes the INSERT collide under migration
      // 054. The ownDraft shortcut does not apply because the caller policy is
      // regen_gap_card_only, so recovery falls through to decideSlotAction and
      // refuses, which is the property under test.
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
    const fake = useFake('054')
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
    const fake = useFake('054')
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

  it('054: the carrier the check named reaches messages.pending_commitment', async () => {
    const fake = useFake('054')
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

  it('054: the draft lands in the obligation slot, beside a conversation card', async () => {
    const fake = useFake('054')

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
  it('054: an obligation the check finds replaces a recommendation on the row', async () => {
    const fake = useFake('054')
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
  it('054: a comp generation emitted is written unchanged, never a second one', async () => {
    const fake = useFake('054')
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

  it('054: a failed check queues the draft with no carrier at all', async () => {
    const fake = useFake('054')

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


// TAC-527: the 2026-09-23 incident, replayed end to end.
//
// Deliberately in THIS file rather than a new prose-promise-carrier-replay.ts:
// the harness here runs the REAL gate and the REAL persist layer against an
// in-memory messages table, so it can assert the persisted row. A new file
// would have had to duplicate that fake to make a weaker claim.
describe('the 2026-09-23 gulab jamun exchange (TAC-527)', () => {
  // Verbatim from the incident. It trips matchComp on "on us", which is why
  // the reply WAS held; what it did not do was carry anything.
  const INCIDENT_REPLY = "ugh, that's on us too. really sorry, Jaipal 🙏"

  // What the widened check returns for that reply once it can see the guest's
  // message. The description comes from the guest's message, which is the only
  // place the item is ever named.
  const FLAGGED_GULAB: ProsePromiseBackstopResult = {
    status: 'flagged',
    commitment: {
      type: 'comp',
      description: 'a replacement gulab jamun',
      code: 'G1H2',
      expiresAt: null,
    },
  }

  // AC1. Before this ticket the row below carried pending_commitment: null,
  // the operator approved it, and nothing was created.
  it('054: approving the held reply now has a comp to create', async () => {
    const fake = useFake('054')

    const turn = await runTurn(
      ctxFor({ category: 'comp_complaint' }),
      generation({ body: INCIDENT_REPLY }),
      'regen',
      FLAGGED_GULAB,
    )

    expect(turn.persisted).toMatchObject({ action: 'inserted' })
    const row = fake.rows.find((r) => r.id === turn.persisted!.outboundMessageId)
    expect(row?.pending_commitment).toEqual({
      type: 'comp',
      description: 'a replacement gulab jamun',
      code: 'G1H2',
      expiresAt: null,
    })
  })

  // The incident's own trigger set, plus the one that was missing from it.
  // comp_regex_backstop still fires — nothing about this ticket removes it —
  // and prose_promise_backstop outranks it in PRIMARY_TRIGGER_PRIORITY, so the
  // card's primary label is the one that can name what approving creates.
  it('054: both detectors fire, and the prose-promise label wins the card', async () => {
    const fake = useFake('054')

    const turn = await runTurn(
      ctxFor({ category: 'comp_complaint' }),
      generation({ body: INCIDENT_REPLY }),
      'regen',
      FLAGGED_GULAB,
    )

    const row = fake.rows.find((r) => r.id === turn.persisted!.outboundMessageId)
    expect(row?.review_triggers).toContain('comp_regex_backstop')
    expect(row?.review_triggers).toContain('prose_promise_backstop')
    expect(row?.review_reason).toBe('prose_promise_backstop')
  })

  // AC2, and the shape of the assertion is the point. The carrier resolution
  // never reads the trigger set, so the guard varies the ONE input that flips
  // matchComp — the body — while holding the check's verdict fixed, and
  // requires the persisted carrier to be identical. A future change that
  // special-cases either trigger fails here.
  it('054: the carrier is identical whichever detector fired', async () => {
    // Trips matchComp ("on us") AND flagged.
    const bothFake = useFake('054')
    const both = await runTurn(
      ctxFor({ category: 'comp_complaint' }),
      generation({ body: INCIDENT_REPLY }),
      'regen',
      FLAGGED_GULAB,
    )
    const bothRow = bothFake.rows.find((r) => r.id === both.persisted!.outboundMessageId)

    // Trips NO comp pattern, flagged all the same. This is TAC-401's own
    // population: a promise the regex cannot see.
    const proseOnlyFake = useFake('054')
    const proseOnly = await runTurn(
      ctxFor({ category: 'comp_complaint' }),
      generation({ body: 'I want to make that right for you' }),
      'regen',
      FLAGGED_GULAB,
    )
    const proseRow = proseOnlyFake.rows.find(
      (r) => r.id === proseOnly.persisted!.outboundMessageId,
    )

    expect(bothRow?.pending_commitment).toEqual(proseRow?.pending_commitment)
    expect(bothRow?.pending_commitment).toEqual({
      type: 'comp',
      description: 'a replacement gulab jamun',
      code: 'G1H2',
      expiresAt: null,
    })
    // And the trigger sets genuinely differ, so the equality above is a real
    // comparison rather than two identical runs.
    expect(bothRow?.review_triggers).toContain('comp_regex_backstop')
    expect(proseRow?.review_triggers).not.toContain('comp_regex_backstop')
  })

  // AC5 on the residual path: the regex fires, the check still says clean, and
  // NOTHING is minted from the regex alone. That matters because the regex has
  // fired twice in production and one of those was a false positive on a
  // refusal ("A refund isn't something I can do over text").
  it('054: a regex hit with a clean check carries nothing', async () => {
    const fake = useFake('054')

    const turn = await runTurn(
      ctxFor({ category: 'comp_complaint' }),
      generation({ body: INCIDENT_REPLY }),
      'regen',
      { status: 'clean' },
    )

    expect(turn.persisted).toMatchObject({ action: 'inserted' })
    const row = fake.rows.find((r) => r.id === turn.persisted!.outboundMessageId)
    expect(row?.pending_commitment).toBeNull()
    expect(row?.review_reason).toBe('comp_regex_backstop')
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

  // TAC-397 strengthens this: the turn now gets its OWN card rather than
  // regenerating the gap card. Better than either earlier answer — the guest's
  // outstanding question keeps its card AND this reply keeps its text. The
  // property under test is unchanged: a failed check never costs a reply.
  it('054: gets its own card beside a protected knowledge-gap card, losing neither', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const fake = useFake('054')
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
    expect(turn.persisted).toMatchObject({ action: 'inserted' })
    // The gap card is untouched — body, clock and all.
    expect(fake.snapshot('gap-conv')?.pending_until).toBe('2026-09-14T16:30:00.000Z')
    expect(fake.snapshot('gap-conv')?.body).toBe('')
    // And the guest now holds two conversation cards, which is the point.
    expect(fake.rows.filter((r) => r.review_state === 'pending')).toHaveLength(2)
  })

  // The race-recovery mirror. gapFlagsFromTriggers is what 23505 recovery
  // decides with, and it reads the trigger STRINGS off the row rather than the
  // gate's own flags — so the two computations have to be widened together or
  // the gate spares a draft and recovery destroys it.
  it('054: recovery reaching the same card decides it the same way', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const fake = useFake('054')
    seedGapCard(fake)

    // existingPendingDraftId null: the gate never saw the card, so the INSERT
    // takes a 23505 and recovery has to decide it from the trigger set alone.
    //
    // TAC-397: no inbound, so this draft's key is the coalesce sentinel and it
    // collides with the seeded proactive card. With an inbound the keys differ
    // and there is no 23505 to recover from at all.
    const result = await persistOrRegenQueuedDraft(
      ctxFor({ category: 'new_question', manual: true }),
      generation({ body: 'we open at 7 tomorrow' }),
      'prose_promise_check_failed',
      null,
      {
        reviewTriggers: ['prose_promise_check_failed'],
        callerPolicy: 'regen',
        // Recovery decides exactly as the gate would, and the gate only
        // regenerates on a correction.
        conversationDisposition: 'correction',
      },
    )

    expect(result).toMatchObject({ action: 'updated', outboundMessageId: 'gap-conv' })
  })

  // The negative half. A check failure is an absence; a caught promise is a
  // finding, and a finding beside a protected card still drops, exactly as
  // every other non-gap trigger does.
  it('054: a FLAGGED promise beside a protected gap card still drops', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const fake = useFake('054')
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

  // TAC-397 REWRITES this. It asserted `knowledge_gap_card_protected`, which
  // is now UNREACHABLE on the conversation slot: ruling Q3 removed that drop
  // because an unrelated turn no longer overwrites the gap card, it opens its
  // own. Left as it was, the test would have kept passing only until someone
  // noticed it was asserting a drop the ticket deleted.
  //
  // The property it existed for survives and is stronger: a finding beside a
  // protected card costs the guest nothing. It used to cost them this reply.
  it('054: a flagged promise the check could not NAME gets its own card, costing nothing', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const fake = useFake('054')
    seedGapCard(fake)

    const turn = await runTurn(
      ctxFor({ category: 'new_question' }),
      generation({ body: "we'll sort you out next time" }),
      'regen',
      { status: 'flagged', commitment: null },
    )

    expect(turn.decision.action).toBe('queue')
    if (turn.decision.action !== 'queue') return
    expect(turn.decision.slot).toBe('conversation')
    expect(turn.persisted).toMatchObject({ action: 'inserted' })
    // The gap card is untouched.
    expect(fake.snapshot('gap-conv')?.body).toBe('')
    expect(fake.snapshot('gap-conv')?.pending_until).toBe('2026-09-14T16:30:00.000Z')
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
    const fake = useFake('054')
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
    const fake = useFake('054')
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
    const fake = useFake('054')
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

    // The guest's next turn. TAC-397: a regen in place now happens only on a
    // CORRECTION — an unrelated question would open its own card and leave
    // this one's carrier alone, which is a different test. The property here
    // is that the regen CLEARS a stale cancellation, so the turn has to be the
    // kind that regenerates.
    const second = await runTurn(
      ctxFor({ category: 'reply', corrects: true }),
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

// ---------------------------------------------------------------------------
// TAC-397: the 2026-09-18 Le Mil's exchange, replayed against the real gate
// and the real persist layer.
//
//   16:07  guest: any events coming up?
//          agent: a draft about the events, QUEUED for review.
//   16:10  guest: my sofi was flat
//          agent: a draft apologising, which REGENERATED the events draft out
//                 of existence. The events question was never answered.
//
// Migration 041 allowed one conversation card per guest and TAC-264
// regenerates that card in place, so the second reply overwrote the first.
// Measured at roughly 4 in 10 regens, the replacement answered only the newest
// message (TAC-394 PR 1).
//
// Replayed with FIXTURE ROW STATE rather than live model calls: the routing is
// what this ticket changed, and a live generation would make the test a
// measurement of the model instead of a test of the mechanism. The classifier
// judgement each turn is stated, which is exactly what the pre-registered
// measurement harness exists to check separately.
//
// The NEGATIVE CONTROL is the same exchange under migration 041's index: it
// reproduces the incident. Without it, "two cards, neither question lost"
// could pass against a fake that simply never collides.
// ---------------------------------------------------------------------------
describe("TAC-397 replay: the events-then-SoFi exchange (Le Mil's, 2026-09-18)", () => {
  const EVENTS_Q = 'any events coming up?'
  const EVENTS_A = "we've got an open mic on the 24th and a cupping the week after"
  const SOFI_COMPLAINT = 'my sofi was flat'
  const SOFI_A = "sorry about that, that's not how it should taste"
  // TAC-513's commitment shape, local to this block.
  const CANCELLED_TONIC = {
    id: 'cfa37ed7-1041-4679-a258-92062726f4c2',
    type: 'comp' as const,
    description: 'replacement blossom tonic',
    code: 'GWPZ',
    status: 'open' as const,
    expected_arrival: null,
    arrival_signal: null,
    created_at: '2026-09-21T22:49:02.075Z',
  }

  async function replay() {
    const first = await runTurn(
      ctxFor({ category: 'event_question', held: true, inboundId: 'in-events', body: EVENTS_Q }),
      generation({ body: EVENTS_A }),
    )
    const second = await runTurn(
      // The SoFi complaint is a NEW subject, not an amendment of the events
      // question, so the classifier says false and the disposition is own_card.
      ctxFor({
        category: 'comp_complaint',
        held: true,
        inboundId: 'in-sofi',
        body: SOFI_COMPLAINT,
        corrects: false,
      }),
      generation({ body: SOFI_A }),
    )
    return { first, second }
  }

  it('produces TWO cards and loses neither question', async () => {
    const fake = useFake('054')
    const { first, second } = await replay()

    expect(first.persisted?.action).toBe('inserted')
    expect(second.persisted?.action).toBe('inserted')
    expect(first.persisted?.outboundMessageId).not.toBe(second.persisted?.outboundMessageId)

    const pending = fake.rows.filter((r) => r.review_state === 'pending')
    expect(pending).toHaveLength(2)

    // The events answer is still there, byte-identical, answering its own
    // inbound. That is the whole acceptance criterion.
    const events = fake.snapshot(first.persisted!.outboundMessageId as string)
    expect(events?.body).toBe(EVENTS_A)
    expect(events?.reply_to_message_id).toBe('in-events')

    const sofi = fake.snapshot(second.persisted!.outboundMessageId as string)
    expect(sofi?.body).toBe(SOFI_A)
    expect(sofi?.reply_to_message_id).toBe('in-sofi')

    // Neither card claims to have replaced anything, because neither did.
    expect(events?.replaced_draft_body ?? null).toBeNull()
    expect(sofi?.replaced_draft_body ?? null).toBeNull()
  })

  it('the second card does NOT claim it was held behind the first', async () => {
    useFake('054')
    const { second } = await replay()
    expect(second.decision.action).toBe('queue')
    if (second.decision.action !== 'queue') return
    // previous_pending_held would be false here: nothing was replaced.
    expect(second.decision.triggers).not.toContain(APPROVAL_TRIGGERS.PREVIOUS_PENDING_HELD)
    expect(second.decision.existingPendingDraftId).toBeNull()
    // It does report that the guest has another card waiting, which is true.
    expect(second.decision.otherSlotOccupied).toBe(false)
  })

  // NEGATIVE CONTROL. Without one, "two cards, neither question lost" could
  // pass against a fake that simply never collides, or against a routing layer
  // that had stopped consulting the disposition at all.
  //
  // The control is the SAME exchange with the SoFi complaint judged a
  // correction instead. That reproduces the incident exactly — one card, the
  // events answer overwritten — which shows the two-card result above comes
  // from the disposition and nothing else.
  //
  // It is NOT run under migration 041, deliberately: new code against 041
  // cannot reproduce the old behaviour, it red-alerts on the second card. That
  // is the deploy-window failure, and it has its own test above.
  it('CONTROL: judged a correction instead, the same exchange overwrites the events answer', async () => {
    const fake = useFake('054')

    const first = await runTurn(
      ctxFor({ category: 'event_question', held: true, inboundId: 'in-events', body: EVENTS_Q }),
      generation({ body: EVENTS_A }),
    )
    const eventsCardId = first.persisted!.outboundMessageId as string
    expect(fake.snapshot(eventsCardId)?.body).toBe(EVENTS_A)

    const second = await runTurn(
      ctxFor({
        category: 'comp_complaint',
        held: true,
        inboundId: 'in-sofi',
        body: SOFI_COMPLAINT,
        corrects: true,
      }),
      generation({ body: SOFI_A }),
    )

    // One card, and it is the events card with the SoFi reply written over it.
    expect(fake.rows.filter((r) => r.review_state === 'pending')).toHaveLength(1)
    expect(second.persisted?.outboundMessageId).toBe(eventsCardId)
    expect(fake.snapshot(eventsCardId)?.body).toBe(SOFI_A)
    // The difference from the incident: the replaced text is KEPT, so the
    // operator can see what the correction displaced rather than losing it.
    expect(fake.snapshot(eventsCardId)?.replaced_draft_body).toBe(EVENTS_A)
  })

  // The third case, on the same exchange: had the guest AMENDED the events
  // question instead of changing the subject, the card is rewritten in place
  // and keeps what it replaced, so the operator can compare.
  it('an amendment of the events question rewrites that card and keeps the old text', async () => {
    const fake = useFake('054')
    const first = await runTurn(
      ctxFor({ category: 'event_question', held: true, inboundId: 'in-events', body: EVENTS_Q }),
      generation({ body: EVENTS_A }),
    )
    const cardId = first.persisted!.outboundMessageId as string

    const second = await runTurn(
      ctxFor({
        category: 'event_question',
        held: true,
        inboundId: 'in-amend',
        body: 'sorry i meant this weekend',
        corrects: true,
      }),
      generation({ body: 'nothing this weekend, next one is the 24th' }),
    )

    expect(second.persisted?.action).toBe('updated')
    expect(second.persisted?.outboundMessageId).toBe(cardId)
    expect(fake.rows.filter((r) => r.review_state === 'pending')).toHaveLength(1)

    const card = fake.snapshot(cardId)
    expect(card?.body).toBe('nothing this weekend, next one is the 24th')
    expect(card?.replaced_draft_body).toBe(EVENTS_A)
    expect(typeof card?.replaced_draft_at).toBe('string')
    // The card now answers the amending message.
    expect(card?.reply_to_message_id).toBe('in-amend')
  })

  // held: FALSE deliberately. At an auto_send venue nothing else fires, so the
  // gate's own early return is the only thing that can produce silence —
  // decideSlotAction is never reached, because `triggers.length === 0` would
  // have returned `send` first.
  //
  // Found by a code-review mutant: deleting that early return passed the
  // entire suite, because the only silence test then used held: true, where
  // category_requires_approval fires and decideSlotAction's own silence branch
  // gives the same answer. The redundancy hid the one case that matters.
  it('a message needing no answer leaves the events card byte-identical (auto_send venue)', async () => {
    const fake = useFake('054')
    const first = await runTurn(
      ctxFor({ category: 'event_question', held: true, inboundId: 'in-events', body: EVENTS_Q }),
      generation({ body: EVENTS_A }),
    )
    const cardId = first.persisted!.outboundMessageId as string
    const before = fake.snapshot(cardId)

    const second = await runTurn(
      ctxFor({ category: 'acknowledgment', held: false, inboundId: 'in-haha', body: 'haha' }),
      generation({ body: 'glad you think so' }),
    )

    expect(second.decision.action).toBe('silence')
    expect(second.persisted).toBeNull()
    expect(fake.rows.filter((r) => r.review_state === 'pending')).toHaveLength(1)
    expect(fake.snapshot(cardId)).toEqual(before)
  })

  // The sibling at a holding venue, so both paths to silence stay covered.
  it('a message needing no answer is silenced at a holding venue too', async () => {
    const fake = useFake('054')
    await runTurn(
      ctxFor({ category: 'event_question', held: true, inboundId: 'in-events', body: EVENTS_Q }),
      generation({ body: EVENTS_A }),
    )
    const second = await runTurn(
      ctxFor({ category: 'acknowledgment', held: true, inboundId: 'in-haha', body: 'haha' }),
      generation({ body: 'glad you think so' }),
    )
    expect(second.decision.action).toBe('silence')
    expect(fake.rows.filter((r) => r.review_state === 'pending')).toHaveLength(1)
  })

  // TAC-397 + TAC-513: a draft that WITHDRAWS a promise is never silenced,
  // however chatty the guest's message reads. Found in code review: the
  // silence guard excludes an obligation carrier by slot, and a cancellation
  // carrier is invisible to that check, so a resolved withdrawal was being
  // discarded with the draft.
  it('a cancellation is never silenced, even on a chatter turn', async () => {
    const fake = useFake('054')
    await runTurn(
      ctxFor({ category: 'event_question', held: true, inboundId: 'in-events', body: EVENTS_Q }),
      generation({ body: EVENTS_A }),
    )

    const second = await runTurn(
      ctxFor({
        category: 'acknowledgment',
        held: false,
        inboundId: 'in-nevermind',
        body: "nah don't worry about it",
      }),
      generation({ body: "no problem, that one's off then" }),
      'regen',
      { status: 'skipped' },
      {
        resolution: {
          status: 'resolved',
          cancellation: { commitmentId: CANCELLED_TONIC.id },
          commitment: CANCELLED_TONIC,
        },
        claim: 'skipped',
      },
    )

    expect(second.decision.action).not.toBe('silence')
    expect(second.persisted?.action).toBe('inserted')
    expect(fake.rows.at(-1)?.pending_cancellation).toEqual({
      commitmentId: CANCELLED_TONIC.id,
    })
  })

  // TAC-397: the replaced text is CLEARED on a regen that is not a correction.
  // Found by a review mutant: writing priorBody unconditionally passed the
  // whole suite, so a card corrected once and later rewritten by the operator
  // decline would keep showing text displaced for an unrelated reason, labelled
  // as what the guest had just amended.
  it('a later non-correction regen CLEARS the replaced text', async () => {
    const fake = useFake('054')
    const first = await runTurn(
      ctxFor({ category: 'event_question', held: true, inboundId: 'in-events', body: EVENTS_Q }),
      generation({ body: EVENTS_A }),
    )
    const cardId = first.persisted!.outboundMessageId as string

    await runTurn(
      ctxFor({
        category: 'event_question',
        held: true,
        inboundId: 'in-amend',
        body: 'sorry i meant this weekend',
        corrects: true,
      }),
      generation({ body: 'nothing this weekend' }),
    )
    expect(fake.snapshot(cardId)?.replaced_draft_body).toBe(EVENTS_A)

    // Now the operator declines a commitment, which regenerates the same card
    // under regen_always — not a correction.
    await persistOrRegenQueuedDraft(
      ctxFor({ category: 'manual', held: true, manual: true }),
      generation({ body: "sorry, we can't do that one after all" }),
      'operator_decline_initiated',
      cardId,
      { callerPolicy: 'regen_always', conversationDisposition: null },
    )

    expect(fake.snapshot(cardId)?.replaced_draft_body).toBeNull()
    expect(fake.snapshot(cardId)?.replaced_draft_at).toBeNull()
  })
})
