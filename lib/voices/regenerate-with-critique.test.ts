/* eslint-disable @typescript-eslint/no-unused-vars */

import { readFile } from 'node:fs/promises'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
// Derived from the live constant: a stale fixture literal ships green, and
// nothing fails (see .claude/rules/prompt-versioning.md).
import { PROMPT_VERSION } from '@/lib/ai/prompts/system-template'

vi.mock('@/lib/db/admin', () => ({
  createAdminClient: vi.fn(),
}))
vi.mock('@/lib/agent/build-runtime-context', () => ({
  buildRuntimeContext: vi.fn(),
}))
vi.mock('@/lib/agent/stages', () => ({
  buildAiRuntime: vi.fn(),
  STRONG_MATCH_SIMILARITY: 0.3,
  MIN_STRONG_MATCHES: 1,
  CORPUS_RETRIEVE_LIMIT: 8,
  // TAC-547: regen no longer filters or falls back on its own — it calls the
  // production stage, which does both. Mocked at that boundary because it
  // still does real DB and Voyage work. Its behaviour is stages.test.ts's
  // job; what this file asserts is that regen DELEGATES rather than
  // reimplementing, which is TAC-366's guarantee made structural.
  retrieveKnowledgeWithContextStage: vi.fn(),
}))

vi.mock('@/lib/ai', () => ({
  classifyMessage: vi.fn(),
  generateMessage: vi.fn(),
  verifyMechanicOffer: vi.fn(),
  // TAC-401: the advisory prose-promise check this path mirrors.
  verifyProsePromise: vi.fn(),
}))
vi.mock('@/lib/rag', () => ({
  loadVoicePack: vi.fn(),
}))
vi.mock('@/lib/observability', () => ({
  noopAgentTrace: {
    id: '',
    captureContent: false,
    span: () => ({}),
    update: () => {},
    flushAsync: async () => {},
  },
}))

import { buildRuntimeContext } from '@/lib/agent/build-runtime-context'
import {
  buildAiRuntime,
  retrieveKnowledgeWithContextStage,
} from '@/lib/agent/stages'
import {
  classifyMessage,
  generateMessage,
  verifyMechanicOffer,
  verifyProsePromise,
} from '@/lib/ai'
import { createAdminClient } from '@/lib/db/admin'
import { loadVoicePack } from '@/lib/rag'
import { regenerateWithCritique } from './regenerate-with-critique'

const VENUE_ID = '11111111-1111-4111-8111-111111111111'
const OUTBOUND_ID = '22222222-2222-4222-8222-222222222222'
/** The inbound the fixture regenerates against; the retrieval query. */
const INBOUND_BODY = 'do you have oat milk'

function chunk(id: string, similarity: number) {
  return {
    id,
    knowledgeCorpusId: `kc-${id}`,
    text: `chunk ${id}`,
    sourceType: 'voicenote_transcript',
    confidence: 0.9,
    similarity,
    primaryTags: [] as string[],
    secondaryTags: [] as string[],
  }
}

/** The knowledge chunks the generator was actually handed. */
function knowledgeHandedToGenerator() {
  const call = vi.mocked(generateMessage).mock.calls.at(-1)
  return (
    (call?.[0] as { knowledgeChunks?: { id: string }[] } | undefined)
      ?.knowledgeChunks ?? []
  )
}
const INBOUND_ID = '33333333-3333-4333-8333-333333333333'
const GUEST_ID = '44444444-4444-4444-8444-444444444444'

interface DbMockState {
  outboundRow: Record<string, unknown> | null
  inboundRow: Record<string, unknown> | null
  outboundError: { message: string } | null
  inboundError: { message: string } | null
}

function newDbState(overrides: Partial<DbMockState> = {}): DbMockState {
  return {
    outboundRow: {
      id: OUTBOUND_ID,
      venue_id: VENUE_ID,
      guest_id: GUEST_ID,
      direction: 'outbound',
      reply_to_message_id: INBOUND_ID,
      created_at: '2026-05-08T10:00:01.000Z',
    },
    inboundRow: {
      id: INBOUND_ID,
      body: 'do you have oat milk',
      direction: 'inbound',
      created_at: '2026-05-08T10:00:00.000Z',
      provider_message_id: 'sb_xyz',
      channel: 'text',
    },
    outboundError: null,
    inboundError: null,
    ...overrides,
  }
}

function makeAdminMock(state: DbMockState) {
  let lookupCount = 0
  return {
    from: (_table: string) => ({
      select: (_cols: string) => ({
        eq: (_f: string, _v: unknown) => ({
          eq: (_f2: string, _v2: unknown) => ({
            maybeSingle: async () => {
              // First call: outbound (selected with venue_id filter); second: inbound
              if (lookupCount++ === 0) {
                return {
                  data: state.outboundRow,
                  error: state.outboundError,
                }
              }
              return { data: state.inboundRow, error: state.inboundError }
            },
          }),
          maybeSingle: async () => {
            // For the second lookup which only filters by id
            return { data: state.inboundRow, error: state.inboundError }
          },
        }),
      }),
    }),
  }
}

const baseCtx = {
  agentRunId: 'run-1',
  venue: {
    id: VENUE_ID,
    slug: 'test',
    brandPersona: {
      tone: 't',
      formality: 'casual',
      speakerFraming: 'venue',
      signaturePhrases: [],
      bannedTopics: [],
      emojiPolicy: 'never',
      lengthGuide: 'short',
      voiceAntiPatterns: [],
      voiceTouchstones: [],
    },
    venueInfo: {},
    timezone: 'America/Los_Angeles',
    sendblueNumber: '+15555550000',
    holdAllOutbound: false,
  },
  guest: { id: GUEST_ID },
  conversationChannel: 'text' as const,
  recentMessages: [
    {
      direction: 'inbound' as const,
      body: 'hi',
      createdAt: new Date('2026-05-08T09:55:00Z'),
    },
  ],
  recognition: { state: 'returning' as const },
  recentVisits: [],
  mechanics: [],
  lastVisit: null,
  corpus: null,
  knowledgeCorpus: null,
  classification: null,
  trace: {
    id: '',
    captureContent: false,
    span: () => ({}),
    update: () => {},
    flushAsync: async () => {},
  },
}

beforeEach(() => {
  vi.mocked(createAdminClient).mockReset()
  vi.mocked(buildRuntimeContext).mockReset()
  vi.mocked(buildAiRuntime).mockReset()
  vi.mocked(classifyMessage).mockReset()
  vi.mocked(generateMessage).mockReset()
  vi.mocked(loadVoicePack).mockReset()
  vi.mocked(retrieveKnowledgeWithContextStage).mockReset()
  // Default: retrieval succeeds with nothing. Every test that cares sets its
  // own; without a default the stage resolves undefined and regen throws on
  // .map, which reads as a wiring bug rather than a fixture one.
  vi.mocked(retrieveKnowledgeWithContextStage).mockResolvedValue([])
  vi.mocked(verifyMechanicOffer).mockReset()
  vi.mocked(verifyProsePromise).mockReset()
  // Advisory and fail-open on this path: a check that returns nothing leaves
  // promisesSomething false, which is what every pre-TAC-401 test expects.
  vi.mocked(verifyProsePromise).mockResolvedValue({
    ok: true,
    data: {
      promisesSomething: false,
      commitmentType: null,
      commitmentDescription: null,
      promptVersion: 'v1.0.0',
    },
  })
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('regenerateWithCritique — error paths up front', () => {
  it('returns message_not_found when outbound is missing', async () => {
    vi.mocked(createAdminClient).mockReturnValue(
      makeAdminMock(newDbState({ outboundRow: null })) as unknown as ReturnType<
        typeof createAdminClient
      >,
    )
    const r = await regenerateWithCritique({
      venueId: VENUE_ID,
      originalMessageId: OUTBOUND_ID,
      critique: 'x',
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.errorCode).toBe('message_not_found')
  })

  it('returns not_an_outbound_reply when reply_to_message_id is null', async () => {
    vi.mocked(createAdminClient).mockReturnValue(
      makeAdminMock(
        newDbState({
          outboundRow: {
            id: OUTBOUND_ID,
            venue_id: VENUE_ID,
            guest_id: GUEST_ID,
            direction: 'outbound',
            reply_to_message_id: null,
            created_at: '2026-05-08T10:00:01.000Z',
          },
        }),
      ) as unknown as ReturnType<typeof createAdminClient>,
    )
    const r = await regenerateWithCritique({
      venueId: VENUE_ID,
      originalMessageId: OUTBOUND_ID,
      critique: 'x',
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.errorCode).toBe('not_an_outbound_reply')
  })

  it('returns inbound_not_found when triggering inbound is missing', async () => {
    vi.mocked(createAdminClient).mockReturnValue(
      makeAdminMock(newDbState({ inboundRow: null })) as unknown as ReturnType<
        typeof createAdminClient
      >,
    )
    const r = await regenerateWithCritique({
      venueId: VENUE_ID,
      originalMessageId: OUTBOUND_ID,
      critique: 'x',
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.errorCode).toBe('inbound_not_found')
  })
})

// TAC-348 (code review follow-up): a crisis-safety inbound must refuse
// BEFORE retrieval or generation ever run — mirrors handle-inbound.ts's
// short circuit. The original message triggered a fixed, hardcoded reply
// specifically so no persona/corpus/category instruction would touch it;
// regenerating it here would run exactly the generateMessage call that
// mechanism exists to bypass.
describe('regenerateWithCritique — crisis-safety refusal (TAC-348)', () => {
  beforeEach(() => {
    vi.mocked(createAdminClient).mockReturnValue(
      makeAdminMock(newDbState()) as unknown as ReturnType<
        typeof createAdminClient
      >,
    )
    vi.mocked(buildRuntimeContext).mockResolvedValue(
      baseCtx as unknown as Awaited<ReturnType<typeof buildRuntimeContext>>,
    )
    vi.mocked(classifyMessage).mockResolvedValue({
      ok: true,
      data: {
        category: 'casual_chatter',
        classifierConfidence: 0.8,
        reasoning: 'r',
        crisisSafety: true,
        correctsPendingReply: false,
        followUpWorthy: false,
        promptVersion: PROMPT_VERSION,
      },
    })
  })

  it('returns crisis_safety_ineligible instead of proceeding to retrieval or generation', async () => {
    const r = await regenerateWithCritique({
      venueId: VENUE_ID,
      originalMessageId: OUTBOUND_ID,
      critique: 'this reads generic, make it warmer',
    })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.errorCode).toBe('crisis_safety_ineligible')
    expect(r.error).toContain('crisis-safety')
  })

  it('never calls loadVoicePack or generateMessage for a crisis-safety inbound', async () => {
    await regenerateWithCritique({
      venueId: VENUE_ID,
      originalMessageId: OUTBOUND_ID,
      critique: 'x',
    })
    expect(loadVoicePack).not.toHaveBeenCalled()
    expect(retrieveKnowledgeWithContextStage).not.toHaveBeenCalled()
    expect(generateMessage).not.toHaveBeenCalled()
  })
})

describe('regenerateWithCritique — happy path', () => {
  beforeEach(() => {
    vi.mocked(createAdminClient).mockReturnValue(
      makeAdminMock(newDbState()) as unknown as ReturnType<
        typeof createAdminClient
      >,
    )
    vi.mocked(buildRuntimeContext).mockResolvedValue(
      baseCtx as unknown as Awaited<ReturnType<typeof buildRuntimeContext>>,
    )
    vi.mocked(buildAiRuntime).mockReturnValue({
      guestName: 'Test',
      inboundMessage: 'do you have oat milk',
      today: {
        isoDate: '2026-05-08',
        dayOfWeek: 'Friday',
        venueLocalTime: '10:00',
        venueTimezone: 'America/Los_Angeles',
        calendar: [
          { weekday: 'Mon', monthDay: 'Jan 5' },
          { weekday: 'Tue', monthDay: 'Jan 6' },
          { weekday: 'Wed', monthDay: 'Jan 7' },
        ],
      },
      recentMessages: [],
      mechanics: [],
    })
    vi.mocked(classifyMessage).mockResolvedValue({
      ok: true,
      data: {
        category: 'reply',
        classifierConfidence: 0.9,
        reasoning: 'r',
        crisisSafety: false,
        correctsPendingReply: false,
        followUpWorthy: false,
        promptVersion: 'v1.8.0',
      },
    })
    vi.mocked(loadVoicePack).mockResolvedValue({
      ok: true,
      data: [
        {
          id: 'c1',
          voiceCorpusId: 'vc1',
          text: 'venue speaks like this',
          sourceType: 'sample_text',
          confidence: 0.9,
          similarity: 1,
        },
      ],
    })
    vi.mocked(generateMessage).mockResolvedValue({
      ok: true,
      data: {
        body: "yeah. oat's on.",
        unverifiedUrls: [],
        requiresOperatorApproval: false,
        approvalReason: '',
        complaintIntent: 'none' as const,
        knowledgeGap: false,
        contextUpdate: {},
        commitment: {},
        arrivalCapture: {},
        cancelsCommitmentId: '',
        intentionQuestion: '',
        closedTheConversation: false,
        intentionQuestionDuplicateStripped: false,
        intentionQuestionDroppedForBodyQuestion: false,
        attempts: 1,
        attemptHistory: [],
        systemPrompt: '',
        userPrompt: '',
        conversation: '',
        promptVersion: 'v1.8.0',
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        dashViolationPersisted: false,
        selfTalkViolationPersisted: false,
        emojiDirectiveViolated: false,
      },
    })
  })

  // TAC-495: this file mirrors generateStage, and the channel is part of what
  // it mirrors. Without these, the Voices playground would regenerate an
  // Instagram guest's reply with the SMS copy and nobody would see why.
  it("threads the triggering inbound's channel into buildRuntimeContext", async () => {
    vi.mocked(createAdminClient).mockReturnValue(
      makeAdminMock(
        newDbState({
          inboundRow: {
            id: INBOUND_ID,
            body: 'do you have oat milk',
            direction: 'inbound',
            created_at: '2026-05-08T10:00:00.000Z',
            provider_message_id: 'sb_xyz',
            channel: 'instagram',
          },
        }),
      ) as unknown as ReturnType<typeof createAdminClient>,
    )
    await regenerateWithCritique({
      venueId: VENUE_ID,
      originalMessageId: OUTBOUND_ID,
      critique: 'x',
    })
    const call = vi.mocked(buildRuntimeContext).mock.calls[0][0]
    expect(call.currentMessage?.channel).toBe('instagram')
  })

  it("passes the context's conversation channel to generateMessage", async () => {
    vi.mocked(buildRuntimeContext).mockResolvedValue({
      ...baseCtx,
      conversationChannel: 'instagram',
    } as unknown as Awaited<ReturnType<typeof buildRuntimeContext>>)
    await regenerateWithCritique({
      venueId: VENUE_ID,
      originalMessageId: OUTBOUND_ID,
      critique: 'x',
    })
    expect(generateMessage).toHaveBeenCalledWith(
      expect.objectContaining({ channel: 'instagram' }),
    )
  })

  // The admin mock ignores select()'s argument, so only the source shows the
  // column is loaded at all. TAC-518 added referral_source for the same reason
  // channel is here: this file's standing obligation is to mirror
  // handle-inbound's loadInbound, and a regen of a scan turn that arms nothing
  // answers a different question than the generation it is supposed to replay.
  it('selects the channel and referral columns when loading the triggering inbound', async () => {
    const src = await readFile(
      new URL('./regenerate-with-critique.ts', import.meta.url),
      'utf-8',
    )
    expect(src).toContain(
      [
        '.select(',
        "      'id, body, created_at, provider_message_id, direction, channel, referral_source',",
        '    )',
      ].join('\n'),
    )
    expect(src).toContain('referralSource: load.data.inbound.referral_source,')
  })

  it('threads historyEndIso = inbound.created_at into buildRuntimeContext', async () => {
    await regenerateWithCritique({
      venueId: VENUE_ID,
      originalMessageId: OUTBOUND_ID,
      critique: 'too eager',
    })
    expect(buildRuntimeContext).toHaveBeenCalled()
    const call = vi.mocked(buildRuntimeContext).mock.calls[0][0]
    expect(call.historyEndIso).toBe('2026-05-08T10:00:00.000Z')
    expect(call.currentMessage?.body).toBe('do you have oat milk')
  })

  it('post-injects critiqueToIncorporate onto the AI runtime', async () => {
    await regenerateWithCritique({
      venueId: VENUE_ID,
      originalMessageId: OUTBOUND_ID,
      critique: 'too eager — drop the exclamation',
    })
    expect(generateMessage).toHaveBeenCalled()
    const genCall = vi.mocked(generateMessage).mock.calls[0][0]
    expect(genCall.runtime.critiqueToIncorporate).toBe(
      'too eager — drop the exclamation',
    )
  })

  it('forwards recentMessages and guestState to classifyMessage (TAC-240)', async () => {
    await regenerateWithCritique({
      venueId: VENUE_ID,
      originalMessageId: OUTBOUND_ID,
      critique: 'x',
    })
    expect(classifyMessage).toHaveBeenCalledTimes(1)
    const call = vi.mocked(classifyMessage).mock.calls[0][0]
    expect(call.recentMessages).toEqual(baseCtx.recentMessages)
    expect(call.guestState).toBe('returning')
  })

  it('returns the slim projection (body, attempts, generatedAt)', async () => {
    const r = await regenerateWithCritique({
      venueId: VENUE_ID,
      originalMessageId: OUTBOUND_ID,
      critique: 'x',
    })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.data.body).toBe("yeah. oat's on.")
    expect(r.data.attempts).toBe(1)
    expect(r.data.generatedAt).toBeInstanceOf(Date)
  })

  // TAC-362. The third field to arrive on this result type by the same route
  // (knowledgeGap before TAC-350, selfTalkViolationPersisted before TAC-355):
  // generateMessage computed it all along and this path wasn't reading it.
  //
  // `emojiDirective` is the half that matters more than the violation flag.
  // buildAiRuntime re-draws the coin on every regen call, so two attempts in
  // one critique session can differ in emoji permission for reasons unrelated
  // to the operator's critique — and this loop is what writes voice_corpus
  // rows and anti-pattern rules, so an operator misattributing that to their
  // own critique becomes persisted venue config.
  it('surfaces the emoji directive and violation flag on the attempt', async () => {
    const r = await regenerateWithCritique({
      venueId: VENUE_ID,
      originalMessageId: OUTBOUND_ID,
      critique: 'x',
    })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.data.emojiDirectiveViolated).toBe(false)
    // The fixture persona is `never`, so no coin is flipped and the field is
    // undefined rather than a directive — which is itself the signal the UI
    // needs ("this venue doesn't vary per message").
    expect(r.data.emojiDirective).toBeUndefined()
  })

  // TAC-355: mechanic-offer backstop, advisory only on this path (no gate
  // to feed — the operator reviews the raw attempt directly). Deliberately
  // does NOT skip on requiresOperatorApproval/commitment.type, unlike the
  // production stage — see RegenerateWithCritiqueResult's own comment.
  const gatedMechanic = {
    id: 'mech-1',
    type: 'perk' as const,
    name: 'Referral Surprise',
    description: null,
    qualification: 'A regular brings a friend in for the first time.',
    rewardDescription: 'A complimentary item for the first-time guest.',
    minState: 'regular' as const,
    requiresOperatorApproval: true,
  }

  it('surfaces a caught mechanic offer from the backstop', async () => {
    vi.mocked(buildRuntimeContext).mockResolvedValue({
      ...baseCtx,
      mechanics: [gatedMechanic],
    } as unknown as Awaited<ReturnType<typeof buildRuntimeContext>>)
    vi.mocked(verifyMechanicOffer).mockResolvedValue({
      ok: true,
      data: {
        offersGatedMechanic: true,
        mechanicId: 'mech-1',
        promptVersion: 'v1.0.0',
      },
    })

    const r = await regenerateWithCritique({
      venueId: VENUE_ID,
      originalMessageId: OUTBOUND_ID,
      critique: 'x',
    })
    expect(verifyMechanicOffer).toHaveBeenCalledTimes(1)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.data.offersGatedMechanic).toBe(true)
    expect(r.data.offeredMechanicId).toBe('mech-1')
  })

  it('does not flag a mechanic offer when the backstop finds nothing', async () => {
    vi.mocked(buildRuntimeContext).mockResolvedValue({
      ...baseCtx,
      mechanics: [gatedMechanic],
    } as unknown as Awaited<ReturnType<typeof buildRuntimeContext>>)
    vi.mocked(verifyMechanicOffer).mockResolvedValue({
      ok: true,
      data: {
        offersGatedMechanic: false,
        mechanicId: 'none',
        promptVersion: 'v1.0.0',
      },
    })

    const r = await regenerateWithCritique({
      venueId: VENUE_ID,
      originalMessageId: OUTBOUND_ID,
      critique: 'x',
    })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.data.offersGatedMechanic).toBe(false)
    expect(r.data.offeredMechanicId).toBeNull()
  })

  it('skips the mechanic-offer backstop entirely when no eligible mechanic requires approval', async () => {
    // baseCtx.mechanics is [] by default in this describe block's setup.
    const r = await regenerateWithCritique({
      venueId: VENUE_ID,
      originalMessageId: OUTBOUND_ID,
      critique: 'x',
    })
    expect(verifyMechanicOffer).not.toHaveBeenCalled()
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.data.offersGatedMechanic).toBe(false)
    expect(r.data.offeredMechanicId).toBeNull()
  })

  it('degrades to offersGatedMechanic=false (advisory, no throw) when the backstop call errors', async () => {
    vi.mocked(buildRuntimeContext).mockResolvedValue({
      ...baseCtx,
      mechanics: [gatedMechanic],
    } as unknown as Awaited<ReturnType<typeof buildRuntimeContext>>)
    vi.mocked(verifyMechanicOffer).mockResolvedValue({
      ok: false,
      error: 'model unavailable',
    })

    const r = await regenerateWithCritique({
      venueId: VENUE_ID,
      originalMessageId: OUTBOUND_ID,
      critique: 'x',
    })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.data.offersGatedMechanic).toBe(false)
    expect(r.data.offeredMechanicId).toBeNull()
  })
})

// TAC-242's primary-tag-preference block lived here. TAC-547 deleted it: regen
// no longer resolves a tag preference or calls the knowledge RPC at all — it
// calls `retrieveKnowledgeWithContextStage`, which does both. Testing the
// preference here would be testing the production stage through a second
// mock, and the real coverage is stages.test.ts's
// 'retrieveKnowledgeStage — tag-aware routing' and
// 'lets EACH arm take its own tag-preference fallback'. What this file still
// owns is that regen DELEGATES, asserted at the bottom of the file.

// Reversed from 'corpus thinness' when decision 0008 made voice a static
// pack: there is no similarity left to be thin, so the closed failure modes
// are a pack that will not load and a venue with no corpus at all.
describe('regenerateWithCritique — voice pack failures', () => {
  beforeEach(() => {
    vi.mocked(createAdminClient).mockReturnValue(
      makeAdminMock(newDbState()) as unknown as ReturnType<
        typeof createAdminClient
      >,
    )
    vi.mocked(buildRuntimeContext).mockResolvedValue(
      baseCtx as unknown as Awaited<ReturnType<typeof buildRuntimeContext>>,
    )
    vi.mocked(classifyMessage).mockResolvedValue({
      ok: true,
      data: {
        category: 'reply',
        classifierConfidence: 0.9,
        reasoning: 'r',
        crisisSafety: false,
        correctsPendingReply: false,
        followUpWorthy: false,
        promptVersion: 'v1.8.0',
      },
    })
  })

  it('fails closed when the pack load errors', async () => {
    vi.mocked(loadVoicePack).mockResolvedValue({
      ok: false,
      error: 'db down',
      errorCode: 'db_query_failed',
    })
    const r = await regenerateWithCritique({
      venueId: VENUE_ID,
      originalMessageId: OUTBOUND_ID,
      critique: 'x',
    })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.errorCode).toBe('retrieve_failed')
      expect(r.error).toContain('db down')
    }
    expect(generateMessage).not.toHaveBeenCalled()
  })

  it('fails closed when the venue has an empty voice pack', async () => {
    vi.mocked(loadVoicePack).mockResolvedValue({ ok: true, data: [] })
    const r = await regenerateWithCritique({
      venueId: VENUE_ID,
      originalMessageId: OUTBOUND_ID,
      critique: 'x',
    })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.errorCode).toBe('retrieve_failed')
      expect(r.error).toContain('empty_voice_pack')
    }
    expect(generateMessage).not.toHaveBeenCalled()
  })
})

/**
 * TAC-366, rewritten by TAC-547.
 *
 * TAC-366's subject was that regen reimplemented `retrieveKnowledgeStage`'s
 * body and had drifted from it: the relevance floor lived only in stages.ts,
 * so the playground showed up to four chunks where production showed zero —
 * in the direction that HID the TAC-358 bug from anyone reproducing it here.
 * It fixed that by sharing `filterByRelevance`.
 *
 * TAC-547 removed the duplication outright: regen now calls the production
 * stage, so the floor, the tag-preference fallback and the contextual arm are
 * production's by construction rather than by a mirrored helper. These tests
 * therefore assert the DELEGATION, which is the stronger guarantee — the
 * floor's own behaviour is stages.test.ts's job and is no longer restatable
 * here. The source-level half is kept and widened: it is still what stops
 * someone reintroducing a local copy, which is the whole point of the
 * original ticket.
 */
describe('regenerateWithCritique — knowledge retrieval delegates to stages.ts (TAC-366, TAC-547)', () => {
  beforeEach(() => {
    vi.mocked(createAdminClient).mockReturnValue(
      makeAdminMock(newDbState()) as unknown as ReturnType<
        typeof createAdminClient
      >,
    )
    vi.mocked(buildRuntimeContext).mockResolvedValue(
      baseCtx as unknown as Awaited<ReturnType<typeof buildRuntimeContext>>,
    )
    vi.mocked(classifyMessage).mockResolvedValue({
      ok: true,
      data: {
        category: 'new_question',
        classifierConfidence: 0.9,
        reasoning: 'r',
        crisisSafety: false,
        correctsPendingReply: false,
        followUpWorthy: false,
        promptVersion: 'v1.8.0',
      },
    })
    vi.mocked(loadVoicePack).mockResolvedValue({
      ok: true,
      data: [
        {
          id: 'c1',
          voiceCorpusId: 'vc1',
          text: 't',
          sourceType: 'sample_text',
          confidence: 0.9,
          similarity: 1,
        },
      ],
    })
    vi.mocked(buildAiRuntime).mockReturnValue(
      {} as ReturnType<typeof buildAiRuntime>,
    )
    vi.mocked(generateMessage).mockResolvedValue({
      ok: true,
      data: {
        body: 'b',
        promptVersion: 'v1.8.0',
        knowledgeGap: false,
        requiresOperatorApproval: false,
        approvalReason: '',
        contextUpdate: {},
        commitment: {},
        arrivalCapture: {},
        cancelsCommitmentId: '',
        intentionQuestion: '',
        closedTheConversation: false,
        intentionQuestionDuplicateStripped: false,
        intentionQuestionDroppedForBodyQuestion: false,
        userPrompt: 'p',
        conversation: '',
        systemPrompt: 's',
        dashViolationPersisted: false,
        selfTalkViolationPersisted: false,
        emojiDirectiveViolated: false,
        unverifiedUrls: [],
      },
    } as unknown as Awaited<ReturnType<typeof generateMessage>>)
  })

  it('calls the shared stage with the category and the original inbound body', async () => {
    await regenerateWithCritique({
      venueId: VENUE_ID,
      originalMessageId: OUTBOUND_ID,
      critique: 'x',
    })

    expect(retrieveKnowledgeWithContextStage).toHaveBeenCalledTimes(1)
    const [, category, query] = vi.mocked(retrieveKnowledgeWithContextStage)
      .mock.calls[0]
    expect(category).toBe('new_question')
    expect(query).toBe(INBOUND_BODY)
  })

  it('hands the stage result to the generator unchanged', async () => {
    vi.mocked(retrieveKnowledgeWithContextStage).mockResolvedValueOnce([
      chunk('a', 0.9),
      chunk('b', 0.8),
    ])

    await regenerateWithCritique({
      venueId: VENUE_ID,
      originalMessageId: OUTBOUND_ID,
      critique: 'x',
    })

    expect(knowledgeHandedToGenerator().map((c) => c.id)).toEqual(['a', 'b'])
  })

  it('degrades to no knowledge when the stage returns nothing, without failing the regen', async () => {
    vi.mocked(retrieveKnowledgeWithContextStage).mockResolvedValueOnce([])

    const r = await regenerateWithCritique({
      venueId: VENUE_ID,
      originalMessageId: OUTBOUND_ID,
      critique: 'x',
    })

    expect(r.ok).toBe(true)
    expect(knowledgeHandedToGenerator()).toEqual([])
  })

  it('does NOT reimplement retrieval: no direct RPC call, no local floor', async () => {
    // The behavioural tests above pass equally well against a local copy of
    // the stage's body — that local copy is precisely the drift TAC-366
    // removed and TAC-547 deleted, so the guarantee is asserted at the
    // source. Same technique as handle-operator-decline.test.ts's
    // persist-not-send import check.
    const src = await readFile(
      new URL('./regenerate-with-critique.ts', import.meta.url),
      'utf8',
    )
    const withoutComments = src
      .replace(/\/\/.*$/gm, '')
      .replace(/\/\*[\s\S]*?\*\//g, '')

    expect(withoutComments).toMatch(
      /import\s*{[^}]*\bretrieveKnowledgeWithContextStage\b[^}]*}\s*from\s*'@\/lib\/agent\/stages'/,
    )
    // No direct knowledge RPC, which is how a reimplementation would start.
    expect(withoutComments).not.toMatch(/\bretrieveKnowledgeContext\s*\(/)
    // No tag preference resolved locally.
    expect(withoutComments).not.toMatch(/\bgetPrimaryTagPreference\s*\(/)
    // No similarity compared against a NUMERIC LITERAL. Catches someone
    // inlining the floor, while still permitting the legitimate
    // `m.similarity >= STRONG_MATCH_SIMILARITY` voice-corpus thinness check
    // that lives in this same function — the first draft of this assertion
    // banned both and failed on the good one.
    expect(withoutComments).not.toMatch(/similarity\s*>=\s*\d*\.?\d/)
  })
})
