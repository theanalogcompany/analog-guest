// Mock signatures mirror the supabase-js fluent builder, which passes column
// names + filter args we don't inspect inside the test.
/* eslint-disable @typescript-eslint/no-unused-vars */

import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/db/admin', () => ({
  createAdminClient: vi.fn(),
}))

import { createAdminClient } from '@/lib/db/admin'
import {
  dedupeAndAppendAntiPatterns,
  normalizeAntiPattern,
} from './append-anti-patterns'

// dedupeAndAppendAntiPatterns is DB-touching; this file mocks the admin
// client at the supabase-js builder boundary. Coverage matters here because
// THE-236 reshaped the persisted entries from string[] to struct[] and
// readers/writers across the codebase rely on the in-place forward
// migration semantics this helper enforces.

describe('normalizeAntiPattern', () => {
  it('lowercases, collapses internal whitespace, trims edges', () => {
    expect(normalizeAntiPattern('  Rule:   Avoid  EM-Dashes  ')).toBe('rule: avoid em-dashes')
  })

  it('treats whitespace-different rules as equivalent', () => {
    expect(normalizeAntiPattern('rule: be   terse')).toBe(normalizeAntiPattern('rule: be terse'))
  })

  it('treats case-different rules as equivalent', () => {
    expect(normalizeAntiPattern('Rule: be Terse')).toBe(normalizeAntiPattern('rule: be terse'))
  })

  it('returns empty string for whitespace-only input', () => {
    expect(normalizeAntiPattern('   \n\t   ')).toBe('')
  })
})

const VENUE_ID = '11111111-1111-4111-8111-111111111111'
const OPERATOR_ID = '22222222-2222-4222-8222-222222222222'

// Minimal valid persona shape — the helper round-trips the whole object via
// BrandPersonaSchema and must not lose unrelated fields.
function makePersonaWithAntiPatterns(antiPatterns: unknown[]) {
  return {
    tone: 'warm and direct',
    formality: 'casual',
    speakerFraming: 'venue',
    emojiPolicy: 'never',
    lengthGuide: 'short — 1-2 sentences',
    signaturePhrases: [],
    bannedTopics: [],
    voiceTouchstones: [],
    voiceAntiPatterns: antiPatterns,
  }
}

interface MockState {
  /** Whatever shape the test wants in venue_configs.brand_persona. */
  persona: ReturnType<typeof makePersonaWithAntiPatterns>
  /** Captured `update` payloads — we inspect these to assert what got written. */
  updateCalls: Array<{ payload: Record<string, unknown> }>
}

function makeAdminMock(state: MockState) {
  return {
    from: (_table: string) => ({
      select: (_cols: string) => ({
        eq: (_col: string, _v: unknown) => ({
          single: async () => ({
            data: { brand_persona: state.persona },
            error: null,
          }),
        }),
      }),
      update: (payload: Record<string, unknown>) => ({
        eq: async (_col: string, _v: unknown) => {
          state.updateCalls.push({ payload })
          return { error: null }
        },
      }),
    }),
  }
}

beforeEach(() => {
  vi.mocked(createAdminClient).mockReset()
})

describe('dedupeAndAppendAntiPatterns — write shape', () => {
  it('writes struct entries with text, source, addedAt, and authorOperatorId', async () => {
    const state: MockState = {
      persona: makePersonaWithAntiPatterns([]),
      updateCalls: [],
    }
    vi.mocked(createAdminClient).mockReturnValue(
      makeAdminMock(state) as unknown as ReturnType<typeof createAdminClient>,
    )

    const result = await dedupeAndAppendAntiPatterns(
      VENUE_ID,
      ['no marketing flourishes'],
      { source: 'auto', authorOperatorId: OPERATOR_ID },
    )

    expect(result.added).toEqual(['no marketing flourishes'])
    expect(state.updateCalls).toHaveLength(1)
    const written = state.updateCalls[0].payload.brand_persona as {
      voiceAntiPatterns: Array<Record<string, unknown>>
    }
    expect(written.voiceAntiPatterns).toHaveLength(1)
    const entry = written.voiceAntiPatterns[0]
    expect(entry.text).toBe('no marketing flourishes')
    expect(entry.source).toBe('auto')
    expect(entry.authorOperatorId).toBe(OPERATOR_ID)
    expect(typeof entry.addedAt).toBe('string')
    // ISO-8601 sanity check — the helper stamps `new Date().toISOString()`.
    expect(entry.addedAt as string).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/)
  })

  it('omits authorOperatorId when not provided (CLI/script path)', async () => {
    const state: MockState = {
      persona: makePersonaWithAntiPatterns([]),
      updateCalls: [],
    }
    vi.mocked(createAdminClient).mockReturnValue(
      makeAdminMock(state) as unknown as ReturnType<typeof createAdminClient>,
    )

    await dedupeAndAppendAntiPatterns(VENUE_ID, ['avoid em dashes'], {
      source: 'manual',
    })

    const written = state.updateCalls[0].payload.brand_persona as {
      voiceAntiPatterns: Array<Record<string, unknown>>
    }
    const entry = written.voiceAntiPatterns[0]
    expect(entry).not.toHaveProperty('authorOperatorId')
    expect(entry.source).toBe('manual')
  })
})

describe('dedupeAndAppendAntiPatterns — mixed input migration', () => {
  it('preserves legacy string entries as struct on first write (in-place migration)', async () => {
    // The Zod parse on read transforms the legacy strings into struct shape;
    // the write-back persists the migrated form alongside the new entry.
    const state: MockState = {
      persona: makePersonaWithAntiPatterns([
        'legacy entry 1',
        'legacy entry 2',
      ]),
      updateCalls: [],
    }
    vi.mocked(createAdminClient).mockReturnValue(
      makeAdminMock(state) as unknown as ReturnType<typeof createAdminClient>,
    )

    await dedupeAndAppendAntiPatterns(VENUE_ID, ['fresh entry'], {
      source: 'auto',
    })

    const written = state.updateCalls[0].payload.brand_persona as {
      voiceAntiPatterns: Array<{ text: string; source: string; addedAt?: string }>
    }
    expect(written.voiceAntiPatterns).toHaveLength(3)
    // Legacy entries: text preserved, source defaulted to 'manual', no addedAt
    expect(written.voiceAntiPatterns[0]).toEqual({
      text: 'legacy entry 1',
      source: 'manual',
    })
    expect(written.voiceAntiPatterns[1]).toEqual({
      text: 'legacy entry 2',
      source: 'manual',
    })
    // New entry: full struct with addedAt
    expect(written.voiceAntiPatterns[2].text).toBe('fresh entry')
    expect(written.voiceAntiPatterns[2].source).toBe('auto')
    expect(typeof written.voiceAntiPatterns[2].addedAt).toBe('string')
  })

  it('preserves struct entries with their existing metadata', async () => {
    const existingStruct = {
      text: 'existing struct',
      source: 'auto',
      authorOperatorId: 'd4f6e3a2-1b5c-4f8e-9a7d-2e3f4b5c6d7e',
      addedAt: '2026-04-01T10:00:00.000Z',
    }
    const state: MockState = {
      persona: makePersonaWithAntiPatterns([existingStruct]),
      updateCalls: [],
    }
    vi.mocked(createAdminClient).mockReturnValue(
      makeAdminMock(state) as unknown as ReturnType<typeof createAdminClient>,
    )

    await dedupeAndAppendAntiPatterns(VENUE_ID, ['second entry'], {
      source: 'manual',
      authorOperatorId: OPERATOR_ID,
    })

    const written = state.updateCalls[0].payload.brand_persona as {
      voiceAntiPatterns: Array<Record<string, unknown>>
    }
    expect(written.voiceAntiPatterns).toHaveLength(2)
    expect(written.voiceAntiPatterns[0]).toEqual(existingStruct)
  })
})

describe('dedupeAndAppendAntiPatterns — dedup behavior', () => {
  it('skips a candidate that exactly matches an existing entry', async () => {
    const state: MockState = {
      persona: makePersonaWithAntiPatterns(['no marketing flourishes']),
      updateCalls: [],
    }
    vi.mocked(createAdminClient).mockReturnValue(
      makeAdminMock(state) as unknown as ReturnType<typeof createAdminClient>,
    )

    const result = await dedupeAndAppendAntiPatterns(
      VENUE_ID,
      ['no marketing flourishes'],
      { source: 'manual' },
    )

    expect(result.added).toEqual([])
    // No write should fire when nothing was added — round-trip migration is
    // intentionally lazy, only writes when we have net-new content.
    expect(state.updateCalls).toHaveLength(0)
  })

  it('skips a candidate that matches existing only after whitespace + case normalization', async () => {
    const state: MockState = {
      persona: makePersonaWithAntiPatterns(['No Marketing Flourishes']),
      updateCalls: [],
    }
    vi.mocked(createAdminClient).mockReturnValue(
      makeAdminMock(state) as unknown as ReturnType<typeof createAdminClient>,
    )

    const result = await dedupeAndAppendAntiPatterns(
      VENUE_ID,
      ['no   marketing  flourishes'],
      { source: 'manual' },
    )

    expect(result.added).toEqual([])
    expect(state.updateCalls).toHaveLength(0)
  })

  it('dedupes within the candidate batch (intra-batch)', async () => {
    const state: MockState = {
      persona: makePersonaWithAntiPatterns([]),
      updateCalls: [],
    }
    vi.mocked(createAdminClient).mockReturnValue(
      makeAdminMock(state) as unknown as ReturnType<typeof createAdminClient>,
    )

    const result = await dedupeAndAppendAntiPatterns(
      VENUE_ID,
      ['avoid em dashes', 'AVOID EM DASHES', 'avoid  em dashes'],
      { source: 'auto' },
    )

    expect(result.added).toEqual(['avoid em dashes'])
    const written = state.updateCalls[0].payload.brand_persona as {
      voiceAntiPatterns: unknown[]
    }
    expect(written.voiceAntiPatterns).toHaveLength(1)
  })

  it('returns existing texts (not structs) for caller-side counting', async () => {
    const state: MockState = {
      persona: makePersonaWithAntiPatterns([
        'legacy a',
        { text: 'struct b', source: 'auto', addedAt: '2026-04-01T00:00:00.000Z' },
      ]),
      updateCalls: [],
    }
    vi.mocked(createAdminClient).mockReturnValue(
      makeAdminMock(state) as unknown as ReturnType<typeof createAdminClient>,
    )

    const result = await dedupeAndAppendAntiPatterns(VENUE_ID, ['c'], {
      source: 'manual',
    })

    // existing/added are string[] by design — see the AntiPatternUpdateResult
    // interface comment about the deliberately narrow return shape.
    expect(result.existing).toEqual(['legacy a', 'struct b'])
    expect(result.added).toEqual(['c'])
  })
})
