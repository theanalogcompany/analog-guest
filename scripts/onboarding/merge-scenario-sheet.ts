import type { sheets_v4 } from 'googleapis'
import { embedText } from '@/lib/rag'
import { readTabValues, writeTabValues } from './drive'
import {
  cosineSimilarity,
  detectTombstones,
  filterTombstoneDuplicates,
  groupTombstonesByTopic,
  mergeScenarioRows,
  stampFreshRows,
  type MetaEntry,
} from './merge-scenario-sheet-pure'
import {
  buildMergedMetaEntries,
  META_COLUMNS,
  scenarioRowToValues,
  SCENARIO_COLUMNS,
  valuesToScenarioRow,
} from './merge-scenario-sheet-serialize'
import type { Scenario, ScenarioSheetRow } from './scenario-schema'

export * from './merge-scenario-sheet-pure'
export * from './merge-scenario-sheet-serialize'

/**
 * Near-duplicate bar for the tombstone dedup filter. Cosine similarity on
 * Voyage embeddings of full inbound messages; 0.92 is a "same test intent,
 * different phrasing" bar, not merely "same topic" — two different
 * questions about the same topic should still both survive.
 */
export const TOMBSTONE_SIMILARITY_THRESHOLD = 0.92

export const SCENARIOS_TAB = 'Scenarios'
export const TOPICS_TAB = 'Topics'
export const META_TAB = '_meta'

export interface LoadedSheet {
  spreadsheetId: string
  currentRows: ScenarioSheetRow[]
  metaEntries: MetaEntry[]
}

/** Read the existing Scenarios + _meta tabs, if the sheet already exists. */
export async function loadExistingSheet(
  sheets: sheets_v4.Sheets,
  spreadsheetId: string,
): Promise<LoadedSheet> {
  const [scenarioValues, metaValues] = await Promise.all([
    readTabValues(sheets, spreadsheetId, SCENARIOS_TAB),
    readTabValues(sheets, spreadsheetId, META_TAB),
  ])

  const [scenarioHeader, ...scenarioData] = scenarioValues
  const currentRows = scenarioHeader
    ? scenarioData.flatMap((row) => {
        const parsed = valuesToScenarioRow(scenarioHeader, row)
        return parsed ? [parsed] : []
      })
    : []

  const [, ...metaData] = metaValues
  const metaEntries: MetaEntry[] = metaData
    .filter((row) => row.length >= 3 && row[0])
    .map((row) => ({ id: row[0], topic: row[1], message: row[2] }))

  return { spreadsheetId, currentRows, metaEntries }
}

async function embedCached(text: string, cache: Map<string, number[]>): Promise<number[] | null> {
  const cached = cache.get(text)
  if (cached) return cached
  const result = await embedText(text, 'document')
  if (!result.ok) {
    console.warn(`[merge-scenario-sheet] embedding failed for tombstone dedup: ${result.error}`)
    return null
  }
  cache.set(text, result.data.embedding)
  return result.data.embedding
}

export interface DedupReport {
  droppedCount: number
  dropped: Array<{ message: string; topic: string; matchedTombstoneId: string }>
}

/**
 * Real (Voyage-backed) implementation of the tombstone near-duplicate
 * filter. Embeds every distinct message once (cached), so a topic with many
 * candidates against few tombstones costs roughly (candidates + tombstones)
 * embed calls, not candidates × tombstones.
 */
export async function dedupeAgainstTombstones(
  freshScenarios: readonly Scenario[],
  metaEntries: readonly MetaEntry[],
  currentRows: readonly ScenarioSheetRow[],
): Promise<{ kept: Scenario[]; report: DedupReport }> {
  const tombstones = detectTombstones(metaEntries, currentRows)
  if (tombstones.length === 0) {
    return { kept: [...freshScenarios], report: { droppedCount: 0, dropped: [] } }
  }
  const byTopic = groupTombstonesByTopic(tombstones)
  const cache = new Map<string, number[]>()

  // Pre-embed every tombstone message that shares a topic with at least one
  // fresh candidate (skip topics with no candidates — nothing to compare).
  const relevantTopics = new Set(freshScenarios.map((s) => s.topic))
  for (const topic of relevantTopics) {
    for (const t of byTopic.get(topic) ?? []) {
      await embedCached(t.message, cache)
    }
  }

  const similarityLookup = (candidateMessage: string, tombstoneMessage: string): number => {
    const a = cache.get(candidateMessage)
    const b = cache.get(tombstoneMessage)
    if (!a || !b) return 0
    return cosineSimilarity(a, b)
  }

  // Embed every candidate up front (sequential await above already primed
  // the tombstone side; candidates are primed here before the sync filter
  // pass runs, since filterTombstoneDuplicates itself is a pure sync fn).
  for (const s of freshScenarios) {
    if ((byTopic.get(s.topic) ?? []).length > 0) {
      await embedCached(s.inbound_message, cache)
    }
  }

  const { kept, dropped } = filterTombstoneDuplicates(
    freshScenarios,
    byTopic,
    similarityLookup,
    TOMBSTONE_SIMILARITY_THRESHOLD,
  )

  return {
    kept,
    report: {
      droppedCount: dropped.length,
      dropped: dropped.map((d) => ({
        message: d.scenario.inbound_message,
        topic: d.scenario.topic,
        matchedTombstoneId: d.matchedTombstone.id,
      })),
    },
  }
}

export interface WriteSheetInput {
  spreadsheetId: string
  finalRows: ScenarioSheetRow[]
  topicsTabRows: string[][] // pre-built, header included
  allMetaEntries: MetaEntry[] // existing + newly-written ids, deduped by id
}

export async function writeFullSheet(
  sheets: sheets_v4.Sheets,
  input: WriteSheetInput,
): Promise<void> {
  const scenarioRows = [
    [...SCENARIO_COLUMNS],
    ...input.finalRows.map(scenarioRowToValues),
  ]
  const metaRows = [
    [...META_COLUMNS],
    ...input.allMetaEntries.map((m) => [m.id, m.topic, m.message]),
  ]

  await writeTabValues(sheets, input.spreadsheetId, SCENARIOS_TAB, scenarioRows)
  await writeTabValues(sheets, input.spreadsheetId, TOPICS_TAB, input.topicsTabRows)
  await writeTabValues(sheets, input.spreadsheetId, META_TAB, metaRows)
}

/**
 * Full orchestration: dedupe fresh candidates against tombstones, merge
 * against whatever currently exists, return everything the caller needs to
 * write the sheet plus a stats report for the CLI's console output.
 */
export async function runMerge(args: {
  freshScenarios: Scenario[]
  existing: LoadedSheet | null
}): Promise<{
  finalRows: ScenarioSheetRow[]
  allMetaEntries: MetaEntry[]
  mergeStats: ReturnType<typeof mergeScenarioRows>['stats']
  dedupReport: DedupReport
}> {
  const currentRows = args.existing?.currentRows ?? []
  const metaEntries = args.existing?.metaEntries ?? []

  const { kept: dedupedFresh, report: dedupReport } = await dedupeAgainstTombstones(
    args.freshScenarios,
    metaEntries,
    currentRows,
  )

  const freshStampedRows = stampFreshRows(dedupedFresh)
  const { finalRows, stats } = mergeScenarioRows({ currentRows, freshStampedRows })
  const allMetaEntries = buildMergedMetaEntries(metaEntries, freshStampedRows)

  return { finalRows, allMetaEntries, mergeStats: stats, dedupReport }
}
