import { ScenarioSheetRowSchema, type ScenarioSheetRow } from './scenario-schema'
import type { MetaEntry } from './merge-scenario-sheet-pure'

/**
 * TAC-347 Stage 1 (redesign). Sheet row <-> ScenarioSheetRow serialization,
 * split out from merge-scenario-sheet.ts so it stays vitest-safe: that file
 * imports @/lib/rag for embedText, which transitively imports the `voyageai`
 * SDK — a directory-style ESM import vitest's resolver can't follow (same
 * failure class CLAUDE.md documents for lib/tunables/manifest.test.ts).
 * Per the module-split-for-testability convention, the pure serialization
 * logic (no SDK deps) lives here; DB/SDK-touching orchestration stays in
 * merge-scenario-sheet.ts, which re-exports everything from this file.
 */

export const SCENARIO_COLUMNS = [
  'id',
  'topic',
  'category',
  'mode',
  'guest_state',
  'message',
  'key_facts',
  'expected_route',
  'expected_behavior',
  'notes',
  'exclude',
  'origin',
  'generated_hash',
  'scenario_source',
  'forbidden_claims',
  'source_row_ids',
  'expected_failure',
  'scenario_description',
] as const

export const TOPICS_COLUMNS = ['topic', 'subtopics', 'source_row_ids'] as const
export const META_COLUMNS = ['id', 'topic', 'message'] as const

const join = (values: readonly string[]): string => values.join('; ')
const split = (value: string): string[] =>
  value
    .split(';')
    .map((v) => v.trim())
    .filter((v) => v.length > 0)

export function scenarioRowToValues(row: ScenarioSheetRow): string[] {
  return [
    row.sample_id,
    row.topic,
    row.category,
    row.mode,
    row.guest_state,
    row.inbound_message,
    join(row.expected_facts),
    row.expected_route,
    row.expected_behavior,
    row.notes,
    row.exclude ? 'TRUE' : 'FALSE',
    row.origin,
    row.generated_hash,
    row.scenario_source,
    join(row.forbidden_claims),
    join(row.source_row_ids),
    row.expected_failure ?? '',
    row.scenario,
  ]
}

/**
 * Parse one data row back from sheet values, keyed by header rather than
 * position — tolerant of column reordering if a human rearranges the
 * sheet, and fails loudly (skips + logs) on a row that no longer validates
 * rather than silently corrupting the merge.
 */
export function valuesToScenarioRow(headerRow: string[], dataRow: string[]): ScenarioSheetRow | null {
  const byHeader = new Map(headerRow.map((h, i) => [h, dataRow[i] ?? '']))
  const get = (col: (typeof SCENARIO_COLUMNS)[number]): string => byHeader.get(col) ?? ''

  const candidate = {
    sample_id: get('id'),
    topic: get('topic'),
    category: get('category'),
    mode: get('mode'),
    guest_state: get('guest_state'),
    inbound_message: get('message'),
    expected_facts: split(get('key_facts')),
    expected_route: get('expected_route'),
    expected_behavior: get('expected_behavior'),
    notes: get('notes'),
    exclude: get('exclude').trim().toUpperCase() === 'TRUE',
    origin: get('origin'),
    generated_hash: get('generated_hash'),
    scenario_source: get('scenario_source'),
    forbidden_claims: split(get('forbidden_claims')),
    source_row_ids: split(get('source_row_ids')),
    expected_failure: get('expected_failure').length > 0 ? get('expected_failure') : null,
    scenario: get('scenario_description'),
  }

  const parsed = ScenarioSheetRowSchema.safeParse(candidate)
  if (!parsed.success) {
    console.warn(
      `[merge-scenario-sheet] dropping unparseable row id="${candidate.sample_id}": ${parsed.error.message}`,
    )
    return null
  }
  return parsed.data
}

export function buildMergedMetaEntries(
  existing: readonly MetaEntry[],
  freshRows: readonly ScenarioSheetRow[],
): MetaEntry[] {
  const byId = new Map(existing.map((m) => [m.id, m]))
  for (const row of freshRows) {
    byId.set(row.sample_id, { id: row.sample_id, topic: row.topic, message: row.inbound_message })
  }
  return Array.from(byId.values())
}
