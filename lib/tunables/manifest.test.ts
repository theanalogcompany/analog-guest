import { describe, expect, it, vi } from 'vitest'

// The manifest transitively imports modules that init heavy SDK clients
// at module load (Voyage via lib/rag/retrieve → lib/rag/embed → lib/rag/client).
// Voyage's ESM build trips vitest's directory-import resolution. We mock
// just the SDK leaf — the constants the manifest needs are evaluated
// before any client is instantiated at runtime, so this mock is only test
// scaffolding to dodge the resolver bug.
vi.mock('voyageai', () => ({
  VoyageAIClient: class {},
}))

import { SEND_FIDELITY_FLOOR, STRONG_MATCH_SIMILARITY } from '@/lib/agent/stages'
import { SIMILARITY_FLOOR } from '@/lib/rag/retrieve'
import { TUNABLES, type TunableCategory, type TunableType } from './manifest'

const VALID_CATEGORIES: readonly TunableCategory[] = [
  'agent_runtime',
  'classification',
  'timing',
  'recognition',
  'retrieval',
  'mechanics',
]

const VALID_TYPES: readonly TunableType[] = [
  'number',
  'boolean',
  'string-enum',
  'range',
  'object',
]

describe('TUNABLES manifest', () => {
  it('contains exactly 33 entries (locks the audit set)', () => {
    expect(TUNABLES.length).toBe(33)
  })

  // Per-category counts catch silent rebalancing — a future writer adding to
  // one bucket and removing from another keeps the total satisfied. The
  // CLAUDE.md "Adding a tunable" rubric tells writers to bump the count
  // assertion; this makes the assertion meaningful.
  it('matches the documented per-category breakdown', () => {
    const counts: Record<TunableCategory, number> = {
      agent_runtime: 0,
      classification: 0,
      timing: 0,
      recognition: 0,
      retrieval: 0,
      mechanics: 0,
    }
    for (const t of TUNABLES) counts[t.category] += 1
    expect(counts).toEqual({
      agent_runtime: 10,
      classification: 1,
      timing: 4,
      recognition: 8,
      retrieval: 10,
      mechanics: 0,
    })
  })

  it('has unique entry names', () => {
    const names = TUNABLES.map((t) => t.name)
    expect(new Set(names).size).toBe(names.length)
  })

  it('every entry has a valid category', () => {
    for (const t of TUNABLES) {
      expect(VALID_CATEGORIES).toContain(t.category)
    }
  })

  it('every entry has a valid type', () => {
    for (const t of TUNABLES) {
      expect(VALID_TYPES).toContain(t.type)
    }
  })

  it('every entry has a non-empty description and source path', () => {
    for (const t of TUNABLES) {
      expect(t.description.length).toBeGreaterThan(0)
      expect(t.source.length).toBeGreaterThan(0)
    }
  })

  it('values match the imported source constants for spot-checked entries', () => {
    const fidelity = TUNABLES.find((t) => t.name === 'send_fidelity_floor')
    expect(fidelity?.value).toBe(SEND_FIDELITY_FLOOR)

    const strong = TUNABLES.find((t) => t.name === 'strong_match_similarity')
    expect(strong?.value).toBe(STRONG_MATCH_SIMILARITY)

    const floor = TUNABLES.find((t) => t.name === 'similarity_floor')
    expect(floor?.value).toBe(SIMILARITY_FLOOR)
  })

  // Documented in the manifest header: STRONG_MATCH_SIMILARITY (agent gate)
  // counts chunks the rag layer has already admitted, so it can never be lower
  // than SIMILARITY_FLOOR (rag layer filter) without becoming meaningless.
  it('preserves invariant: STRONG_MATCH_SIMILARITY >= SIMILARITY_FLOOR', () => {
    expect(STRONG_MATCH_SIMILARITY).toBeGreaterThanOrEqual(SIMILARITY_FLOOR)
  })
})
