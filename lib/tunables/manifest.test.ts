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

import { SEND_FIDELITY_FLOOR } from '@/lib/agent/stages'
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
  it('contains exactly 48 entries (locks the audit set)', () => {
    // TAC-350 added knowledge_relevance_floor; TAC-367 added
    // verify_grounding_max_output_tokens. TAC-380 added six intention
    // entries. TAC-421 removed the four lib/agent/timing.ts entries with
    // the module itself. Decision 0007 (voice is a static pack) removed
    // corpus_top_similarity_low_threshold, corpus_retrieve_limit,
    // min_strong_matches and strong_match_similarity with the retrieval
    // mechanism they tuned.
    expect(TUNABLES.length).toBe(48)
  })

  // Per-category counts catch silent rebalancing — a future writer adding to
  // one bucket and removing from another keeps the total satisfied. Adding a
  // tunable means bumping both the total above and the category below; this
  // second assertion is what makes the first one mean anything.
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
      // Decision 0007 removed corpus_top_similarity_low_threshold.
      agent_runtime: 22,
      classification: 3,
      // TAC-421 took this from 11 to 7: the four lib/agent/timing.ts
      // constants went with the deleted module. The remaining seven are
      // followup + knowledge-gap windows, which are unrelated.
      timing: 7,
      recognition: 8,
      // TAC-350 added knowledge_relevance_floor; decision 0007 removed
      // corpus_retrieve_limit, min_strong_matches, strong_match_similarity.
      retrieval: 8,
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

    const floor = TUNABLES.find((t) => t.name === 'similarity_floor')
    expect(floor?.value).toBe(SIMILARITY_FLOOR)
  })

  // Decision 0007: voice is a static pack, so the retrieval-era voice
  // tunables must not quietly reappear under their old names.
  it('carries no entry for the removed voice-retrieval mechanism', () => {
    const retired = [
      'corpus_top_similarity_low_threshold',
      'corpus_retrieve_limit',
      'min_strong_matches',
      'strong_match_similarity',
    ]
    for (const name of retired) {
      expect(TUNABLES.find((t) => t.name === name)).toBeUndefined()
    }
  })
})
