// Mock signatures mirror the supabase-js fluent builder, which passes
// column names + filter args we don't inspect inside the test.
/* eslint-disable @typescript-eslint/no-unused-vars */

import { beforeEach, describe, expect, it, vi } from 'vitest'

// Mocks must be hoisted before importing the route handler.
vi.mock('@/lib/db/server', () => ({
  createServerClient: vi.fn(),
}))
vi.mock('@/lib/auth', async () => {
  const actual =
    await vi.importActual<typeof import('@/lib/auth')>('@/lib/auth')
  return {
    ...actual,
    verifyAnalogAdminAccess: vi.fn(),
  }
})
vi.mock('@/lib/db/admin', () => ({
  createAdminClient: vi.fn(),
}))
vi.mock('@/lib/voice-training', () => ({
  upsertCorpusEdit: vi.fn(),
  dedupeAndAppendAntiPatterns: vi.fn(),
}))

import { AuthError, verifyAnalogAdminAccess } from '@/lib/auth'
import { createAdminClient } from '@/lib/db/admin'
import { createServerClient } from '@/lib/db/server'
import {
  dedupeAndAppendAntiPatterns,
  upsertCorpusEdit,
} from '@/lib/voice-training'
import { PUT } from './route'

const MESSAGE_ID = '11111111-1111-4111-8111-111111111111'
const VENUE_ID = '22222222-2222-4222-8222-222222222222'
const OPERATOR_ID = '33333333-3333-4333-8333-333333333333'
const AUTH_USER_ID = '44444444-4444-4444-8444-444444444444'

interface AdminMockState {
  message: { id: string; venue_id: string; direction: string } | null
  messageLookupError: { message: string } | null
  updateCalls: Array<{ id: string; payload: Record<string, unknown> }>
  updateError: { message: string } | null
}

function newAdminState(overrides: Partial<AdminMockState> = {}): AdminMockState {
  return {
    message: { id: MESSAGE_ID, venue_id: VENUE_ID, direction: 'outbound' },
    messageLookupError: null,
    updateCalls: [],
    updateError: null,
    ...overrides,
  }
}

function makeAdminMock(state: AdminMockState) {
  return {
    from: (_table: string) => ({
      select: (_cols: string) => ({
        eq: (_f: string, _v: unknown) => ({
          maybeSingle: async () => ({
            data: state.message,
            error: state.messageLookupError,
          }),
        }),
      }),
      update: (payload: Record<string, unknown>) => ({
        eq: async (_f: string, v: unknown) => {
          state.updateCalls.push({ id: String(v), payload })
          return { error: state.updateError }
        },
      }),
    }),
  }
}

function makeSessionMock(session: { user: { id: string } } | null) {
  return {
    auth: {
      getSession: async () => ({ data: { session }, error: null }),
    },
  }
}

function buildRequest(body: unknown): Request {
  return new Request('http://test/admin/conversations/api/review/x', {
    method: 'PUT',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  })
}

function buildParams(messageId: string) {
  return { params: Promise.resolve({ messageId }) }
}

beforeEach(() => {
  vi.mocked(createServerClient).mockReset()
  vi.mocked(createAdminClient).mockReset()
  vi.mocked(verifyAnalogAdminAccess).mockReset()
  vi.mocked(upsertCorpusEdit).mockReset()
  vi.mocked(dedupeAndAppendAntiPatterns).mockReset()
})

describe('PUT /admin/conversations/api/review/[messageId] — auth', () => {
  it('returns 401 when no session', async () => {
    vi.mocked(createServerClient).mockResolvedValue(
      makeSessionMock(null) as unknown as Awaited<ReturnType<typeof createServerClient>>,
    )

    const res = await PUT(buildRequest({}), buildParams(MESSAGE_ID))
    expect(res.status).toBe(401)
  })

  it('returns 403 when operator is not an analog admin', async () => {
    vi.mocked(createServerClient).mockResolvedValue(
      makeSessionMock({ user: { id: AUTH_USER_ID } }) as unknown as Awaited<
        ReturnType<typeof createServerClient>
      >,
    )
    vi.mocked(verifyAnalogAdminAccess).mockRejectedValue(
      new AuthError(403, 'not an analog admin'),
    )

    const res = await PUT(buildRequest({}), buildParams(MESSAGE_ID))
    expect(res.status).toBe(403)
  })
})

describe('PUT /admin/conversations/api/review/[messageId] — validation', () => {
  beforeEach(() => {
    vi.mocked(createServerClient).mockResolvedValue(
      makeSessionMock({ user: { id: AUTH_USER_ID } }) as unknown as Awaited<
        ReturnType<typeof createServerClient>
      >,
    )
    vi.mocked(verifyAnalogAdminAccess).mockResolvedValue({
      operatorId: OPERATOR_ID,
      allowedVenueIds: [],
      isAnalogAdmin: true,
    })
  })

  it('returns 400 for invalid messageId', async () => {
    const res = await PUT(buildRequest({}), buildParams('not-a-uuid'))
    expect(res.status).toBe(400)
  })

  it('returns 400 for invalid body shape', async () => {
    // category must be a string when provided.
    const res = await PUT(
      buildRequest({ category: 123 }),
      buildParams(MESSAGE_ID),
    )
    expect(res.status).toBe(400)
  })

  it('returns 400 for invalid JSON body', async () => {
    const req = new Request('http://test/admin/conversations/api/review/x', {
      method: 'PUT',
      body: '{not json',
      headers: { 'content-type': 'application/json' },
    })
    const res = await PUT(req, buildParams(MESSAGE_ID))
    expect(res.status).toBe(400)
  })
})

describe('PUT /admin/conversations/api/review/[messageId] — message guards', () => {
  beforeEach(() => {
    vi.mocked(createServerClient).mockResolvedValue(
      makeSessionMock({ user: { id: AUTH_USER_ID } }) as unknown as Awaited<
        ReturnType<typeof createServerClient>
      >,
    )
    vi.mocked(verifyAnalogAdminAccess).mockResolvedValue({
      operatorId: OPERATOR_ID,
      allowedVenueIds: [],
      isAnalogAdmin: true,
    })
  })

  it('returns 404 when message not found', async () => {
    const state = newAdminState({ message: null })
    vi.mocked(createAdminClient).mockReturnValue(
      makeAdminMock(state) as unknown as ReturnType<typeof createAdminClient>,
    )

    const res = await PUT(buildRequest({}), buildParams(MESSAGE_ID))
    expect(res.status).toBe(404)
  })

  it('returns 400 for inbound message (reviews are outbound-only)', async () => {
    const state = newAdminState({
      message: { id: MESSAGE_ID, venue_id: VENUE_ID, direction: 'inbound' },
    })
    vi.mocked(createAdminClient).mockReturnValue(
      makeAdminMock(state) as unknown as ReturnType<typeof createAdminClient>,
    )

    const res = await PUT(buildRequest({}), buildParams(MESSAGE_ID))
    expect(res.status).toBe(400)
    expect(state.updateCalls).toEqual([])
    expect(upsertCorpusEdit).not.toHaveBeenCalled()
    expect(dedupeAndAppendAntiPatterns).not.toHaveBeenCalled()
  })

  it('returns 403 when venue not in allowedVenueIds', async () => {
    vi.mocked(verifyAnalogAdminAccess).mockResolvedValue({
      operatorId: OPERATOR_ID,
      allowedVenueIds: ['some-other-venue-id'],
      isAnalogAdmin: true,
    })
    const state = newAdminState()
    vi.mocked(createAdminClient).mockReturnValue(
      makeAdminMock(state) as unknown as ReturnType<typeof createAdminClient>,
    )

    const res = await PUT(buildRequest({}), buildParams(MESSAGE_ID))
    expect(res.status).toBe(403)
  })
})

describe('PUT /admin/conversations/api/review/[messageId] — success paths', () => {
  beforeEach(() => {
    vi.mocked(createServerClient).mockResolvedValue(
      makeSessionMock({ user: { id: AUTH_USER_ID } }) as unknown as Awaited<
        ReturnType<typeof createServerClient>
      >,
    )
    vi.mocked(verifyAnalogAdminAccess).mockResolvedValue({
      operatorId: OPERATOR_ID,
      allowedVenueIds: [],
      isAnalogAdmin: true,
    })
  })

  it('runs corpus → antipattern → JSONB stamp in that order on a full save', async () => {
    const state = newAdminState()
    vi.mocked(createAdminClient).mockReturnValue(
      makeAdminMock(state) as unknown as ReturnType<typeof createAdminClient>,
    )
    vi.mocked(upsertCorpusEdit).mockResolvedValue({
      ok: true,
      corpusId: 'new-corpus-id',
      outcome: 'replaced',
    })
    vi.mocked(dedupeAndAppendAntiPatterns).mockResolvedValue({
      existing: [],
      added: ["rule: don't apologize twice"],
    })

    const res = await PUT(
      buildRequest({
        category: 'comp_complaint',
        editedMessage: 'try a refund of the cortado.',
        comment: 'too defensive in the original',
        rule: "rule: don't apologize twice",
      }),
      buildParams(MESSAGE_ID),
    )

    expect(res.status).toBe(200)
    const corpusOrder = vi.mocked(upsertCorpusEdit).mock.invocationCallOrder[0]
    const ruleOrder = vi.mocked(dedupeAndAppendAntiPatterns).mock.invocationCallOrder[0]
    expect(corpusOrder).toBeLessThan(ruleOrder)
    expect(state.updateCalls).toHaveLength(1)
    const stampedJson = state.updateCalls[0].payload.response_review as Record<string, unknown>
    expect(stampedJson.editedMessage).toBe('try a refund of the cortado.')
    expect(stampedJson.rule).toBe("rule: don't apologize twice")
    expect(stampedJson.reviewedBy).toBe(OPERATOR_ID)
    expect(stampedJson.schemaVersion).toBe(1)
    // verdict and corpusSourceRef stripped per pushback.
    expect('verdict' in stampedJson).toBe(false)
    expect('corpusSourceRef' in stampedJson).toBe(false)
  })

  it('passes replace mode + tags to upsertCorpusEdit', async () => {
    const state = newAdminState()
    vi.mocked(createAdminClient).mockReturnValue(
      makeAdminMock(state) as unknown as ReturnType<typeof createAdminClient>,
    )
    vi.mocked(upsertCorpusEdit).mockResolvedValue({
      ok: true,
      corpusId: 'new-corpus-id',
      outcome: 'inserted',
    })

    await PUT(
      buildRequest({ category: 'reply', editedMessage: 'better' }),
      buildParams(MESSAGE_ID),
    )

    expect(upsertCorpusEdit).toHaveBeenCalledWith(
      {
        venueId: VENUE_ID,
        sourceRef: `cc-review:${MESSAGE_ID}`,
        editedMessage: 'better',
        tags: ['cc_review', 'reply'],
      },
      'replace',
    )
  })

  it('omits category from tags when category is absent', async () => {
    const state = newAdminState()
    vi.mocked(createAdminClient).mockReturnValue(
      makeAdminMock(state) as unknown as ReturnType<typeof createAdminClient>,
    )
    vi.mocked(upsertCorpusEdit).mockResolvedValue({
      ok: true,
      corpusId: 'new-corpus-id',
      outcome: 'inserted',
    })

    await PUT(
      buildRequest({ editedMessage: 'better' }),
      buildParams(MESSAGE_ID),
    )

    expect(upsertCorpusEdit).toHaveBeenCalledWith(
      expect.objectContaining({ tags: ['cc_review'] }),
      'replace',
    )
  })

  it('skips corpus and antipattern when only category + comment are present (stamp-only)', async () => {
    const state = newAdminState()
    vi.mocked(createAdminClient).mockReturnValue(
      makeAdminMock(state) as unknown as ReturnType<typeof createAdminClient>,
    )

    const res = await PUT(
      buildRequest({ category: 'reply', comment: 'looks good' }),
      buildParams(MESSAGE_ID),
    )

    expect(res.status).toBe(200)
    expect(upsertCorpusEdit).not.toHaveBeenCalled()
    expect(dedupeAndAppendAntiPatterns).not.toHaveBeenCalled()
    expect(state.updateCalls).toHaveLength(1)
  })

  it('expectedFailure=true short-circuits ingestion (skip corpus + antipattern, stamp only)', async () => {
    const state = newAdminState()
    vi.mocked(createAdminClient).mockReturnValue(
      makeAdminMock(state) as unknown as ReturnType<typeof createAdminClient>,
    )

    const res = await PUT(
      buildRequest({
        editedMessage: 'should not be ingested',
        rule: "rule: should not be appended",
        expectedFailure: true,
      }),
      buildParams(MESSAGE_ID),
    )

    expect(res.status).toBe(200)
    expect(upsertCorpusEdit).not.toHaveBeenCalled()
    expect(dedupeAndAppendAntiPatterns).not.toHaveBeenCalled()
    expect(state.updateCalls).toHaveLength(1)
    const stamped = state.updateCalls[0].payload.response_review as Record<string, unknown>
    expect(stamped.expectedFailure).toBe(true)
    // The submitted edit/rule are still recorded in the JSONB even though
    // they didn't drive ingestion — operator audit value.
    expect(stamped.editedMessage).toBe('should not be ingested')
  })
})

describe('PUT /admin/conversations/api/review/[messageId] — failure paths', () => {
  beforeEach(() => {
    vi.mocked(createServerClient).mockResolvedValue(
      makeSessionMock({ user: { id: AUTH_USER_ID } }) as unknown as Awaited<
        ReturnType<typeof createServerClient>
      >,
    )
    vi.mocked(verifyAnalogAdminAccess).mockResolvedValue({
      operatorId: OPERATOR_ID,
      allowedVenueIds: [],
      isAnalogAdmin: true,
    })
  })

  it('returns 502 when upsertCorpusEdit fails with embed_failed; antipattern + stamp not called', async () => {
    const state = newAdminState()
    vi.mocked(createAdminClient).mockReturnValue(
      makeAdminMock(state) as unknown as ReturnType<typeof createAdminClient>,
    )
    vi.mocked(upsertCorpusEdit).mockResolvedValue({
      ok: false,
      error: 'voyage timeout',
      errorCode: 'embed_failed',
    })

    const res = await PUT(
      buildRequest({ editedMessage: 'edit', rule: 'rule: foo' }),
      buildParams(MESSAGE_ID),
    )

    expect(res.status).toBe(502)
    expect(dedupeAndAppendAntiPatterns).not.toHaveBeenCalled()
    expect(state.updateCalls).toEqual([])
  })

  it('returns 500 when dedupeAndAppendAntiPatterns throws; stamp not called', async () => {
    const state = newAdminState()
    vi.mocked(createAdminClient).mockReturnValue(
      makeAdminMock(state) as unknown as ReturnType<typeof createAdminClient>,
    )
    vi.mocked(dedupeAndAppendAntiPatterns).mockRejectedValue(new Error('venue_configs not found'))

    const res = await PUT(
      buildRequest({ rule: 'rule: be terser' }),
      buildParams(MESSAGE_ID),
    )

    expect(res.status).toBe(500)
    expect(state.updateCalls).toEqual([])
  })
})
