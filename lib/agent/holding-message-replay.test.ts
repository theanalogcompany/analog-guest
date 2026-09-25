// TAC-484: the 2026-09-18 Le Mil's exchange, replayed against the real gate,
// the real persist layer and the real findPendingQuestion.
//
// What the guest received, all four auto-sent:
//
//   agent: still tracking that down, sorry for the wait.
//   guest: tracking what?
//   agent: oh, we owe you an answer on the Pink Panther from yesterday.
//   guest: what did i ask?
//   agent: ha, sorry for the confusion. you mentioned the Pink Panther you had
//          yesterday and i got curious about it.
//   guest: you're confusing me
//   agent: ha, fair enough. ignore me, we're good
//
// The guest had asked nothing. They reported an order: "oh and i got the pink
// panther yesterday". A draft replying to that statement was caught by the
// grounding backstop and queued, and two independent legs then built a wait
// that did not exist:
//
//   LEG A  the queued card armed messages.pending_until, the timer fired five
//          minutes later, and the holding message asserted "sorry for the
//          wait".
//   LEG B  the card made `## Unanswered question` render "the venue still owes
//          them an answer" against the STATEMENT, on every turn it stayed
//          pending, which is what turns two through four defended.
//
// Each of the four commits on this ticket has its own unit tests. This file
// exists for what those cannot show, and the reason is specific rather than
// general tidiness: every message the guest sent AFTER the first one IS a
// question. "tracking what?" and "what did i ask?" both carry a literal "?".
// So a fix that gated the prompt block on the CURRENT message would pass a
// looksLikeQuestion unit test, pass a findPendingQuestion unit test, and
// reproduce the incident exactly. The check has to be on the inbound the CARD
// REPLIES TO, and that is what the leg B tests below pin, using the incident's
// own messages in the incident's own order.
//
// One half of the ruling is deliberately NOT here. "A backstop catch never
// arms the clock, whatever the inbound said" is the SOURCE asymmetry, and it
// is pinned in stages.test.ts against an inbound that is a real question,
// which is the only way to isolate it from the question gate. This file's
// inbound is a statement, so the question gate alone would block the clock
// here and a mutant that let the backstop arm it survives this file. Verified:
// that mutant dies in stages.test.ts, not here. Read the two together.
//
// Both legs carry a NEGATIVE CONTROL. Without them "no clock armed" and "no
// question found" pass against a hardcoded `undefined` and a hardcoded `null`,
// which is the same gate-that-never-fires problem CLAUDE.md logs for
// comp_regex_backstop.
//
// No live model call: CI has no Anthropic key, and none of this needs one. The
// half that DOES need one is the model's reply to "what did i ask?" given R35,
// and that stays QA: Device per the ticket.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { GenerateMessageResult } from '@/lib/ai'
import { createPendingRowsFake } from './testing/pending-rows-fake'
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

import { KNOWLEDGE_GAP_HOLDING_MESSAGE_ENABLED } from './knowledge-gap-timeout'
import { looksLikeQuestion } from './looks-like-question'
import { findPendingQuestion } from './pending-question'
import { persistOrRegenQueuedDraft } from './schedule-and-send'
import { applyApprovalPolicyStage, isKnowledgeGapCard } from './stages'
// By path, not through the mocked `@/lib/ai` barrel: a barrel mock would hand
// this back as `undefined` and the R35 assertion would pass against nothing.
import { SYSTEM_TEMPLATE } from '@/lib/ai/prompts/system-template'

const VENUE = '00000000-0000-4000-8000-0000000000aa'
const GUEST = '00000000-0000-4000-8000-0000000000bb'

// The incident's four guest messages, verbatim from the thread. The first is
// the one the card replies to; the rest are the challenges it produced.
const REPORTED_ORDER = 'oh and i got the pink panther yesterday'
const CHALLENGE_1 = 'tracking what?'
const CHALLENGE_2 = 'what did i ask?'
const CHALLENGE_3 = "you're confusing me"

function useFake() {
  const fake = createPendingRowsFake('041')
  mockAdmin.client = fake.client
  return fake
}

function ctxFor(inboundBody: string): RuntimeContext {
  return {
    agentRunId: 'run-484',
    venue: {
      id: VENUE,
      holdAllOutbound: false,
      approvalPolicy: { default: 'auto_send', perCategory: {} },
    },
    guest: { id: GUEST, firstName: 'Sam', phoneNumber: '+15555550853', isDemo: false },
    currentMessage: {
      id: 'in-reported-order',
      body: inboundBody,
      providerMessageId: 'p-1',
      receivedAt: new Date('2026-09-18T15:41:00.000Z'),
    },
    followupTrigger: null,
    classification: {
      category: 'reply',
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
    body: 'the drafted reply that the backstop caught',
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
    promptVersion: 'v1.66.0',
    dashViolationPersisted: false,
    selfTalkViolationPersisted: false,
    emojiDirectiveViolated: false,
    ...over,
  }
}

/** The grounding backstop catching the draft, which is what happened. */
const BACKSTOP_FLAGGED = {
  status: 'flagged' as const,
  claims: ['the guest had the same drink two days running'],
}

async function runTurn(
  ctx: RuntimeContext,
  gen: GenerateMessageResult,
  grounding: Parameters<typeof applyApprovalPolicyStage>[2] = { status: 'clean' },
) {
  return applyApprovalPolicyStage(ctx, gen, grounding, { status: 'skipped' }, { status: 'skipped' }, {
    resolution: { status: 'none' },
    claim: 'skipped',
  })
}

beforeEach(() => {
  fireRedAlertMock.mockReset()
  fireRedAlertMock.mockResolvedValue(undefined)
})

afterEach(() => {
  vi.clearAllMocks()
  mockAdmin.client = null
})

describe('TAC-484 leg A: the card that started it arms no clock', () => {
  it('queues the backstop-caught draft and arms NO clock, so the timer has nothing to pick up', async () => {
    useFake()
    const decision = await runTurn(ctxFor(REPORTED_ORDER), generation(), BACKSTOP_FLAGGED)

    expect(decision.action).toBe('queue')
    if (decision.action !== 'queue') return
    // The incident in one assertion: this is the clock the timer read.
    expect(decision.pendingUntil).toBeUndefined()
    expect(decision.triggers).toContain('knowledge_gap_backstop')
  })

  it('still protects the card, so the operator keeps seeing it', async () => {
    const fake = useFake()
    const ctx = ctxFor(REPORTED_ORDER)
    const decision = await runTurn(ctx, generation(), BACKSTOP_FLAGGED)
    if (decision.action !== 'queue') throw new Error('expected a queue')

    const persisted = await persistOrRegenQueuedDraft(
      ctx,
      generation(),
      decision.primaryTrigger,
      decision.existingPendingDraftId,
      {
        pendingUntil: decision.pendingUntil,
        blankBody: decision.blankBody,
        reviewTriggers: decision.triggers,
        ungroundedClaims: decision.ungroundedClaims,
        callerPolicy: 'regen',
      },
    )

    expect(persisted.action).toBe('inserted')
    const row = fake.rows.find((r) => r.id === persisted.outboundMessageId)
    expect(row).toBeDefined()
    // No clock on the row, and still a knowledge-gap card: the fix removes the
    // automated message, not the human review.
    expect(row?.pending_until).toBeNull()
    expect(isKnowledgeGapCard(row as never)).toBe(true)
  })

  it('arms no clock on the HONEST path either, when the self-report lands on the same statement', async () => {
    useFake()
    const decision = await runTurn(
      ctxFor(REPORTED_ORDER),
      generation({ knowledgeGap: true }),
    )

    expect(decision.action).toBe('queue')
    if (decision.action !== 'queue') return
    expect(decision.pendingUntil).toBeUndefined()
  })

  // NEGATIVE CONTROL. Without this the three above pass against
  // `const pendingUntil = undefined`, and the knowledge-gap mechanism would be
  // silently dead for every guest who really did ask something.
  it('DOES arm the clock for a self-reported gap on a real question', async () => {
    useFake()
    const decision = await runTurn(
      ctxFor('do you have oat milk?'),
      generation({ knowledgeGap: true }),
    )

    expect(decision.action).toBe('queue')
    if (decision.action !== 'queue') return
    expect(decision.pendingUntil).toBeInstanceOf(Date)
  })

  it('leaves the holding message disabled at the second gate', () => {
    expect(KNOWLEDGE_GAP_HOLDING_MESSAGE_ENABLED).toBe(false)
  })
})

describe('TAC-484 leg B: the prompt block reads the card, not the current turn', () => {
  // The incident's own card: pending, backstop-caught, replying to the guest's
  // statement.
  function seedIncidentCard(fake: ReturnType<typeof useFake>) {
    fake.seed({
      id: 'in-reported-order',
      venue_id: VENUE,
      guest_id: GUEST,
      direction: 'inbound',
      body: REPORTED_ORDER,
      provider_message_id: 'p-1',
      created_at: '2026-09-18T15:41:00.000Z',
    })
    fake.seed({
      id: 'card-b577dff5',
      venue_id: VENUE,
      guest_id: GUEST,
      review_state: 'pending',
      review_reason: 'knowledge_gap_backstop',
      pending_until: null,
      reply_to_message_id: 'in-reported-order',
      created_at: '2026-09-18T15:41:07.900Z',
    })
  }

  it('renders no unanswered question, because the card replies to a statement', async () => {
    const fake = useFake()
    seedIncidentCard(fake)

    expect(await findPendingQuestion(VENUE, GUEST)).toBeNull()
  })

  // The load-bearing one. Each of these three IS a question, so a check on the
  // current message would find one and render "the venue still owes them an
  // answer" exactly as it did on the day.
  it.each([CHALLENGE_1, CHALLENGE_2, CHALLENGE_3])(
    'still renders nothing while the guest challenges it with %j',
    async (challenge) => {
      const fake = useFake()
      seedIncidentCard(fake)
      // The guest's own challenge, sitting in the thread as it did.
      fake.seed({
        id: `in-${challenge.slice(0, 8)}`,
        venue_id: VENUE,
        guest_id: GUEST,
        direction: 'inbound',
        body: challenge,
        provider_message_id: `p-${challenge.slice(0, 8)}`,
        created_at: '2026-09-18T15:48:00.000Z',
      })

      expect(await findPendingQuestion(VENUE, GUEST)).toBeNull()
    },
  )

  // Two of the three challenges are questions on their own. If this stops
  // being true the test above stops meaning anything, so it is asserted rather
  // than assumed.
  it('the challenges really would read as questions on their own', () => {
    expect(looksLikeQuestion(CHALLENGE_1)).toBe(true)
    expect(looksLikeQuestion(CHALLENGE_2)).toBe(true)
    expect(looksLikeQuestion(REPORTED_ORDER)).toBe(false)
  })

  // NEGATIVE CONTROL. Without this every assertion above passes against
  // `return null`, and the block would be dead for every real question.
  it('DOES render the question when the card replies to one', async () => {
    const fake = useFake()
    fake.seed({
      id: 'in-oat',
      venue_id: VENUE,
      guest_id: GUEST,
      direction: 'inbound',
      body: 'do you have oat milk?',
      provider_message_id: 'p-oat',
      created_at: '2026-09-18T15:41:00.000Z',
    })
    fake.seed({
      id: 'card-real',
      venue_id: VENUE,
      guest_id: GUEST,
      review_state: 'pending',
      review_reason: 'knowledge_gap',
      pending_until: '2026-09-18T15:46:00.000Z',
      reply_to_message_id: 'in-oat',
      created_at: '2026-09-18T15:41:07.900Z',
    })

    const loaded = await findPendingQuestion(VENUE, GUEST)
    expect(loaded?.question.question).toBe('do you have oat milk?')
  })
})

describe('TAC-484: R35 is the last line of defence if a sequence starts anyway', () => {
  // Both legs above stop THIS sequence. R35 is what the model has when some
  // other message draws a challenge. Its full wording is pinned in
  // system-template.test.ts; this asserts only that the turn the incident
  // failed on now has an instruction at all.
  it('gives the model an instruction for a challenged message', () => {
    expect(SYSTEM_TEMPLATE).toContain(
      'When a guest questions or pushes back on something you said',
    )
    expect(SYSTEM_TEMPLATE).toContain(
      'Never invent a reason for what you said, and never tell the guest to disregard it, ignore you, or that everything is fine.',
    )
  })
})
