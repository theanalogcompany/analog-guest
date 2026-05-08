import { NextResponse } from 'next/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/auth', () => ({
  requireVenueAdmin: vi.fn(),
}))
vi.mock('@/lib/voice-training', () => ({
  upsertCorpusEdit: vi.fn(),
  dedupeAndAppendAntiPatterns: vi.fn(),
  SOURCE_REF_PREFIXES: {
    ccReview: 'cc-review:',
    voicesCommit: 'voices-commit:',
    phase5Review: '08-review:',
  },
}))
vi.mock('@/lib/voices', () => ({
  persistCritique: vi.fn(),
  findPatternClusterForCritique: vi.fn(),
}))
vi.mock('@/lib/analytics/posthog', () => ({
  capturePostHogEvent: vi.fn().mockResolvedValue(undefined),
}))

import { requireVenueAdmin } from '@/lib/auth'
import {
  dedupeAndAppendAntiPatterns,
  upsertCorpusEdit,
} from '@/lib/voice-training'
import {
  findPatternClusterForCritique,
  persistCritique,
} from '@/lib/voices'
import { POST } from './route'

const VENUE_ID = '11111111-1111-4111-8111-111111111111'
const MSG_ID = '22222222-2222-4222-8222-222222222222'
const OP_ID = '33333333-3333-4333-8333-333333333333'
const CRIT_ID = '44444444-4444-4444-8444-444444444444'

function buildRequest(body: unknown): Request {
  return new Request('http://test/admin/voices/api/commit', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  })
}

beforeEach(() => {
  vi.mocked(requireVenueAdmin).mockReset()
  vi.mocked(upsertCorpusEdit).mockReset()
  vi.mocked(dedupeAndAppendAntiPatterns).mockReset()
  vi.mocked(persistCritique).mockReset()
  vi.mocked(findPatternClusterForCritique).mockReset()
  vi.mocked(requireVenueAdmin).mockResolvedValue({
    ok: true,
    operatorId: OP_ID,
    venueId: VENUE_ID,
  })
  vi.mocked(persistCritique).mockResolvedValue({
    ok: true,
    critiqueId: CRIT_ID,
    embedding: [0.1, 0.2],
  })
  vi.mocked(findPatternClusterForCritique).mockResolvedValue(null)
})

describe('POST /admin/voices/api/commit — edit_only path', () => {
  it('writes corpus + critique, runs cluster check, returns null cluster when below threshold', async () => {
    vi.mocked(upsertCorpusEdit).mockResolvedValue({
      ok: true,
      corpusId: 'c1',
      outcome: 'inserted',
    })

    const res = await POST(
      buildRequest({
        venueId: VENUE_ID,
        originalMessageId: MSG_ID,
        selectedResponse: "yeah. oat's on.",
        critique: 'too eager',
        kind: 'edit_only',
        saveToCorpus: true,
      }),
    )
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json).toMatchObject({
      success: true,
      corpusOutcome: 'inserted',
      antiPatternAdded: [],
      critiqueId: CRIT_ID,
      patternCluster: null,
    })

    expect(upsertCorpusEdit).toHaveBeenCalledWith(
      expect.objectContaining({
        venueId: VENUE_ID,
        sourceRef: `voices-commit:${MSG_ID}`,
      }),
      'replace',
    )
    expect(persistCritique).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'edit_only',
        createdByOperatorId: OP_ID,
      }),
    )
    expect(findPatternClusterForCritique).toHaveBeenCalled()
    expect(dedupeAndAppendAntiPatterns).not.toHaveBeenCalled()
  })

  it('returns the cluster payload when verification confirms', async () => {
    vi.mocked(upsertCorpusEdit).mockResolvedValue({
      ok: true,
      corpusId: 'c1',
      outcome: 'inserted',
    })
    vi.mocked(findPatternClusterForCritique).mockResolvedValue({
      critiqueIds: [CRIT_ID, 'a', 'b'],
      members: [
        { id: CRIT_ID, text: 'too eager', messageId: MSG_ID },
        { id: 'a', text: 'sounds like marketing', messageId: 'm1' },
        { id: 'b', text: 'drop the exclamation', messageId: 'm2' },
      ],
      proposedRuleText: 'no marketing flourishes',
    })

    const res = await POST(
      buildRequest({
        venueId: VENUE_ID,
        originalMessageId: MSG_ID,
        selectedResponse: "yeah. oat's on.",
        critique: 'too eager',
        kind: 'edit_only',
        saveToCorpus: true,
      }),
    )
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.patternCluster).not.toBeNull()
    expect(json.patternCluster.proposedRuleText).toBe('no marketing flourishes')
  })

  it('skips corpus write when saveToCorpus=false', async () => {
    const res = await POST(
      buildRequest({
        venueId: VENUE_ID,
        originalMessageId: MSG_ID,
        selectedResponse: "yeah. oat's on.",
        critique: 'too eager',
        kind: 'edit_only',
        saveToCorpus: false,
      }),
    )
    expect(res.status).toBe(200)
    expect(upsertCorpusEdit).not.toHaveBeenCalled()
  })
})

describe('POST /admin/voices/api/commit — edit_and_rule path', () => {
  it('appends rule with source=manual + operator UUID, no cluster check', async () => {
    vi.mocked(upsertCorpusEdit).mockResolvedValue({
      ok: true,
      corpusId: 'c1',
      outcome: 'inserted',
    })
    vi.mocked(dedupeAndAppendAntiPatterns).mockResolvedValue({
      existing: [],
      added: ['no marketing flourishes'],
    })

    const res = await POST(
      buildRequest({
        venueId: VENUE_ID,
        originalMessageId: MSG_ID,
        selectedResponse: 'morning',
        critique: 'too eager',
        kind: 'edit_and_rule',
        ruleTextOverride: 'no marketing flourishes',
        saveToCorpus: true,
      }),
    )
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.antiPatternAdded).toEqual(['no marketing flourishes'])
    expect(dedupeAndAppendAntiPatterns).toHaveBeenCalledWith(
      VENUE_ID,
      ['no marketing flourishes'],
      { source: 'manual', authorOperatorId: OP_ID },
    )
    // edit_and_rule path doesn't run cluster check
    expect(findPatternClusterForCritique).not.toHaveBeenCalled()
  })

  it('400 when kind=edit_and_rule but ruleTextOverride is empty', async () => {
    vi.mocked(upsertCorpusEdit).mockResolvedValue({
      ok: true,
      corpusId: 'c1',
      outcome: 'inserted',
    })

    const res = await POST(
      buildRequest({
        venueId: VENUE_ID,
        originalMessageId: MSG_ID,
        selectedResponse: 'morning',
        critique: 'too eager',
        kind: 'edit_and_rule',
        ruleTextOverride: '   ',
        saveToCorpus: true,
      }),
    )
    expect(res.status).toBe(400)
  })
})

describe('POST /admin/voices/api/commit — error paths', () => {
  it('502 when corpus embed fails', async () => {
    vi.mocked(upsertCorpusEdit).mockResolvedValue({
      ok: false,
      error: 'voyage 502',
      errorCode: 'embed_failed',
    })

    const res = await POST(
      buildRequest({
        venueId: VENUE_ID,
        originalMessageId: MSG_ID,
        selectedResponse: 'morning',
        critique: 'x',
        kind: 'edit_only',
        saveToCorpus: true,
      }),
    )
    expect(res.status).toBe(502)
  })

  it('502 when persistCritique embed fails', async () => {
    vi.mocked(persistCritique).mockResolvedValue({
      ok: false,
      error: 'voyage 502',
      errorCode: 'embed_failed',
    })

    const res = await POST(
      buildRequest({
        venueId: VENUE_ID,
        originalMessageId: MSG_ID,
        selectedResponse: 'morning',
        critique: 'x',
        kind: 'edit_only',
        saveToCorpus: false,
      }),
    )
    expect(res.status).toBe(502)
  })

  it('passes through auth helper response', async () => {
    vi.mocked(requireVenueAdmin).mockResolvedValue({
      ok: false,
      response: NextResponse.json({ error: 'venue not allowed' }, { status: 403 }),
    })

    const res = await POST(
      buildRequest({
        venueId: VENUE_ID,
        originalMessageId: MSG_ID,
        selectedResponse: 'morning',
        critique: 'x',
        kind: 'edit_only',
        saveToCorpus: false,
      }),
    )
    expect(res.status).toBe(403)
  })
})
