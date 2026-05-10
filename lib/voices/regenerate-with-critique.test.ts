/* eslint-disable @typescript-eslint/no-unused-vars */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

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
  KNOWLEDGE_RETRIEVE_LIMIT: 4,
}))
vi.mock('@/lib/ai', () => ({
  classifyMessage: vi.fn(),
  generateMessage: vi.fn(),
}))
vi.mock('@/lib/rag', () => ({
  retrieveContext: vi.fn(),
  retrieveKnowledgeContext: vi.fn(),
}))
vi.mock('@/lib/observability', () => ({
  noopAgentTrace: { id: '', captureContent: false, span: () => ({}), update: () => {}, flushAsync: async () => {} },
}))

import { buildRuntimeContext } from '@/lib/agent/build-runtime-context'
import { buildAiRuntime } from '@/lib/agent/stages'
import { classifyMessage, generateMessage } from '@/lib/ai'
import { createAdminClient } from '@/lib/db/admin'
import { retrieveContext, retrieveKnowledgeContext } from '@/lib/rag'
import { regenerateWithCritique } from './regenerate-with-critique'

const VENUE_ID = '11111111-1111-4111-8111-111111111111'
const OUTBOUND_ID = '22222222-2222-4222-8222-222222222222'
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
  },
  guest: { id: GUEST_ID },
  recentMessages: [
    { direction: 'inbound' as const, body: 'hi', createdAt: new Date('2026-05-08T09:55:00Z') },
  ],
  recognition: { state: 'returning' as const },
  mechanics: [],
  lastVisit: null,
  corpus: null,
  knowledgeCorpus: null,
  classification: null,
  trace: { id: '', captureContent: false, span: () => ({}), update: () => {}, flushAsync: async () => {} },
}

beforeEach(() => {
  vi.mocked(createAdminClient).mockReset()
  vi.mocked(buildRuntimeContext).mockReset()
  vi.mocked(buildAiRuntime).mockReset()
  vi.mocked(classifyMessage).mockReset()
  vi.mocked(generateMessage).mockReset()
  vi.mocked(retrieveContext).mockReset()
  vi.mocked(retrieveKnowledgeContext).mockReset()
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

describe('regenerateWithCritique — happy path', () => {
  beforeEach(() => {
    vi.mocked(createAdminClient).mockReturnValue(
      makeAdminMock(newDbState()) as unknown as ReturnType<typeof createAdminClient>,
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
        promptVersion: 'v1.8.0',
      },
    })
    vi.mocked(retrieveContext).mockResolvedValue({
      ok: true,
      data: [
        {
          id: 'c1',
          voiceCorpusId: 'vc1',
          text: 'venue speaks like this',
          sourceType: 'sample_text',
          confidence: 0.9,
          similarity: 0.5,
        },
      ],
    })
    vi.mocked(retrieveKnowledgeContext).mockResolvedValue({
      ok: true,
      data: [],
    })
    vi.mocked(generateMessage).mockResolvedValue({
      ok: true,
      data: {
        body: "yeah. oat's on.",
        voiceFidelity: 0.85,
        reasoning: 'good',
        attempts: 1,
        attemptScores: [0.85],
        attemptHistory: [],
        systemPrompt: '',
        userPrompt: '',
        promptVersion: 'v1.8.0',
        dashViolationPersisted: false,
      },
    })
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
    expect(genCall.runtime.critiqueToIncorporate).toBe('too eager — drop the exclamation')
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

  it('returns the slim projection (body, fidelity, attempts, attemptScores)', async () => {
    const r = await regenerateWithCritique({
      venueId: VENUE_ID,
      originalMessageId: OUTBOUND_ID,
      critique: 'x',
    })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.data.body).toBe("yeah. oat's on.")
    expect(r.data.voiceFidelity).toBe(0.85)
    expect(r.data.attempts).toBe(1)
    expect(r.data.attemptScores).toEqual([0.85])
    expect(r.data.generatedAt).toBeInstanceOf(Date)
  })
})

describe('regenerateWithCritique — primary-tag preference (TAC-242)', () => {
  beforeEach(() => {
    vi.mocked(createAdminClient).mockReturnValue(
      makeAdminMock(newDbState()) as unknown as ReturnType<typeof createAdminClient>,
    )
    vi.mocked(buildRuntimeContext).mockResolvedValue(
      baseCtx as unknown as Awaited<ReturnType<typeof buildRuntimeContext>>,
    )
    vi.mocked(buildAiRuntime).mockReturnValue({
      guestName: 'Test',
      inboundMessage: 'do you have any free drinks?',
      today: {
        isoDate: '2026-05-08',
        dayOfWeek: 'Friday',
        venueLocalTime: '10:00',
        venueTimezone: 'America/Los_Angeles',
      },
      recentMessages: [],
      mechanics: [],
    })
    vi.mocked(retrieveContext).mockResolvedValue({
      ok: true,
      data: [
        {
          id: 'c1',
          voiceCorpusId: 'vc1',
          text: 'venue speaks like this',
          sourceType: 'sample_text',
          confidence: 0.9,
          similarity: 0.5,
        },
      ],
    })
    vi.mocked(generateMessage).mockResolvedValue({
      ok: true,
      data: {
        body: 'no, sorry.',
        voiceFidelity: 0.85,
        reasoning: 'good',
        attempts: 1,
        attemptScores: [0.85],
        attemptHistory: [],
        systemPrompt: '',
        userPrompt: '',
        promptVersion: 'v1.12.0',
        dashViolationPersisted: false,
      },
    })
  })

  it('threads the mapped preference into retrieveKnowledgeContext for mechanic_request', async () => {
    vi.mocked(classifyMessage).mockResolvedValue({
      ok: true,
      data: {
        category: 'mechanic_request',
        classifierConfidence: 0.9,
        reasoning: 'r',
        promptVersion: 'v1.12.0',
      },
    })
    vi.mocked(retrieveKnowledgeContext).mockResolvedValueOnce({
      ok: true,
      data: [],
    })
    // Fallback after zero matches:
    vi.mocked(retrieveKnowledgeContext).mockResolvedValueOnce({
      ok: true,
      data: [],
    })

    await regenerateWithCritique({
      venueId: VENUE_ID,
      originalMessageId: OUTBOUND_ID,
      critique: 'x',
    })

    expect(retrieveKnowledgeContext).toHaveBeenCalledTimes(2)
    const firstArgs = vi.mocked(retrieveKnowledgeContext).mock.calls[0][0]
    const secondArgs = vi.mocked(retrieveKnowledgeContext).mock.calls[1][0]
    expect(firstArgs.primaryTagPreference).toEqual(['mechanic'])
    expect(secondArgs.primaryTagPreference).toBeUndefined()
  })

  it('does NOT fall back when category is unmapped (cosine-only)', async () => {
    vi.mocked(classifyMessage).mockResolvedValue({
      ok: true,
      data: {
        category: 'reply',
        classifierConfidence: 0.9,
        reasoning: 'r',
        promptVersion: 'v1.12.0',
      },
    })
    vi.mocked(retrieveKnowledgeContext).mockResolvedValueOnce({ ok: true, data: [] })

    await regenerateWithCritique({
      venueId: VENUE_ID,
      originalMessageId: OUTBOUND_ID,
      critique: 'x',
    })

    expect(retrieveKnowledgeContext).toHaveBeenCalledTimes(1)
    const args = vi.mocked(retrieveKnowledgeContext).mock.calls[0][0]
    expect(args.primaryTagPreference).toBeUndefined()
  })
})

describe('regenerateWithCritique — corpus thinness', () => {
  it('fails closed when no strong matches above 0.3', async () => {
    vi.mocked(createAdminClient).mockReturnValue(
      makeAdminMock(newDbState()) as unknown as ReturnType<typeof createAdminClient>,
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
        promptVersion: 'v1.8.0',
      },
    })
    vi.mocked(retrieveContext).mockResolvedValue({
      ok: true,
      data: [
        {
          id: 'c1',
          voiceCorpusId: 'vc1',
          text: 't',
          sourceType: 'sample_text',
          confidence: 0.9,
          similarity: 0.1,
        },
      ],
    })

    const r = await regenerateWithCritique({
      venueId: VENUE_ID,
      originalMessageId: OUTBOUND_ID,
      critique: 'x',
    })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.errorCode).toBe('retrieve_failed')
      expect(r.error).toContain('insufficient_corpus_matches')
    }
    expect(generateMessage).not.toHaveBeenCalled()
  })
})
