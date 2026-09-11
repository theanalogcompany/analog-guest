import { describe, expect, it } from 'vitest'
import {
  computeRowHash,
  cosineSimilarity,
  dedupeRowsBySampleId,
  detectTombstones,
  filterRunnableScenarios,
  filterTombstoneDuplicates,
  groupTombstonesByTopic,
  mergeScenarioRows,
  stampFreshRows,
  type MetaEntry,
} from './merge-scenario-sheet-pure'
import type { Scenario, ScenarioSheetRow } from './scenario-schema'

const baseScenario = (overrides: Partial<Scenario> = {}): Scenario => ({
  sample_id: 'venue_topic:story:1',
  topic: 'story_and_sourcing',
  category: 'venue_topic',
  mode: 'graded',
  guest_state: 'new',
  scenario: 'asks about bean origin',
  inbound_message: 'where do your beans come from',
  expected_failure: null,
  scenario_source: 'venue_topic',
  expected_facts: ['sourced from a farm in Guatemala'],
  forbidden_claims: [],
  source_row_ids: ['kc-1'],
  expected_route: 'unknown',
  expected_behavior: '',
  ...overrides,
})

const stampRow = (overrides: Partial<Scenario> = {}): ScenarioSheetRow => {
  return stampFreshRows([baseScenario(overrides)])[0]
}

describe('computeRowHash', () => {
  it('is deterministic for identical content', () => {
    const row = stampRow()
    expect(computeRowHash(row)).toBe(computeRowHash(row))
  })

  it('changes when the message changes', () => {
    const a = stampRow({ inbound_message: 'where do your beans come from' })
    const b = stampRow({ inbound_message: 'where do you source your coffee' })
    expect(computeRowHash(a)).not.toBe(computeRowHash(b))
  })

  it('changes when exclude changes (exclude is owner-controllable content)', () => {
    const row = stampRow()
    const excluded = { ...row, exclude: true }
    expect(computeRowHash(row)).not.toBe(computeRowHash(excluded))
  })

  it('changes when notes changes', () => {
    const row = stampRow()
    const noted = { ...row, notes: 'owner thinks this is fine' }
    expect(computeRowHash(row)).not.toBe(computeRowHash(noted))
  })

  it('does not depend on sample_id, origin, or generated_hash', () => {
    const a = stampRow()
    const b = { ...a, sample_id: 'different-id' }
    expect(computeRowHash(a)).toBe(computeRowHash(b))
  })
})

describe('stampFreshRows', () => {
  it('stamps origin=generated and a hash matching the stamped content', () => {
    const [row] = stampFreshRows([baseScenario()])
    expect(row.origin).toBe('generated')
    expect(row.exclude).toBe(false)
    expect(row.notes).toBe('')
    expect(row.generated_hash).toBe(computeRowHash(row))
  })
})

describe('mergeScenarioRows', () => {
  it('replaces an untouched generated row (hash still matches)', () => {
    const untouched = stampRow({ sample_id: 'a' })
    const fresh = stampFreshRows([baseScenario({ sample_id: 'b', inbound_message: 'fresh regen' })])
    const { finalRows, stats } = mergeScenarioRows({ currentRows: [untouched], freshStampedRows: fresh })
    expect(finalRows.map((r) => r.sample_id)).toEqual(['b'])
    expect(stats).toEqual({ keptOwner: 0, keptEdited: 0, replaced: 1, inserted: 1, dedupedSampleIds: [] })
  })

  it('preserves an edited generated row (hash no longer matches) untouched', () => {
    const original = stampRow({ sample_id: 'a', inbound_message: 'original message' })
    const edited: ScenarioSheetRow = { ...original, inbound_message: 'owner rewrote this' }
    const fresh = stampFreshRows([baseScenario({ sample_id: 'b' })])
    const { finalRows, stats } = mergeScenarioRows({ currentRows: [edited], freshStampedRows: fresh })
    const keptEdited = finalRows.find((r) => r.sample_id === 'a')
    expect(keptEdited?.inbound_message).toBe('owner rewrote this')
    expect(stats.keptEdited).toBe(1)
    expect(stats.replaced).toBe(0)
  })

  it('preserves an owner-added row regardless of content or hash', () => {
    const ownerRow: ScenarioSheetRow = {
      ...stampRow({ sample_id: 'owner-1', inbound_message: 'owner typed this from scratch' }),
      origin: 'owner',
      generated_hash: 'irrelevant-does-not-matter',
    }
    const fresh = stampFreshRows([baseScenario({ sample_id: 'b' })])
    const { finalRows, stats } = mergeScenarioRows({ currentRows: [ownerRow], freshStampedRows: fresh })
    expect(finalRows.some((r) => r.sample_id === 'owner-1')).toBe(true)
    expect(stats.keptOwner).toBe(1)
  })

  it('an excluded-but-otherwise-untouched row is treated as edited (exclude changes the hash) and preserved', () => {
    const base = stampRow({ sample_id: 'a' })
    const excluded: ScenarioSheetRow = { ...base, exclude: true } // hash still reflects pre-exclude content
    const fresh = stampFreshRows([baseScenario({ sample_id: 'b' })])
    const { finalRows, stats } = mergeScenarioRows({ currentRows: [excluded], freshStampedRows: fresh })
    const kept = finalRows.find((r) => r.sample_id === 'a')
    expect(kept?.exclude).toBe(true)
    expect(stats.keptEdited).toBe(1)
  })

  // TAC-347 Stage 3 bugfix: a "kept" row (hash mismatched for reasons other
  // than an owner edit — the false "kept as edited" bug) that shares an id
  // with a brand-new fresh row must not produce two physical rows.
  it('when a kept-edited row collides with a fresh row sharing its id, the fresh row wins', () => {
    const original = stampRow({ sample_id: 'venue_topic:menu_food:17', inbound_message: 'stale content' })
    const staleKept: ScenarioSheetRow = { ...original, inbound_message: 'unexplainably different now' }
    const fresh = stampFreshRows([
      baseScenario({ sample_id: 'venue_topic:menu_food:17', inbound_message: 'brand new generation' }),
    ])
    const { finalRows, stats } = mergeScenarioRows({ currentRows: [staleKept], freshStampedRows: fresh })
    const matches = finalRows.filter((r) => r.sample_id === 'venue_topic:menu_food:17')
    expect(matches).toHaveLength(1)
    expect(matches[0].inbound_message).toBe('brand new generation')
    expect(stats.dedupedSampleIds).toEqual(['venue_topic:menu_food:17'])
  })

  it('an owner row always wins a same-id collision, even against a fresh row', () => {
    const ownerRow: ScenarioSheetRow = {
      ...stampRow({ sample_id: 'venue_topic:menu_food:17', inbound_message: 'owner wrote this' }),
      origin: 'owner',
      generated_hash: 'irrelevant',
    }
    const fresh = stampFreshRows([
      baseScenario({ sample_id: 'venue_topic:menu_food:17', inbound_message: 'fresh generation' }),
    ])
    const { finalRows, stats } = mergeScenarioRows({ currentRows: [ownerRow], freshStampedRows: fresh })
    const matches = finalRows.filter((r) => r.sample_id === 'venue_topic:menu_food:17')
    expect(matches).toHaveLength(1)
    expect(matches[0].inbound_message).toBe('owner wrote this')
    expect(matches[0].origin).toBe('owner')
    expect(stats.dedupedSampleIds).toEqual(['venue_topic:menu_food:17'])
  })
})

describe('dedupeRowsBySampleId', () => {
  it('is a no-op when every id is unique', () => {
    const rows = [stampRow({ sample_id: 'a' }), stampRow({ sample_id: 'b' })]
    const { rows: result, droppedSampleIds } = dedupeRowsBySampleId(rows)
    expect(result).toHaveLength(2)
    expect(droppedSampleIds).toEqual([])
  })

  it('keeps the LAST generated row among duplicates (most-recently-appended heuristic)', () => {
    const first = stampRow({ sample_id: 'x', inbound_message: 'older' })
    const second = stampRow({ sample_id: 'x', inbound_message: 'newer' })
    const { rows: result, droppedSampleIds } = dedupeRowsBySampleId([first, second])
    expect(result).toHaveLength(1)
    expect(result[0].inbound_message).toBe('newer')
    expect(droppedSampleIds).toEqual(['x'])
  })

  it('never drops an owner row, regardless of position', () => {
    const generated = stampRow({ sample_id: 'x', inbound_message: 'generated' })
    const owner: ScenarioSheetRow = {
      ...stampRow({ sample_id: 'x', inbound_message: 'owner' }),
      origin: 'owner',
    }
    // owner first, generated second (position shouldn't matter)
    const { rows: result } = dedupeRowsBySampleId([owner, generated])
    expect(result).toHaveLength(1)
    expect(result[0].origin).toBe('owner')
  })
})

describe('deleted rows never resurrected (tombstones + similarity filter)', () => {
  it('drops a fresh candidate that duplicates a tombstoned row in the same topic', () => {
    const metaEntries: MetaEntry[] = [
      { id: 'venue_topic:story:1', topic: 'story_and_sourcing', message: 'where do your beans come from' },
    ]
    // The row is gone from the current sheet — owner deleted it.
    const currentRows: ScenarioSheetRow[] = []
    const tombstones = detectTombstones(metaEntries, currentRows)
    expect(tombstones).toHaveLength(1)

    const byTopic = groupTombstonesByTopic(tombstones)
    const freshCandidate = baseScenario({
      sample_id: 'venue_topic:story:2',
      inbound_message: 'where does your coffee come from',
    })
    // Fake similarity: near-identical phrasing scores high.
    const { kept, dropped } = filterTombstoneDuplicates(
      [freshCandidate],
      byTopic,
      () => 0.95,
      0.9,
    )
    expect(kept).toHaveLength(0)
    expect(dropped).toHaveLength(1)
    expect(dropped[0].matchedTombstone.id).toBe('venue_topic:story:1')
  })

  it('keeps a fresh candidate for the same topic that is not similar to any tombstone', () => {
    const metaEntries: MetaEntry[] = [
      { id: 'venue_topic:story:1', topic: 'story_and_sourcing', message: 'where do your beans come from' },
    ]
    const byTopic = groupTombstonesByTopic(detectTombstones(metaEntries, []))
    const freshCandidate = baseScenario({
      sample_id: 'venue_topic:story:2',
      inbound_message: 'do you ever do latte art',
    })
    const { kept, dropped } = filterTombstoneDuplicates([freshCandidate], byTopic, () => 0.1, 0.9)
    expect(kept).toHaveLength(1)
    expect(dropped).toHaveLength(0)
  })

  it('a row still present in the sheet is not a tombstone even if its hash changed', () => {
    const metaEntries: MetaEntry[] = [{ id: 'a', topic: 't', message: 'm' }]
    const currentRows: ScenarioSheetRow[] = [stampRow({ sample_id: 'a' })]
    expect(detectTombstones(metaEntries, currentRows)).toHaveLength(0)
  })

  it('does not cross-match tombstones from a different topic', () => {
    const metaEntries: MetaEntry[] = [{ id: 'a', topic: 'wholesale', message: 'do you sell wholesale' }]
    const byTopic = groupTombstonesByTopic(detectTombstones(metaEntries, []))
    const freshCandidate = baseScenario({ topic: 'story_and_sourcing', inbound_message: 'do you sell wholesale' })
    const { kept, dropped } = filterTombstoneDuplicates([freshCandidate], byTopic, () => 0.99, 0.9)
    expect(kept).toHaveLength(1)
    expect(dropped).toHaveLength(0)
  })
})

describe('filterRunnableScenarios (excluded rows skipped by the runner)', () => {
  it('drops rows with exclude=true and keeps everything else', () => {
    const a = stampRow({ sample_id: 'a' })
    const b: ScenarioSheetRow = { ...stampRow({ sample_id: 'b' }), exclude: true }
    const c = stampRow({ sample_id: 'c' })
    const runnable = filterRunnableScenarios([a, b, c])
    expect(runnable.map((r) => r.sample_id)).toEqual(['a', 'c'])
  })
})

describe('cosineSimilarity', () => {
  it('returns 1 for identical vectors', () => {
    expect(cosineSimilarity([1, 2, 3], [1, 2, 3])).toBeCloseTo(1)
  })

  it('returns 0 for orthogonal vectors', () => {
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0)
  })

  it('returns 0 for mismatched lengths or empty vectors', () => {
    expect(cosineSimilarity([1, 2], [1])).toBe(0)
    expect(cosineSimilarity([], [])).toBe(0)
  })
})
